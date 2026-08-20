// Types and validation mirroring the property-outreach Supabase schema.
//
// The database carries the real constraints (CHECKs, unique indexes, the
// consent-evidence constraint). Validating here turns what would surface as an
// opaque Postgres error into a 400 that names the field.

import { isE164 } from './consent'

export const CONTACT_TYPES = ['owner', 'buyer', 'both', 'unknown'] as const
export const OPT_IN_STATES = ['unknown', 'opted_in', 'opted_out'] as const
export const CONSENT_EVENTS = ['opt_in', 'opt_out'] as const
export const CONSENT_METHODS = [
  'website_form',
  'click_to_whatsapp_ad',
  'inbound_message',
  'in_person_written',
  'phone_recorded',
  'imported_documented',
  'user_request',
] as const
export const TEMPLATE_CATEGORIES = ['marketing', 'utility', 'authentication'] as const
export const META_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'paused',
  'disabled',
] as const
export const OUTREACH_STATUSES = [
  'draft',
  'blocked',
  'approved',
  'sending',
  'sent',
  'failed',
  'cancelled',
] as const
export const LISTING_TYPES = ['sale', 'rent'] as const
export const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'done'] as const

export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]

export type ContactType = (typeof CONTACT_TYPES)[number]
export type OptInState = (typeof OPT_IN_STATES)[number]
export type ConsentEventName = (typeof CONSENT_EVENTS)[number]
export type ConsentMethod = (typeof CONSENT_METHODS)[number]
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]
export type MetaStatus = (typeof META_STATUSES)[number]
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number]

export interface Property {
  id: string
  reference: string | null
  title: string
  property_type: string | null
  area: string | null
  city: string | null
  bedrooms: number | null
  bathrooms: number | null
  size_sqft: number | null
  price: number | null
  currency: string
  listing_type: (typeof LISTING_TYPES)[number]
  listing_agent: string | null
  source_sheet: string | null
  url: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Contact {
  id: string
  phone_e164: string
  full_name: string | null
  email: string | null
  contact_type: ContactType
  language: string
  source: string | null
  source_detail: string | null
  opt_in_state: OptInState
  /**
   * How the current opt-in was obtained, denormalised from consent_events so
   * the gate can ask whether this person came to us without a second query.
   */
  opt_in_method: ConsentMethod | null
  opted_in_at: string | null
  opted_out_at: string | null
  last_inbound_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface ConsentEvent {
  id: string
  contact_id: string
  event: ConsentEventName
  channel: 'whatsapp'
  method: ConsentMethod
  evidence_url: string | null
  evidence_note: string | null
  occurred_at: string
  recorded_by: string | null
  created_at: string
}

export interface MessageTemplate {
  id: string
  name: string
  language: string
  category: TemplateCategory
  body: string
  variables: string[]
  meta_status: MetaStatus
  meta_rejection_reason: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Campaign {
  id: string
  name: string
  template_id: string
  status: CampaignStatus
  audience_contact_type: ContactType | null
  audience_language: string | null
  /** Ordered `contact.<col>` / `property.<col>` sources for {{1}}, {{2}} … */
  variable_sources: string[]
  property_id: string | null
  daily_cap: number
  batch_size: number
  sent_count: number
  last_run_at: string | null
  created_at: string
  updated_at: string
}

export interface OutreachMessage {
  id: string
  campaign_id: string | null
  contact_id: string
  property_id: string | null
  template_id: string | null
  language: string
  rendered_body: string
  variables: string[]
  status: OutreachStatus
  block_reasons: string[]
  provider: string
  provider_message_id: string | null
  error: string | null
  approved_at: string | null
  approved_by: string | null
  sent_at: string | null
  created_at: string
  updated_at: string
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

type Rules = {
  required?: string[]
  strings?: string[]
  booleans?: string[]
  timestamps?: string[]
  /** [min, max] inclusive. */
  numbers?: Record<string, [number, number]>
  urls?: string[]
  phones?: string[]
  /** Must be an array of strings. */
  stringArrays?: string[]
  enums?: Record<string, readonly string[]>
}

/**
 * Only http and https may be stored.
 *
 * Evidence URLs and listing URLs come from third parties and are rendered as
 * anchors in the dashboard. A `javascript:` URL there executes on the Worker's
 * own origin, where it can read the API token out of localStorage — and that
 * token fronts a service-role key that bypasses RLS. Rejected at the door
 * here; ui.ts re-checks at the sink.
 */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:'])

export function isSafeUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return SAFE_URL_SCHEMES.has(new URL(value).protocol)
  } catch {
    return false
  }
}

function isTimestamp(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/**
 * Validates a body against a table's rules and returns only known columns.
 * Unknown keys are dropped rather than rejected: PostgREST fails the whole
 * write on an unknown column, and ignoring a stray field beats a 400 for a
 * typo in something optional.
 */
function validate(
  body: unknown,
  allowed: string[],
  rules: Rules,
  { partial }: { partial: boolean },
): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('body must be a JSON object')
  }
  const input = body as Record<string, unknown>

  if (!partial) {
    for (const field of rules.required ?? []) {
      const value = input[field]
      if (value === undefined || value === null || value === '') {
        throw new ValidationError(`${field} is required`)
      }
    }
  }

  const out: Record<string, unknown> = {}
  for (const key of allowed) {
    if (!(key in input)) continue
    const value = input[key]

    if (value === null) {
      if ((rules.required ?? []).includes(key)) {
        throw new ValidationError(`${key} cannot be null`)
      }
      out[key] = null
      continue
    }

    if (rules.enums?.[key]) {
      const options = rules.enums[key]
      if (typeof value !== 'string' || !options.includes(value)) {
        throw new ValidationError(`${key} must be one of: ${options.join(', ')}`)
      }
    } else if ((rules.phones ?? []).includes(key)) {
      if (!isE164(value)) {
        throw new ValidationError(
          `${key} must be E.164, e.g. +971501234567 — a local form like 0501234567 is undeliverable`,
        )
      }
    } else if ((rules.urls ?? []).includes(key)) {
      if (!isSafeUrl(value)) {
        throw new ValidationError(`${key} must be an http or https URL`)
      }
    } else if ((rules.stringArrays ?? []).includes(key)) {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new ValidationError(`${key} must be an array of strings`)
      }
    } else if (rules.numbers?.[key]) {
      const [min, max] = rules.numbers[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationError(`${key} must be a number`)
      }
      if (value < min || value > max) {
        throw new ValidationError(`${key} must be between ${min} and ${max}`)
      }
    } else if ((rules.booleans ?? []).includes(key)) {
      if (typeof value !== 'boolean') {
        throw new ValidationError(`${key} must be a boolean`)
      }
    } else if ((rules.timestamps ?? []).includes(key)) {
      if (!isTimestamp(value)) {
        throw new ValidationError(`${key} must be an ISO 8601 timestamp`)
      }
    } else if ((rules.strings ?? []).includes(key)) {
      if (typeof value !== 'string') {
        throw new ValidationError(`${key} must be a string`)
      }
    }

    out[key] = value
  }

  if (partial && Object.keys(out).length === 0) {
    throw new ValidationError('no updatable fields supplied')
  }
  return out
}

const PROPERTY_COLUMNS = [
  'reference', 'title', 'property_type', 'area', 'city', 'bedrooms', 'bathrooms',
  'size_sqft', 'price', 'currency', 'listing_type', 'listing_agent', 'source_sheet',
  'url', 'notes',
]

const PROPERTY_RULES: Rules = {
  required: ['title'],
  strings: ['reference', 'title', 'property_type', 'area', 'city', 'currency',
    'listing_agent', 'source_sheet', 'notes'],
  urls: ['url'],
  numbers: {
    bedrooms: [0, 100],
    bathrooms: [0, 100],
    size_sqft: [0, 10_000_000],
    price: [0, 100_000_000_000],
  },
  enums: { listing_type: LISTING_TYPES },
}

/**
 * `opt_in_state` and its timestamps are absent on purpose.
 *
 * Consent is only ever changed by appending to consent_events, which is what
 * POST /api/contacts/:id/consent does. If an import could set opted_in
 * directly there would be a path to a message with no evidence behind it, and
 * that path is the one that gets numbers banned. See migrations/0000_init.sql.
 */
const CONTACT_COLUMNS = [
  'phone_e164', 'full_name', 'email', 'contact_type', 'language',
  'source', 'source_detail', 'last_inbound_at', 'notes',
]

const CONTACT_RULES: Rules = {
  required: ['phone_e164'],
  strings: ['full_name', 'email', 'language', 'source', 'source_detail', 'notes'],
  phones: ['phone_e164'],
  timestamps: ['last_inbound_at'],
  enums: { contact_type: CONTACT_TYPES },
}

const CONSENT_COLUMNS = [
  'event', 'method', 'evidence_url', 'evidence_note', 'occurred_at', 'recorded_by',
]

const CONSENT_RULES: Rules = {
  required: ['event', 'method'],
  strings: ['evidence_note', 'recorded_by'],
  urls: ['evidence_url'],
  timestamps: ['occurred_at'],
  enums: { event: CONSENT_EVENTS, method: CONSENT_METHODS },
}

const TEMPLATE_COLUMNS = [
  'name', 'language', 'category', 'body', 'variables', 'meta_status',
  'meta_rejection_reason', 'notes',
]

const TEMPLATE_RULES: Rules = {
  required: ['name', 'body'],
  strings: ['name', 'language', 'body', 'meta_rejection_reason', 'notes'],
  stringArrays: ['variables'],
  enums: { category: TEMPLATE_CATEGORIES, meta_status: META_STATUSES },
}

const CAMPAIGN_COLUMNS = [
  'name', 'template_id', 'status', 'audience_contact_type', 'audience_language',
  'variable_sources', 'property_id', 'daily_cap', 'batch_size',
]

const CAMPAIGN_RULES: Rules = {
  required: ['name', 'template_id'],
  strings: ['name', 'template_id', 'audience_language', 'property_id'],
  stringArrays: ['variable_sources'],
  // Bounded here as well as by the database CHECK. An unattended sender with
  // an unbounded daily cap is the failure mode this whole file guards against,
  // and a 400 naming the field beats a constraint violation.
  numbers: { daily_cap: [1, 1000], batch_size: [1, 100] },
  enums: {
    status: CAMPAIGN_STATUSES,
    audience_contact_type: CONTACT_TYPES,
  },
}

/**
 * `sent_count` and `last_run_at` are absent: they are the runner's own record
 * of what it did, and a caller that could edit them could hide a campaign that
 * had already blown through its cap.
 */
export function parseCampaign(body: unknown, partial = false) {
  const values = validate(body, CAMPAIGN_COLUMNS, CAMPAIGN_RULES, { partial })
  for (const source of (values.variable_sources as string[] | undefined) ?? []) {
    if (!/^(contact|property)\.[a-z_]+$/.test(source)) {
      throw new ValidationError(
        `variable source "${source}" must look like contact.full_name or property.area`,
      )
    }
  }
  return values
}

export function parseProperty(body: unknown, partial = false) {
  return validate(body, PROPERTY_COLUMNS, PROPERTY_RULES, { partial })
}

export function parseContact(body: unknown, partial = false) {
  return validate(body, CONTACT_COLUMNS, CONTACT_RULES, { partial })
}

export function parseTemplate(body: unknown, partial = false) {
  return validate(body, TEMPLATE_COLUMNS, TEMPLATE_RULES, { partial })
}

/**
 * A consent record. The database also enforces that an opt-in carries
 * evidence; this repeats the rule so the caller gets a sentence instead of a
 * constraint name, and so the requirement is visible where it is written.
 */
export function parseConsent(body: unknown) {
  const values = validate(body, CONSENT_COLUMNS, CONSENT_RULES, { partial: false })
  if (
    values.event === 'opt_in' &&
    values.method !== 'inbound_message' &&
    !values.evidence_url &&
    !values.evidence_note
  ) {
    throw new ValidationError(
      'an opt_in needs evidence_url or evidence_note — record where and when they agreed',
    )
  }
  values.channel = 'whatsapp'
  return values
}

/**
 * A draft queued by the agent.
 *
 * `status` and `block_reasons` are not accepted from the caller: they are the
 * gate's verdict, and a drafting agent that could set its own status could
 * post a row straight to `approved` and skip the human entirely.
 */
const DRAFT_COLUMNS = [
  'contact_id', 'property_id', 'template_id', 'language', 'rendered_body', 'variables',
]

const DRAFT_RULES: Rules = {
  required: ['contact_id', 'rendered_body'],
  strings: ['contact_id', 'property_id', 'template_id', 'language', 'rendered_body'],
  stringArrays: ['variables'],
}

export function parseDraft(body: unknown, partial = false) {
  return validate(body, DRAFT_COLUMNS, DRAFT_RULES, { partial })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertUuid(value: string, label = 'id'): string {
  if (!UUID_RE.test(value)) throw new ValidationError(`${label} must be a UUID`)
  return value
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
