// Minimal PostgREST client.
//
// Deliberately not @supabase/supabase-js: this Worker only needs CRUD over
// three tables, and hand-rolling it keeps the bundle small, avoids Node
// polyfill surprises on Workers, and makes URL building unit-testable
// without a network or a mocked SDK.

export class SupabaseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'SupabaseError'
  }
}

export interface ListOptions {
  select?: string
  order?: string
  limit?: number
  offset?: number
  /** Column filters, e.g. { status: 'eq.applied' }. Values are PostgREST operators. */
  filters?: Record<string, string>
}

/** Builds the PostgREST query string. Exported for tests. */
export function buildQuery(options: ListOptions = {}): string {
  const params = new URLSearchParams()
  params.set('select', options.select ?? '*')
  if (options.order) params.set('order', options.order)
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.offset !== undefined) params.set('offset', String(options.offset))
  for (const [column, expression] of Object.entries(options.filters ?? {})) {
    params.set(column, expression)
  }
  return params.toString()
}

export class Supabase {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
  ) {
    if (!url) throw new Error('SUPABASE_URL is not configured')
    if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured')
  }

  private endpoint(table: string, query?: string): string {
    const base = `${this.url.replace(/\/$/, '')}/rest/v1/${table}`
    return query ? `${base}?${query}` : base
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      'Content-Type': 'application/json',
      ...extra,
    }
  }

  private async send(url: string, init: RequestInit): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(url, init)
    } catch {
      // DNS failure, TLS error, connection refused. This is the same class
      // of problem as an upstream 5xx, so report it the same way rather
      // than letting a raw TypeError surface as our own 500.
      throw new SupabaseError('could not reach supabase', 502)
    }
    const text = await response.text()
    const body = text ? safeJson(text) : null

    if (!response.ok) {
      const detail = body as { message?: string; code?: string; details?: string } | null
      const code = detail?.code
      // 23505 = unique_violation. The job_url unique index makes this the
      // most likely write failure, and "already tracked" beats a raw 500.
      if (code === '23505') {
        throw new SupabaseError('a row with that unique value already exists', 409, code)
      }
      // 23503 = foreign_key_violation, e.g. a cover letter pointing at a
      // deleted application.
      if (code === '23503') {
        throw new SupabaseError('referenced row does not exist', 400, code)
      }
      throw new SupabaseError(
        detail?.message || detail?.details || `supabase request failed (${response.status})`,
        response.status >= 500 ? 502 : response.status,
        code,
      )
    }
    return body
  }

  async list<T>(table: string, options?: ListOptions): Promise<T[]> {
    const rows = await this.send(this.endpoint(table, buildQuery(options)), {
      method: 'GET',
      headers: this.headers(),
    })
    return (rows ?? []) as T[]
  }

  async getById<T>(table: string, id: string): Promise<T | null> {
    const rows = await this.list<T>(table, { filters: { id: `eq.${id}` }, limit: 1 })
    return rows[0] ?? null
  }

  async insert<T>(table: string, values: Record<string, unknown>): Promise<T> {
    const rows = (await this.send(this.endpoint(table), {
      method: 'POST',
      headers: this.headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(values),
    })) as T[]
    return rows[0]
  }

  async update<T>(table: string, id: string, values: Record<string, unknown>): Promise<T | null> {
    // updated_at has a default but no trigger, so keep it honest on write.
    const payload = { ...values, updated_at: new Date().toISOString() }
    const rows = (await this.send(
      this.endpoint(table, buildQuery({ filters: { id: `eq.${id}` } })),
      {
        method: 'PATCH',
        headers: this.headers({ Prefer: 'return=representation' }),
        body: JSON.stringify(payload),
      },
    )) as T[]
    return rows[0] ?? null
  }

  async remove(table: string, id: string): Promise<boolean> {
    const rows = (await this.send(
      this.endpoint(table, buildQuery({ filters: { id: `eq.${id}` } })),
      {
        method: 'DELETE',
        headers: this.headers({ Prefer: 'return=representation' }),
      },
    )) as unknown[]
    return rows.length > 0
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}
