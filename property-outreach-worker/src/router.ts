// Pure request routing. Kept free of Supabase and env access so the whole URL
// surface can be unit tested without a network or a Worker runtime.

export type RouteName =
  | 'ui'
  | 'health'
  | 'stats'
  | 'queue'
  | 'draft'
  | 'approve'
  | 'send'
  | 'cancel'
  | 'consent'
  | 'consent-history'
  | 'list'
  | 'create'
  | 'get'
  | 'update'
  | 'delete'

export type Table = 'properties' | 'contacts' | 'message_templates' | 'outreach_messages'

export interface Match {
  name: RouteName
  table?: Table
  id?: string
}

const COLLECTIONS: Record<string, Table> = {
  properties: 'properties',
  contacts: 'contacts',
  templates: 'message_templates',
  outreach: 'outreach_messages',
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
  // Where the drafting agent posts one message for review.
  if (path === '/api/draft') {
    return method === 'POST'
      ? { name: 'draft', table: 'outreach_messages' }
      : 'method-not-allowed'
  }
  if (path === '/api/queue') {
    return method === 'GET'
      ? { name: 'queue', table: 'outreach_messages' }
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

  if (segments.length === 4) {
    const id = segments[2]
    const action = segments[3]

    if (table === 'outreach_messages') {
      // approve and send are separate verbs on purpose. Approving is the
      // human's judgement; sending is the transmission. Keeping them apart
      // means a send that fails at the provider can be retried without
      // re-asking for approval, and a queue can be approved offline.
      if (action === 'approve') {
        return method === 'POST' ? { name: 'approve', table, id } : 'method-not-allowed'
      }
      if (action === 'send') {
        return method === 'POST' ? { name: 'send', table, id } : 'method-not-allowed'
      }
      if (action === 'cancel') {
        return method === 'POST' ? { name: 'cancel', table, id } : 'method-not-allowed'
      }
      return null
    }

    if (table === 'contacts' && action === 'consent') {
      // POST appends to the ledger; GET reads it back. There is deliberately
      // no PATCH or DELETE — an audit trail you can edit is not one.
      if (method === 'POST') return { name: 'consent', table, id }
      if (method === 'GET') return { name: 'consent-history', table, id }
      return 'method-not-allowed'
    }
  }

  return null
}

/** Translates the query string into PostgREST filters, per table. */
export function listOptionsFromSearch(search: URLSearchParams, table: Table) {
  const filters: Record<string, string> = {}

  const status = search.get('status')
  if (status && table === 'outreach_messages') filters.status = `eq.${status}`

  if (table === 'contacts') {
    const optIn = search.get('opt_in_state')
    if (optIn) filters.opt_in_state = `eq.${optIn}`
    const type = search.get('contact_type')
    if (type) filters.contact_type = `eq.${type}`
    const phone = search.get('phone')
    // Exact match: a phone number is an identifier, and a partial match here
    // would let a careless lookup act on the wrong person.
    if (phone) filters.phone_e164 = `eq.${phone}`
  }

  if (table === 'message_templates') {
    const metaStatus = search.get('meta_status')
    if (metaStatus) filters.meta_status = `eq.${metaStatus}`
    const category = search.get('category')
    if (category) filters.category = `eq.${category}`
  }

  if (table === 'properties') {
    const area = search.get('area')
    if (area) filters.area = `ilike.*${area}*`
    const listingType = search.get('listing_type')
    if (listingType) filters.listing_type = `eq.${listingType}`
  }

  const limit = clampInt(search.get('limit'), 50, 1, 200)
  const offset = clampInt(search.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)

  return {
    filters,
    limit,
    offset,
    order: search.get('order') ?? 'created_at.desc',
  }
}

/**
 * Filters for the review queue: everything a human still has to decide on.
 *
 * `blocked` rows are included rather than hidden. A blocked row is the most
 * useful thing in the queue — it names a contact who needs an opt-in recorded,
 * or copy that claims something untrue — and a queue that hides its problems
 * looks finished when it is not.
 */
export function queueOptions(search: URLSearchParams) {
  const limit = clampInt(search.get('limit'), 50, 1, 200)
  const offset = clampInt(search.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
  const status = search.get('status')
  return {
    filters: {
      status: status ? `eq.${status}` : 'in.(draft,blocked,approved,failed)',
    },
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

/** ISO timestamp for the start of the frequency-cap window. */
export function windowStart(now: Date, windowDays: number): string {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString()
}
