// Pure request routing. Kept free of Supabase and env access so the whole
// URL surface can be unit tested without a network or a Worker runtime.

export type RouteName =
  | 'ui'
  | 'health'
  | 'stats'
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

  return null
}

/** Translates ?status=&company=&q=&limit=&offset= into PostgREST filters. */
export function listOptionsFromSearch(search: URLSearchParams) {
  const filters: Record<string, string> = {}

  const status = search.get('status')
  if (status) filters.status = `eq.${status}`

  const company = search.get('company')
  if (company) filters.company = `ilike.*${company}*`

  // Free-text across the two columns worth searching.
  const q = search.get('q')
  if (q) filters.or = `(company.ilike.*${q}*,role.ilike.*${q}*)`

  const limit = clampInt(search.get('limit'), 50, 1, 200)
  const offset = clampInt(search.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)

  return {
    filters,
    limit,
    offset,
    order: search.get('order') ?? 'created_at.desc',
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}
