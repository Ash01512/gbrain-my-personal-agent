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
| Code | Committed, typechecked, 150 tests green in CI |
| Dashboard | Exercised against a live `wrangler dev`, desktop and mobile, light and dark |
| Product loop | **Verified end to end locally** — see below |
| Database | **Migrated.** `0002_verify.sql` reports `schema OK` against the live project |
| Worker | **Deployed and configured.** `job-tracker-worker.ashabbas-2023.workers.dev` — `/api/health` returns `ok: true` with all three secrets set |

The whole loop has been driven once against a stateful PostgREST stand-in, in
one pass, through the real Worker: the agent queues three scored candidates, a
re-run of the same role returns 409 rather than duplicating, an agent trying to
send `status: applied` has it stripped to `saved`, the human applies and the
daily count goes 0 → 1, a second click returns 409 and the count holds, a
revert to `saved` clears the date and the count returns to 0, re-applying dates
it today rather than resurrecting the old date, and moving on to `screening`
keeps it counted. `applied_on` landed on Dubai's calendar day while UTC was
still on the previous one, which is `APP_TIMEZONE` doing its job.

One check remains, and it is deliberately separate: `/api/health` reports which
variables are *set*, and never touches Supabase — so a green health check
proves configuration and nothing more. Loading the dashboard and seeing the
counters populate proves the round trip, because those figures can only come
from a query that reached Postgres.
