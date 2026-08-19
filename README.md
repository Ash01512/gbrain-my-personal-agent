# job-tracker-agent

An agent that finds relevant roles, scores them against a CV, drafts tailored
cover letters, and queues them for approval. The human presses submit — no job
board in this stack exposes an apply endpoint, and a counter that reported
applications nobody sent would be worse than no counter.

**Start here: [`job-tracker-worker/README.md`](job-tracker-worker/README.md).**
That is the deployable — a Cloudflare Worker serving the JSON API and the
approval dashboard over a Supabase database. Every command in it runs from
`job-tracker-worker/`, not from this directory.

| Path | What it is |
| --- | --- |
| `job-tracker-worker/` | The Worker: API, dashboard, migrations, tests |
| `docs/designs/job-tracker-agent.md` | The approved design, and why the agent loop runs as a scheduled Claude session rather than inside the Worker |
| `docs/agent-loop.md` | The scheduled half: search tracks, the 0-10 scoring rubric, volume cap, and the run prompt |
| `.github/workflows/check-worker.yml` | Typecheck and test on every push and PR. Deployment is Cloudflare's Git integration, not this |
| `.claude/hooks/session-start.sh` | Rebuilds the agent toolchain in an ephemeral container |
| `CLAUDE.md` | Agent tooling notes for this workspace |

## Status

| | |
| --- | --- |
| Code | Committed, typechecked, 125 tests green in CI |
| Dashboard | Exercised against a live `wrangler dev`, desktop and mobile, light and dark |
| Database | **Migrated.** `0002_verify.sql` reports `schema OK` against the live project |
| Worker | **Not deployed.** Never run against the real Supabase project |

The remaining gap is the round trip: every test stubs `fetch`, so nothing yet
proves the deployed Worker can actually reach PostgREST with real credentials.
`npm run smoke <url>` is what closes it. Until that passes, this is not
"deployed" and should not be described as such.
