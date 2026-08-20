// Worker entrypoint for property outreach.
//
// The shape mirrors job-tracker-worker: PostgREST behind a shared token, a
// self-contained dashboard at /, and the agent posting drafts to an endpoint
// that cannot approve them. `auth.ts` and `supabase.ts` are imported from that
// Worker rather than copied — same repository, same checkout, and a divergent
// copy of the auth check is a security bug waiting to happen.

import { isAuthorized } from '../../job-tracker-worker/src/auth'
import { Supabase, SupabaseError } from '../../job-tracker-worker/src/supabase'
import {
  evaluateGate,
  renderTemplate,
  serviceWindowOpen,
  TemplateRenderError,
  unsupportedClaims,
  type GateResult,
} from './consent'
import * as letsbot from './letsbot'
import {
  listOptionsFromSearch,
  matchRoute,
  queueOptions,
  windowStart,
  type Match,
  type Table,
} from './router'
import {
  assertUuid,
  parseConsent,
  parseContact,
  parseDraft,
  parseProperty,
  parseTemplate,
  ValidationError,
  type Contact,
  type MessageTemplate,
  type OutreachMessage,
} from './schema'
import { dashboardHtml } from './ui'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  API_TOKEN: string
  LETSBOT_API_KEY?: string
  LETSBOT_API_BASE?: string
  LETSBOT_SEND_PATH?: string
  /** "true" arms real sending. Anything else keeps every send a dry run. */
  OUTREACH_LIVE?: string
  OUTREACH_MAX_PER_CONTACT?: string
  OUTREACH_WINDOW_DAYS?: string
  APP_TIMEZONE?: string
}

export interface Limits {
  maxPerContact: number
  windowDays: number
}

/**
 * Reads the caps, falling back to values that are safe rather than permissive.
 *
 * A malformed OUTREACH_MAX_PER_CONTACT must not become Infinity. The whole
 * point of the cap is to hold when someone fat-fingers the config.
 */
export function limitsFrom(env: Env): Limits {
  return {
    maxPerContact: positiveInt(env.OUTREACH_MAX_PER_CONTACT, 2, 20),
    windowDays: positiveInt(env.OUTREACH_WINDOW_DAYS, 30, 365),
  }
}

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

/**
 * Live sending requires the exact string "true".
 *
 * Not truthiness: "false", "0" and "no" are all strings and all truthy, and a
 * config typo that silently arms a WhatsApp sender is not a mistake this
 * should be able to make.
 */
export function isLive(env: Env): boolean {
  return env.OUTREACH_LIVE === 'true'
}

export function letsbotConfig(env: Env): letsbot.LetsBotConfig {
  return {
    apiKey: env.LETSBOT_API_KEY ?? '',
    apiBase: env.LETSBOT_API_BASE || 'https://api.letsbot.net',
    sendPath: env.LETSBOT_SEND_PATH || '/v1/messages',
    live: isLive(env),
  }
}

const PARSERS: Record<Table, (body: unknown, partial?: boolean) => Record<string, unknown>> = {
  properties: parseProperty,
  contacts: parseContact,
  message_templates: parseTemplate,
  outreach_messages: parseDraft,
}

const ROW_LIMIT = 1000

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
      return new Response(dashboardHtml(isLive(env)), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    if (match.name === 'health') {
      const configured = {
        supabase_url: Boolean(env.SUPABASE_URL),
        service_role_key: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
        api_token: Boolean(env.API_TOKEN),
        letsbot_api_key: Boolean(env.LETSBOT_API_KEY),
      }
      // Sending is reported separately from configuration. A Worker that is
      // fully configured but still in dry run is healthy and should say so
      // loudly, because "why did nothing arrive" is the question this answers.
      const ok = configured.supabase_url && configured.service_role_key && configured.api_token
      return json(
        {
          ok,
          configured,
          sending: isLive(env) ? 'live' : 'dry-run',
          limits: limitsFrom(env),
        },
        ok ? 200 : 503,
      )
    }

    if (!isAuthorized(request.headers, env.API_TOKEN)) {
      return json({ error: 'unauthorized' }, 401, {
        'www-authenticate': 'Bearer realm="property-outreach"',
      })
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      const missing = [
        env.SUPABASE_URL ? null : 'SUPABASE_URL',
        env.SUPABASE_SERVICE_ROLE_KEY ? null : 'SUPABASE_SERVICE_ROLE_KEY',
      ].filter(Boolean)
      return json({ error: `not configured: ${missing.join(', ')} — see /api/health` }, 503)
    }

    try {
      const db = new Supabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
      return await handle(match, request, url, db, env)
    } catch (error) {
      if (error instanceof ValidationError) return json({ error: error.message }, 400)
      if (error instanceof TemplateRenderError) return json({ error: error.message }, 400)
      if (error instanceof SupabaseError) return json({ error: error.message }, error.status)
      if (error instanceof letsbot.LetsBotError) {
        return json({ error: error.message, provider: 'letsbot' }, error.status)
      }
      if (error instanceof SyntaxError) return json({ error: 'body must be valid JSON' }, 400)
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
  env: Env,
): Promise<Response> {
  const now = new Date()
  const limits = limitsFrom(env)

  if (match.name === 'stats') return stats(db, limits, now)

  if (match.name === 'queue') {
    const rows = await db.list<OutreachMessage>('outreach_messages', queueOptions(url.searchParams))
    return json({ data: rows, count: rows.length, sending: isLive(env) ? 'live' : 'dry-run' })
  }

  if (match.name === 'draft') return draft(request, db, limits, now)
  if (match.name === 'approve') return approve(request, match, db, limits, now)
  if (match.name === 'send') return sendOne(match, db, env, limits, now)
  if (match.name === 'cancel') return cancel(match, db)
  if (match.name === 'consent') return recordConsent(request, match, db)

  if (match.name === 'consent-history') {
    const contactId = assertUuid(match.id!, 'contact id')
    const rows = await db.list('consent_events', {
      filters: { contact_id: `eq.${contactId}` },
      order: 'occurred_at.desc',
      limit: 200,
    })
    return json({ data: rows, count: rows.length })
  }

  const table = match.table!
  const parse = PARSERS[table]

  switch (match.name) {
    case 'list': {
      const rows = await db.list(table, listOptionsFromSearch(url.searchParams, table))
      return json({ data: rows, count: rows.length })
    }
    case 'create': {
      if (table === 'outreach_messages') {
        // Creating a queue row has to go through the gate, so there is exactly
        // one way in. Otherwise POST /api/outreach would be an unchecked
        // alternative to POST /api/draft.
        return json({ error: 'post drafts to /api/draft so they are gated' }, 405)
      }
      const values = parse(await request.json())
      return json({ data: await db.insert(table, values) }, 201)
    }
    case 'get': {
      const row = await db.getById(table, assertUuid(match.id!))
      return row ? json({ data: row }) : json({ error: 'not found' }, 404)
    }
    case 'update': {
      const id = assertUuid(match.id!)
      if (table === 'outreach_messages') {
        // Editing the copy re-opens the decision, so it re-runs the gate.
        return editDraft(request, id, db, limits, now)
      }
      const values = parse(await request.json(), true)
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

// ── The gate, applied ──────────────────────────────────────────────────────

interface GateContext {
  contact: Contact
  template: MessageTemplate | null
  result: GateResult
}

/**
 * Loads what the gate needs and runs it.
 *
 * Called at draft, at edit, at approve and again at send — four times for one
 * message, deliberately. Consent is not a fact about the moment a draft was
 * written: someone can opt out between a human clicking Approve and the send
 * going out, and the send is the only one of those that can get a number
 * banned. So the check that matters is the last one, and it is never skipped
 * because an earlier one passed.
 */
async function runGate(
  db: Supabase,
  contactId: string,
  templateId: string | null,
  renderedBody: string,
  limits: Limits,
  now: Date,
): Promise<GateContext | null> {
  const contact = await db.getById<Contact>('contacts', contactId)
  if (!contact) return null

  let template: MessageTemplate | null = null
  if (templateId) {
    template = await db.getById<MessageTemplate>('message_templates', templateId)
    if (!template) {
      return {
        contact,
        template: null,
        result: {
          allowed: false,
          blockers: [{ code: 'TEMPLATE_MISSING', detail: 'the referenced template no longer exists' }],
        },
      }
    }
  }

  // Counts only messages that actually went out. A draft sitting in the queue
  // has not reached anyone and must not consume the contact's allowance.
  const recent = await db.list<{ id: string }>('outreach_messages', {
    select: 'id',
    filters: {
      contact_id: `eq.${contactId}`,
      sent_at: `gte.${windowStart(now, limits.windowDays)}`,
      status: 'eq.sent',
    },
    limit: limits.maxPerContact + 1,
  })

  const result = evaluateGate({
    contact: {
      phone_e164: contact.phone_e164,
      opt_in_state: contact.opt_in_state,
      last_inbound_at: contact.last_inbound_at,
    },
    template: template
      ? { name: template.name, category: template.category, meta_status: template.meta_status }
      : null,
    renderedBody,
    recentSendCount: recent.length,
    limits,
    now,
  })

  return { contact, template, result }
}

/** Shapes the gate verdict for storage on the row. */
function verdict(result: GateResult) {
  return {
    status: result.allowed ? 'draft' : 'blocked',
    block_reasons: result.blockers.map((b) => b.code),
  }
}

async function draft(
  request: Request,
  db: Supabase,
  limits: Limits,
  now: Date,
): Promise<Response> {
  const values = parseDraft(await request.json())
  const contactId = assertUuid(String(values.contact_id), 'contact_id')
  const templateId = values.template_id ? assertUuid(String(values.template_id), 'template_id') : null
  if (values.property_id) assertUuid(String(values.property_id), 'property_id')

  const gate = await runGate(db, contactId, templateId, String(values.rendered_body), limits, now)
  if (!gate) return json({ error: 'contact not found' }, 404)

  const row = await db.insert<OutreachMessage>('outreach_messages', {
    ...values,
    language: values.language ?? gate.contact.language,
    ...verdict(gate.result),
  })

  return json(
    { data: row, gate: gate.result, blockers: gate.result.blockers },
    201,
  )
}

async function editDraft(
  request: Request,
  id: string,
  db: Supabase,
  limits: Limits,
  now: Date,
): Promise<Response> {
  const values = parseDraft(await request.json(), true)
  const current = await db.getById<OutreachMessage>('outreach_messages', id)
  if (!current) return json({ error: 'not found' }, 404)
  if (current.status === 'sent' || current.status === 'sending') {
    // Rewriting the record of a message that already went out would make the
    // queue disagree with what the recipient actually read.
    return json({ error: `cannot edit a ${current.status} message` }, 409)
  }

  const merged = { ...current, ...values }
  const gate = await runGate(
    db,
    String(merged.contact_id),
    merged.template_id ? String(merged.template_id) : null,
    String(merged.rendered_body),
    limits,
    now,
  )
  if (!gate) return json({ error: 'contact not found' }, 404)

  // An edit withdraws any approval it had. The human approved specific words;
  // different words need a fresh decision.
  const row = await db.update<OutreachMessage>('outreach_messages', id, {
    ...values,
    ...verdict(gate.result),
    approved_at: null,
    approved_by: null,
  })
  if (!row) return json({ error: 'not found' }, 404)
  return json({ data: row, gate: gate.result })
}

async function approve(
  request: Request,
  match: Match,
  db: Supabase,
  limits: Limits,
  now: Date,
): Promise<Response> {
  const id = assertUuid(match.id!)
  const message = await db.getById<OutreachMessage>('outreach_messages', id)
  if (!message) return json({ error: 'not found' }, 404)
  if (message.status === 'sent' || message.status === 'sending') {
    return json({ error: `already ${message.status}` }, 409)
  }

  const gate = await runGate(
    db,
    message.contact_id,
    message.template_id,
    message.rendered_body,
    limits,
    now,
  )
  if (!gate) return json({ error: 'contact not found' }, 404)

  if (!gate.result.allowed) {
    // Re-stamp the row so the queue shows the current reasons, not the ones
    // from whenever the draft was written.
    await db.update('outreach_messages', id, verdict(gate.result))
    return json({ error: 'blocked', blockers: gate.result.blockers }, 409)
  }

  const approvedBy = await approverFrom(request)
  const row = await db.update<OutreachMessage>('outreach_messages', id, {
    status: 'approved',
    block_reasons: [],
    approved_at: now.toISOString(),
    approved_by: approvedBy,
  })
  if (!row) return json({ error: 'not found' }, 404)
  return json({ data: row })
}

async function sendOne(
  match: Match,
  db: Supabase,
  env: Env,
  limits: Limits,
  now: Date,
): Promise<Response> {
  const id = assertUuid(match.id!)
  const message = await db.getById<OutreachMessage>('outreach_messages', id)
  if (!message) return json({ error: 'not found' }, 404)

  // Only a human-approved message may be transmitted. `failed` is included so
  // a provider-side error can be retried without a second approval; the gate
  // below still re-runs, so a retry cannot outlive a withdrawn consent.
  if (message.status !== 'approved' && message.status !== 'failed') {
    return json(
      { error: `only approved messages can be sent — this one is ${message.status}` },
      409,
    )
  }

  const gate = await runGate(
    db,
    message.contact_id,
    message.template_id,
    message.rendered_body,
    limits,
    now,
  )
  if (!gate) return json({ error: 'contact not found' }, 404)

  // The check that actually matters. Consent can be withdrawn in the seconds
  // between approval and this line, and this is the last place it can be
  // honoured.
  if (!gate.result.allowed) {
    await db.update('outreach_messages', id, {
      ...verdict(gate.result),
      approved_at: null,
      approved_by: null,
    })
    return json({ error: 'blocked at send time', blockers: gate.result.blockers }, 409)
  }

  const request: letsbot.SendRequest = gate.template
    ? {
        kind: 'template',
        phone: gate.contact.phone_e164,
        templateName: gate.template.name,
        language: message.language || gate.template.language,
        variables: message.variables ?? [],
        body: message.rendered_body,
      }
    : { kind: 'text', phone: gate.contact.phone_e164, body: message.rendered_body }

  let outcome: letsbot.SendOutcome
  try {
    outcome = await letsbot.send(letsbotConfig(env), request)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'send failed'
    await db.update('outreach_messages', id, { status: 'failed', error: detail })
    throw error
  }

  if (!outcome.delivered) {
    // Dry run: the row stays approved so the same message can be sent for
    // real once the send path is confirmed. Returning the payload is the
    // whole point — see the header of letsbot.ts.
    return json({
      dry_run: true,
      note: 'OUTREACH_LIVE is not "true" — nothing was transmitted',
      would_send: outcome.request,
      data: message,
    })
  }

  const row = await db.update<OutreachMessage>('outreach_messages', id, {
    status: 'sent',
    sent_at: now.toISOString(),
    provider_message_id: outcome.providerMessageId,
    error: null,
  })
  return json({ data: row ?? message, provider_message_id: outcome.providerMessageId })
}

async function cancel(match: Match, db: Supabase): Promise<Response> {
  const id = assertUuid(match.id!)
  const message = await db.getById<OutreachMessage>('outreach_messages', id)
  if (!message) return json({ error: 'not found' }, 404)
  if (message.status === 'sent' || message.status === 'sending') {
    return json({ error: `cannot cancel a ${message.status} message` }, 409)
  }
  const row = await db.update<OutreachMessage>('outreach_messages', id, {
    status: 'cancelled',
    approved_at: null,
    approved_by: null,
  })
  return json({ data: row ?? message })
}

/**
 * Appends to the consent ledger and brings the contact's cached state in step.
 *
 * The ledger row is written first. If the second write fails, the evidence
 * still exists and the contact stays in whatever state it was — which fails
 * towards not sending. The reverse order could mark someone opted in with no
 * record behind it, which is the exact situation this whole design exists to
 * prevent.
 */
async function recordConsent(request: Request, match: Match, db: Supabase): Promise<Response> {
  const contactId = assertUuid(match.id!, 'contact id')
  const contact = await db.getById<Contact>('contacts', contactId)
  if (!contact) return json({ error: 'contact not found' }, 404)

  const values = parseConsent(await request.json())
  const event = await db.insert('consent_events', { ...values, contact_id: contactId })

  const occurredAt = String(values.occurred_at ?? new Date().toISOString())
  const optingIn = values.event === 'opt_in'
  const updated = await db.update<Contact>('contacts', contactId, {
    opt_in_state: optingIn ? 'opted_in' : 'opted_out',
    ...(optingIn ? { opted_in_at: occurredAt } : { opted_out_at: occurredAt }),
  })

  return json({ data: updated ?? contact, event }, 201)
}

// ── Stats ──────────────────────────────────────────────────────────────────

async function stats(db: Supabase, limits: Limits, now: Date): Promise<Response> {
  const [messages, contacts] = await Promise.all([
    db.list<Pick<OutreachMessage, 'status'>>('outreach_messages', {
      select: 'status',
      order: 'created_at.desc',
      limit: ROW_LIMIT,
    }),
    db.list<Pick<Contact, 'opt_in_state'>>('contacts', {
      select: 'opt_in_state',
      order: 'created_at.desc',
      limit: ROW_LIMIT,
    }),
  ])

  const byStatus: Record<string, number> = Object.create(null)
  for (const row of messages) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1
  }
  const byOptIn: Record<string, number> = Object.create(null)
  for (const row of contacts) {
    byOptIn[row.opt_in_state] = (byOptIn[row.opt_in_state] ?? 0) + 1
  }

  return json({
    messages: {
      total: messages.length,
      truncated: messages.length >= ROW_LIMIT,
      by_status: { ...byStatus },
    },
    contacts: {
      total: contacts.length,
      truncated: contacts.length >= ROW_LIMIT,
      by_opt_in: { ...byOptIn },
    },
    // The number that decides whether any of this can run: how many people
    // you are actually allowed to message.
    sendable_contacts: byOptIn.opted_in ?? 0,
    limits,
    as_of: now.toISOString(),
  })
}

/** Records who approved, when the caller says. Never trusted for authorization. */
async function approverFrom(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { approved_by?: unknown } | null
    const value = body?.approved_by
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null
  } catch {
    // An empty body is the normal case for this endpoint.
    return null
  }
}

// Re-exported so the dashboard and tests share one definition of these rules
// rather than a second copy that can drift from the gate.
export { serviceWindowOpen, unsupportedClaims, renderTemplate }

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
