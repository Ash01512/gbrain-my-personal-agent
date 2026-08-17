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
  ],
  dates: ['applied_on', 'last_contact_on'],
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
