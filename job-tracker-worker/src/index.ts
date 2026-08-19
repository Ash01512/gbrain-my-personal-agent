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

/**
 * Rows fetched per tally. Both stats endpoints report `truncated` when they
 * hit it, because a capped count that renders as a total is worse than no
 * count at all — this tracker's whole claim is that its numbers are true.
 */
const ROW_LIMIT = 1000

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
      const configured = {
        supabase_url: Boolean(env.SUPABASE_URL),
        service_role_key: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
        api_token: Boolean(env.API_TOKEN),
      }
      // `ok` means "configured", not "the process is running". An unconfigured
      // Worker answering ok:true is the failure this endpoint exists to catch.
      const ok = Object.values(configured).every(Boolean)
      return json({ ok, configured }, ok ? 200 : 503)
    }

    if (!isAuthorized(request.headers, env.API_TOKEN)) {
      return json({ error: 'unauthorized' }, 401, {
        'www-authenticate': 'Bearer realm="job-tracker"',
      })
    }

    // The most likely first-run mistake deserves the most useful answer. A
    // missing secret used to reach the generic catch and surface as
    // `{"error":"internal error"}`, which sends the operator looking for a bug
    // in the Worker instead of at their own configuration.
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      const missing = [
        env.SUPABASE_URL ? null : 'SUPABASE_URL',
        env.SUPABASE_SERVICE_ROLE_KEY ? null : 'SUPABASE_SERVICE_ROLE_KEY',
      ].filter(Boolean)
      return json({ error: `not configured: ${missing.join(', ')} — see /api/health` }, 503)
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
    // count here is small, and this avoids needing a database view. `order`
    // is set so a capped read returns a stable page rather than an arbitrary
    // sample that makes the chips flicker between refreshes.
    const rows = await db.list<Pick<Application, 'status'>>('applications', {
      select: 'status',
      order: 'created_at.desc',
      limit: ROW_LIMIT,
    })
    // A null-prototype map: `in` would otherwise match inherited keys, so a
    // row with status "toString" would increment a function and yield NaN.
    const byStatus: Record<string, number> = Object.create(null)
    for (const status of APPLICATION_STATUSES) byStatus[status] = 0
    for (const row of rows) {
      if (Object.hasOwn(byStatus, row.status)) byStatus[row.status] += 1
    }
    return json({
      total: rows.length,
      truncated: rows.length >= ROW_LIMIT,
      by_status: { ...byStatus },
    })
  }

  if (match.name === 'daily') {
    const rows = await db.list<Pick<Application, 'applied_on'>>('applications', {
      select: 'applied_on',
      // `lte.today` excludes nulls on its own (NULL fails the comparison) and
      // also drops future dates, which are meaningless here and would consume
      // the cap from the front — pushing real recent days out of the window
      // and reading as "applied today 0" against a database that has rows.
      filters: { applied_on: `lte.${today}` },
      order: 'applied_on.desc',
      limit: ROW_LIMIT,
    })
    const series = tallyDaily(rows, today)
    // Say so rather than freezing at the cap and looking like a real total.
    const truncated = rows.length >= ROW_LIMIT
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
      // Moving a row off `applied` clears its date (see the update handler),
      // so a reverted row arrives here with `applied_on` already null and gets
      // today. The fallback only survives for a row whose date was set
      // directly, where preserving it is the honest reading.
      applied_on: current.applied_on ?? today,
    })
    // getById and update are two round trips, so the row can be deleted in
    // between. Answering 200 for a write that matched nothing would tell the
    // user an application was recorded when nothing was.
    if (!row) return json({ error: 'not found' }, 404)
    // The apply link is what the human opens. Submission is their action.
    return json({ data: row, apply_url: current.job_url })
  }

  switch (match.name) {
    case 'list': {
      const options = listOptionsFromSearch(url.searchParams, table)
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
      // `applied` and a date are one fact, so this handler keeps them in step
      // in both directions.
      if (table === 'applications' && typeof values.status === 'string') {
        if (values.status === 'applied') {
          // The dashboard's status dropdown can move a row straight to
          // `applied`. Without stamping the date it would never reach the
          // daily count while still showing as applied. Gated on the key being
          // absent rather than `undefined`, because an explicit
          // `{"status":"applied","applied_on":null}` survives validation and
          // would otherwise write a row that is applied but uncountable — and
          // could un-stamp a row that a past day's total already counted.
          if (!('applied_on' in values) || values.applied_on === null) {
            const current = await db.getById<Application>(table, id)
            values.applied_on = current?.applied_on ?? today
          }
        } else if (values.status === 'saved' && !('applied_on' in values)) {
          // Back to `saved` means "not sent after all", so the date goes with
          // it. Otherwise a row recorded by mistake leaves that day's total
          // permanently inflated, and the stale date is what a later genuine
          // application would inherit instead of today.
          //
          // Only `saved`. Everything past `applied` — screening, interview,
          // offer, rejected, withdrawn — describes what happened *after* an
          // application was sent, so those keep the date.
          values.applied_on = null
        }
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
