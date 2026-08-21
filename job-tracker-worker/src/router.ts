// Pure request routing. Kept free of Supabase and env access so the whole
// URL surface can be unit tested without a network or a Worker runtime.

export type RouteName =
  | 'ui'
  | 'health'
  | 'stats'
  | 'daily'
  | 'queue'
  | 'apply'
  | 'list'
  | 'create'
  | 'get'
  | 'update'
  | 'delete'

export interface Match {
  name: RouteName
  /** Supabase table, absent for ui/health. */
  table?: 'applications' | 'cv_versions' | 'cover_letters'
  id?: string
}

const COLLECTIONS: Record<string, Match['table']> = {
  applications: 'applications',
  'cv-versions': 'cv_versions',
  'cover-letters': 'cover_letters',
}

/**
 * Returns the matched route, `null` for an unknown path (404), or
 * `'method-not-allowed'` when the path exists but the verb does not (405).
 */
export function matchRoute(
  method: string,
  pathname: string,
): Match | null | 'method-not-allowed' {
  const path = pathname.replace(/\/+$/, '') || '/'

  if (path === '/') return method === 'GET' ? { name: 'ui' } : 'method-not-allowed'
  if (path === '/api/health') {
    return method === 'GET' ? { name: 'health' } : 'method-not-allowed'
  }
  if (path === '/api/stats') {
    return method === 'GET' ? { name: 'stats' } : 'method-not-allowed'
  }
  if (path === '/api/stats/daily') {
    return method === 'GET' ? { name: 'daily' } : 'method-not-allowed'
  }
  // Where the matching agent posts scored candidates.
  if (path === '/api/queue') {
    return method === 'POST'
      ? { name: 'queue', table: 'applications' }
      : 'method-not-allowed'
  }

  const segments = path.split('/').filter(Boolean)
  if (segments[0] !== 'api') return null

  const table = COLLECTIONS[segments[1] ?? '']
  if (!table) return null

  if (segments.length === 2) {
    if (method === 'GET') return { name: 'list', table }
    if (method === 'POST') return { name: 'create', table }
    return 'method-not-allowed'
  }

  if (segments.length === 3) {
    const id = segments[2]
    if (method === 'GET') return { name: 'get', table, id }
    if (method === 'PATCH' || method === 'PUT') return { name: 'update', table, id }
    if (method === 'DELETE') return { name: 'delete', table, id }
    return 'method-not-allowed'
  }

  // /api/applications/:id/apply — records that the human sent this one.
  if (segments.length === 4 && segments[3] === 'apply' && table === 'applications') {
    return method === 'POST'
      ? { name: 'apply', table, id: segments[2] }
      : 'method-not-allowed'
  }

  return null
}

/**
 * Wraps a filter value in PostgREST's double-quote form.
 *
 * Inside a logic tree (`or=(...)`) commas and parentheses are the grammar's
 * own separators, so an unquoted company name like `Smith, Jones & Co` splits
 * into terms that do not parse and returns an opaque 400 for an entirely
 * ordinary search. Quoting keeps the value one token; `*` still means the
 * wildcard, which is what the caller wants here.
 */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Translates ?status=&company=&q=&limit=&offset= into PostgREST filters.
 *
 * Filters are gated by what the table actually has. Sending PostgREST a
 * filter on a column that does not exist surfaces a raw 400 to the caller:
 * `status` is absent from `cv_versions`, and `company`, `role` and
 * `match_score` exist only on `applications`.
 */
export function listOptionsFromSearch(
  search: URLSearchParams,
  table: Match['table'] = 'applications',
) {
  const filters: Record<string, string> = {}
  const isApplications = table === 'applications'
  const hasStatus = table !== 'cv_versions'

  const status = hasStatus ? search.get('status') : null
  if (status) filters.status = `eq.${status}`

  const company = isApplications ? search.get('company') : null
  if (company) filters.company = `ilike.*${company}*`

  // ?track=ai or ?track=facilities narrows to one search profile. The two score
  // against different rubrics, so a combined ranking compares numbers that do
  // not mean the same thing. ?track=none reaches rows queued before tracks
  // existed — `eq.` cannot express IS NULL, so PostgREST needs `is.null`.
  const track = isApplications ? search.get('track') : null
  if (track) filters.track = track === 'none' ? 'is.null' : `eq.${track}`

  // Free-text across the two columns worth searching.
  const q = isApplications ? search.get('q') : null
  if (q) filters.or = `(company.ilike.${quoted(`*${q}*`)},role.ilike.${quoted(`*${q}*`)})`

  const limit = clampInt(search.get('limit'), 50, 1, 200)
  const offset = clampInt(search.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)

  // ?queue=true is the review list: everything not yet sent, best fit first.
  // An explicit status filter wins, so ?queue=true&status=applied still works.
  const queueMode = isApplications && search.get('queue') === 'true'
  if (queueMode && !filters.status) filters.status = 'eq.saved'

  const defaultOrder = queueMode
    ? 'match_score.desc.nullslast,created_at.desc'
    : 'created_at.desc'

  return {
    filters,
    limit,
    offset,
    order: search.get('order') ?? defaultOrder,
  }
}

/**
 * Tallies applications per calendar day from their `applied_on` dates, newest
 * first, filling gaps with zero so a quiet day reads as 0 rather than missing.
 * `today` is passed in because Workers have no stable local timezone and the
 * caller owns the clock.
 */
export function tallyDaily(
  rows: { applied_on: string | null }[],
  today: string,
  days = 14,
): { date: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (!row.applied_on) continue
    counts.set(row.applied_on, (counts.get(row.applied_on) ?? 0) + 1)
  }

  const out: { date: string; count: number }[] = []
  const cursor = new Date(`${today}T00:00:00Z`)
  for (let i = 0; i < days; i++) {
    const date = cursor.toISOString().slice(0, 10)
    out.push({ date, count: counts.get(date) ?? 0 })
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  return out
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}
