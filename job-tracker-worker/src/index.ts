import { isAuthorized } from './auth'
import { listOptionsFromSearch, matchRoute, tallyDaily, type Match } from './router'
import {
  APPLICATION_STATUSES,
  ValidationError,
  assertUuid,
  parseApplication,
  parseCoverLetter,
  parseCvVersion,
  parseQueueItem,
  type Application,
} from './schema'
import { Supabase, SupabaseError } from './supabase'
import { dashboardHtml } from './ui'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  API_TOKEN: string
  /**
   * IANA zone used to decide which calendar day an application belongs to,
   * e.g. "Asia/Dubai". Defaults to UTC. Without it, an application sent at
   * 01:30 in UTC+4 files under the previous day and "applied today" resets
   * at 04:00 local.
   */
  APP_TIMEZONE?: string
}

/** Today's date in the configured zone, as YYYY-MM-DD. */
export function localDate(timeZone: string | undefined, now = new Date()): string {
  try {
    // en-CA formats as YYYY-MM-DD, which is what Postgres `date` wants.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  } catch {
    // An invalid zone must not take the endpoint down; fall back to UTC.
    return now.toISOString().slice(0, 10)
  }
}

const DAILY_ROW_LIMIT = 1000

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
      return await handle(match, request, url, db, localDate(env.APP_TIMEZONE))
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
  today: string,
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

  if (match.name === 'daily') {
    const rows = await db.list<Pick<Application, 'applied_on'>>('applications', {
      select: 'applied_on',
      filters: { applied_on: 'not.is.null' },
      order: 'applied_on.desc',
      limit: DAILY_ROW_LIMIT,
    })
    const series = tallyDaily(rows, today)
    // Say so rather than freezing at the cap and looking like a real total.
    const truncated = rows.length >= DAILY_ROW_LIMIT
    return json({
      today: series[0]?.count ?? 0,
      total: rows.length,
      truncated,
      days: series,
    })
  }

  const table = match.table!
  const parse = PARSERS[table]

  if (match.name === 'queue') {
    // Duplicate job_url hits the unique index and surfaces as 409, so a
    // re-run of the agent cannot queue the same role twice.
    const values = parseQueueItem(await request.json())
    return json({ data: await db.insert(table, values) }, 201)
  }

  if (match.name === 'apply') {
    const id = assertUuid(match.id!)
    const current = await db.getById<Application>(table, id)
    if (!current) return json({ error: 'not found' }, 404)
    // Refuse to re-apply. Without this the daily count would inflate every
    // time the button was clicked twice, and the number has to be true.
    if (current.status !== 'saved') {
      return json(
        { error: `already ${current.status}`, applied_on: current.applied_on },
        409,
      )
    }
    const row = await db.update<Application>(table, id, {
      status: 'applied',
      // Keep the original date if this row was applied to before and later
      // moved back to saved, so re-applying cannot shuffle a past
      // application onto today and distort the history.
      applied_on: current.applied_on ?? today,
    })
    // The apply link is what the human opens. Submission is their action.
    return json({ data: row, apply_url: current.job_url })
  }

  switch (match.name) {
    case 'list': {
      const options = listOptionsFromSearch(url.searchParams, table === 'applications')
      const rows = await db.list(table, options)
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
      const id = assertUuid(match.id!)
      const values = parse(await request.json(), true)
      // The dashboard's status dropdown can move a row straight to `applied`.
      // Without stamping the date here it would never reach the daily count,
      // and the "applied" chip would contradict "applied total" next to it.
      if (
        table === 'applications' &&
        values.status === 'applied' &&
        values.applied_on === undefined
      ) {
        const current = await db.getById<Application>(table, id)
        values.applied_on = current?.applied_on ?? today
      }
      const row = await db.update(table, id, values)
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
