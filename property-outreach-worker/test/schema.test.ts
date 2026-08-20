import { describe, expect, it } from 'vitest'
import {
  isSafeUrl,
  parseConsent,
  parseContact,
  parseDraft,
  parseTemplate,
  ValidationError,
} from '../src/schema'

describe('parseContact', () => {
  it('requires E.164 and says why a local number will not do', () => {
    expect(() => parseContact({ phone_e164: '0501234567' })).toThrow(/E\.164/)
    try {
      parseContact({ phone_e164: '0501234567' })
    } catch (error) {
      expect((error as Error).message).toContain('undeliverable')
    }
  })

  it('accepts a well-formed contact', () => {
    const values = parseContact({
      phone_e164: '+971501234567',
      full_name: 'Sara',
      contact_type: 'owner',
      source: 'Alpha Realty sheet, Aug 2026',
    })
    expect(values.phone_e164).toBe('+971501234567')
    expect(values.contact_type).toBe('owner')
  })

  it('refuses to let an import set consent directly', () => {
    // The single most important line in this file. If opt_in_state were
    // writable here, a spreadsheet import could mark a cold list as consenting
    // and the gate would wave it straight through.
    const values = parseContact({
      phone_e164: '+971501234567',
      opt_in_state: 'opted_in',
      opted_in_at: '2026-01-01T00:00:00Z',
    })
    expect(values).not.toHaveProperty('opt_in_state')
    expect(values).not.toHaveProperty('opted_in_at')
  })

  it('rejects an unknown contact_type', () => {
    expect(() => parseContact({ phone_e164: '+971501234567', contact_type: 'vendor' }))
      .toThrow(ValidationError)
  })
})

describe('parseConsent', () => {
  it('requires evidence for an opt-in', () => {
    expect(() => parseConsent({ event: 'opt_in', method: 'website_form' }))
      .toThrow(/evidence/)
  })

  it('accepts an opt-in with a note', () => {
    const values = parseConsent({
      event: 'opt_in',
      method: 'website_form',
      evidence_note: 'valuation form, 2026-08-14, IP logged',
    })
    expect(values.event).toBe('opt_in')
    expect(values.channel).toBe('whatsapp')
  })

  it('does not require evidence when they messaged first', () => {
    // Their own inbound message IS the evidence.
    expect(() => parseConsent({ event: 'opt_in', method: 'inbound_message' })).not.toThrow()
  })

  it('never blocks recording an opt-out on a paperwork rule', () => {
    // When someone says stop, that must always be recordable.
    expect(() => parseConsent({ event: 'opt_out', method: 'user_request' })).not.toThrow()
  })

  it('rejects a javascript: evidence URL', () => {
    expect(() => parseConsent({
      event: 'opt_in',
      method: 'website_form',
      evidence_url: 'javascript:alert(document.cookie)',
    })).toThrow(/http or https/)
  })
})

describe('parseDraft', () => {
  it('will not let the drafting agent set its own status', () => {
    // An agent that could write status:'approved' would skip the human, which
    // is the one thing the queue exists to prevent.
    const values = parseDraft({
      contact_id: '00000000-0000-4000-8000-000000000000',
      rendered_body: 'Hello',
      status: 'approved',
      block_reasons: [],
      approved_by: 'agent',
    })
    expect(values).not.toHaveProperty('status')
    expect(values).not.toHaveProperty('block_reasons')
    expect(values).not.toHaveProperty('approved_by')
  })

  it('requires a contact and a body', () => {
    expect(() => parseDraft({ rendered_body: 'Hi' })).toThrow(/contact_id is required/)
    expect(() => parseDraft({ contact_id: 'x' })).toThrow(/rendered_body is required/)
  })
})

describe('parseTemplate', () => {
  it('rejects a meta_status outside the known set', () => {
    expect(() => parseTemplate({ name: 'x', body: 'y', meta_status: 'live' }))
      .toThrow(ValidationError)
  })

  it('requires variables to be strings', () => {
    expect(() => parseTemplate({ name: 'x', body: 'y', variables: [1, 2] }))
      .toThrow(/array of strings/)
  })
})

describe('isSafeUrl', () => {
  it('allows http and https only', () => {
    expect(isSafeUrl('https://example.com')).toBe(true)
    expect(isSafeUrl('http://example.com')).toBe(true)
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeUrl('data:text/html,<script>')).toBe(false)
    expect(isSafeUrl('not a url')).toBe(false)
  })
})
