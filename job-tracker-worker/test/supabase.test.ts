import { afterEach, describe, expect, it, vi } from 'vitest'
import { Supabase, SupabaseError, buildQuery } from '../src/supabase'
import { isAuthorized, safeEqual } from '../src/auth'

const URL_BASE = 'https://ref.supabase.co'
const KEY = 'service-key'

function mockFetch(status: number, body: unknown) {
  // Args are declared so `spy.mock.calls` stays typed as [url, init].
  const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(body === null ? '' : JSON.stringify(body), { status }),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => vi.unstubAllGlobals())

describe('buildQuery', () => {
  it('always selects and passes filters through', () => {
    expect(buildQuery()).toBe('select=*')
    const q = new URLSearchParams(buildQuery({ filters: { id: 'eq.7' }, limit: 10 }))
    expect(q.get('id')).toBe('eq.7')
    expect(q.get('limit')).toBe('10')
  })
})

describe('a token that picked up whitespace still works', () => {
  // Pasting a secret into a dashboard form very easily appends a newline. The
  // token then looks identical to the one you copied and never matches, and
  // the only symptom is "unauthorized" with nothing to explain it.
  const headers = (token: string) => new Headers({ authorization: `Bearer ${token}` })
  const TOKEN = 'a'.repeat(64)

  it('tolerates whitespace around the stored secret', () => {
    expect(isAuthorized(headers(TOKEN), `${TOKEN}\n`)).toBe(true)
    expect(isAuthorized(headers(TOKEN), ` ${TOKEN} `)).toBe(true)
    expect(isAuthorized(headers(TOKEN), `${TOKEN}\r\n`)).toBe(true)
  })

  it('tolerates whitespace around the presented token', () => {
    expect(isAuthorized(new Headers({ 'x-api-token': ` ${TOKEN} ` }), TOKEN)).toBe(true)
  })

  it('still rejects a genuinely different token', () => {
    expect(isAuthorized(headers('b'.repeat(64)), TOKEN)).toBe(false)
    expect(isAuthorized(headers(TOKEN.slice(0, 63)), TOKEN)).toBe(false)
    expect(isAuthorized(headers(''), TOKEN)).toBe(false)
  })
})

describe('Supabase', () => {
  it('refuses to construct without configuration', () => {
    expect(() => new Supabase('', KEY)).toThrow(/SUPABASE_URL/)
    expect(() => new Supabase(URL_BASE, '')).toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('sends the service key on both required headers', async () => {
    const spy = mockFetch(200, [])
    await new Supabase(URL_BASE, KEY).list('applications')
    const [url, init] = spy.mock.calls[0]!
    expect(url).toBe(`${URL_BASE}/rest/v1/applications?select=*`)
    const headers = init!.headers as Record<string, string>
    expect(headers.apikey).toBe(KEY)
    expect(headers.Authorization).toBe(`Bearer ${KEY}`)
  })

  it('strips a trailing slash from the configured URL', async () => {
    const spy = mockFetch(200, [])
    await new Supabase(`${URL_BASE}/`, KEY).list('applications')
    expect(spy.mock.calls[0]![0]).toBe(
      `${URL_BASE}/rest/v1/applications?select=*`,
    )
  })

  it('maps a unique violation to 409', async () => {
    mockFetch(400, { code: '23505', message: 'duplicate key value' })
    await expect(new Supabase(URL_BASE, KEY).insert('applications', {})).rejects.toMatchObject({
      status: 409,
      code: '23505',
    })
  })

  it('maps a foreign key violation to 400', async () => {
    mockFetch(400, { code: '23503', message: 'fk violation' })
    await expect(new Supabase(URL_BASE, KEY).insert('cover_letters', {})).rejects.toMatchObject({
      status: 400,
    })
  })

  it('reports upstream 5xx as 502 rather than leaking it as our own 500', async () => {
    mockFetch(503, { message: 'upstream down' })
    await expect(new Supabase(URL_BASE, KEY).list('applications')).rejects.toMatchObject({
      status: 502,
    })
  })

  it('maps an unreachable upstream to 502, not a raw TypeError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    await expect(new Supabase(URL_BASE, KEY).list('applications')).rejects.toMatchObject({
      status: 502,
      message: 'could not reach supabase',
    })
  })

  it('survives a non-JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })))
    await expect(new Supabase(URL_BASE, KEY).list('applications')).rejects.toBeInstanceOf(
      SupabaseError,
    )
  })

  it('returns null when an id matches nothing', async () => {
    mockFetch(200, [])
    expect(await new Supabase(URL_BASE, KEY).getById('applications', 'x')).toBeNull()
  })

  it('reports whether a delete removed anything', async () => {
    mockFetch(200, [{ id: 'x' }])
    expect(await new Supabase(URL_BASE, KEY).remove('applications', 'x')).toBe(true)
    mockFetch(200, [])
    expect(await new Supabase(URL_BASE, KEY).remove('applications', 'x')).toBe(false)
  })

  it('stamps updated_at on every patch', async () => {
    const spy = mockFetch(200, [{ id: 'x' }])
    await new Supabase(URL_BASE, KEY).update('applications', 'x', { status: 'offer' })
    const body = JSON.parse(spy.mock.calls[0]![1]!.body as string)
    expect(body.status).toBe('offer')
    expect(body.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('auth', () => {
  it('compares equal-length strings correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })

  it('accepts either header form', () => {
    expect(isAuthorized(new Headers({ authorization: 'Bearer t0k' }), 't0k')).toBe(true)
    expect(isAuthorized(new Headers({ 'x-api-token': 't0k' }), 't0k')).toBe(true)
    expect(isAuthorized(new Headers({ authorization: 'bearer t0k' }), 't0k')).toBe(true)
  })

  it('fails closed when the token is unset or wrong', () => {
    expect(isAuthorized(new Headers({ authorization: 'Bearer t0k' }), undefined)).toBe(false)
    expect(isAuthorized(new Headers({ authorization: 'Bearer t0k' }), '')).toBe(false)
    expect(isAuthorized(new Headers(), 't0k')).toBe(false)
    expect(isAuthorized(new Headers({ authorization: 'Bearer nope' }), 't0k')).toBe(false)
  })
})
