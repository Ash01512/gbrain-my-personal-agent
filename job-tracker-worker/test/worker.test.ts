// Integration tests for the fetch handler.
//
// The rest of the suite covers pure helpers. This file drives the default
// export with a stubbed `fetch`, because everything that actually composes —
// the auth gate running before Supabase is touched, the error mapping, and the
// applied_on rules the daily count depends on — lives only in that wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { type Env } from '../src/index'
import { APPLICATION_STATUSES } from '../src/schema'

const env: Env = {
  SUPABASE_URL: 'https://ref.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  API_TOKEN: 'test-token',
  APP_TIMEZONE: 'UTC',
}

const ID = '4f2a1b3c-1111-4222-8333-abcdefabcdef'
const auth = { authorization: `Bearer ${env.API_TOKEN}` }
const jsonAuth = { ...auth, 'content-type': 'application/json' }

/** Stubs Supabase: `rows` answers reads, `patched` answers PATCH/POST/DELETE. */
function stubDb(rows: unknown[], patched: unknown[] = rows) {
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = method === 'GET' ? rows : patched
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

const calls = (spy: ReturnType<typeof stubDb>, method: string) =>
  spy.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method)

const sentBody = (spy: ReturnType<typeof stubDb>, method: string) =>
  JSON.parse(calls(spy, method)[0]![1]!.body as string)

const get = (path: string, headers: Record<string, string> = auth) =>
  worker.fetch(new Request(`https://w${path}`, { headers }), env)

const send = (method: string, path: string, body?: unknown, e: Env = env) =>
  worker.fetch(
    new Request(`https://w${path}`, {
      method,
      headers: jsonAuth,
      body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined,
    }),
    e,
  )

beforeEach(() => stubDb([]))
afterEach(() => vi.unstubAllGlobals())

describe('the public surface stays public and everything else stays shut', () => {
  it('answers a CORS preflight without a token', async () => {
    const res = await worker.fetch(
      new Request('https://w/api/applications', { method: 'OPTIONS' }),
      env,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('serves the dashboard and health unauthenticated', async () => {
    const ui = await worker.fetch(new Request('https://w/'), env)
    expect(ui.status).toBe(200)
    expect(ui.headers.get('content-type')).toMatch(/text\/html/)

    const health = await worker.fetch(new Request('https://w/api/health'), env)
    expect(health.status).toBe(200)
    expect(await health.json() as any).toEqual({
      ok: true,
      configured: { supabase_url: true, service_role_key: true, api_token: true },
    })
  })

  it('is never cached, so a fixed configuration is not reported as broken', async () => {
    // A cached 503 tells you the secrets are still missing after you have set
    // them, with nothing to indicate you are reading a stale answer.
    for (const path of ['/api/health', '/api/applications', '/api/stats/daily']) {
      const res = await get(path)
      expect(res.headers.get('cache-control'), `${path} is cacheable`).toBe('no-store')
    }
  })

  it('reports an unconfigured Worker as unhealthy rather than ok', async () => {
    // ok:true on a Worker that cannot reach anything is the exact failure the
    // endpoint exists to catch.
    const res = await worker.fetch(new Request('https://w/api/health'), {
      ...env,
      API_TOKEN: '',
    })
    expect(res.status).toBe(503)
    expect((await res.json() as any).ok).toBe(false)
  })

  it('401s every data route without a valid token, before touching supabase', async () => {
    const spy = stubDb([])
    const wrong: Record<string, string>[] = [{}, { authorization: 'Bearer wrong' }, { authorization: 'x' }]
    for (const headers of wrong) {
      const res = await get('/api/applications', headers)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toMatch(/Bearer/)
    }
    // The service-role key must never leave the Worker on an unauthorised call.
    expect(spy).not.toHaveBeenCalled()
  })

  it('accepts the X-API-Token header as well as Bearer', async () => {
    expect((await get('/api/applications', { 'x-api-token': env.API_TOKEN })).status).toBe(200)
  })

  it('separates an unknown path from an unsupported verb', async () => {
    expect((await get('/api/nope')).status).toBe(404)
    expect((await send('POST', '/api/health')).status).toBe(405)
  })

  it('refuses to talk to supabase when a secret is missing, and says which', async () => {
    const res = await send('GET', '/api/applications', undefined, {
      ...env,
      SUPABASE_URL: '',
    })
    expect(res.status).toBe(503)
    expect((await res.json() as any).error).toMatch(/SUPABASE_URL/)
  })
})

describe('error mapping', () => {
  it('maps malformed JSON to a 400, not a 500', async () => {
    const res = await send('POST', '/api/applications', 'not json')
    expect(res.status).toBe(400)
    expect(await res.json() as any).toEqual({ error: 'body must be valid JSON' })
  })

  it('maps a validation failure to a 400 naming the field', async () => {
    const res = await send('POST', '/api/applications', { company: 'A' })
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toMatch(/role is required/)
  })

  it('propagates a unique violation as a 409 end to end', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: '23505' }), { status: 400 })),
    )
    const res = await send('POST', '/api/queue', {
      company: 'A',
      role: 'B',
      job_url: 'https://jobs.example/1',
      match_score: 7,
      match_rationale: 'fits',
    })
    expect(res.status).toBe(409)
  })

  it('never leaks internals on an unrecognised failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new RangeError('service-key leaked in a stack')
      }),
    )
    const res = await get('/api/applications')
    expect(res.status).toBe(502)
    expect(await res.text()).not.toMatch(/service-key/)
  })
})

describe('the apply endpoint is the only thing that may record a send', () => {
  const apply = () =>
    worker.fetch(
      new Request(`https://w/api/applications/${ID}/apply`, { method: 'POST', headers: auth }),
      env,
    )

  it('404s a row that does not exist', async () => {
    stubDb([])
    expect((await apply()).status).toBe(404)
  })

  it('409s a row that was already applied to, and echoes the date', async () => {
    stubDb([{ id: ID, status: 'applied', applied_on: '2026-08-01' }])
    const res = await apply()
    expect(res.status).toBe(409)
    expect(await res.json() as any).toMatchObject({
      error: 'already applied',
      applied_on: '2026-08-01',
    })
  })

  it('stamps today and returns the apply link', async () => {
    const spy = stubDb(
      [{ id: ID, status: 'saved', applied_on: null, job_url: 'https://jobs.example/1' }],
      [{ id: ID, status: 'applied' }],
    )
    const res = await apply()
    expect(await res.json() as any).toMatchObject({ apply_url: 'https://jobs.example/1' })
    expect(sentBody(spy, 'PATCH').applied_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('does not shuffle an existing date onto today', async () => {
    const spy = stubDb(
      [{ id: ID, status: 'saved', applied_on: '2026-07-01' }],
      [{ id: ID, status: 'applied' }],
    )
    await apply()
    expect(sentBody(spy, 'PATCH').applied_on).toBe('2026-07-01')
  })

  it('does not claim success when the write matched nothing', async () => {
    // The row was deleted between the read and the write. A 200 here would
    // tell the user an application was recorded that never was.
    stubDb([{ id: ID, status: 'saved', applied_on: null }], [])
    expect((await apply()).status).toBe(404)
  })
})

describe('status and applied_on move together', () => {
  const patch = (body: unknown, path = `/api/applications/${ID}`) => send('PATCH', path, body)

  it('stamps the date when the dropdown moves a row to applied', async () => {
    const spy = stubDb([{ id: ID, status: 'saved', applied_on: null }], [{ id: ID }])
    await patch({ status: 'applied' })
    expect(sentBody(spy, 'PATCH').applied_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('keeps a date that is already there', async () => {
    const spy = stubDb([{ id: ID, status: 'screening', applied_on: '2026-07-01' }], [{ id: ID }])
    await patch({ status: 'applied' })
    expect(sentBody(spy, 'PATCH').applied_on).toBe('2026-07-01')
  })

  it('refuses to write an applied row with no date', async () => {
    // An explicit null survives validation, so gating on `undefined` let a
    // caller create a row that counts as applied but is invisible to the
    // daily rollup — and un-stamp a row a past day already counted.
    const spy = stubDb([{ id: ID, status: 'saved', applied_on: null }], [{ id: ID }])
    await patch({ status: 'applied', applied_on: null })
    expect(sentBody(spy, 'PATCH').applied_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('clears the date when a row goes back to saved', async () => {
    // Otherwise the day it was recorded stays inflated forever, and a later
    // genuine application inherits the stale date instead of today.
    const spy = stubDb([{ id: ID, status: 'applied', applied_on: '2026-07-01' }], [{ id: ID }])
    await patch({ status: 'saved' })
    expect(sentBody(spy, 'PATCH').applied_on).toBeNull()
  })

  it('keeps the date through every stage that comes after applying', async () => {
    for (const status of ['screening', 'interview', 'offer', 'rejected', 'withdrawn']) {
      const spy = stubDb([{ id: ID, status: 'applied', applied_on: '2026-07-01' }], [{ id: ID }])
      await patch({ status })
      expect(sentBody(spy, 'PATCH')).not.toHaveProperty('applied_on')
      vi.unstubAllGlobals()
    }
  })

  it('honours a date the caller supplied deliberately', async () => {
    const spy = stubDb([{ id: ID, status: 'saved', applied_on: null }], [{ id: ID }])
    await patch({ status: 'applied', applied_on: '2026-01-02' })
    expect(sentBody(spy, 'PATCH').applied_on).toBe('2026-01-02')
  })

  it('never puts applied_on on a table that has no such column', async () => {
    const spy = stubDb([{ id: ID }], [{ id: ID }])
    await patch({ label: 'v2' }, `/api/cv-versions/${ID}`)
    expect(sentBody(spy, 'PATCH')).not.toHaveProperty('applied_on')
  })

  it('will not let the queue endpoint claim an application', async () => {
    const spy = stubDb([], [{ id: ID }])
    await send('POST', '/api/queue', {
      company: 'A',
      role: 'B',
      job_url: 'https://jobs.example/1',
      match_score: 9,
      match_rationale: 'fits',
      status: 'applied',
      applied_on: '2026-01-01',
    })
    const body = sentBody(spy, 'POST')
    expect(body.status).toBe('saved')
    expect(body).not.toHaveProperty('applied_on')
  })
})

describe('the counts say what they mean', () => {
  it('returns every status at zero for an empty table', async () => {
    const body = await (await get('/api/stats')).json() as any
    expect(body.total).toBe(0)
    expect(body.truncated).toBe(false)
    expect(Object.keys(body.by_status).sort()).toEqual([...APPLICATION_STATUSES].sort())
  })

  it('is not corrupted by a status outside the enum', async () => {
    // `in` on a normal object matches inherited keys, so a row with status
    // "toString" incremented a function and produced NaN in the response.
    stubDb([{ status: 'toString' }, { status: 'ghosted' }, { status: 'saved' }])
    const body = await (await get('/api/stats')).json() as any
    expect(body.total).toBe(3)
    expect(body.by_status.saved).toBe(1)
    expect(Object.values(body.by_status).every((v) => Number.isFinite(v))).toBe(true)
  })

  it('flags a capped tally instead of passing it off as a total', async () => {
    stubDb(Array.from({ length: 1000 }, () => ({ status: 'saved' })))
    expect((await (await get('/api/stats')).json() as any).truncated).toBe(true)
    stubDb(Array.from({ length: 999 }, () => ({ status: 'saved' })))
    expect((await (await get('/api/stats')).json() as any).truncated).toBe(false)
  })

  it('asks supabase only for dated rows up to today, newest first', async () => {
    const spy = stubDb([])
    await get('/api/stats/daily')
    const url = new URL(spy.mock.calls[0]![0] as string)
    // A future date would consume the cap from the front and push real recent
    // days out of the window.
    expect(url.searchParams.get('applied_on')).toMatch(/^lte\.\d{4}-\d{2}-\d{2}$/)
    expect(url.searchParams.get('order')).toBe('applied_on.desc')
    expect(url.searchParams.get('limit')).toBe('1000')
  })

  it('reports an empty history as zeroes across a full fortnight', async () => {
    const body = await (await get('/api/stats/daily')).json() as any
    expect(body).toMatchObject({ today: 0, total: 0, truncated: false })
    expect(body.days).toHaveLength(14)
  })

  it('counts today from the configured zone, not UTC', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-19T20:30:00Z'))
    stubDb([{ applied_on: '2026-08-20' }])
    const res = await worker.fetch(
      new Request('https://w/api/stats/daily', { headers: auth }),
      { ...env, APP_TIMEZONE: 'Asia/Dubai' },
    )
    // 20:30 UTC is already the 20th in Dubai, so this is today's application.
    expect((await res.json() as any).today).toBe(1)
    vi.useRealTimers()
  })
})

describe('list responses keep the shape the dashboard expects', () => {
  it('returns data and count, never null', async () => {
    expect(await (await get('/api/applications')).json() as any).toEqual({ data: [], count: 0 })
  })

  it('does not send applications-only filters to another table', async () => {
    const spy = stubDb([])
    await get('/api/cv-versions?queue=true&company=acme&q=eng&status=draft')
    const url = new URL(spy.mock.calls[0]![0] as string)
    for (const param of ['status', 'company', 'or']) {
      expect(url.searchParams.get(param)).toBeNull()
    }
  })

  it('404s a get and a delete that match nothing', async () => {
    expect((await get(`/api/applications/${ID}`)).status).toBe(404)
    expect((await send('DELETE', `/api/applications/${ID}`)).status).toBe(404)
  })

  it('rejects a non-UUID id before it reaches a filter expression', async () => {
    const res = await get('/api/applications/not-a-uuid')
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toMatch(/UUID/)
  })

  it('returns 201 on create and on queue intake', async () => {
    stubDb([], [{ id: ID }])
    expect((await send('POST', '/api/applications', { company: 'A', role: 'B' })).status).toBe(
      201,
    )
    expect(
      (
        await send('POST', '/api/queue', {
          company: 'A',
          role: 'B',
          job_url: 'https://jobs.example/1',
          match_score: 7,
          match_rationale: 'fits',
        })
      ).status,
    ).toBe(201)
  })
})
