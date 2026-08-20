// Configuration that fails open is the failure mode that costs a WhatsApp
// number, so the defaults get their own tests.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isLive, limitsFrom, type Env } from '../src/index'

const ROOT = join(import.meta.dirname, '..')

function env(overrides: Partial<Env> = {}): Env {
  return {
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'key',
    API_TOKEN: 'token',
    ...overrides,
  }
}

describe('isLive', () => {
  it('arms only on the exact string "true"', () => {
    expect(isLive(env({ OUTREACH_LIVE: 'true' }))).toBe(true)
  })

  it('stays a dry run for every other value', () => {
    // "false", "0" and "no" are all truthy strings. A truthiness check here
    // would arm a WhatsApp sender on a config typo.
    for (const value of ['false', '0', 'no', 'TRUE', 'yes', '', undefined]) {
      expect(isLive(env({ OUTREACH_LIVE: value })), String(value)).toBe(false)
    }
  })
})

describe('limitsFrom', () => {
  it('reads the configured caps', () => {
    expect(limitsFrom(env({ OUTREACH_MAX_PER_CONTACT: '3', OUTREACH_WINDOW_DAYS: '14' })))
      .toEqual({ maxPerContact: 3, windowDays: 14 })
  })

  it('falls back to safe values rather than permissive ones', () => {
    // A malformed cap must not become Infinity — holding under a fat-fingered
    // config is the entire point of a cap.
    for (const value of ['', 'junk', '0', '-5', undefined]) {
      expect(limitsFrom(env({ OUTREACH_MAX_PER_CONTACT: value })).maxPerContact, String(value))
        .toBe(2)
    }
  })

  it('clamps an absurd cap', () => {
    expect(limitsFrom(env({ OUTREACH_MAX_PER_CONTACT: '10000' })).maxPerContact).toBe(20)
    expect(limitsFrom(env({ OUTREACH_WINDOW_DAYS: '99999' })).windowDays).toBe(365)
  })
})

describe('wrangler.toml', () => {
  const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8')

  it('ships with sending disarmed', () => {
    // A repository that deploys live-by-default sends its first campaign
    // before anyone has read the send path.
    expect(toml).toMatch(/OUTREACH_LIVE\s*=\s*"false"/)
  })

  it('keeps secrets out', () => {
    // wrangler.toml is committed.
    for (const key of [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'API_TOKEN',
      'LETSBOT_API_KEY',
    ]) {
      expect(toml).not.toMatch(new RegExp(`^\\s*${key}\\s*=`, 'm'))
    }
  })

  it('does not share the job tracker Worker name', () => {
    // Two Workers, one account: a shared name would have one deploy silently
    // replace the other.
    expect(toml).toMatch(/name\s*=\s*"property-outreach-worker"/)
  })
})

describe('the root wrangler.toml still belongs to the job tracker', () => {
  it('does not point Cloudflare Git deploys at the outreach Worker', () => {
    // The outreach Worker is deployed by hand on purpose: the thing that
    // sends WhatsApp messages should go out when a human runs the command,
    // not when a commit lands.
    const root = readFileSync(join(ROOT, '..', 'wrangler.toml'), 'utf8')
    expect(root).toMatch(/name\s*=\s*"job-tracker-worker"/)
    expect(root).not.toMatch(/property-outreach/)
  })
})
