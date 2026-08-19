// Two wrangler configs exist on purpose, and that is a drift risk worth a test.
//
// job-tracker-worker/wrangler.toml is what `npm run dev` and `npm run deploy`
// use. The copy at the repository root exists so Cloudflare's Git integration
// works with its default settings — no root directory, no build command, no
// deploy command — because the field that would otherwise be needed does not
// appear in every version of the dashboard, and getting it wrong produces a
// green build that serves nothing.
//
// If they disagree, the Worker you test locally is not the Worker Cloudflare
// publishes, and nothing would say so.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const REPO = join(ROOT, '..')

/** Minimal TOML read for the flat keys these two files share. */
function values(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][\w-]*)\s*=\s*(.+?)\s*$/)
    if (!match || line.trimStart().startsWith('#')) continue
    out[match[1]!] = match[2]!.replace(/^["']|["']$/g, '')
  }
  return out
}

const local = values(join(ROOT, 'wrangler.toml'))
const root = values(join(REPO, 'wrangler.toml'))

describe('the two wrangler configs cannot drift apart', () => {
  it('agrees on the Worker name', () => {
    // The dashboard project name must match this, or the build fails outright.
    expect(root.name).toBe(local.name)
    expect(root.name).toBe('job-tracker-worker')
  })

  it('agrees on the compatibility date', () => {
    // A different date is a different runtime, silently.
    expect(root.compatibility_date).toBe(local.compatibility_date)
  })

  it('agrees on the timezone the daily count is filed under', () => {
    expect(root.APP_TIMEZONE).toBe(local.APP_TIMEZONE)
    expect(root.APP_TIMEZONE).toBe('Asia/Dubai')
  })

  it('keeps dashboard-set variables through a deploy', () => {
    // Without this, wrangler deletes every var not in the config on each
    // deploy. Three secrets added through the dashboard as plain variables
    // disappeared on the next push, and /api/health reported all three false.
    expect(root.keep_vars).toBe('true')
    expect(local.keep_vars).toBe('true')
  })

  it('points the root config at the real entrypoint', () => {
    expect(local.main).toBe('src/index.ts')
    expect(root.main).toBe('job-tracker-worker/src/index.ts')
  })

  it('keeps secrets out of both', () => {
    // wrangler.toml is committed. Only APP_TIMEZONE belongs in [vars].
    for (const [label, config] of [['root', root], ['local', local]] as const) {
      for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'API_TOKEN']) {
        expect(config[key], `${label} wrangler.toml must not contain ${key}`).toBeUndefined()
      }
    }
  })
})
