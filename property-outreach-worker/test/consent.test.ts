// The gate is the only thing standing between a drafted message and a banned
// WhatsApp number, so it gets the closest tests in this repository. Each case
// below corresponds to a way a real campaign gets a number restricted.

import { describe, expect, it } from 'vitest'
import {
  evaluateGate,
  isE164,
  renderTemplate,
  serviceWindowOpen,
  TemplateRenderError,
  unsupportedClaims,
  type GateInput,
} from '../src/consent'

const NOW = new Date('2026-08-20T12:00:00Z')
const LIMITS = { maxPerContact: 2, windowDays: 30 }

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    contact: {
      phone_e164: '+971501234567',
      opt_in_state: 'opted_in',
      last_inbound_at: null,
    },
    template: { name: 'listing_intro', category: 'marketing', meta_status: 'approved' },
    renderedBody: 'Hi Sara, I have a 2-bed in Marina at 1.9M. Reply STOP to opt out.',
    recentSendCount: 0,
    limits: LIMITS,
    now: NOW,
    ...overrides,
  }
}

function codes(result: { blockers: { code: string }[] }): string[] {
  return result.blockers.map((b) => b.code)
}

describe('isE164', () => {
  it('accepts a full international number', () => {
    expect(isE164('+971501234567')).toBe(true)
    expect(isE164('+447700900123')).toBe(true)
  })

  it('rejects the local forms that fill listing sheets', () => {
    // These are the two shapes a spreadsheet export actually produces, and
    // both are silently undeliverable if they reach the provider.
    expect(isE164('0501234567')).toBe(false)
    expect(isE164('971501234567')).toBe(false)
    expect(isE164('+971 50 123 4567')).toBe(false)
    expect(isE164('9.71501e+11')).toBe(false)
    expect(isE164('+0501234567')).toBe(false)
    expect(isE164('')).toBe(false)
    expect(isE164(null)).toBe(false)
  })
})

describe('evaluateGate — consent', () => {
  it('lets an opted-in contact through', () => {
    const result = evaluateGate(input())
    expect(result.allowed).toBe(true)
    expect(result.blockers).toEqual([])
  })

  it('blocks a contact with no recorded opt-in', () => {
    // The default state of every number lifted off a listing sheet.
    const result = evaluateGate(input({
      contact: { phone_e164: '+971501234567', opt_in_state: 'unknown', last_inbound_at: null },
    }))
    expect(result.allowed).toBe(false)
    expect(codes(result)).toContain('NO_OPT_IN')
  })

  it('blocks a contact who opted out', () => {
    const result = evaluateGate(input({
      contact: { phone_e164: '+971501234567', opt_in_state: 'opted_out', last_inbound_at: null },
    }))
    expect(codes(result)).toContain('OPTED_OUT')
    expect(codes(result)).not.toContain('NO_OPT_IN')
  })
})

describe('evaluateGate — the prior-contact claim guard', () => {
  // The reason this project exists. Every phrase here is one a real estate
  // outreach draft reaches for, and each is a lie when the recipient's number
  // came off a listing sheet.
  const claims = [
    'Hi, you showed interest in a property in JVC last year.',
    'You had previously shown interest in Downtown apartments.',
    'You enquired about a villa in Arabian Ranches recently.',
    'You recently contacted us about selling your unit.',
    'You registered with us for off-plan launches.',
    'Following up on your enquiry about the Marina tower.',
    'As we discussed, I have three options for you.',
    'Since we last spoke, prices in your area moved.',
    'Thanks for your interest in our listings!',
    'Regarding your recent viewing of the Palm villa.',
  ]

  for (const body of claims) {
    it(`blocks: ${body.slice(0, 44)}…`, () => {
      const result = evaluateGate(input({ renderedBody: body }))
      expect(result.allowed).toBe(false)
      expect(codes(result)).toContain('UNSUPPORTED_CLAIM')
    })
  }

  it('names the phrase it objected to, so the copy can be fixed', () => {
    const result = evaluateGate(input({
      renderedBody: 'Hi, you showed interest in a Marina apartment.',
    }))
    const blocker = result.blockers.find((b) => b.code === 'UNSUPPORTED_CLAIM')
    expect(blocker?.detail).toContain('you showed interest')
    expect(blocker?.detail).toContain('never messaged you')
  })

  it('allows the same claim once the person really has messaged first', () => {
    // The claim is only false when there is no prior contact. With a real
    // inbound on record it is simply true, and must not be blocked.
    const result = evaluateGate(input({
      renderedBody: 'Following up on your enquiry about the Marina tower.',
      contact: {
        phone_e164: '+971501234567',
        opt_in_state: 'opted_in',
        last_inbound_at: '2026-08-01T09:00:00Z',
      },
    }))
    expect(codes(result)).not.toContain('UNSUPPORTED_CLAIM')
  })

  it('leaves honest first-contact copy alone', () => {
    const honest = [
      'Hi Sara, I am a broker in Dubai Marina. You listed 2BR unit 1204 with Alpha Realty — I have a buyer at 1.9M. Interested?',
      'Hello, I work on Palm Jumeirah listings and have three villas under 8M this month.',
      'Hi, I saw your property advertised for sale. May I send you a valuation?',
    ]
    for (const body of honest) {
      expect(unsupportedClaims(body)).toEqual([])
      expect(evaluateGate(input({ renderedBody: body })).allowed).toBe(true)
    }
  })

  it('does not fire on the word interest used honestly', () => {
    // "interest rates" and "if you are interested" are not claims about the
    // past. A guard that blocks ordinary copy gets switched off.
    expect(unsupportedClaims('Interest rates dropped this quarter.')).toEqual([])
    expect(unsupportedClaims('Let me know if you are interested.')).toEqual([])
    expect(unsupportedClaims('This may be of interest to you.')).toEqual([])
  })
})

describe('evaluateGate — templates and the service window', () => {
  it('blocks a template Meta has not approved', () => {
    for (const status of ['draft', 'submitted', 'rejected', 'paused', 'disabled'] as const) {
      const result = evaluateGate(input({
        template: { name: 'listing_intro', category: 'marketing', meta_status: status },
      }))
      expect(codes(result), status).toContain('TEMPLATE_NOT_APPROVED')
    }
  })

  it('blocks free-form outside the 24h window', () => {
    const result = evaluateGate(input({ template: null }))
    expect(codes(result)).toContain('FREEFORM_OUTSIDE_WINDOW')
  })

  it('allows free-form inside the 24h window', () => {
    const result = evaluateGate(input({
      template: null,
      contact: {
        phone_e164: '+971501234567',
        opt_in_state: 'opted_in',
        // Two hours ago.
        last_inbound_at: '2026-08-20T10:00:00Z',
      },
    }))
    expect(result.allowed).toBe(true)
  })
})

describe('serviceWindowOpen', () => {
  it('is closed when they have never written', () => {
    expect(serviceWindowOpen(null, NOW)).toBe(false)
  })

  it('is open just inside 24 hours and closed just outside', () => {
    expect(serviceWindowOpen('2026-08-19T12:00:01Z', NOW)).toBe(true)
    expect(serviceWindowOpen('2026-08-19T11:59:59Z', NOW)).toBe(false)
  })

  it('treats a future timestamp as closed, not open', () => {
    // A bad import must not be able to unlock free-form sending to a contact
    // who never wrote.
    expect(serviceWindowOpen('2026-09-01T00:00:00Z', NOW)).toBe(false)
  })

  it('treats an unparseable timestamp as closed', () => {
    expect(serviceWindowOpen('not a date', NOW)).toBe(false)
  })
})

describe('evaluateGate — frequency cap', () => {
  it('blocks at the cap', () => {
    expect(evaluateGate(input({ recentSendCount: 2 })).allowed).toBe(false)
    expect(codes(evaluateGate(input({ recentSendCount: 2 })))).toContain('FREQUENCY_CAP')
  })

  it('allows below the cap', () => {
    expect(evaluateGate(input({ recentSendCount: 1 })).allowed).toBe(true)
  })
})

describe('evaluateGate — reporting', () => {
  it('reports every blocker at once rather than one at a time', () => {
    // A gate that reveals problems one per attempt trains people to click
    // Approve until it stops complaining.
    const result = evaluateGate(input({
      contact: { phone_e164: '0501234567', opt_in_state: 'unknown', last_inbound_at: null },
      template: { name: 'x', category: 'marketing', meta_status: 'draft' },
      renderedBody: 'You showed interest in this last year.',
      recentSendCount: 5,
    }))
    expect(codes(result).sort()).toEqual([
      'FREQUENCY_CAP',
      'INVALID_PHONE',
      'NO_OPT_IN',
      'TEMPLATE_NOT_APPROVED',
      'UNSUPPORTED_CLAIM',
    ])
  })

  it('blocks an empty body', () => {
    expect(codes(evaluateGate(input({ renderedBody: '   ' })))).toContain('EMPTY_BODY')
  })
})

describe('renderTemplate', () => {
  it('substitutes positional placeholders', () => {
    expect(renderTemplate('Hi {{1}}, a unit in {{2}} is available.', ['Sara', 'Marina']))
      .toBe('Hi Sara, a unit in Marina is available.')
  })

  it('repeats a placeholder used twice without needing a second value', () => {
    expect(renderTemplate('{{1}}, this is for you {{1}}.', ['Sara']))
      .toBe('Sara, this is for you Sara.')
  })

  it('refuses a count mismatch instead of shipping a visible hole', () => {
    // The API rejects this anyway with error 132000; failing here says why.
    expect(() => renderTemplate('Hi {{1}} in {{2}}', ['Sara'])).toThrow(TemplateRenderError)
    expect(() => renderTemplate('Hi {{1}}', ['Sara', 'extra'])).toThrow(TemplateRenderError)
  })

  it('handles a template with no variables', () => {
    expect(renderTemplate('Hello there.', [])).toBe('Hello there.')
  })
})
