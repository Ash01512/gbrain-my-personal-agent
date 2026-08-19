import { describe, expect, it } from 'vitest'
import { listOptionsFromSearch, matchRoute, tallyDaily } from '../src/router'
import { ValidationError, parseApplication, parseQueueItem } from '../src/schema'

describe('parseQueueItem', () => {
  const valid = {
    company: 'Emirates Group',
    role: 'Asset Data Lead',
    job_url: 'https://example.com/job/1',
    match_score: 8.5,
    match_rationale: 'CMMS data plus 12 years facilities',
  }

  it('accepts a fully specified candidate', () => {
    expect(parseQueueItem(valid)).toMatchObject({ match_score: 8.5 })
  })

  it('requires the fields that make a candidate reviewable', () => {
    for (const field of ['company', 'role', 'job_url', 'match_score', 'match_rationale']) {
      const { [field]: _dropped, ...rest } = valid as Record<string, unknown>
      expect(() => parseQueueItem(rest)).toThrow(new RegExp(`${field} is required`))
    }
  })

  it('accepts a zero score, which is a real score and not a missing one', () => {
    expect(parseQueueItem({ ...valid, match_score: 0 }).match_score).toBe(0)
  })

  it('rejects scores outside 0-10 and non-numbers', () => {
    expect(() => parseQueueItem({ ...valid, match_score: 11 })).toThrow(/between 0 and 10/)
    expect(() => parseQueueItem({ ...valid, match_score: -1 })).toThrow(/between 0 and 10/)
    expect(() => parseQueueItem({ ...valid, match_score: '8' })).toThrow(/must be a number/)
    expect(() => parseQueueItem({ ...valid, match_score: NaN })).toThrow(/must be a number/)
  })

  it('forces status to saved and strips applied_on', () => {
    // The agent must never be able to claim something was applied to.
    const parsed = parseQueueItem({ ...valid, status: 'applied', applied_on: '2026-08-19' })
    expect(parsed.status).toBe('saved')
    expect(parsed).not.toHaveProperty('applied_on')
  })

  it('is stricter than a manual create', () => {
    expect(() => parseQueueItem({ company: 'A', role: 'B' })).toThrow(ValidationError)
    expect(parseApplication({ company: 'A', role: 'B' })).toBeTruthy()
  })
})

describe('queue routing', () => {
  it('routes the agent intake endpoint', () => {
    expect(matchRoute('POST', '/api/queue')).toEqual({
      name: 'queue',
      table: 'applications',
    })
    expect(matchRoute('GET', '/api/queue')).toBe('method-not-allowed')
  })

  it('routes the apply action', () => {
    expect(matchRoute('POST', '/api/applications/abc/apply')).toEqual({
      name: 'apply',
      table: 'applications',
      id: 'abc',
    })
    expect(matchRoute('GET', '/api/applications/abc/apply')).toBe('method-not-allowed')
  })

  it('does not expose apply on other collections or unknown actions', () => {
    expect(matchRoute('POST', '/api/cv-versions/abc/apply')).toBeNull()
    expect(matchRoute('POST', '/api/applications/abc/nope')).toBeNull()
  })

  it('routes daily stats', () => {
    expect(matchRoute('GET', '/api/stats/daily')).toEqual({ name: 'daily' })
    expect(matchRoute('DELETE', '/api/stats/daily')).toBe('method-not-allowed')
  })
})

describe('queue list options', () => {
  const opts = (qs: string) => listOptionsFromSearch(new URLSearchParams(qs))

  it('shows unsent roles, best fit first', () => {
    const o = opts('queue=true')
    expect(o.filters.status).toBe('eq.saved')
    expect(o.order).toBe('match_score.desc.nullslast,created_at.desc')
  })

  it('lets an explicit status filter override queue mode', () => {
    expect(opts('queue=true&status=applied').filters.status).toBe('eq.applied')
  })

  it('leaves ordering alone when queue mode is off', () => {
    expect(opts('').order).toBe('created_at.desc')
  })
})

describe('tallyDaily', () => {
  const rows = [
    { applied_on: '2026-08-19' },
    { applied_on: '2026-08-19' },
    { applied_on: '2026-08-17' },
    { applied_on: null },
  ]

  it('counts per day, newest first', () => {
    const series = tallyDaily(rows, '2026-08-19', 3)
    expect(series).toEqual([
      { date: '2026-08-19', count: 2 },
      { date: '2026-08-18', count: 0 },
      { date: '2026-08-17', count: 1 },
    ])
  })

  it('reports a quiet day as zero rather than omitting it', () => {
    expect(tallyDaily([], '2026-08-19', 2)).toEqual([
      { date: '2026-08-19', count: 0 },
      { date: '2026-08-18', count: 0 },
    ])
  })

  it('ignores rows that were never applied to', () => {
    expect(tallyDaily([{ applied_on: null }], '2026-08-19', 1)[0]!.count).toBe(0)
  })

  it('crosses a month boundary correctly', () => {
    const series = tallyDaily([{ applied_on: '2026-07-31' }], '2026-08-01', 2)
    expect(series).toEqual([
      { date: '2026-08-01', count: 0 },
      { date: '2026-07-31', count: 1 },
    ])
  })
})
