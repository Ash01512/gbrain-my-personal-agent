// Opt-out handling is the highest-stakes code in this repository.
//
// Everything else risks a message not being sent. This risks a message being
// sent to someone who told you to stop — which is the complaint Meta acts on
// fastest, and the one that ends a number. Every case below is a real way a
// person types "stop".

import { describe, expect, it } from 'vitest'
import {
  classifyInbound,
  normalise,
  normalisePhone,
  parseInbound,
  secretMatches,
} from '../src/inbound'

describe('classifyInbound — opt-out', () => {
  const stops = [
    'STOP',
    'stop',
    '  Stop  ',
    'Stop.',
    'stop!',
    'Please stop',
    'unsubscribe',
    'UNSUBSCRIBE',
    'remove me',
    'Remove me please',
    'opt out',
    'optout',
    'no more messages',
    "don't contact me",
    'do not contact me',
  ]

  for (const text of stops) {
    it(`treats "${text}" as an opt-out`, () => {
      expect(classifyInbound(text)).toBe('opt_out')
    })
  }

  const arabic = ['إيقاف', 'ايقاف', 'الغاء', 'إلغاء', 'توقف', 'لا تراسلني']

  for (const text of arabic) {
    it(`treats "${text}" as an opt-out`, () => {
      // LetsBot's market is Saudi and the Gulf. A person who types إيقاف and
      // keeps receiving messages presses Block, and Block is the signal Meta
      // rates the number on.
      expect(classifyInbound(text)).toBe('opt_out')
    })
  }

  it('normalises alef forms so a different keyboard still opts out', () => {
    expect(normalise('إيقاف')).toBe(normalise('ايقاف'))
    expect(classifyInbound('أيقاف')).toBe('opt_out')
  })

  it('opts out on a mixed message rather than guessing', () => {
    // Ambiguous to a human, unambiguous here. Being wrong this way costs a
    // lead; being wrong the other way costs the number.
    expect(classifyInbound('stop sending me villas, but call me about Marina'))
      .toBe('opt_out')
  })

  it('does not fire on a stop word inside another word', () => {
    // A guard that opts people out of a conversation they wanted is its own
    // kind of failure.
    expect(classifyInbound('I stopped by the villa today')).toBe('opt_in')
    expect(classifyInbound('the bus stopped outside')).toBe('opt_in')
    expect(classifyInbound('Is there a workshop nearby?')).toBe('opt_in')
  })
})

describe('classifyInbound — everything else', () => {
  it('treats an ordinary message as consent to reply', () => {
    expect(classifyInbound('Hi, is the Marina unit still available?')).toBe('opt_in')
    expect(classifyInbound('نعم مهتم')).toBe('opt_in')
  })

  it('treats an empty message as neither', () => {
    // An image with no caption. Not consent, not an opt-out.
    expect(classifyInbound('')).toBe('message')
    expect(classifyInbound('   ')).toBe('message')
  })
})

describe('parseInbound', () => {
  it('reads a flat payload', () => {
    expect(parseInbound({ phone: '+971501234567', body: 'Hello' })).toMatchObject({
      phone: '+971501234567',
      text: 'Hello',
    })
  })

  it('unwraps the nestings a BSP might use', () => {
    expect(parseInbound({ data: { from: '971501234567', text: 'Hi' } })).toMatchObject({
      phone: '+971501234567',
      text: 'Hi',
    })
    expect(parseInbound({ messages: [{ wa_id: '971501234567', body: 'Hi' }] }))
      .toMatchObject({ phone: '+971501234567' })
  })

  it('returns null rather than throwing on a shape it does not know', () => {
    // A parser that throws would drop an opt-out on the floor.
    expect(parseInbound({ status: 'delivered' })).toBeNull()
    expect(parseInbound(null)).toBeNull()
    expect(parseInbound('nonsense')).toBeNull()
  })

  it('accepts unix seconds and milliseconds as well as ISO', () => {
    expect(parseInbound({ phone: '+971501234567', timestamp: '1755691200' })?.at)
      .toBe('2025-08-20T12:00:00.000Z')
    expect(parseInbound({ phone: '+971501234567', timestamp: '1755691200000' })?.at)
      .toBe('2025-08-20T12:00:00.000Z')
    expect(parseInbound({ phone: '+971501234567', timestamp: '2026-08-20T12:00:00Z' })?.at)
      .toBe('2026-08-20T12:00:00.000Z')
  })

  it('survives a missing body', () => {
    expect(parseInbound({ phone: '+971501234567' })?.text).toBe('')
  })
})

describe('normalisePhone', () => {
  it('adds the + a provider may omit', () => {
    // Whether the row is found or duplicated turns on this. A duplicate is how
    // an opt-out gets recorded against one row while the other stays sendable.
    expect(normalisePhone('971501234567')).toBe('+971501234567')
    expect(normalisePhone('+971501234567')).toBe('+971501234567')
    expect(normalisePhone('+971 50 123 4567')).toBe('+971501234567')
    expect(normalisePhone('+971-50-123-4567')).toBe('+971501234567')
  })

  it('leaves something unrecognisable alone rather than inventing a +', () => {
    expect(normalisePhone('not-a-number')).toBe('notanumber')
  })
})

describe('secretMatches', () => {
  it('accepts the right secret and rejects everything else', () => {
    expect(secretMatches('abc123', 'abc123')).toBe(true)
    expect(secretMatches('abc124', 'abc123')).toBe(false)
    expect(secretMatches('abc12', 'abc123')).toBe(false)
  })

  it('fails closed when no secret is configured', () => {
    // Otherwise a deployment that forgot the secret would accept forged
    // opt-ins from anyone who found the URL.
    expect(secretMatches('anything', undefined)).toBe(false)
    expect(secretMatches('', undefined)).toBe(false)
    expect(secretMatches('', '')).toBe(false)
  })
})
