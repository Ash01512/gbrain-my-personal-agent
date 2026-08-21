// Configuration that fails open is the failure mode that costs a WhatsApp
// number, so the defaults get their own tests.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import worker, { isAutopilot, isLive, limitsFrom, type Env } from '../src/index'

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

describe('isAutopilot', () => {
  it('arms only on the exact string "true"', () => {
    expect(isAutopilot(env({ OUTREACH_AUTOPILOT: 'true' }))).toBe(true)
  })

  it('stays off for every other value', () => {
    // Deploying the Worker must not by itself start a campaign.
    for (const value of ['false', '0', 'no', 'TRUE', 'yes', '', undefined]) {
      expect(isAutopilot(env({ OUTREACH_AUTOPILOT: value })), String(value)).toBe(false)
    }
  })

  it('is independent of live sending', () => {
    // Autopilot in dry run is the rehearsal: the schedule fires, real contacts
    // are selected, payloads are built and logged, nothing is transmitted.
    const rehearsal = env({ OUTREACH_AUTOPILOT: 'true', OUTREACH_LIVE: 'false' })
    expect(isAutopilot(rehearsal)).toBe(true)
    expect(isLive(rehearsal)).toBe(false)
  })
})

describe('limitsFrom', () => {
  it('reads the configured caps', () => {
    expect(limitsFrom(env({ OUTREACH_MAX_PER_CONTACT: '3', OUTREACH_WINDOW_DAYS: '14' })))
      .toEqual({ maxPerContact: 3, windowDays: 14, oncePerContact: true })
  })

  it('keeps the once-per-contact rule non-configurable', () => {
    // One message per person is the policy, not a setting. There is no env var
    // that turns it off, and the database enforces it again.
    for (const value of ['false', 'no', '0', undefined]) {
      expect(
        limitsFrom(env({ OUTREACH_MAX_PER_CONTACT: value })).oncePerContact,
        String(value),
      ).toBe(true)
    }
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

  it('ships with autopilot disarmed', () => {
    // Deploying must not by itself start messaging people.
    expect(toml).toMatch(/OUTREACH_AUTOPILOT\s*=\s*"false"/)
  })

  it('has a cron trigger, or autopilot never fires', () => {
    expect(toml).toMatch(/\[triggers\]/)
    expect(toml).toMatch(/crons\s*=/)
  })

  it('exports a scheduled handler for that cron to call', () => {
    // The cron and the handler are configured in two different files. If the
    // export were missing or renamed, Cloudflare would fire the trigger every
    // hour into nothing, and the only symptom would be that no message ever
    // goes out — which looks exactly like an empty contact list.
    expect(typeof worker.scheduled).toBe('function')
    expect(typeof worker.fetch).toBe('function')
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

describe('a sibling root wrangler.toml cannot hijack this deploy', () => {
  it('does not point Cloudflare Git deploys at the outreach Worker', () => {
    // Only meaningful inside the monorepo, where a root wrangler.toml drives
    // Cloudflare's Git integration for job-tracker-worker. If it ever named
    // this Worker, a plain `git push` would redeploy the thing that sends
    // WhatsApp messages — which is precisely what deploying by hand avoids.
    //
    // Absent once this folder is its own repository, and that is the safe
    // state, so the check skips rather than failing.
    const rootConfig = join(ROOT, '..', 'wrangler.toml')
    if (!existsSync(rootConfig)) return

    const root = readFileSync(rootConfig, 'utf8')
    expect(root).not.toMatch(/property-outreach/)
  })
})
