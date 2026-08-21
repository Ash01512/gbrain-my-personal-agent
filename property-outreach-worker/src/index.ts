// Worker entrypoint for property outreach.
//
// The shape mirrors job-tracker-worker: PostgREST behind a shared token, a
// self-contained dashboard at /, and an endpoint the drafting agent posts to
// that cannot approve its own work.
//
// `auth.ts` and `supabase.ts` are vendored copies of that Worker's files
// rather than cross-directory imports, so this project builds, tests and
// deploys from its own folder with no sibling checked out — which is what lets
// it live in its own repository. The risk of a copy is drift, and a divergent
// copy of the auth check is a security bug, so test/vendored.test.ts fails the
// build if the two disagree whenever both are present.

import { isAuthorized } from './auth'
import { Supabase, SupabaseError } from './supabase'
import {
  allowanceForRun,
  audienceFilters,
  draftFor,
  emptyReport,
  limitsForCampaign,
  noteReason,
  type RunReport,
} from './campaign'
import {
  evaluateGate,
  renderTemplate,
  serviceWindowOpen,
  TemplateRenderError,
  unsupportedClaims,
  type GateLimits,
  type GateResult,
} from './consent'
import {
  classifyInbound,
  normalisePhone,
  parseInbound,
  secretMatches,
} from './inbound'
import * as letsbot from './letsbot'
import {
  evidenceNote,
  optInDoneHtml,
  optInPageHtml,
  OptInError,
  parseSubmission,
} from './optin'
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
  parseCampaign,
  parseConsent,
  parseContact,
  parseDraft,
  parseProperty,
  parseTemplate,
  ValidationError,
  type Campaign,
  type Contact,
  type MessageTemplate,
  type OutreachMessage,
  type Property,
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
  /**
   * "true" lets the cron handler send without a human. Independent of
   * OUTREACH_LIVE on purpose: autopilot in dry run is the rehearsal you want
   * before autopilot on a real number.
   */
  OUTREACH_AUTOPILOT?: string
  OUTREACH_MAX_PER_CONTACT?: string
  OUTREACH_WINDOW_DAYS?: string
  /** Path secret for the provider's inbound webhook. See inbound.ts. */
  INBOUND_WEBHOOK_SECRET?: string
  /** Shown on the public opt-in page. */
  BUSINESS_NAME?: string
  /** The business WhatsApp number, E.164. Powers the wa.me link on /optin. */
  WHATSAPP_NUMBER?: string
  APP_TIMEZONE?: string
}

export type Limits = GateLimits

/**
 * Reads the caps, falling back to values that are safe rather than permissive.
 *
 * A malformed OUTREACH_MAX_PER_CONTACT must not become Infinity. The whole
 * point of a cap is to hold when someone fat-fingers the config — and with no
 * human in the loop, nobody is watching the first run that gets it wrong.
 *
 * `oncePerContact` is true and not configurable. One message per person is the
 * campaign policy this system implements, and it is enforced again by a unique
 * index in the database.
 */
export function limitsFrom(env: Env): Limits {
  return {
    maxPerContact: positiveInt(env.OUTREACH_MAX_PER_CONTACT, 2, 20),
    windowDays: positiveInt(env.OUTREACH_WINDOW_DAYS, 30, 365),
    oncePerContact: true,
  }
}

/** Autopilot needs its own explicit "true", for the same reason live sending does. */
export function isAutopilot(env: Env): boolean {
  return env.OUTREACH_AUTOPILOT === 'true'
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
  campaigns: parseCampaign,
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
      return new Response(dashboardHtml(isLive(env), isAutopilot(env)), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    // ── Public routes ────────────────────────────────────────────────────
    // These sit ahead of the token check because the people and systems that
    // use them cannot hold the token: a member of the public filling in the
    // opt-in form, and the provider posting a webhook. Each carries its own
    // authentication instead — a required consent checkbox, and a path secret.

    const businessName = env.BUSINESS_NAME || 'our team'

    if (match.name === 'optin-form') {
      return html(optInPageHtml(businessName, undefined, env.WHATSAPP_NUMBER))
    }

    if (match.name === 'optin-submit') {
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        return html(
          optInPageHtml(businessName, 'Sorry — we could not save that. Try again later.', env.WHATSAPP_NUMBER),
          503,
        )
      }
      const db = new Supabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
      return optInSubmit(request, db, businessName, env.WHATSAPP_NUMBER)
    }

    if (match.name === 'inbound') {
      // A wrong secret is a 404, not a 403: an attacker probing the path
      // learns nothing about whether they found a real endpoint.
      if (!secretMatches(match.secret ?? '', env.INBOUND_WEBHOOK_SECRET)) {
        return json({ error: 'not found' }, 404)
      }
      if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
        return json({ error: 'not configured' }, 503)
      }
      const db = new Supabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
      return handleInbound(request, db)
    }

    if (match.name === 'health') {
      const configured = {
        supabase_url: Boolean(env.SUPABASE_URL),
        service_role_key: Boolean(env.SUPABASE_SERVICE_ROLE_KEY),
        api_token: Boolean(env.API_TOKEN),
        letsbot_api_key: Boolean(env.LETSBOT_API_KEY),
        inbound_webhook_secret: Boolean(env.INBOUND_WEBHOOK_SECRET),
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
          autopilot: isAutopilot(env) ? 'on' : 'off',
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

  /**
   * The cron tick. This is what "no human interaction" actually means: every
   * active campaign advances by one batch, on the schedule in wrangler.toml.
   *
   * Three properties this handler needs and a request handler does not:
   *
   *   - It refuses to send unless OUTREACH_AUTOPILOT is exactly "true", so
   *     deploying the Worker does not by itself start a campaign.
   *   - One campaign's failure does not stop the others; each is caught.
   *   - It reports to the log, because the log is the only place anyone will
   *     ever see what it did.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tick(env, new Date(event.scheduledTime)))
  },
}

export async function tick(env: Env, now: Date): Promise<RunReport[]> {
  if (!isAutopilot(env)) {
    console.log('autopilot off (OUTREACH_AUTOPILOT is not "true") — no campaigns run')
    return []
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('autopilot cannot run: supabase is not configured')
    return []
  }

  const db = new Supabase(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
  const limits = limitsFrom(env)

  const campaigns = await db.list<Campaign>('campaigns', {
    filters: { status: 'eq.active' },
    order: 'created_at.asc',
    limit: 25,
  })

  const reports: RunReport[] = []
  for (const campaign of campaigns) {
    try {
      const report = await runCampaign(campaign, db, env, limits, now)
      reports.push(report)
      console.log('campaign run', JSON.stringify(report))
    } catch (error) {
      // One broken campaign must not stop the rest. Logged rather than
      // rethrown, because a throw here would abandon every campaign after it.
      console.error(`campaign ${campaign.name} failed`, error)
      reports.push({
        ...emptyReport(campaign.name),
        stoppedBecause: error instanceof Error ? error.message : 'run failed',
      })
    }
  }
  return reports
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

  if (match.name === 'run-campaign') {
    const id = assertUuid(match.id!, 'campaign id')
    const campaign = await db.getById<Campaign>('campaigns', id)
    if (!campaign) return json({ error: 'not found' }, 404)
    const report = await runCampaign(campaign, db, env, limits, now)
    return json({ report })
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

  // Lifetime, for the once-ever rule. A separate query rather than a wider
  // window on the one above, because "ever" and "recently" are different
  // questions and collapsing them would silently retire the rolling cap.
  const lifetime = await db.list<{ id: string }>('outreach_messages', {
    select: 'id',
    filters: { contact_id: `eq.${contactId}`, status: 'eq.sent' },
    limit: 1,
  })

  const result = evaluateGate({
    contact: {
      phone_e164: contact.phone_e164,
      opt_in_state: contact.opt_in_state,
      last_inbound_at: contact.last_inbound_at,
      opt_in_method: contact.opt_in_method,
    },
    template: template
      ? { name: template.name, category: template.category, meta_status: template.meta_status }
      : null,
    renderedBody,
    recentSendCount: recent.length,
    lifetimeSendCount: lifetime.length,
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
    // Carried onto the contact so the claim guard can tell an opt-in the
    // person initiated from one the business recorded on their behalf.
    // Cleared on opt-out so a later re-subscribe cannot inherit it.
    opt_in_method: optingIn ? values.method : null,
    ...(optingIn ? { opted_in_at: occurredAt } : { opted_out_at: occurredAt }),
  })

  return json({ data: updated ?? contact, event }, 201)
}

// ── Autopilot ──────────────────────────────────────────────────────────────

/**
 * Runs one batch of one campaign.
 *
 * Called by the cron handler and by POST /api/campaigns/:id/run, so the
 * scheduled path and the manual path cannot drift apart — a manual trigger
 * that behaved differently from the real thing would be a rehearsal of the
 * wrong play.
 *
 * The order of checks matters and is not an accident:
 *
 *   1. Campaign must be active.
 *   2. Template must still be approved by Meta — re-read every run, because
 *      Meta can pause a template at any time and nobody here would notice.
 *   3. Daily budget and batch size, whichever is smaller.
 *   4. For each candidate: personalise, then gate, then send.
 *
 * Every step that cannot be completed safely skips that contact and records
 * why. Nothing here retries, escalates, or improvises — an unattended process
 * that improvises is how a list gets emptied into WhatsApp.
 */
export async function runCampaign(
  campaign: Campaign,
  db: Supabase,
  env: Env,
  baseLimits: Limits,
  now: Date,
): Promise<RunReport> {
  const report = emptyReport(campaign.name)

  if (campaign.status !== 'active') {
    report.stoppedBecause = `campaign is ${campaign.status}`
    return report
  }

  const template = await db.getById<MessageTemplate>('message_templates', campaign.template_id)
  if (!template) {
    report.stoppedBecause = 'template no longer exists'
    return report
  }
  // Re-read rather than trusted from when the campaign was created. Meta can
  // pause or reject a template after approval, and a scheduler that cached the
  // old verdict would keep sending against it.
  if (template.meta_status !== 'approved') {
    report.stoppedBecause = `template is ${template.meta_status}, not approved by Meta`
    // Park the campaign so it stops burning cron ticks until someone looks.
    await db.update('campaigns', campaign.id, { status: 'paused' })
    return report
  }

  const sentToday = await countSentToday(db, campaign.id, now, env.APP_TIMEZONE)
  const allowance = allowanceForRun(campaign, sentToday)
  if (allowance <= 0) {
    report.stoppedBecause = `daily cap reached (${sentToday}/${campaign.daily_cap})`
    return report
  }

  const property = campaign.property_id
    ? await db.getById<Property>('properties', campaign.property_id)
    : null

  const reclaimed = await reclaimStuckSending(db, campaign.id, now)
  if (reclaimed > 0) {
    noteReason(report, `reclaimed ${reclaimed} row(s) stranded in sending`)
  }

  const alreadyDone = await sentContactIds(db, campaign.id)
  const limits = limitsForCampaign(baseLimits)

  // Paged rather than one over-fetched read.
  //
  // A single `limit: allowance * 5` looked sufficient and was not: contacts are
  // ordered oldest-first, so once a campaign has worked through its first few
  // hundred people, every row in that window is already done and the run sends
  // nothing while reporting no problem. Paging walks past them instead.
  const candidates = await collectCandidates(db, campaign, alreadyDone, allowance)
  if (candidates.length === 0) {
    report.stoppedBecause = 'no eligible contacts left in this audience'
  }

  for (const contact of candidates) {
    if (report.sent >= allowance) break
    report.considered += 1

    const built = draftFor(campaign, template, contact, property, renderTemplate)
    if ('skip' in built) {
      report.skipped += 1
      noteReason(report, built.skip)
      continue
    }

    const gate = await runGate(db, contact.id, template.id, built.body, limits, now)
    if (!gate || !gate.result.allowed) {
      report.blocked += 1
      for (const blocker of gate?.result.blockers ?? [{ code: 'CONTACT_MISSING', detail: '' }]) {
        noteReason(report, blocker.code)
      }
      continue
    }

    // The row is written before the send, not after. If the send throws or the
    // isolate is evicted mid-flight, the row exists in `sending` and the
    // unique index stops the next tick re-drafting the same contact — the
    // failure mode being avoided is a duplicate message, which to the
    // recipient is indistinguishable from spam.
    let row: OutreachMessage
    try {
      row = await db.insert<OutreachMessage>('outreach_messages', {
        campaign_id: campaign.id,
        contact_id: contact.id,
        property_id: campaign.property_id,
        template_id: template.id,
        language: contact.language || template.language,
        rendered_body: built.body,
        variables: built.variables,
        status: 'sending',
        block_reasons: [],
      })
    } catch (error) {
      // 23505 from the once-per-campaign index: another tick got there first.
      // Not an error worth reporting, just a race resolving correctly.
      if (error instanceof SupabaseError && error.code === '23505') continue
      throw error
    }

    try {
      const outcome = await letsbot.send(letsbotConfig(env), {
        kind: 'template',
        phone: contact.phone_e164,
        templateName: template.name,
        language: row.language,
        variables: built.variables,
        body: built.body,
      })

      if (!outcome.delivered) {
        // Dry run. The row is parked as approved so a later live run picks it
        // up, rather than counted as sent — the number has to be true.
        await db.update('outreach_messages', row.id, {
          status: 'approved',
          approved_at: now.toISOString(),
          approved_by: 'autopilot (dry run)',
        })
        report.skipped += 1
        noteReason(report, 'dry run — OUTREACH_LIVE is not "true"')
        continue
      }

      await db.update('outreach_messages', row.id, {
        status: 'sent',
        sent_at: now.toISOString(),
        provider_message_id: outcome.providerMessageId,
        approved_by: 'autopilot',
        approved_at: now.toISOString(),
      })
      report.sent += 1
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'send failed'
      await db.update('outreach_messages', row.id, { status: 'failed', error: detail })
      report.failed += 1
      noteReason(report, detail)
      // Stop the batch on a provider failure rather than working through the
      // list. If LetsBot is rejecting sends — bad credentials, a suspended
      // number, a rate limit — every remaining attempt fails the same way, and
      // hammering a suspended number is how a suspension becomes a ban.
      report.stoppedBecause = 'stopped after a provider failure'
      break
    }
  }

  await db.update('campaigns', campaign.id, {
    last_run_at: now.toISOString(),
    sent_count: campaign.sent_count + report.sent,
  })

  return report
}

/** How many rows one page of a paged read pulls. */
const PAGE = 500

/**
 * Walks the audience until it has enough contacts this campaign has not
 * already handled.
 *
 * Stops as soon as it has `wanted`, so a campaign near the start of its list
 * costs one query. The page budget bounds the worst case — a campaign whose
 * audience is entirely done exits after 20 pages rather than paging forever
 * inside a cron tick that has a wall-clock limit.
 */
async function collectCandidates(
  db: Supabase,
  campaign: Campaign,
  alreadyDone: Set<string>,
  wanted: number,
): Promise<Contact[]> {
  const picked: Contact[] = []
  for (let page = 0; page < 20 && picked.length < wanted; page++) {
    const rows = await db.list<Contact>('contacts', {
      filters: audienceFilters(campaign),
      order: 'created_at.asc',
      limit: PAGE,
      offset: page * PAGE,
    })
    for (const row of rows) {
      if (alreadyDone.has(row.id)) continue
      picked.push(row)
      if (picked.length >= wanted) break
    }
    if (rows.length < PAGE) break
  }
  return picked
}

/**
 * Contacts this campaign has already produced a message for.
 *
 * Paged rather than capped. A single capped read looked fine and was not: once
 * a campaign passed the cap, the set came back incomplete, contacts that had
 * already been messaged looked eligible again, and every one of them was
 * re-drafted only to be rejected by the database's unique index. The campaign
 * would then spend its whole batch losing races and send nothing — a stall that
 * reports success, which is the worst kind for something nobody is watching.
 */
async function sentContactIds(db: Supabase, campaignId: string): Promise<Set<string>> {
  const seen = new Set<string>()
  for (let page = 0; page < 40; page++) {
    const rows = await db.list<{ contact_id: string }>('outreach_messages', {
      select: 'contact_id',
      filters: { campaign_id: `eq.${campaignId}`, status: 'neq.cancelled' },
      order: 'created_at.asc',
      limit: PAGE,
      offset: page * PAGE,
    })
    for (const row of rows) seen.add(row.contact_id)
    if (rows.length < PAGE) return seen
  }
  // 20,000 rows in one campaign. Say so rather than silently under-reporting:
  // past this point the unique index is the only thing preventing duplicates.
  console.warn(`campaign ${campaignId}: more than ${40 * PAGE} messages, dedupe set truncated`)
  return seen
}

/**
 * Frees rows stranded mid-send.
 *
 * A row is written as `sending` before the request goes out, so an isolate that
 * dies in flight leaves it there forever. Nothing else would ever clear it: the
 * campaign's dedupe filter counts it as done, and the cancel route refuses to
 * touch a `sending` row. That contact would simply never be messaged, silently.
 *
 * Only rows older than the window are touched, so a send genuinely in progress
 * in a concurrent tick is left alone. They become `failed` rather than
 * `approved`: we do not know whether the provider received the message, and
 * assuming it did not is how someone gets it twice.
 */
async function reclaimStuckSending(db: Supabase, campaignId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 15 * 60 * 1000).toISOString()
  const stuck = await db.list<{ id: string }>('outreach_messages', {
    select: 'id',
    filters: {
      campaign_id: `eq.${campaignId}`,
      status: 'eq.sending',
      updated_at: `lt.${cutoff}`,
    },
    limit: 50,
  })
  for (const row of stuck) {
    await db.update('outreach_messages', row.id, {
      status: 'failed',
      error: 'stranded in sending — the run did not finish; delivery unknown',
    })
  }
  return stuck.length
}

async function countSentToday(
  db: Supabase,
  campaignId: string,
  now: Date,
  timeZone: string | undefined,
): Promise<number> {
  // Midnight in the configured zone, not UTC. With APP_TIMEZONE at Asia/Dubai
  // a UTC day boundary would reset the cap at 04:00 local, handing the
  // campaign a second day's budget in the middle of the night.
  const today = localDate(timeZone, now)
  const rows = await db.list<{ id: string }>('outreach_messages', {
    select: 'id',
    filters: {
      campaign_id: `eq.${campaignId}`,
      status: 'eq.sent',
      sent_at: `gte.${zoneMidnightIso(today, timeZone, now)}`,
    },
    limit: 1001,
  })
  return rows.length
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
    // An invalid zone must not take the campaign runner down; fall back to UTC.
    return now.toISOString().slice(0, 10)
  }
}

/**
 * Start of `date` in `timeZone`, as an instant.
 *
 * Derived by measuring the zone's actual offset at `now` rather than assuming
 * one, so it stays correct across a DST change without a timezone library.
 */
export function zoneMidnightIso(date: string, timeZone: string | undefined, now: Date): string {
  const offsetMs = zoneOffsetMs(timeZone, now)
  return new Date(Date.parse(`${date}T00:00:00Z`) - offsetMs).toISOString()
}

function zoneOffsetMs(timeZone: string | undefined, at: Date): number {
  if (!timeZone) return 0
  try {
    // Format the same instant as if it were UTC, then diff: the gap is the
    // zone's offset at that instant.
    const asZone = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(at)
    const [datePart, timePart] = asZone.split(', ')
    const parsed = Date.parse(`${datePart}T${timePart}Z`)
    if (Number.isNaN(parsed)) return 0
    return parsed - at.getTime()
  } catch {
    return 0
  }
}

// ── Public route handlers ──────────────────────────────────────────────────

/**
 * Records an opt-in from the public form.
 *
 * Upserts by phone: someone who signs up twice, or who signed up after
 * previously opting out, must land on the same contact row. A second row would
 * split their history, and an opt-out recorded against one row would leave the
 * other still sendable.
 */
async function optInSubmit(
  request: Request,
  db: Supabase,
  businessName: string,
  businessNumber?: string,
): Promise<Response> {
  let submission: ReturnType<typeof parseSubmission>
  try {
    submission = parseSubmission(new URLSearchParams(await request.text()))
  } catch (error) {
    const message = error instanceof OptInError ? error.message : 'Something went wrong.'
    return html(optInPageHtml(businessName, message, businessNumber), 400)
  }

  const at = new Date().toISOString()
  const existing = await db.list<Contact>('contacts', {
    filters: { phone_e164: `eq.${submission.phone}` },
    limit: 1,
  })

  let contact = existing[0] ?? null
  if (!contact) {
    contact = await db.insert<Contact>('contacts', {
      phone_e164: submission.phone,
      full_name: submission.name,
      contact_type: submission.contactType,
      source: 'web opt-in form',
    })
  } else if (submission.name && !contact.full_name) {
    await db.update('contacts', contact.id, { full_name: submission.name })
  }

  await db.insert('consent_events', {
    contact_id: contact.id,
    event: 'opt_in',
    channel: 'whatsapp',
    method: 'website_form',
    evidence_note: evidenceNote(request, at),
    occurred_at: at,
    recorded_by: 'optin-page',
  })
  await db.update('contacts', contact.id, { opt_in_state: 'opted_in', opted_in_at: at, opt_in_method: 'website_form' })

  return html(optInDoneHtml(businessName))
}

/**
 * Handles an inbound message from the provider.
 *
 * Always answers 200, even for a payload it could not parse. A webhook that
 * returns an error gets retried, and a provider retrying a message it has
 * already delivered is noise; worse, a parse failure that 500s can make a
 * provider disable the webhook entirely — which would silently stop opt-outs
 * being recorded.
 */
async function handleInbound(request: Request, db: Supabase): Promise<Response> {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return json({ ok: true, note: 'unparseable body ignored' })
  }

  const inbound = parseInbound(payload)
  if (!inbound) return json({ ok: true, note: 'no message found in payload' })

  const phone = normalisePhone(inbound.phone)
  const at = inbound.at ?? new Date().toISOString()
  const intent = classifyInbound(inbound.text)

  const existing = await db.list<Contact>('contacts', {
    filters: { phone_e164: `eq.${phone}` },
    limit: 1,
  })
  let contact = existing[0] ?? null

  if (!contact) {
    // Someone writing to the business from a number not on file. Create the
    // row so the opt-out below has something to attach to — an opt-out from an
    // unknown number that we drop on the floor is the worst outcome here.
    contact = await db.insert<Contact>('contacts', {
      phone_e164: phone,
      source: 'inbound whatsapp message',
    })
  }

  if (intent === 'opt_out') {
    await db.insert('consent_events', {
      contact_id: contact.id,
      event: 'opt_out',
      channel: 'whatsapp',
      method: 'user_request',
      evidence_note: `inbound message: ${inbound.text.slice(0, 200)}`,
      occurred_at: at,
      recorded_by: 'inbound-webhook',
    })
    await db.update('contacts', contact.id, {
      opt_in_state: 'opted_out',
      opted_out_at: at,
      last_inbound_at: at,
    })
    return json({ ok: true, intent, contact_id: contact.id })
  }

  // Their own message is the evidence, so this is the one consent method that
  // needs nothing else attached. An existing opt-out is NOT overturned by a
  // later message: someone who said stop and then asks an unrelated question
  // has not re-subscribed.
  if (contact.opt_in_state !== 'opted_out') {
    await db.insert('consent_events', {
      contact_id: contact.id,
      event: 'opt_in',
      channel: 'whatsapp',
      method: 'inbound_message',
      evidence_note: `inbound message: ${inbound.text.slice(0, 200)}`,
      occurred_at: at,
      recorded_by: 'inbound-webhook',
    })
    await db.update('contacts', contact.id, {
      opt_in_state: 'opted_in',
      opted_in_at: at,
      opt_in_method: 'inbound_message',
      last_inbound_at: at,
    })
  } else {
    // Still record that they wrote, without touching their opt-out.
    await db.update('contacts', contact.id, { last_inbound_at: at })
  }

  return json({ ok: true, intent, contact_id: contact.id })
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

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The opt-in page takes user input and is public. No inline scripts are
      // used, so the strictest policy that still renders is the right one.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      'referrer-policy': 'no-referrer',
    },
  })
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
