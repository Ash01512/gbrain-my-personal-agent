import { describe, expect, it } from 'vitest'
import {
  ValidationError,
  assertUuid,
  parseApplication,
  parseCoverLetter,
  parseCvVersion,
} from '../src/schema'

describe('parseApplication', () => {
  it('accepts a minimal valid application', () => {
    expect(parseApplication({ company: 'Acme', role: 'Facilities Manager' })).toEqual({
      company: 'Acme',
      role: 'Facilities Manager',
    })
  })

  it('requires company and role on create', () => {
    expect(() => parseApplication({ company: 'Acme' })).toThrow(ValidationError)
    expect(() => parseApplication({ role: 'Manager' })).toThrow(/company is required/)
  })

  it('treats empty strings as missing', () => {
    expect(() => parseApplication({ company: '', role: 'Manager' })).toThrow(
      /company is required/,
    )
  })

  it('rejects a status outside the CHECK constraint', () => {
    expect(() => parseApplication({ company: 'A', role: 'B', status: 'ghosted' })).toThrow(
      /status must be one of/,
    )
  })

  it('accepts every status the database allows', () => {
    for (const status of ['saved', 'applied', 'screening', 'interview', 'offer', 'rejected', 'withdrawn']) {
      expect(parseApplication({ company: 'A', role: 'B', status }).status).toBe(status)
    }
  })

  it('enforces YYYY-MM-DD on date columns', () => {
    expect(() => parseApplication({ company: 'A', role: 'B', applied_on: '17-08-2026' })).toThrow(
      /applied_on must be a YYYY-MM-DD date/,
    )
    expect(parseApplication({ company: 'A', role: 'B', applied_on: '2026-08-17' })).toMatchObject({
      applied_on: '2026-08-17',
    })
  })

  it('drops unknown columns instead of failing the write', () => {
    const parsed = parseApplication({ company: 'A', role: 'B', nope: 'x' })
    expect(parsed).not.toHaveProperty('nope')
  })

  it('allows nulling an optional column but not a required one', () => {
    expect(parseApplication({ company: 'A', role: 'B', notes: null })).toMatchObject({
      notes: null,
    })
    expect(() => parseApplication({ company: null, role: 'B' })).toThrow()
  })

  it('does not require fields in partial mode, but needs at least one', () => {
    expect(parseApplication({ status: 'offer' }, true)).toEqual({ status: 'offer' })
    expect(() => parseApplication({}, true)).toThrow(/no updatable fields/)
  })

  it('rejects non-object bodies', () => {
    expect(() => parseApplication('nope')).toThrow(/must be a JSON object/)
    expect(() => parseApplication([])).toThrow(/must be a JSON object/)
    expect(() => parseApplication(null)).toThrow(/must be a JSON object/)
  })
})

describe('parseCvVersion', () => {
  it('requires a label', () => {
    expect(() => parseCvVersion({ content: 'text' })).toThrow(/label is required/)
  })

  it('type-checks is_default', () => {
    expect(() => parseCvVersion({ label: 'v1', is_default: 'yes' })).toThrow(
      /is_default must be a boolean/,
    )
    expect(parseCvVersion({ label: 'v1', is_default: true })).toMatchObject({ is_default: true })
  })
})

describe('parseCoverLetter', () => {
  it('has no required columns', () => {
    expect(parseCoverLetter({ content: 'Dear team' })).toEqual({ content: 'Dear team' })
  })

  it('constrains status to the CHECK values', () => {
    expect(() => parseCoverLetter({ status: 'posted' })).toThrow(/status must be one of/)
    expect(parseCoverLetter({ status: 'sent' })).toMatchObject({ status: 'sent' })
  })
})

describe('assertUuid', () => {
  it('accepts a uuid and rejects anything else', () => {
    const id = '4f2a1b3c-1111-4222-8333-abcdefabcdef'
    expect(assertUuid(id)).toBe(id)
    expect(() => assertUuid('123')).toThrow(/must be a UUID/)
    // Guards against a PostgREST filter-injection attempt via the path.
    expect(() => assertUuid('eq.any')).toThrow(/must be a UUID/)
  })
})
