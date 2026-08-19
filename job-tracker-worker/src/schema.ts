// Types and validation mirroring the job-tracker Supabase schema.
//
// The database is the source of truth: `status` columns carry CHECK
// constraints and `job_url` carries a unique index. Validating here turns
// what would be an opaque Postgres error into a 400 that names the field.

export const APPLICATION_STATUSES = [
  'saved',
  'applied',
  'screening',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
] as const

export const COVER_LETTER_STATUSES = ['draft', 'final', 'sent'] as const

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]
export type CoverLetterStatus = (typeof COVER_LETTER_STATUSES)[number]

export interface Application {
  id: string
  company: string
  role: string
  location: string | null
  job_url: string | null
  source: string | null
  status: ApplicationStatus
  applied_on: string | null
  last_contact_on: string | null
  salary_range: string | null
  contact_name: string | null
  contact_email: string | null
  notes: string | null
  /** 0-10 fit score written by the matching agent. */
  match_score: number | null
  match_rationale: string | null
  cv_version_id: string | null
  created_at: string
  updated_at: string
}

export interface CvVersion {
  id: string
  label: string
  content: string | null
  file_url: string | null
  target_role: string | null
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface CoverLetter {
  id: string
  application_id: string | null
  cv_version_id: string | null
  content: string | null
  status: CoverLetterStatus
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
  dates?: string[]
  /** [min, max] inclusive. */
  numbers?: Record<string, [number, number]>
  enums?: Record<string, readonly string[]>
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Validates a request body against a table's rules and returns only the
 * known columns. Unknown keys are dropped rather than rejected: PostgREST
 * would fail the whole write on an unknown column, and silently ignoring
 * a stray field is friendlier than a 400 for a typo in an optional key.
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
    } else if ((rules.dates ?? []).includes(key)) {
      if (typeof value !== 'string' || !DATE_RE.test(value)) {
        throw new ValidationError(`${key} must be a YYYY-MM-DD date`)
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

const APPLICATION_COLUMNS = [
  'company',
  'role',
  'location',
  'job_url',
  'source',
  'status',
  'applied_on',
  'last_contact_on',
  'salary_range',
  'contact_name',
  'contact_email',
  'notes',
  'match_score',
  'match_rationale',
  'cv_version_id',
]

const APPLICATION_RULES: Rules = {
  required: ['company', 'role'],
  strings: [
    'company',
    'role',
    'location',
    'job_url',
    'source',
    'salary_range',
    'contact_name',
    'contact_email',
    'notes',
    'match_rationale',
    'cv_version_id',
  ],
  dates: ['applied_on', 'last_contact_on'],
  numbers: { match_score: [0, 10] },
  enums: { status: APPLICATION_STATUSES },
}

const CV_VERSION_COLUMNS = ['label', 'content', 'file_url', 'target_role', 'is_default']

const CV_VERSION_RULES: Rules = {
  required: ['label'],
  strings: ['label', 'content', 'file_url', 'target_role'],
  booleans: ['is_default'],
}

const COVER_LETTER_COLUMNS = ['application_id', 'cv_version_id', 'content', 'status']

const COVER_LETTER_RULES: Rules = {
  strings: ['application_id', 'cv_version_id', 'content'],
  enums: { status: COVER_LETTER_STATUSES },
}

export function parseApplication(body: unknown, partial = false) {
  return validate(body, APPLICATION_COLUMNS, APPLICATION_RULES, { partial })
}

/**
 * A candidate role submitted by the matching agent. Stricter than a manual
 * create: `job_url` is required because it is both the dedupe key (unique
 * index) and the link the human clicks to actually apply, and a scored
 * candidate with no rationale is not reviewable.
 */
export function parseQueueItem(body: unknown): Record<string, unknown> {
  const values = validate(
    body,
    APPLICATION_COLUMNS,
    {
      ...APPLICATION_RULES,
      required: ['company', 'role', 'job_url', 'match_score', 'match_rationale'],
    },
    { partial: false },
  )
  // The agent queues candidates; it never marks them applied. Only the
  // apply endpoint may do that, and only when a human triggers it.
  values.status = 'saved'
  delete values.applied_on
  return values
}

export function parseCvVersion(body: unknown, partial = false) {
  return validate(body, CV_VERSION_COLUMNS, CV_VERSION_RULES, { partial })
}

export function parseCoverLetter(body: unknown, partial = false) {
  return validate(body, COVER_LETTER_COLUMNS, COVER_LETTER_RULES, { partial })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertUuid(value: string, label = 'id'): string {
  if (!UUID_RE.test(value)) throw new ValidationError(`${label} must be a UUID`)
  return value
}
