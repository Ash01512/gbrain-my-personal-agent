// `src/auth.ts` and `src/supabase.ts` are copies of job-tracker-worker's, so
// this Worker is a self-contained project that can live in its own repository.
//
// Copying buys independence and costs drift. That trade is only acceptable if
// the drift is caught, and it matters most for `auth.ts`: this Worker holds a
// Supabase service-role key that bypasses RLS, so its token check IS the
// security boundary. A copy that quietly fell behind a fix to the original is
// exactly the bug nobody notices.
//
// The originals will not exist once this folder is extracted into its own
// repository. That is expected, and these tests skip rather than fail — a red
// suite in the extracted repo would be noise, not a finding.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = join(import.meta.dirname, '..')
const ORIGINAL = join(HERE, '..', 'job-tracker-worker', 'src')

/** Everything above the first `export` is this project's own provenance note. */
function body(source: string): string {
  const start = source.indexOf('export ')
  return start === -1 ? source : source.slice(start)
}

const VENDORED = ['auth', 'supabase']

describe('vendored copies have not drifted', () => {
  for (const name of VENDORED) {
    it(`${name}.ts matches job-tracker-worker's copy`, () => {
      const originalPath = join(ORIGINAL, `${name}.ts`)
      if (!existsSync(originalPath)) {
        // Extracted repository: nothing to compare against.
        return
      }
      const ours = readFileSync(join(HERE, 'src', `${name}.ts`), 'utf8')
      const theirs = readFileSync(originalPath, 'utf8')
      expect(body(ours)).toBe(body(theirs))
    })
  }

  it('says where each copy came from', () => {
    // Without the note, the next person to read these files has no way to know
    // they are copies, and will fix a bug in only one of them.
    for (const name of VENDORED) {
      const source = readFileSync(join(HERE, 'src', `${name}.ts`), 'utf8')
      expect(source, name).toContain('Vendored from job-tracker-worker')
    }
  })
})

describe('the project stands alone', () => {
  it('imports nothing from outside its own folder', () => {
    // The whole point of vendoring. A `../../` import would build here and
    // fail the moment this folder became its own repository.
    for (const file of ['index', 'campaign', 'consent', 'inbound', 'letsbot', 'optin', 'router', 'schema', 'ui']) {
      const source = readFileSync(join(HERE, 'src', `${file}.ts`), 'utf8')
      const escapes = source
        .split('\n')
        .filter((line) => /^\s*(import|export)\b.*from\s+['"]\.\.\/\.\./.test(line))
      expect(escapes, `${file}.ts reaches outside the project`).toEqual([])
    }
  })
})
