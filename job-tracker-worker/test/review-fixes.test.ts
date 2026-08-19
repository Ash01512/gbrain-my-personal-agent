// Regression tests for the findings from the code review of 94b4007.
// Each block names the defect it locks down.

import { describe, expect, it } from 'vitest'
import { localDate } from '../src/index'
import { listOptionsFromSearch } from '../src/router'

describe('localDate — applications filed under the wrong day (UTC-only clock)', () => {
  // 20:30 UTC on the 19th is already 00:30 on the 20th in Dubai.
  const lateEvening = new Date('2026-08-19T20:30:00Z')

  it('uses the configured zone, not UTC', () => {
    expect(localDate('Asia/Dubai', lateEvening)).toBe('2026-08-20')
    expect(localDate('UTC', lateEvening)).toBe('2026-08-19')
  })

  it('defaults to UTC when unset', () => {
    expect(localDate(undefined, lateEvening)).toBe('2026-08-19')
    expect(localDate('', lateEvening)).toBe('2026-08-19')
  })

  it('falls back to UTC on a bad zone instead of throwing', () => {
    expect(localDate('Not/AZone', lateEvening)).toBe('2026-08-19')
  })

  it('emits the YYYY-MM-DD shape Postgres date columns expect', () => {
    expect(localDate('America/New_York', lateEvening)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('handles a zone behind UTC crossing back a day', () => {
    expect(localDate('America/Los_Angeles', new Date('2026-08-19T05:00:00Z'))).toBe(
      '2026-08-18',
    )
  })
})

describe('queue filters must not leak onto collections without those columns', () => {
  const opts = (qs: string, table?: 'applications' | 'cv_versions' | 'cover_letters') =>
    listOptionsFromSearch(new URLSearchParams(qs), table)

  it('ignores queue mode for cv_versions and cover_letters', () => {
    for (const table of ['cv_versions', 'cover_letters'] as const) {
      const o = opts('queue=true', table)
      expect(o.filters.status).toBeUndefined()
      expect(o.order).toBe('created_at.desc')
    }
  })

  it('ignores company and q, which only exist on applications', () => {
    const o = opts('company=acme&q=eng', 'cover_letters')
    expect(o.filters.company).toBeUndefined()
    expect(o.filters.or).toBeUndefined()
  })

  it('honours status on cover_letters, which has the column', () => {
    expect(opts('status=draft', 'cover_letters').filters.status).toBe('eq.draft')
  })

  it('drops status on cv_versions, which does not have the column', () => {
    // The old gate let this through and surfaced a raw PostgREST 400.
    expect(opts('status=draft', 'cv_versions').filters.status).toBeUndefined()
  })

  it('keeps every filter for applications', () => {
    const o = opts('queue=true&company=acme&q=eng', 'applications')
    expect(o.filters.status).toBe('eq.saved')
    expect(o.filters.company).toBe('ilike.*acme*')
    expect(o.filters.or).toBe('(company.ilike."*eng*",role.ilike."*eng*")')
  })

  it('defaults to applications when the table is omitted', () => {
    expect(listOptionsFromSearch(new URLSearchParams('queue=true')).filters.status).toBe(
      'eq.saved',
    )
  })
})

describe('free-text search must survive punctuation in a company name', () => {
  const or = (q: string) =>
    listOptionsFromSearch(new URLSearchParams(`q=${encodeURIComponent(q)}`)).filters.or

  it('keeps a comma inside one quoted term instead of splitting the logic tree', () => {
    // Unquoted, PostgREST read this as four terms and 400d on the two halves.
    expect(or('Smith, Jones')).toBe(
      '(company.ilike."*Smith, Jones*",role.ilike."*Smith, Jones*")',
    )
  })

  it('escapes quotes and backslashes so the value cannot end early', () => {
    expect(or('a"b')).toBe('(company.ilike."*a\\"b*",role.ilike."*a\\"b*")')
    expect(or('a\\b')).toBe('(company.ilike."*a\\\\b*",role.ilike."*a\\\\b*")')
  })

  it('cannot inject an extra term through parentheses', () => {
    const built = or('x*,role.ilike.*')
    expect(built).toBe('(company.ilike."*x*,role.ilike.**",role.ilike."*x*,role.ilike.**")')
    // Two terms, not four: every comma the caller supplied is inside quotes.
    expect(built!.split('",').length).toBe(2)
  })
})
