// The send gate.
//
// Everything else in this Worker is CRUD. This file is the reason it exists:
// it is the last thing between a drafted message and a WhatsApp number that
// can be banned for sending it. Meta's Business Messaging Policy requires
// prior opt-in for every business-initiated message, and undocumented consent
// is the leading cause of Business account restrictions. There is no appeal
// worth relying on, so the rule is enforced here rather than trusted to
// whoever is clicking Approve at the time.
//
// Deliberately pure: no database, no fetch, no clock of its own. The caller
// loads the rows and passes `now`. That makes every branch below testable
// without a network, which matters for the one piece of logic in this
// repository that cannot be allowed to fail open.

/** Every reason a message can be refused. Stored on the row and shown in the UI. */
export type BlockCode =
  | 'INVALID_PHONE'
  | 'NO_OPT_IN'
  | 'OPTED_OUT'
  | 'TEMPLATE_MISSING'
  | 'TEMPLATE_NOT_APPROVED'
  | 'FREEFORM_OUTSIDE_WINDOW'
  | 'UNSUPPORTED_CLAIM'
  | 'FREQUENCY_CAP'
  | 'EMPTY_BODY'

export interface Blocker {
  code: BlockCode
  /** Written for the person reading the queue, not for a log. */
  detail: string
}

export type OptInState = 'unknown' | 'opted_in' | 'opted_out'
export type TemplateCategory = 'marketing' | 'utility' | 'authentication'
export type MetaStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'paused' | 'disabled'

export interface GateContact {
  phone_e164: string
  opt_in_state: OptInState
  /** Last time this person messaged us. Null means they never have. */
  last_inbound_at: string | null
}

export interface GateTemplate {
  name: string
  category: TemplateCategory
  meta_status: MetaStatus
}

export interface GateInput {
  contact: GateContact
  /** Null means the draft is free-form, which is only legal inside the window. */
  template: GateTemplate | null
  renderedBody: string
  /** Messages already sent to this contact inside the cap window. */
  recentSendCount: number
  limits: { maxPerContact: number; windowDays: number }
  now: Date
}

export interface GateResult {
  allowed: boolean
  blockers: Blocker[]
}

/**
 * WhatsApp accepts E.164 only: a leading +, a non-zero country code, and 8–15
 * digits total. Sheet exports are full of `05x…` local forms and numbers
 * mangled by a spreadsheet into scientific notation, and both are silently
 * undeliverable — so they are caught here rather than at the provider.
 */
const E164_RE = /^\+[1-9]\d{7,14}$/

export function isE164(value: unknown): value is string {
  return typeof value === 'string' && E164_RE.test(value)
}

/** Milliseconds in the customer-service window WhatsApp opens on an inbound. */
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Phrases that assert a prior relationship with the recipient.
 *
 * This is the guard that this project was actually built around. Outreach
 * built from listing-agent sheets reaches people who have never contacted the
 * sender, and the tempting opener — "you showed interest in one of our
 * properties" — is both untrue and the single fastest route to a block-and-
 * report, which is what Meta's quality signal is made of. One campaign of it
 * is enough to lose the number.
 *
 * So a claim of prior contact is only allowed when the database can show
 * prior contact: `contacts.last_inbound_at` is set, meaning that person really
 * did message this business. Otherwise the draft is refused and the copy has
 * to say what is actually true — which converts better anyway, because the
 * recipient can tell the difference.
 */
const PRIOR_CONTACT_CLAIMS: { pattern: RegExp; label: string }[] = [
  { pattern: /\byou (?:had |have )?(?:previously |earlier )?(?:showed|shown|expressed)\b[^.!?]{0,30}\binterest\b/i, label: 'claims they showed interest' },
  { pattern: /\byou (?:previously |earlier |recently )?(?:enquired|inquired)\b/i, label: 'claims they enquired' },
  { pattern: /\byou (?:previously |earlier |recently )?(?:contacted|approached|reached out|got in touch)\b/i, label: 'claims they contacted us' },
  { pattern: /\byou (?:previously |earlier |recently )?(?:registered|signed up|submitted|filled)\b/i, label: 'claims they registered' },
  { pattern: /\byou (?:previously |earlier |recently )?(?:requested|asked for|asked about)\b/i, label: 'claims they requested something' },
  { pattern: /\byour (?:recent |previous |earlier )?(?:enquiry|inquiry|request|viewing|visit|interest|registration)\b/i, label: 'refers to their enquiry' },
  { pattern: /\bas (?:we |previously )?discussed\b/i, label: 'claims a prior discussion' },
  { pattern: /\b(?:following up|further) (?:on|to) (?:your|our)\b/i, label: 'claims a prior exchange' },
  { pattern: /\b(?:when|since) we (?:last )?(?:spoke|talked|met)\b/i, label: 'claims a prior conversation' },
  { pattern: /\bour (?:last|previous|earlier) (?:call|conversation|chat|meeting)\b/i, label: 'claims a prior conversation' },
  { pattern: /\bthanks? (?:you )?for (?:your |the )?(?:enquiry|inquiry|interest|message|call)\b/i, label: 'thanks them for contact that did not happen' },
]

/**
 * Returns the claims a body makes about a prior relationship. Exported so the
 * dashboard can mark the offending phrase while the copy is being written,
 * rather than only at approval time.
 */
export function unsupportedClaims(body: string): string[] {
  const found: string[] = []
  for (const { pattern, label } of PRIOR_CONTACT_CLAIMS) {
    const match = body.match(pattern)
    if (match) found.push(`${label} ("${match[0].trim()}")`)
  }
  return [...new Set(found)]
}

/** True while WhatsApp's 24-hour free-form window is open. */
export function serviceWindowOpen(lastInboundAt: string | null, now: Date): boolean {
  if (!lastInboundAt) return false
  const last = Date.parse(lastInboundAt)
  if (Number.isNaN(last)) return false
  const elapsed = now.getTime() - last
  // A future timestamp is corrupt data, not an open window. Treating it as
  // open would let a bad import unlock free-form sending to a cold contact.
  return elapsed >= 0 && elapsed < SERVICE_WINDOW_MS
}

/**
 * Decides whether one drafted message may be sent.
 *
 * Collects every blocker rather than returning the first: someone fixing a
 * queue wants the whole list, and a gate that reveals problems one at a time
 * trains people to click Approve repeatedly until it stops complaining.
 */
export function evaluateGate(input: GateInput): GateResult {
  const { contact, template, renderedBody, recentSendCount, limits, now } = input
  const blockers: Blocker[] = []

  if (!isE164(contact.phone_e164)) {
    blockers.push({
      code: 'INVALID_PHONE',
      detail: `"${contact.phone_e164}" is not E.164 — WhatsApp needs a leading + and country code`,
    })
  }

  if (contact.opt_in_state === 'opted_out') {
    blockers.push({
      code: 'OPTED_OUT',
      detail: 'this contact asked not to be messaged',
    })
  } else if (contact.opt_in_state !== 'opted_in') {
    blockers.push({
      code: 'NO_OPT_IN',
      detail:
        'no recorded WhatsApp opt-in — record one against evidence before messaging this person',
    })
  }

  const body = renderedBody.trim()
  if (!body) {
    blockers.push({ code: 'EMPTY_BODY', detail: 'nothing to send' })
  }

  const windowOpen = serviceWindowOpen(contact.last_inbound_at, now)

  if (!template) {
    // Free-form is legal only inside the 24 hours after they messaged us.
    if (!windowOpen) {
      blockers.push({
        code: 'FREEFORM_OUTSIDE_WINDOW',
        detail:
          'free-form messages are only allowed within 24h of their last message — use an approved template',
      })
    }
  } else if (template.meta_status !== 'approved') {
    blockers.push({
      code: 'TEMPLATE_NOT_APPROVED',
      detail: `template "${template.name}" is ${template.meta_status}, not approved by Meta`,
    })
  }

  // The claim guard. Applies whether or not the template is approved: Meta
  // approves the *shape* of a template, and never verified that this
  // particular recipient did the thing the copy says they did.
  if (!contact.last_inbound_at) {
    const claims = unsupportedClaims(body)
    if (claims.length > 0) {
      blockers.push({
        code: 'UNSUPPORTED_CLAIM',
        detail: `this person has never messaged you, but the text ${claims.join('; ')}`,
      })
    }
  }

  if (recentSendCount >= limits.maxPerContact) {
    blockers.push({
      code: 'FREQUENCY_CAP',
      detail: `already sent ${recentSendCount} in the last ${limits.windowDays} days (cap ${limits.maxPerContact})`,
    })
  }

  return { allowed: blockers.length === 0, blockers }
}

/**
 * Substitutes {{1}}-style placeholders, the form the WhatsApp API uses.
 *
 * Throws on a count mismatch rather than sending a message with a visible
 * `{{2}}` in it — and because the API rejects a payload whose variable count
 * differs from the approved template with error 132000 anyway.
 */
export function renderTemplate(body: string, values: string[]): string {
  const placeholders = new Set(
    [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])),
  )
  const expected = placeholders.size
  if (expected !== values.length) {
    throw new TemplateRenderError(
      `template expects ${expected} variable${expected === 1 ? '' : 's'}, got ${values.length}`,
    )
  }
  for (const index of placeholders) {
    if (index < 1 || index > values.length) {
      throw new TemplateRenderError(`placeholder {{${index}}} is out of range`)
    }
  }
  return body.replace(/\{\{(\d+)\}\}/g, (_, digits: string) => values[Number(digits) - 1] ?? '')
}

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateRenderError'
  }
}
