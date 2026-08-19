// Documentation that contradicts itself is worse than none: a reader who spots
// one wrong number stops trusting the rest of the page.
//
// A review of this repo found "121 tests" and "125 tests" six lines apart in
// the same README, and "66 tests" in a design doc — every one of them written
// confidently, none of them checkable. These tests make the claims fail loudly
// instead of quietly rotting.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const REPO = join(ROOT, '..')

const DOCS = [
  join(REPO, 'README.md'),
  join(ROOT, 'README.md'),
  join(REPO, 'docs', 'agent-loop.md'),
  join(REPO, 'docs', 'cv-technical-projects.md'),
  join(REPO, 'docs', 'designs', 'job-tracker-agent.md'),
]

const read = (path: string) => readFileSync(path, 'utf8')
const relative = (path: string) => path.slice(REPO.length + 1)

/**
 * Counts `it(...)` declarations across the suite.
 *
 * This equals the reported test count only while every `it` is one test. If a
 * table-driven `it.each` is ever added, one declaration becomes several and
 * this number legitimately drifts below the real one — at which point teach
 * this helper about it rather than editing the docs to match a wrong number.
 */
function countTests(): number {
  const dir = join(ROOT, 'test')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .reduce((total, file) => {
      const matches = read(join(dir, file)).match(/^\s*it(\.each)?\(/gm)
      return total + (matches?.length ?? 0)
    }, 0)
}

describe('the docs do not claim things that are not true', () => {
  it('states one test count, and it is the real one', () => {
    const actual = countTests()
    const claims = DOCS.flatMap((path) =>
      [...read(path).matchAll(/(\d+)\s+tests\b/g)].map((m) => ({
        file: relative(path),
        claimed: Number(m[1]),
      })),
    )

    expect(claims.length, 'no doc states a test count — did the docs move?')
      .toBeGreaterThan(0)

    const wrong = claims.filter((c) => c.claimed !== actual)
    expect(
      wrong,
      `these say a different number than the ${actual} tests that exist: ` +
        wrong.map((c) => `${c.file} says ${c.claimed}`).join('; '),
    ).toEqual([])
  })

  it('does not describe the CI workflow as deploying', () => {
    // It stopped deploying when Cloudflare's Git integration took ownership.
    // A CV bullet still said "CI gates deployment", which is a claim a
    // reviewer can check and find false.
    for (const path of DOCS) {
      expect(read(path), `${relative(path)} says CI gates deployment`).not.toMatch(
        /CI gates deployment/i,
      )
    }
  })

  it('does not describe the rationale as a hover tooltip', () => {
    // The dashboard was rebuilt to show it as visible text — a tooltip does
    // not exist on touch, which is where this gets read.
    for (const path of DOCS) {
      expect(read(path), `${relative(path)} still describes hover`).not.toMatch(
        /rationale on hover|Hovering a score/i,
      )
    }
  })

  it('points at a workflow file that exists', () => {
    const workflows = readdirSync(join(REPO, '.github', 'workflows'))
    for (const path of DOCS) {
      for (const [, name] of read(path).matchAll(/\.github\/workflows\/([\w.-]+\.yml)/g)) {
        expect(workflows, `${relative(path)} references a missing workflow`).toContain(name)
      }
    }
  })

  it('names the repository that actually hosts this', () => {
    // The CV links here. A 404 costs more than an unfashionable repo name.
    for (const path of DOCS) {
      expect(read(path), `${relative(path)} names a repo that does not exist`).not.toMatch(
        /Ash01512\/job-tracker-agent/,
      )
    }
  })
})
