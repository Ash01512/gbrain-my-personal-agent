// The opt-in page is the only door into the sendable list, and it is public.
// Its job is to produce consent that would survive being questioned.

import { describe, expect, it } from 'vitest'
import {
  evidenceNote,
  optInPageHtml,
  OptInError,
  parseSubmission,
  whatsappLink,
} from '../src/optin'

function form(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields)
}

describe('parseSubmission', () => {
  it('accepts a complete submission', () => {
    const result = parseSubmission(form({
      phone: '+971 50 123 4567',
      name: 'Sara',
      contact_type: 'owner',
      consent: 'yes',
    }))
    expect(result.phone).toBe('+971501234567')
    expect(result.name).toBe('Sara')
    expect(result.contactType).toBe('owner')
  })

  it('adds the + when someone omits it', () => {
    expect(parseSubmission(form({ phone: '971501234567', consent: 'yes' })).phone)
      .toBe('+971501234567')
  })

  it('refuses a local number, and says how to fix it', () => {
    // The single most common mistake, and silently undeliverable if stored.
    try {
      parseSubmission(form({ phone: '0501234567', consent: 'yes' }))
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(OptInError)
      expect((error as Error).message).toContain('country code')
    }
  })

  it('refuses a submission with the consent box unticked', () => {
    // Meta is specific that a pre-checked box is not consent. The box ships
    // unchecked, and its absence is refused rather than defaulted.
    expect(() => parseSubmission(form({ phone: '+971501234567' })))
      .toThrow(/tick the box/)
    expect(() => parseSubmission(form({ phone: '+971501234567', consent: 'no' })))
      .toThrow(/tick the box/)
  })

  it('refuses an unknown contact type rather than guessing', () => {
    expect(() => parseSubmission(form({
      phone: '+971501234567', consent: 'yes', contact_type: 'agent',
    }))).toThrow(OptInError)
  })

  it('caps a long name instead of storing it whole', () => {
    const result = parseSubmission(form({
      phone: '+971501234567', consent: 'yes', name: 'x'.repeat(500),
    }))
    expect(result.name!.length).toBe(120)
  })
})

describe('evidenceNote', () => {
  it('records request metadata, not anything the submitter typed', () => {
    // Evidence a user can author is not evidence.
    const request = new Request('https://example.com/optin', {
      method: 'POST',
      headers: {
        'cf-connecting-ip': '203.0.113.9',
        'cf-ipcountry': 'AE',
        'user-agent': 'Mozilla/5.0 (iPhone)',
      },
    })
    const note = evidenceNote(request, '2026-08-20T12:00:00Z')
    expect(note).toContain('2026-08-20T12:00:00Z')
    expect(note).toContain('203.0.113.9')
    expect(note).toContain('AE')
    expect(note).toContain('unchecked by default')
  })

  it('still produces a note when the headers are absent', () => {
    const note = evidenceNote(new Request('https://example.com/optin'), '2026-08-20T12:00:00Z')
    expect(note).toContain('unknown ip')
  })
})

describe('whatsappLink', () => {
  it('builds a wa.me deep link with a prefilled message', () => {
    const link = whatsappLink('+971501234567')
    expect(link).toContain('https://wa.me/971501234567')
    expect(link).toContain('text=')
  })

  it('tolerates spaces and punctuation in the configured number', () => {
    expect(whatsappLink('+971 50 123 4567')).toContain('wa.me/971501234567')
  })

  it('returns null rather than a broken link when unconfigured or invalid', () => {
    // A dead "Message us" button is worse than no button: the visitor taps it,
    // nothing happens, and they do not come back to the form.
    expect(whatsappLink(undefined)).toBeNull()
    expect(whatsappLink('')).toBeNull()
    expect(whatsappLink('not a number')).toBeNull()
    expect(whatsappLink('123')).toBeNull()
  })
})

describe('optInPageHtml', () => {
  it('leads with the WhatsApp link when a number is configured', () => {
    // Preferred because a typed number is self-asserted: nothing stops someone
    // entering a number they do not own, and an unattended sender would then
    // message a stranger. A message from their own handset cannot be forged.
    const page = optInPageHtml('Alpha Realty', undefined, '+971501234567')
    expect(page).toContain('Message us on WhatsApp')
    expect(page).toContain('wa.me/971501234567')
    // The form stays available underneath.
    expect(page).toContain('<form method="POST">')
  })

  it('falls back to the form alone when no number is configured', () => {
    const page = optInPageHtml('Alpha Realty')
    expect(page).not.toContain('Message us on WhatsApp')
    expect(page).toContain('<form method="POST">')
  })

  it('escapes the business name', () => {
    const page = optInPageHtml('<script>alert(1)</script>')
    expect(page).not.toContain('<script>alert(1)</script>')
    expect(page).toContain('&lt;script&gt;')
  })

  it('escapes an error message', () => {
    const page = optInPageHtml('Alpha Realty', '<img onerror=alert(1)>')
    expect(page).not.toContain('<img onerror')
  })

  it('ships the consent box unchecked', () => {
    const page = optInPageHtml('Alpha Realty')
    expect(page).toMatch(/<input id="consent"[^>]*type="checkbox"/)
    expect(page).not.toMatch(/id="consent"[^>]*checked/)
  })

  it('tells people how to stop, on the page itself', () => {
    expect(optInPageHtml('Alpha Realty')).toContain('STOP')
  })
})
