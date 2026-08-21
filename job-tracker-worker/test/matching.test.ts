import { describe, expect, it } from 'vitest'
import { listOptionsFromSearch, matchRoute, tallyDaily } from '../src/router'
import {
  ValidationError,
  isSafeUrl,
  parseApplication,
  parseCvVersion,
  parseQueueItem,
} from '../src/schema'

const valid = {
  company: 'Emirates Group',
  role: 'Asset Data Lead',
  job_url: 'https://example.com/job/1',
  match_score: 8.5,
  match_rationale: 'CMMS data plus 12 years facilities',
}

describe('parseQueueItem', () => {

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
    // Exact shape, not toBeTruthy: `{}` would have passed that, and a parser
    // that dropped every column would send empty INSERTs to PostgREST.
    expect(parseApplication({ company: 'A', role: 'B' })).toEqual({ company: 'A', role: 'B' })
  })

  it('accepts a perfect score and rejects just past it', () => {
    // A 10 is the single most valuable candidate the agent can emit, so the
    // inclusive boundary is worth pinning.
    expect(parseQueueItem({ ...valid, match_score: 10 }).match_score).toBe(10)
    expect(() => parseQueueItem({ ...valid, match_score: 10.0001 })).toThrow(/between 0 and 10/)
    expect(parseQueueItem({ ...valid, match_score: 0 }).match_score).toBe(0)
  })
})

describe('stored URLs must be openable, not executable', () => {
  it('accepts http and https', () => {
    expect(isSafeUrl('https://jobs.example/1')).toBe(true)
    expect(isSafeUrl('http://jobs.example/1')).toBe(true)
  })

  it('rejects schemes that would run as script in the dashboard', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) {
      expect(isSafeUrl(hostile)).toBe(false)
    }
  })

  it('rejects anything that is not an absolute URL at all', () => {
    for (const bad of ['', 'jobs.example/1', '/relative', null, undefined, 7]) {
      expect(isSafeUrl(bad)).toBe(false)
    }
  })

  it('refuses the write rather than storing it and hoping the page copes', () => {
    expect(() => parseQueueItem({ ...valid, job_url: 'javascript:alert(1)' })).toThrow(
      /job_url must be an http or https URL/,
    )
    expect(() =>
      parseApplication({ company: 'A', role: 'B', job_url: 'javascript:alert(1)' }),
    ).toThrow(/job_url/)
    expect(() => parseCvVersion({ label: 'v1', file_url: 'javascript:alert(1)' })).toThrow(
      /file_url/,
    )
  })

  it('still allows clearing the field', () => {
    expect(parseApplication({ job_url: null }, true)).toEqual({ job_url: null })
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

describe('the agent files each role under its search profile', () => {
  const queued = (extra: Record<string, unknown>) =>
    parseQueueItem({
      company: 'Acme',
      role: 'AI Governance Lead',
      job_url: 'https://example.com/j/1',
      match_score: 9,
      match_rationale: '4 domain; 2 seniority; 2 remote-global; 0.5 comp; 1 employer-posted',
      ...extra,
    })

  it('accepts both tracks', () => {
    expect(queued({ track: 'ai' }).track).toBe('ai')
    expect(queued({ track: 'facilities' }).track).toBe('facilities')
  })

  it('rejects a track nobody can filter for', () => {
    // The CHECK in 0003 would reject it anyway, but as an opaque PostgREST 400.
    // Failing here names the field and the allowed values.
    expect(() => queued({ track: 'ai-ops' })).toThrow(/track must be one of/)
  })

  it('leaves the track unset rather than guessing', () => {
    // A manual entry has no search profile behind it, and inventing one would
    // put a role in a queue the human never chose for it.
    expect(queued({}).track).toBeUndefined()
  })
})
