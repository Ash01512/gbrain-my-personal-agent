import { isAuthorized } from './auth'
import { listOptionsFromSearch, matchRoute, type Match } from './router'
import {
  APPLICATION_STATUSES,
  ValidationError,
  assertUuid,
  parseApplication,
  parseCoverLetter,
  parseCvVersion,
  type Application,
} from './schema'
import { Supabase, SupabaseError } from './supabase'
import { dashboardHtml } from './ui'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  API_TOKEN: string
}

const PARSERS = {
  applications: parseApplication,
  cv_versions: parseCvVersion,
  cover_letters: parseCoverLetter,
} as const

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    const match = matchRoute(request.method, url.pathname)
    if (match === null) return json({ error: 'not found' }, 404)
    if (match === 'method-not-allowed') return json({ error: 'method not allowed' }, 405)

    if (match.name === 'ui') {
      return new Response(dashboardHtml(), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    if (match.name === 'health') {
      // Reports configuration presence only. Never the values.
      return json({
        ok: true,
        configured: {
          supabase_url: Boolean(env.SUPABASE_URL),
          service_role_key: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
          api_token: Boolean(env.API_TOKEN),
        },
      })
    }

    if (!isAuthorized(request.headers, env.API_TOKEN)) {
      return json({ error: 'unauthorized' }, 401, {
        'www-authenticate': 'Bearer realm="job-tracker"',
      })
    }

    try {
      const db = new Supabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
      return await handle(match, request, url, db)
    } catch (error) {
      if (error instanceof ValidationError) return json({ error: error.message }, 400)
      if (error instanceof SupabaseError) return json({ error: error.message }, error.status)
      if (error instanceof SyntaxError) return json({ error: 'body must be valid JSON' }, 400)
      // Anything unrecognised stays generic on the wire. The detail goes to
      // the Worker log, where it is useful without being disclosed to a
      // caller who just failed to authenticate against something.
      console.error('unhandled error', error)
      return json({ error: 'internal error' }, 500)
    }
  },
}

async function handle(
  match: Match,
  request: Request,
  url: URL,
  db: Supabase,
): Promise<Response> {
  if (match.name === 'stats') {
    // Tallied in the Worker rather than via a Postgres aggregate: the row
    // count here is small, and this avoids needing a database view.
    const rows = await db.list<Pick<Application, 'status'>>('applications', {
      select: 'status',
      limit: 1000,
    })
    const byStatus = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0]))
    for (const row of rows) {
      if (row.status in byStatus) byStatus[row.status] += 1
    }
    return json({ total: rows.length, by_status: byStatus })
  }

  const table = match.table!
  const parse = PARSERS[table]

  switch (match.name) {
    case 'list': {
      const rows = await db.list(table, listOptionsFromSearch(url.searchParams))
      return json({ data: rows, count: rows.length })
    }
    case 'create': {
      const values = parse(await request.json())
      return json({ data: await db.insert(table, values) }, 201)
    }
    case 'get': {
      const row = await db.getById(table, assertUuid(match.id!))
      return row ? json({ data: row }) : json({ error: 'not found' }, 404)
    }
    case 'update': {
      const values = parse(await request.json(), true)
      const row = await db.update(table, assertUuid(match.id!), values)
      return row ? json({ data: row }) : json({ error: 'not found' }, 404)
    }
    case 'delete': {
      const removed = await db.remove(table, assertUuid(match.id!))
      return removed ? json({ deleted: true }) : json({ error: 'not found' }, 404)
    }
    default:
      return json({ error: 'not found' }, 404)
  }
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-api-token',
  }
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...extra,
    },
  })
}
