// Inbound handling: the webhook LetsBot calls when someone writes to the
// business number.
//
// Without this the system is a sender with nobody to send to. Two things
// arrive here, and both matter more than anything outbound:
//
//   1. STOP. Honouring an opt-out is not a feature, it is the condition of
//      being allowed to send at all, and it has to work when the message is
//      lowercase, padded with spaces, in Arabic, or wrapped in politeness.
//      Every branch below fails towards recording the opt-out.
//   2. A first message from a person, which is consent to reply and the only
//      evidence that any "you contacted us" claim is true.
//
// LetsBot's webhook payload shape is not confirmed — docs.letsbot.net was
// unreachable when this was written — so the parser accepts the shapes a BSP
// plausibly sends and returns null rather than guessing. See letsbot.ts.

export interface InboundMessage {
  phone: string
  text: string
  /** ISO timestamp of the inbound, or null if the payload carried none. */
  at: string | null
}

export type InboundIntent = 'opt_out' | 'opt_in' | 'message'

/**
 * Opt-out keywords, English and Arabic.
 *
 * Arabic is not optional here: LetsBot's market is Saudi and the Gulf, and a
 * person who types إيقاف and keeps receiving messages will press Block and
 * report the number — which costs far more than any campaign is worth.
 *
 * Matched as whole words against the normalised text, so "stop" triggers but
 * "stopped by the villa today" does not.
 */
const OPT_OUT_WORDS = [
  'stop',
  'unsubscribe',
  'remove me',
  'opt out',
  'optout',
  'cancel',
  'do not contact',
  "don't contact",
  'no more messages',
  'إيقاف',
  'ايقاف',
  'الغاء',
  'إلغاء',
  'توقف',
  'ازالة',
  'إزالة',
  'لا تراسلني',
]

/**
 * Strips Arabic diacritics and normalises alef forms so أ إ آ all compare as ا.
 *
 * Without this, إيقاف typed with a different alef fails to match and the
 * person's opt-out is silently ignored.
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْٰ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Decides what an inbound message means.
 *
 * Opt-out wins over everything. A message reading "stop sending me villas, but
 * call me about the Marina one" is ambiguous to a human and unambiguous here:
 * it contains a stop word, so it stops. Being wrong in that direction costs a
 * lead; being wrong in the other costs the number.
 */
export function classifyInbound(text: string): InboundIntent {
  const normalised = normalise(text)
  if (!normalised) return 'message'

  for (const word of OPT_OUT_WORDS) {
    const target = normalise(word)
    if (!target) continue
    // Whole-word / whole-phrase match against the normalised text.
    const pattern = new RegExp(`(^|\\s)${escapeRegex(target)}($|\\s)`, 'u')
    if (pattern.test(normalised)) return 'opt_out'
  }

  // Anyone who writes to the business first has opened a conversation, which
  // is consent to reply to them. Recorded with method 'inbound_message', the
  // one consent method whose evidence is the message itself.
  return 'opt_in'
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Pulls a phone, text and timestamp out of a webhook body.
 *
 * Tolerant by design: the exact envelope LetsBot posts is unconfirmed, and a
 * parser that throws on an unexpected shape would drop an opt-out on the
 * floor. Returns null when nothing usable is present, and the caller answers
 * 200 anyway so the provider does not retry forever.
 */
export function parseInbound(payload: unknown): InboundMessage | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as Record<string, unknown>

  // Unwrap the common nestings before looking for fields. `messages` is the
  // plural Meta's own Cloud API webhook uses and most BSPs mirror, so its
  // absence here would have dropped every real inbound on the floor.
  for (const key of ['data', 'message', 'messages', 'entry', 'changes', 'value', 'payload']) {
    const nested = record[key]
    if (Array.isArray(nested) && nested.length > 0) {
      const found = parseInbound(nested[0])
      if (found) return found
    } else if (typeof nested === 'object' && nested !== null) {
      const found = parseInbound(nested)
      if (found) return found
    }
  }

  const phone = firstString(record, ['phone', 'from', 'sender', 'wa_id', 'msisdn'])
  if (!phone) return null

  const text =
    firstString(record, ['body', 'text', 'message_body', 'content', 'caption']) ?? ''
  const at = firstString(record, ['timestamp', 'created_at', 'sent_at', 'time'])

  return { phone: normalisePhone(phone), text, at: toIso(at) }
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

/**
 * Puts a leading + on a bare international number.
 *
 * Providers vary on whether they send `971501234567` or `+971501234567`, and
 * the difference decides whether the contact lookup finds the existing row or
 * creates a duplicate — and a duplicate is how an opt-out gets recorded
 * against one row while the other stays sendable.
 */
export function normalisePhone(raw: string): string {
  const trimmed = raw.replace(/[\s()\-.]/g, '')
  if (trimmed.startsWith('+')) return trimmed
  if (/^\d{8,15}$/.test(trimmed)) return `+${trimmed}`
  return trimmed
}

/** Accepts ISO strings and unix seconds/milliseconds, which BSPs mix freely. */
function toIso(value: string | null): string | null {
  if (!value) return null
  if (/^\d+$/.test(value)) {
    const number = Number(value)
    // Ten digits is seconds, thirteen is milliseconds.
    const ms = value.length <= 10 ? number * 1000 : number
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

/**
 * Constant-time compare for the webhook secret.
 *
 * The inbound endpoint cannot sit behind API_TOKEN — LetsBot will not send it
 * — so it is authenticated by a secret in the path instead. That makes the
 * secret the only thing stopping anyone who finds the URL from forging an
 * opt-in for a number they do not own.
 */
export function secretMatches(presented: string, expected: string | undefined): boolean {
  if (!expected) return false
  if (presented.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}
