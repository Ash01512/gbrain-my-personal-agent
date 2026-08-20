// LetsBot send adapter.
//
// ── What is confirmed, and what is not ───────────────────────────────────
//
// LetsBot is an official Meta Business Partner and a WhatsApp BSP; its own
// API reference lives at docs.letsbot.net. That host is unreachable from the
// build environment this file was written in, so the request shape below is
// assembled from their published PHP client, which sets an `api_key` and
// sends `phone` and `body`. Those three field names are confirmed. The base
// URL, the path, and the template payload are NOT — they are inferred, and
// they are configuration rather than constants precisely because of that.
//
// Do not resolve this by guessing harder. Do this instead:
//
//   1. Open docs.letsbot.net and read the send endpoint.
//   2. Fix LETSBOT_API_BASE / LETSBOT_SEND_PATH in wrangler.toml, and the
//      field names below if they differ.
//   3. POST /api/outreach/:id/send with OUTREACH_LIVE still "false". The
//      response contains `request`, the exact payload that would have gone
//      out. Diff that against the docs.
//   4. Only then set OUTREACH_LIVE = "true".
//
// Step 3 is why dry-run exists. Verifying a send path by sending is how a
// number picks up its first block, and quality rating is not something you
// get to rebuild once it has fallen.

export interface LetsBotConfig {
  apiKey: string
  apiBase: string
  sendPath: string
  /** False makes send() build the payload and return it without calling out. */
  live: boolean
}

export interface SendTextRequest {
  kind: 'text'
  phone: string
  body: string
}

export interface SendTemplateRequest {
  kind: 'template'
  phone: string
  templateName: string
  language: string
  variables: string[]
  /** The substituted text, carried for logging and for the dry-run response. */
  body: string
}

export type SendRequest = SendTextRequest | SendTemplateRequest

export interface SendOutcome {
  /** False for a dry run: nothing was transmitted. */
  delivered: boolean
  providerMessageId: string | null
  /** Exactly what was (or would have been) POSTed. */
  request: { url: string; body: Record<string, unknown> }
  raw?: unknown
}

export class LetsBotError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly raw?: unknown,
  ) {
    super(message)
    this.name = 'LetsBotError'
  }
}

/**
 * Builds the outbound payload. Pure and exported so tests — and the dry run —
 * can inspect the exact bytes without a network.
 */
export function buildPayload(request: SendRequest): Record<string, unknown> {
  if (request.kind === 'text') {
    return { phone: request.phone, body: request.body }
  }
  return {
    phone: request.phone,
    type: 'template',
    template: {
      name: request.templateName,
      language: request.language,
      // Positional, matching {{1}}, {{2}} … in the approved template. A count
      // that differs from what Meta approved is rejected with error 132000,
      // which is why renderTemplate() refuses to produce one.
      variables: request.variables,
    },
  }
}

export function endpointUrl(config: Pick<LetsBotConfig, 'apiBase' | 'sendPath'>): string {
  const base = config.apiBase.replace(/\/+$/, '')
  const path = config.sendPath.startsWith('/') ? config.sendPath : `/${config.sendPath}`
  return `${base}${path}`
}

/**
 * Pulls a provider message id out of a response whose exact shape is not yet
 * confirmed. Tries the plausible keys and returns null rather than throwing:
 * a message that was accepted but whose id we failed to parse has still been
 * delivered, and recording it as failed would invite a duplicate send.
 */
export function extractMessageId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const direct = record.message_id ?? record.messageId ?? record.id
  if (typeof direct === 'string' && direct) return direct
  const data = record.data
  if (typeof data === 'object' && data !== null) return extractMessageId(data)
  const messages = record.messages
  if (Array.isArray(messages) && messages.length > 0) return extractMessageId(messages[0])
  return null
}

export async function send(config: LetsBotConfig, request: SendRequest): Promise<SendOutcome> {
  const url = endpointUrl(config)
  const body = buildPayload(request)

  if (!config.live) {
    return { delivered: false, providerMessageId: null, request: { url, body } }
  }
  if (!config.apiKey) {
    throw new LetsBotError('LETSBOT_API_KEY is not configured', 503)
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        // Both forms are sent because the PHP client only proves that an
        // `api_key` exists, not which header carries it. A BSP ignoring an
        // extra auth header is harmless; guessing wrong and retrying a send
        // is not.
        Authorization: `Bearer ${config.apiKey}`,
        'X-API-Key': config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw new LetsBotError('could not reach letsbot', 502)
  }

  const text = await response.text()
  const raw = text ? safeJson(text) : null

  if (!response.ok) {
    const detail = raw as { message?: string; error?: string } | null
    throw new LetsBotError(
      detail?.message || detail?.error || `letsbot rejected the send (${response.status})`,
      response.status >= 500 ? 502 : response.status,
      raw,
    )
  }

  return {
    delivered: true,
    providerMessageId: extractMessageId(raw),
    request: { url, body },
    raw,
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}
