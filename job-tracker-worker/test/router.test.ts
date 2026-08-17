import { describe, expect, it } from 'vitest'
import { listOptionsFromSearch, matchRoute } from '../src/router'

describe('matchRoute', () => {
  it('serves the dashboard at the root', () => {
    expect(matchRoute('GET', '/')).toEqual({ name: 'ui' })
    expect(matchRoute('POST', '/')).toBe('method-not-allowed')
  })

  it('maps collections to their Supabase tables', () => {
    expect(matchRoute('GET', '/api/applications')).toEqual({
      name: 'list',
      table: 'applications',
    })
    expect(matchRoute('GET', '/api/cv-versions')).toEqual({
      name: 'list',
      table: 'cv_versions',
    })
    expect(matchRoute('POST', '/api/cover-letters')).toEqual({
      name: 'create',
      table: 'cover_letters',
    })
  })

  it('routes item verbs', () => {
    expect(matchRoute('GET', '/api/applications/abc')).toEqual({
      name: 'get',
      table: 'applications',
      id: 'abc',
    })
    expect(matchRoute('PATCH', '/api/applications/abc')).toMatchObject({ name: 'update' })
    expect(matchRoute('PUT', '/api/applications/abc')).toMatchObject({ name: 'update' })
    expect(matchRoute('DELETE', '/api/applications/abc')).toMatchObject({ name: 'delete' })
  })

  it('ignores trailing slashes', () => {
    expect(matchRoute('GET', '/api/applications/')).toEqual({
      name: 'list',
      table: 'applications',
    })
  })

  it('separates unknown paths from unsupported verbs', () => {
    expect(matchRoute('GET', '/api/nope')).toBeNull()
    expect(matchRoute('GET', '/nope')).toBeNull()
    expect(matchRoute('DELETE', '/api/applications')).toBe('method-not-allowed')
    expect(matchRoute('POST', '/api/health')).toBe('method-not-allowed')
  })

  it('rejects paths deeper than an item', () => {
    expect(matchRoute('GET', '/api/applications/abc/extra')).toBeNull()
  })
})

describe('listOptionsFromSearch', () => {
  const opts = (qs: string) => listOptionsFromSearch(new URLSearchParams(qs))

  it('defaults to newest first with a bounded page', () => {
    expect(opts('')).toEqual({ filters: {}, limit: 50, offset: 0, order: 'created_at.desc' })
  })

  it('builds PostgREST filter expressions', () => {
    expect(opts('status=applied').filters).toEqual({ status: 'eq.applied' })
    expect(opts('company=acme').filters).toEqual({ company: 'ilike.*acme*' })
    expect(opts('q=eng').filters).toEqual({ or: '(company.ilike.*eng*,role.ilike.*eng*)' })
  })

  it('clamps limit into range and ignores junk', () => {
    expect(opts('limit=5000').limit).toBe(200)
    expect(opts('limit=0').limit).toBe(1)
    expect(opts('limit=abc').limit).toBe(50)
    expect(opts('offset=-5').offset).toBe(0)
  })
})
