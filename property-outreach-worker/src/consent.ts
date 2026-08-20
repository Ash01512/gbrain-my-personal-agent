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
  | 'TEMPLATE_REQUIRED'
  | 'TEMPLATE_NOT_APPROVED'
  | 'ALREADY_MESSAGED'
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
  /** How the current opt-in was obtained. See SELF_INITIATED_METHODS. */
  opt_in_method?: string | null
}

/**
 * Opt-in methods where the PERSON came to the business.
 *
 * This is the second half of the claim guard's evidence. `last_inbound_at`
 * proves they wrote on WhatsApp, but someone who filled in the web form or
 * tapped a click-to-WhatsApp ad also genuinely reached out — copy referring to
 * their enquiry is true for them, and blocking it would be wrong.
 *
 * The methods NOT on this list are the whole point. `imported_documented`
 * covers a list from somewhere else, and `phone_recorded` means the business
 * called them; neither is the person expressing interest, so a claim that they
 * did stays blocked. `in_person_written` is deliberately excluded too — a
 * signature on a sheet at an event does not establish that they enquired about
 * anything.
 */
const SELF_INITIATED_METHODS = new Set([
  'website_form',
  'click_to_whatsapp_ad',
  'inbound_message',
])

/**
 * Whether the database can show this person made contact first.
 *
 * The claim guard's entire question. Exported so the campaign runner and the
 * dashboard ask it the same way rather than each reimplementing the rule.
 */
export function hasProvenContact(contact: GateContact): boolean {
  if (contact.last_inbound_at) return true
  if (contact.opt_in_state !== 'opted_in') return false
  return SELF_INITIATED_METHODS.has(contact.opt_in_method ?? '')
}

export interface GateTemplate {
  name: string
  category: TemplateCategory
  meta_status: MetaStatus
}

export interface GateLimits {
  maxPerContact: number
  windowDays: number
  /**
   * One message per contact, ever. The campaign policy this system was built
   * for: a single first-contact message, never a sequence. It is also the
   * cheapest protection there is — a person who hears from you once and is not
   * interested simply ignores it, where a follow-up is what earns the Block.
   */
  oncePerContact: boolean
}

export interface GateInput {
  contact: GateContact
  /**
   * Required. This system is template-only: every message it sends is a
   * one-off first contact, which WhatsApp permits solely through a template
   * Meta has approved. Free-form is legal for 24 hours after someone writes to
   * you, but that is a conversation, and a conversation is not what runs
   * unattended on a schedule.
   */
  template: GateTemplate | null
  renderedBody: string
  /** Messages already sent to this contact inside the cap window. */
  recentSendCount: number
  /** Messages ever sent to this contact, for the once-ever rule. */
  lifetimeSendCount: number
  limits: GateLimits
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
  { pattern: /\byou (?:previously |earlier |recently )?(?:requested|asked)\b/i, label: 'claims they asked for something' },
  { pattern: /\byou (?:told|informed|let) (?:me|us)\b/i, label: 'claims they told us something' },
  { pattern: /\byou (?:were|are) looking (?:for|at|to)\b/i, label: 'claims to know what they were looking for' },
  { pattern: /\bwe (?:spoke|talked|met|connected)\b/i, label: 'claims a prior conversation' },
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
  const { contact, template, renderedBody, recentSendCount, lifetimeSendCount, limits, now } =
    input
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

  if (!template) {
    blockers.push({
      code: 'TEMPLATE_REQUIRED',
      detail: 'every message this system sends must use a template Meta approved',
    })
  } else if (template.meta_status !== 'approved') {
    blockers.push({
      code: 'TEMPLATE_NOT_APPROVED',
      detail: `template "${template.name}" is ${template.meta_status}, not approved by Meta`,
    })
  }

  // The claim guard. Applies whether or not the template is approved: Meta
  // approves the *shape* of a template, and never verified that this
  // particular recipient did the thing the copy says they did.
  if (!hasProvenContact(contact)) {
    const claims = unsupportedClaims(body)
    if (claims.length > 0) {
      blockers.push({
        code: 'UNSUPPORTED_CLAIM',
        detail: `nothing on file shows this person contacted you, but the text ${claims.join('; ')}`,
      })
    }
  }

  if (limits.oncePerContact && lifetimeSendCount > 0) {
    blockers.push({
      code: 'ALREADY_MESSAGED',
      detail: 'this contact has already had their one message',
    })
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
