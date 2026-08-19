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
  const opts = (qs: string, supportsQueue: boolean) =>
    listOptionsFromSearch(new URLSearchParams(qs), supportsQueue)

  it('ignores queue mode for cv_versions and cover_letters', () => {
    const o = opts('queue=true', false)
    expect(o.filters.status).toBeUndefined()
    expect(o.order).toBe('created_at.desc')
  })

  it('ignores company and q, which only exist on applications', () => {
    const o = opts('company=acme&q=eng', false)
    expect(o.filters.company).toBeUndefined()
    expect(o.filters.or).toBeUndefined()
  })

  it('still honours status, which cover_letters does have', () => {
    expect(opts('status=draft', false).filters.status).toBe('eq.draft')
  })

  it('keeps every filter for applications', () => {
    const o = opts('queue=true&company=acme&q=eng', true)
    expect(o.filters.status).toBe('eq.saved')
    expect(o.filters.company).toBe('ilike.*acme*')
    expect(o.filters.or).toBe('(company.ilike.*eng*,role.ilike.*eng*)')
  })

  it('defaults to full behaviour when the flag is omitted', () => {
    expect(listOptionsFromSearch(new URLSearchParams('queue=true')).filters.status).toBe(
      'eq.saved',
    )
  })
})
