import { describe, expect, it } from 'vitest'
import { buildPayload, endpointUrl, extractMessageId, send } from '../src/letsbot'

const CONFIG = {
  apiKey: 'test-key',
  apiBase: 'https://api.letsbot.net',
  sendPath: '/v1/messages',
  live: false,
}

describe('endpointUrl', () => {
  it('joins base and path without doubling the slash', () => {
    expect(endpointUrl({ apiBase: 'https://api.letsbot.net/', sendPath: '/v1/messages' }))
      .toBe('https://api.letsbot.net/v1/messages')
    expect(endpointUrl({ apiBase: 'https://api.letsbot.net', sendPath: 'v1/messages' }))
      .toBe('https://api.letsbot.net/v1/messages')
  })
})

describe('buildPayload', () => {
  it('uses the confirmed field names for a text message', () => {
    // `phone` and `body` are the two names LetsBot's own PHP client proves.
    expect(buildPayload({ kind: 'text', phone: '+971501234567', body: 'Hello' }))
      .toEqual({ phone: '+971501234567', body: 'Hello' })
  })

  it('carries template variables positionally', () => {
    expect(buildPayload({
      kind: 'template',
      phone: '+971501234567',
      templateName: 'listing_intro',
      language: 'en',
      variables: ['Sara', 'Marina'],
      body: 'Hi Sara, a unit in Marina is available.',
    })).toEqual({
      phone: '+971501234567',
      type: 'template',
      template: { name: 'listing_intro', language: 'en', variables: ['Sara', 'Marina'] },
    })
  })
})

describe('send in dry-run mode', () => {
  it('transmits nothing and returns the exact payload', async () => {
    // The whole point: the send path can be verified against the provider's
    // docs without spending a real message on a real number.
    let called = false
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}')
    }) as typeof fetch

    try {
      const outcome = await send(CONFIG, {
        kind: 'text',
        phone: '+971501234567',
        body: 'Hello',
      })
      expect(called).toBe(false)
      expect(outcome.delivered).toBe(false)
      expect(outcome.providerMessageId).toBeNull()
      expect(outcome.request.url).toBe('https://api.letsbot.net/v1/messages')
      expect(outcome.request.body).toEqual({ phone: '+971501234567', body: 'Hello' })
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('extractMessageId', () => {
  it('finds the id across the shapes a BSP might return', () => {
    expect(extractMessageId({ message_id: 'wamid.1' })).toBe('wamid.1')
    expect(extractMessageId({ messageId: 'wamid.2' })).toBe('wamid.2')
    expect(extractMessageId({ data: { id: 'wamid.3' } })).toBe('wamid.3')
    expect(extractMessageId({ messages: [{ id: 'wamid.4' }] })).toBe('wamid.4')
  })

  it('returns null rather than throwing on an unrecognised shape', () => {
    // A message that was accepted but whose id we could not parse has still
    // been delivered. Recording it as failed would invite a duplicate send.
    expect(extractMessageId({ ok: true })).toBeNull()
    expect(extractMessageId(null)).toBeNull()
    expect(extractMessageId('accepted')).toBeNull()
  })
})
