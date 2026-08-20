// The unattended path, end to end.
//
// With a human in the loop, a bug here costs an awkward message someone
// catches at the queue. Without one, it costs the number. These tests are the
// only thing standing where a reviewer used to, so they check the whole
// sequence — selection, personalisation, gate, send — rather than the pieces.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { tick, type Env } from '../src/index'
import {
  allowanceForRun,
  audienceFilters,
  draftFor,
  personalise,
} from '../src/campaign'
import { renderTemplate } from '../src/consent'
import type { Campaign, Contact, MessageTemplate, Property } from '../src/schema'

const CAMPAIGN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TEMPLATE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const ENV: Env = {
  SUPABASE_URL: 'https://db.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  API_TOKEN: 'secret-token',
  LETSBOT_API_KEY: 'letsbot-key',
  LETSBOT_API_BASE: 'https://api.letsbot.net',
  LETSBOT_SEND_PATH: '/v1/messages',
  OUTREACH_LIVE: 'true',
  OUTREACH_AUTOPILOT: 'true',
  APP_TIMEZONE: 'Asia/Dubai',
}

const NOW = new Date('2026-08-20T12:00:00Z')

function campaign(overrides: Partial<Campaign> = {}): Campaign & Row {
  return {
    id: CAMPAIGN_ID,
    name: 'marina-owners',
    template_id: TEMPLATE_ID,
    status: 'active',
    audience_contact_type: 'owner',
    audience_language: null,
    variable_sources: ['contact.full_name'],
    property_id: null,
    daily_cap: 20,
    batch_size: 5,
    sent_count: 0,
    last_run_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  }
}

function template(overrides: Partial<MessageTemplate> = {}): MessageTemplate & Row {
  return {
    id: TEMPLATE_ID,
    name: 'listing_intro',
    language: 'en',
    category: 'marketing',
    body: 'Hi {{1}}, I am a broker working in Dubai Marina. May I send you a valuation?',
    variables: ['name'],
    meta_status: 'approved',
    meta_rejection_reason: null,
    notes: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  }
}

function contact(id: string, overrides: Partial<Contact> = {}): Contact & Row {
  return {
    id,
    // Real E.164. An invalid number here would make every test pass for the
    // wrong reason — the gate would block on INVALID_PHONE and no test would
    // be exercising the path it claims to.
    phone_e164: `+97150120${String(id).replace(/\D/g, '').padStart(4, '0')}`,
    full_name: 'Sara',
    email: null,
    contact_type: 'owner',
    language: 'en',
    source: 'web opt-in form',
    source_detail: null,
    opt_in_state: 'opted_in',
    // The realistic default for an autopilot audience: they signed up on the
    // /optin page. Tests about the claim guard override this, because the case
    // that guard exists for is an imported list.
    opt_in_method: 'website_form',
    opted_in_at: '2026-08-10T00:00:00Z',
    opted_out_at: null,
    last_inbound_at: null,
    notes: null,
    created_at: '2026-08-10T00:00:00Z',
    updated_at: '2026-08-10T00:00:00Z',
    ...overrides,
  }
}

type Row = Record<string, unknown>

interface Tables {
  campaigns: Row[]
  message_templates: Row[]
  contacts: Row[]
  properties: Row[]
  outreach_messages: Row[]
}

let tables: Tables
let sends: Row[]
let letsbotStatus: number
const realFetch = globalThis.fetch

beforeEach(() => {
  tables = {
    campaigns: [campaign()],
    message_templates: [template()],
    contacts: [contact('c1'), contact('c2'), contact('c3')],
    properties: [],
    outreach_messages: [],
  }
  sends = []
  letsbotStatus = 200

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'

    if (url.hostname === 'api.letsbot.net') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      if (letsbotStatus !== 200) {
        return new Response(JSON.stringify({ message: 'rejected' }), { status: letsbotStatus })
      }
      sends.push(body)
      return new Response(JSON.stringify({ message_id: `wamid.${sends.length}` }), {
        status: 200,
      })
    }

    const table = url.pathname.replace('/rest/v1/', '') as keyof Tables
    const rows = tables[table] ?? []

    if (method === 'GET') {
      let selected = [...rows]
      for (const [column, expression] of url.searchParams.entries()) {
        if (['select', 'order', 'limit', 'offset'].includes(column)) continue
        if (expression.startsWith('eq.')) {
          const wanted = expression.slice(3)
          selected = selected.filter((row) => String(row[column] ?? '') === wanted)
        } else if (expression.startsWith('neq.')) {
          const unwanted = expression.slice(4)
          selected = selected.filter((row) => String(row[column] ?? '') !== unwanted)
        } else if (expression.startsWith('gte.')) {
          const floor = expression.slice(4)
          selected = selected.filter((row) => {
            const value = row[column]
            return typeof value === 'string' && value >= floor
          })
        } else if (expression.startsWith('lt.')) {
          const ceiling = expression.slice(3)
          selected = selected.filter((row) => {
            const value = row[column]
            return typeof value === 'string' && value < ceiling
          })
        }
      }
      // Offset is applied, not just skipped as a filter name. Paging is the
      // mechanism two of the fixes below rely on, so a fake that ignored it
      // would let a stall pass as a green test.
      const limit = Number(url.searchParams.get('limit') ?? '1000')
      const offset = Number(url.searchParams.get('offset') ?? '0')
      return new Response(JSON.stringify(selected.slice(offset, offset + limit)), { status: 200 })
    }

    if (method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      // Honour the once-per-campaign unique index.
      if (table === 'outreach_messages' && body.campaign_id) {
        const clash = rows.find(
          (row) =>
            row.campaign_id === body.campaign_id &&
            row.contact_id === body.contact_id &&
            row.status !== 'cancelled',
        )
        if (clash) {
          return new Response(
            JSON.stringify({ code: '23505', message: 'duplicate key' }),
            { status: 409 },
          )
        }
      }
      const created = { id: `row-${rows.length + 1}`, ...body }
      rows.push(created)
      return new Response(JSON.stringify([created]), { status: 201 })
    }

    if (method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const idFilter = url.searchParams.get('id')?.slice(3)
      const target = rows.find((row) => row.id === idFilter)
      if (target) Object.assign(target, body)
      return new Response(JSON.stringify(target ? [target] : []), { status: 200 })
    }

    return new Response('[]', { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('tick — the arming switch', () => {
  it('sends nothing when autopilot is off', async () => {
    // Deploying the Worker must not by itself start messaging people.
    const reports = await tick({ ...ENV, OUTREACH_AUTOPILOT: 'false' }, NOW)
    expect(reports).toEqual([])
    expect(sends).toHaveLength(0)
  })

  it('sends nothing when autopilot is a truthy non-"true" string', async () => {
    const reports = await tick({ ...ENV, OUTREACH_AUTOPILOT: 'yes' }, NOW)
    expect(reports).toEqual([])
    expect(sends).toHaveLength(0)
  })

  it('runs an active campaign when armed', async () => {
    const reports = await tick(ENV, NOW)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.sent).toBe(3)
    expect(sends).toHaveLength(3)
  })
})

describe('tick — who it will not message', () => {
  it('never messages a contact with no opt-in', async () => {
    tables.contacts = [
      contact('c1', { opt_in_state: 'unknown' }),
      contact('c2', { opt_in_state: 'opted_out' }),
    ]
    const reports = await tick(ENV, NOW)
    expect(sends).toHaveLength(0)
    expect(reports[0]!.sent).toBe(0)
  })

  it('never messages a contact twice, across two ticks', async () => {
    // The core of "only one time message". The second tick must find nothing
    // to do, not send a duplicate.
    await tick(ENV, NOW)
    expect(sends).toHaveLength(3)

    const second = await tick(ENV, new Date('2026-08-21T12:00:00Z'))
    expect(sends).toHaveLength(3)
    expect(second[0]!.sent).toBe(0)
  })

  it('skips a contact outside the campaign audience', async () => {
    tables.contacts = [contact('c1', { contact_type: 'buyer' }), contact('c2')]
    await tick(ENV, NOW)
    expect(sends).toHaveLength(1)
  })

  it('skips a contact it cannot personalise rather than sending "Hi ,"', async () => {
    tables.contacts = [contact('c1', { full_name: null }), contact('c2')]
    const reports = await tick(ENV, NOW)
    expect(sends).toHaveLength(1)
    expect(reports[0]!.skipped).toBe(1)
  })
})

describe('tick — the template', () => {
  it('refuses to run against a template Meta paused, and parks the campaign', async () => {
    // Meta can pause a template at any time. Nobody is watching, so the
    // campaign has to notice for itself.
    tables.message_templates = [template({ meta_status: 'paused' })]
    const reports = await tick(ENV, NOW)

    expect(sends).toHaveLength(0)
    expect(reports[0]!.stoppedBecause).toContain('paused')
    expect(tables.campaigns[0]!.status).toBe('paused')
  })

  it('will not send copy claiming an interaction that never happened', async () => {
    // The scenario this whole system was built around: contacts from a listing
    // sheet, and copy telling them they showed interest. Nobody is reviewing,
    // so the guard is the only thing between this and a banned number.
    tables.message_templates = [
      template({ body: 'Hi {{1}}, you showed interest in a Marina apartment last year.' }),
    ]
    tables.contacts = [
      contact('c1', { opt_in_method: 'imported_documented' }),
      contact('c2', { opt_in_method: 'imported_documented' }),
    ]
    const reports = await tick(ENV, NOW)

    expect(sends).toHaveLength(0)
    expect(reports[0]!.skipped).toBe(2)
    expect(Object.keys(reports[0]!.reasons).join(' ')).toContain('past interaction')
  })

  it('allows that same copy for someone who really did write first', async () => {
    tables.message_templates = [
      template({ body: 'Hi {{1}}, following up on your enquiry about Marina.' }),
    ]
    tables.contacts = [contact('c1', { last_inbound_at: '2026-08-19T09:00:00Z' })]
    await tick(ENV, NOW)
    expect(sends).toHaveLength(1)
  })
})

describe('tick — pace', () => {
  it('sends at most batch_size in one tick', async () => {
    tables.campaigns = [campaign({ batch_size: 2 })]
    tables.contacts = [contact('c1'), contact('c2'), contact('c3'), contact('c4')]
    const reports = await tick(ENV, NOW)
    expect(reports[0]!.sent).toBe(2)
    expect(sends).toHaveLength(2)
  })

  it('stops at the daily cap', async () => {
    tables.campaigns = [campaign({ daily_cap: 1, batch_size: 5 })]
    const reports = await tick(ENV, NOW)
    expect(reports[0]!.sent).toBe(1)
  })

  it('stops the batch on a provider failure instead of working through the list', async () => {
    // If LetsBot is rejecting sends, every remaining attempt fails the same
    // way — and hammering a suspended number is how a suspension becomes a ban.
    letsbotStatus = 401
    const reports = await tick(ENV, NOW)
    expect(reports[0]!.failed).toBe(1)
    expect(reports[0]!.stoppedBecause).toContain('provider failure')
    expect(sends).toHaveLength(0)
  })
})

describe('tick — regressions found in review', () => {
  it('keeps sending once the campaign has worked past its first page', async () => {
    // The stall. Contacts are ordered oldest-first, so a campaign that has
    // already handled its earliest people used to fetch a window containing
    // only done contacts, send nothing, and report no problem — the worst
    // failure shape for something nobody is watching.
    tables.contacts = Array.from({ length: 12 }, (_, i) => contact(`c${i + 1}`))
    tables.campaigns = [campaign({ batch_size: 2 })]

    // Nine of the twelve have already had their message.
    tables.outreach_messages = tables.contacts.slice(0, 9).map((row, i) => ({
      id: `old-${i}`,
      campaign_id: CAMPAIGN_ID,
      contact_id: row.id,
      status: 'sent',
      rendered_body: 'already sent',
      created_at: '2026-08-19T00:00:00Z',
      sent_at: '2026-08-19T00:00:00Z',
    }))

    const reports = await tick(ENV, NOW)
    expect(reports[0]!.sent).toBe(2)
    expect(sends).toHaveLength(2)
  })

  it('reports honestly when the audience is exhausted', async () => {
    tables.outreach_messages = tables.contacts.map((row, i) => ({
      id: `old-${i}`,
      campaign_id: CAMPAIGN_ID,
      contact_id: row.id,
      status: 'sent',
      rendered_body: 'already sent',
      created_at: '2026-08-19T00:00:00Z',
      sent_at: '2026-08-19T00:00:00Z',
    }))
    const reports = await tick(ENV, NOW)
    expect(reports[0]!.sent).toBe(0)
    expect(reports[0]!.stoppedBecause).toContain('no eligible contacts')
  })

  it('frees a row stranded in sending, marking delivery unknown', async () => {
    // An isolate that dies mid-send leaves the row in `sending`. Nothing else
    // clears it: the dedupe filter counts it as done and cancel refuses to
    // touch it, so that contact would never be messaged again.
    tables.outreach_messages = [{
      id: 'stuck-1',
      campaign_id: CAMPAIGN_ID,
      contact_id: 'c1',
      status: 'sending',
      rendered_body: 'half sent',
      created_at: '2026-08-20T09:00:00Z',
      updated_at: '2026-08-20T09:00:00Z',
    }]

    await tick(ENV, NOW)
    const row = tables.outreach_messages.find((r) => r.id === 'stuck-1')!
    expect(row.status).toBe('failed')
    // Not "approved": we do not know whether the provider received it, and
    // assuming it did not is how someone gets the same message twice.
    expect(String(row.error)).toContain('delivery unknown')
  })

  it('leaves a send that is still in flight alone', async () => {
    tables.outreach_messages = [{
      id: 'inflight',
      campaign_id: CAMPAIGN_ID,
      contact_id: 'c1',
      status: 'sending',
      rendered_body: 'in flight',
      created_at: '2026-08-20T11:59:00Z',
      updated_at: '2026-08-20T11:59:00Z',
    }]
    await tick(ENV, NOW)
    expect(tables.outreach_messages.find((r) => r.id === 'inflight')!.status).toBe('sending')
  })
})

describe('tick — dry run', () => {
  it('builds real payloads and transmits nothing', async () => {
    // Autopilot in dry run is the rehearsal worth having before a live number.
    const reports = await tick({ ...ENV, OUTREACH_LIVE: 'false' }, NOW)
    expect(sends).toHaveLength(0)
    expect(reports[0]!.sent).toBe(0)
    // The rows exist and are ready, so nothing is lost by rehearsing.
    expect(tables.outreach_messages).toHaveLength(3)
    expect(tables.outreach_messages[0]!.status).toBe('approved')
  })
})

describe('tick — one campaign failing does not stop the others', () => {
  it('reports the broken one and still runs the rest', async () => {
    tables.campaigns = [
      campaign({ id: 'broken', name: 'broken', template_id: 'missing-template' }),
      campaign(),
    ]
    const reports = await tick(ENV, NOW)
    expect(reports).toHaveLength(2)
    expect(reports[0]!.stoppedBecause).toContain('template')
    expect(reports[1]!.sent).toBe(3)
  })
})

// ── Pure helpers ───────────────────────────────────────────────────────────

describe('personalise', () => {
  const property: Property = {
    id: 'p1',
    reference: 'REF-1',
    title: '2BR Marina',
    property_type: 'apartment',
    area: 'Dubai Marina',
    city: 'Dubai',
    bedrooms: 2,
    bathrooms: 2,
    size_sqft: 1200,
    price: 1900000,
    currency: 'AED',
    listing_type: 'sale',
    listing_agent: 'Alpha Realty',
    source_sheet: null,
    url: null,
    notes: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  }

  it('resolves contact and property sources in order', () => {
    const result = personalise(
      { variable_sources: ['contact.full_name', 'property.area'] },
      contact('c1'),
      property,
    )
    expect(result.variables).toEqual(['Sara', 'Dubai Marina'])
  })

  it('skips rather than rendering an empty variable', () => {
    const result = personalise(
      { variable_sources: ['contact.full_name'] },
      contact('c1', { full_name: '   ' }),
      null,
    )
    expect(result.skip).toContain('empty')
  })

  it('skips when a property source has no property', () => {
    const result = personalise({ variable_sources: ['property.area'] }, contact('c1'), null)
    expect(result.skip).toContain('no property')
  })

  it('rejects an unknown scope rather than reaching for it', () => {
    const result = personalise({ variable_sources: ['env.SECRET'] }, contact('c1'), null)
    expect(result.skip).toContain('unknown variable scope')
  })
})

describe('allowanceForRun', () => {
  it('takes the smaller of the remaining day and one batch', () => {
    expect(allowanceForRun({ daily_cap: 20, batch_size: 5 }, 0)).toBe(5)
    expect(allowanceForRun({ daily_cap: 20, batch_size: 5 }, 18)).toBe(2)
    expect(allowanceForRun({ daily_cap: 20, batch_size: 5 }, 20)).toBe(0)
  })

  it('never goes negative', () => {
    expect(allowanceForRun({ daily_cap: 5, batch_size: 5 }, 9)).toBe(0)
  })
})

describe('audienceFilters', () => {
  it('always filters to opted-in contacts', () => {
    // Applied as a query filter as well as a gate check, so an unattended run
    // never even loads the people it must not contact.
    expect(audienceFilters(campaign()).opt_in_state).toBe('eq.opted_in')
    expect(audienceFilters(campaign({ audience_contact_type: null })).opt_in_state)
      .toBe('eq.opted_in')
  })
})

describe('draftFor', () => {
  it('reports a variable-count mismatch instead of sending a hole', () => {
    const result = draftFor(
      campaign({ variable_sources: [] }),
      template(),
      contact('c1'),
      null,
      renderTemplate,
    )
    expect('skip' in result && result.skip).toContain('expects 1 variable')
  })
})
