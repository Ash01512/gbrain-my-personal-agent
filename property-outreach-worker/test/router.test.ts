import { describe, expect, it } from 'vitest'
import { listOptionsFromSearch, matchRoute, queueOptions, windowStart } from '../src/router'

describe('matchRoute', () => {
  it('serves the dashboard at the root', () => {
    expect(matchRoute('GET', '/')).toEqual({ name: 'ui' })
    expect(matchRoute('POST', '/')).toBe('method-not-allowed')
  })

  it('maps collections to their Supabase tables', () => {
    expect(matchRoute('GET', '/api/contacts')).toEqual({ name: 'list', table: 'contacts' })
    expect(matchRoute('GET', '/api/templates')).toEqual({
      name: 'list',
      table: 'message_templates',
    })
    expect(matchRoute('POST', '/api/properties')).toEqual({
      name: 'create',
      table: 'properties',
    })
  })

  it('routes the outreach verbs separately from CRUD', () => {
    expect(matchRoute('POST', '/api/draft')).toEqual({
      name: 'draft',
      table: 'outreach_messages',
    })
    expect(matchRoute('GET', '/api/queue')).toEqual({
      name: 'queue',
      table: 'outreach_messages',
    })
    expect(matchRoute('POST', '/api/outreach/abc/approve')).toEqual({
      name: 'approve',
      table: 'outreach_messages',
      id: 'abc',
    })
    expect(matchRoute('POST', '/api/outreach/abc/send')).toMatchObject({ name: 'send' })
    expect(matchRoute('POST', '/api/outreach/abc/cancel')).toMatchObject({ name: 'cancel' })
  })

  it('keeps approve and send as distinct verbs', () => {
    // Merging them would mean a failed send needs a fresh approval, and that
    // an approval could not be given ahead of time.
    expect(matchRoute('POST', '/api/outreach/abc/approve')).not.toEqual(
      matchRoute('POST', '/api/outreach/abc/send'),
    )
  })

  it('exposes consent as append and read only', () => {
    expect(matchRoute('POST', '/api/contacts/abc/consent')).toEqual({
      name: 'consent',
      table: 'contacts',
      id: 'abc',
    })
    expect(matchRoute('GET', '/api/contacts/abc/consent')).toMatchObject({
      name: 'consent-history',
    })
    // An audit trail you can edit is not an audit trail.
    expect(matchRoute('PATCH', '/api/contacts/abc/consent')).toBe('method-not-allowed')
    expect(matchRoute('DELETE', '/api/contacts/abc/consent')).toBe('method-not-allowed')
  })

  it('does not expose the consent ledger as a collection', () => {
    // Reachable only through a contact, so a write always names whose consent
    // it is.
    expect(matchRoute('GET', '/api/consent-events')).toBeNull()
    expect(matchRoute('POST', '/api/consent_events')).toBeNull()
  })

  it('ignores trailing slashes', () => {
    expect(matchRoute('GET', '/api/contacts/')).toEqual({ name: 'list', table: 'contacts' })
  })

  it('separates unknown paths from unsupported verbs', () => {
    expect(matchRoute('GET', '/api/nope')).toBeNull()
    expect(matchRoute('GET', '/nope')).toBeNull()
    expect(matchRoute('DELETE', '/api/health')).toBe('method-not-allowed')
    expect(matchRoute('POST', '/api/queue')).toBe('method-not-allowed')
    expect(matchRoute('POST', '/api/outreach/abc/nonsense')).toBeNull()
  })
})

describe('listOptionsFromSearch', () => {
  it('matches a phone exactly rather than by substring', () => {
    // A partial match here would let a lookup act on the wrong person.
    const options = listOptionsFromSearch(
      new URLSearchParams('phone=%2B971501234567'),
      'contacts',
    )
    expect(options.filters.phone_e164).toBe('eq.+971501234567')
  })

  it('gates filters by the table that has the column', () => {
    const contacts = listOptionsFromSearch(new URLSearchParams('area=Marina'), 'contacts')
    expect(contacts.filters.area).toBeUndefined()
    const properties = listOptionsFromSearch(new URLSearchParams('area=Marina'), 'properties')
    expect(properties.filters.area).toBe('ilike.*Marina*')
  })

  it('clamps paging', () => {
    expect(listOptionsFromSearch(new URLSearchParams('limit=9999'), 'contacts').limit).toBe(200)
    expect(listOptionsFromSearch(new URLSearchParams('limit=0'), 'contacts').limit).toBe(1)
    expect(listOptionsFromSearch(new URLSearchParams('limit=junk'), 'contacts').limit).toBe(50)
    expect(listOptionsFromSearch(new URLSearchParams('offset=-5'), 'contacts').offset).toBe(0)
  })
})

describe('queueOptions', () => {
  it('shows blocked rows alongside the ones awaiting a decision', () => {
    // A queue that hides its problems looks finished when it is not.
    const options = queueOptions(new URLSearchParams())
    expect(options.filters.status).toContain('blocked')
    expect(options.filters.status).toContain('draft')
    expect(options.filters.status).toContain('approved')
  })

  it('narrows to one status when asked', () => {
    expect(queueOptions(new URLSearchParams('status=sent')).filters.status).toBe('eq.sent')
  })
})

describe('windowStart', () => {
  it('walks back the configured number of days', () => {
    expect(windowStart(new Date('2026-08-20T12:00:00Z'), 30))
      .toBe('2026-07-21T12:00:00.000Z')
  })
})
