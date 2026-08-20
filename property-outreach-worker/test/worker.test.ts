// End-to-end tests through the fetch handler, with Supabase and LetsBot both
// stubbed at the global fetch boundary.
//
// The unit tests prove the gate decides correctly. These prove it is actually
// wired into the paths that can send — which is a separate claim, and the one
// that matters. A perfect gate nobody calls protects nothing.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import worker, { type Env } from '../src/index'

const CONTACT_ID = '11111111-1111-4111-8111-111111111111'
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222'
const TEMPLATE_ID = '33333333-3333-4333-8333-333333333333'

const ENV: Env = {
  SUPABASE_URL: 'https://db.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  API_TOKEN: 'secret-token',
  LETSBOT_API_KEY: 'letsbot-key',
  LETSBOT_API_BASE: 'https://api.letsbot.net',
  LETSBOT_SEND_PATH: '/v1/messages',
  OUTREACH_LIVE: 'true',
  OUTREACH_MAX_PER_CONTACT: '2',
  OUTREACH_WINDOW_DAYS: '30',
}

/** Rows the fake PostgREST will answer with, keyed by table. */
type Fixtures = Record<string, Record<string, unknown>[]>

let fixtures: Fixtures
let letsbotCalls: { url: string; body: unknown }[]
let patches: { table: string; body: Record<string, unknown> }[]
const realFetch = globalThis.fetch

function contact(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTACT_ID,
    phone_e164: '+971501234567',
    full_name: 'Sara',
    language: 'en',
    opt_in_state: 'opted_in',
    last_inbound_at: null,
    ...overrides,
  }
}

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    name: 'listing_intro',
    language: 'en',
    category: 'marketing',
    meta_status: 'approved',
    body: 'Hi {{1}}, I have a unit in {{2}}.',
    variables: ['name', 'area'],
    ...overrides,
  }
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    contact_id: CONTACT_ID,
    property_id: null,
    template_id: TEMPLATE_ID,
    language: 'en',
    rendered_body: 'Hi Sara, I have a unit in Marina.',
    variables: ['Sara', 'Marina'],
    status: 'approved',
    block_reasons: [],
    provider: 'letsbot',
    provider_message_id: null,
    error: null,
    sent_at: null,
    created_at: '2026-08-20T10:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  fixtures = {
    contacts: [contact()],
    message_templates: [template()],
    outreach_messages: [message()],
  }
  letsbotCalls = []
  patches = []

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'

    if (url.hostname === 'api.letsbot.net') {
      letsbotCalls.push({ url: url.toString(), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ message_id: 'wamid.TEST' }), { status: 200 })
    }

    // Fake PostgREST. Enough of it to serve the paths under test.
    const table = url.pathname.replace('/rest/v1/', '')
    const rows = fixtures[table] ?? []

    if (method === 'GET') {
      const idFilter = url.searchParams.get('id')
      const statusFilter = url.searchParams.get('status')
      let selected = rows
      if (idFilter?.startsWith('eq.')) {
        const wanted = idFilter.slice(3)
        selected = rows.filter((row) => row.id === wanted)
      }
      // Powers the frequency-cap count.
      if (statusFilter === 'eq.sent') {
        selected = selected.filter((row) => row.status === 'sent')
      }
      return new Response(JSON.stringify(selected), { status: 200 })
    }

    if (method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      patches.push({ table, body })
      const idFilter = url.searchParams.get('id')?.slice(3)
      const target = rows.find((row) => row.id === idFilter)
      const updated = { ...(target ?? {}), ...body }
      if (target) Object.assign(target, body)
      return new Response(JSON.stringify([updated]), { status: 200 })
    }

    if (method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const created = { id: 'new-row', ...body }
      rows.push(created)
      return new Response(JSON.stringify([created]), { status: 201 })
    }

    return new Response('[]', { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

function call(path: string, init: RequestInit & { token?: string | null } = {}) {
  const { token = ENV.API_TOKEN, ...rest } = init
  return worker.fetch(
    new Request(`https://outreach.example.com${path}`, {
      ...rest,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(rest.headers ?? {}),
      },
    }),
    ENV,
  )
}

describe('authentication', () => {
  it('refuses every API route without the token', async () => {
    for (const path of ['/api/queue', '/api/contacts', '/api/stats']) {
      const response = await call(path, { token: null })
      expect(response.status, path).toBe(401)
    }
  })

  it('serves the dashboard and health without one', async () => {
    expect((await call('/', { token: null })).status).toBe(200)
    expect((await call('/api/health', { token: null })).status).toBe(200)
  })

  it('reports whether sending is armed, without leaking values', async () => {
    const body = await (await call('/api/health', { token: null })).json() as {
      sending: string
      configured: Record<string, boolean>
    }
    expect(body.sending).toBe('live')
    expect(body.configured.letsbot_api_key).toBe(true)
    expect(JSON.stringify(body)).not.toContain('letsbot-key')
    expect(JSON.stringify(body)).not.toContain('service-key')
  })
})

describe('POST /api/outreach/:id/send', () => {
  it('sends an approved message to an opted-in contact', async () => {
    const response = await call(`/api/outreach/${MESSAGE_ID}/send`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(letsbotCalls).toHaveLength(1)
    expect(letsbotCalls[0]!.body).toMatchObject({
      phone: '+971501234567',
      type: 'template',
      template: { name: 'listing_intro', variables: ['Sara', 'Marina'] },
    })
    const body = await response.json() as { provider_message_id: string }
    expect(body.provider_message_id).toBe('wamid.TEST')
  })

  it('refuses to send a message that was never approved', async () => {
    fixtures.outreach_messages = [message({ status: 'draft' })]
    const response = await call(`/api/outreach/${MESSAGE_ID}/send`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect(letsbotCalls).toHaveLength(0)
  })

  it('honours an opt-out that arrived AFTER approval', async () => {
    // The case the whole design turns on. The row is already approved by a
    // human; consent was withdrawn in between. Nothing may go out.
    fixtures.contacts = [contact({ opt_in_state: 'opted_out' })]
    const response = await call(`/api/outreach/${MESSAGE_ID}/send`, { method: 'POST' })

    expect(response.status).toBe(409)
    expect(letsbotCalls).toHaveLength(0)
    const body = await response.json() as { blockers: { code: string }[] }
    expect(body.blockers.map((b) => b.code)).toContain('OPTED_OUT')

    // The approval is withdrawn too, so the queue cannot be clicked again
    // into a send.
    const patch = patches.find((p) => p.table === 'outreach_messages')
    expect(patch?.body.status).toBe('blocked')
    expect(patch?.body.approved_at).toBeNull()
  })

  it('blocks a paused template even though a human approved the row', async () => {
    fixtures.message_templates = [template({ meta_status: 'paused' })]
    const response = await call(`/api/outreach/${MESSAGE_ID}/send`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect(letsbotCalls).toHaveLength(0)
  })

  it('blocks an approved row whose copy claims contact that never happened', async () => {
    // Meta approves the SHAPE of a template. It never verified that this
    // particular recipient did the thing the copy says they did.
    fixtures.outreach_messages = [message({
      rendered_body: 'Hi Sara, you showed interest in a Marina apartment last year.',
    })]
    const response = await call(`/api/outreach/${MESSAGE_ID}/send`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect(letsbotCalls).toHaveLength(0)
    const body = await response.json() as { blockers: { code: string }[] }
    expect(body.blockers.map((b) => b.code)).toContain('UNSUPPORTED_CLAIM')
  })

  it('transmits nothing when OUTREACH_LIVE is not "true"', async () => {
    const response = await worker.fetch(
      new Request(`https://outreach.example.com/api/outreach/${MESSAGE_ID}/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ENV.API_TOKEN}` },
      }),
      { ...ENV, OUTREACH_LIVE: 'false' },
    )
    expect(response.status).toBe(200)
    expect(letsbotCalls).toHaveLength(0)
    const body = await response.json() as { dry_run: boolean; would_send: { body: unknown } }
    expect(body.dry_run).toBe(true)
    // The payload comes back so it can be diffed against the provider's docs.
    expect(body.would_send.body).toMatchObject({ phone: '+971501234567' })
  })
})

describe('POST /api/outreach/:id/approve', () => {
  it('refuses to approve a message the gate blocks', async () => {
    fixtures.contacts = [contact({ opt_in_state: 'unknown' })]
    fixtures.outreach_messages = [message({ status: 'draft' })]
    const response = await call(`/api/outreach/${MESSAGE_ID}/approve`, { method: 'POST' })
    expect(response.status).toBe(409)
    const body = await response.json() as { blockers: { code: string }[] }
    expect(body.blockers.map((b) => b.code)).toContain('NO_OPT_IN')
  })

  it('approves a clean draft', async () => {
    fixtures.outreach_messages = [message({ status: 'draft' })]
    const response = await call(`/api/outreach/${MESSAGE_ID}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approved_by: 'ash' }),
    })
    expect(response.status).toBe(200)
    const patch = patches.find((p) => p.table === 'outreach_messages')
    expect(patch?.body.status).toBe('approved')
    expect(patch?.body.approved_by).toBe('ash')
  })
})

describe('POST /api/draft', () => {
  it('stores a cold-list draft as blocked rather than rejecting it', async () => {
    // Blocked-and-visible beats a 400: the row names the contact who needs an
    // opt-in recorded, which is the actual next action.
    fixtures.contacts = [contact({ opt_in_state: 'unknown' })]
    const response = await call('/api/draft', {
      method: 'POST',
      body: JSON.stringify({
        contact_id: CONTACT_ID,
        template_id: TEMPLATE_ID,
        rendered_body: 'Hi Sara, I have a unit in Marina.',
        variables: ['Sara', 'Marina'],
      }),
    })
    expect(response.status).toBe(201)
    const body = await response.json() as {
      data: { status: string; block_reasons: string[] }
    }
    expect(body.data.status).toBe('blocked')
    expect(body.data.block_reasons).toContain('NO_OPT_IN')
  })

  it('refuses a status supplied by the drafting agent', async () => {
    const response = await call('/api/draft', {
      method: 'POST',
      body: JSON.stringify({
        contact_id: CONTACT_ID,
        template_id: TEMPLATE_ID,
        rendered_body: 'Hi Sara, I have a unit in Marina.',
        status: 'approved',
        approved_by: 'the agent itself',
      }),
    })
    expect(response.status).toBe(201)
    const body = await response.json() as { data: { status: string; approved_by?: unknown } }
    // The gate decides the status, never the caller.
    expect(body.data.status).toBe('draft')
    expect(body.data.approved_by).toBeUndefined()
  })
})

describe('POST /api/outreach — the unchecked way in', () => {
  it('is closed, so /api/draft is the only entrance', async () => {
    const response = await call('/api/outreach', {
      method: 'POST',
      body: JSON.stringify({ contact_id: CONTACT_ID, rendered_body: 'Hi' }),
    })
    expect(response.status).toBe(405)
  })
})

describe('POST /api/contacts/:id/consent', () => {
  it('records an opt-in and updates the cached state', async () => {
    const response = await call(`/api/contacts/${CONTACT_ID}/consent`, {
      method: 'POST',
      body: JSON.stringify({
        event: 'opt_in',
        method: 'website_form',
        evidence_note: 'valuation form 2026-08-14',
      }),
    })
    expect(response.status).toBe(201)
    const patch = patches.find((p) => p.table === 'contacts')
    expect(patch?.body.opt_in_state).toBe('opted_in')
  })

  it('rejects an opt-in with no evidence behind it', async () => {
    const response = await call(`/api/contacts/${CONTACT_ID}/consent`, {
      method: 'POST',
      body: JSON.stringify({ event: 'opt_in', method: 'website_form' }),
    })
    expect(response.status).toBe(400)
    expect(patches.find((p) => p.table === 'contacts')).toBeUndefined()
  })
})
