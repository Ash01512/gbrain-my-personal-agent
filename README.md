# job-tracker-agent

An agent that finds relevant roles, scores them against a CV, drafts tailored
cover letters, and queues them for approval. The human presses submit — no job
board in this stack exposes an apply endpoint, and a counter that reported
applications nobody sent would be worse than no counter.

**Start here: [`job-tracker-worker/README.md`](job-tracker-worker/README.md).**
That is the deployable — a Cloudflare Worker serving the JSON API and the
approval dashboard over a Supabase database. Every command in it runs from
`job-tracker-worker/`, not from this directory.

## Reviewing this?

You do not need to run anything. In rough order of how much they repay the
minute spent:

1. **`job-tracker-worker/README.md` → Security model.** Row-level security is
   on with no policies, so the Worker holds the key that bypasses it. That one
   decision is why every route needs a token and why a missing token fails
   closed rather than open.
2. **`src/index.ts`.** One `fetch` handler, roughly 300 lines. The `update`
   case is the interesting part: `status` and `applied_on` are one fact, and
   keeping them consistent in both directions is what stops the daily count
   from lying.
3. **`docs/agent-loop.md` → the rubric.** A 0–10 additive score with a domain
   floor. The floor exists because working the arithmetic showed a Dubai
   site-engineering role scoring 6.5 and clearing the queue threshold — a step
   backwards that the rubric was happily recommending.
4. **`docs/designs/job-tracker-agent.md`.** Three approaches considered, and
   why the agent loop runs as a scheduled Claude session instead of inside the
   Worker or a GitHub Action.

Two things you can check from a browser, without credentials:

- <https://job-tracker-worker.ashabbas-2023.workers.dev/api/health> — returns
  `ok: true` and which of the three variables are set. Booleans only; it
  reports no values and never queries the database.
- <https://job-tracker-worker.ashabbas-2023.workers.dev/> — the dashboard. It
  will render and then ask for an API token, which is the point: without one
  every `/api` route answers 401. There is nothing to see past that screen
  unless you have been given the token.

**Known gaps, so you do not have to find them.** Every caller shares one token,
so anything holding it can back-date an `applied_on` and move the daily count —
a single-user trust model, not an enforced boundary. Reply detection over Gmail
is designed but not built. `cv_versions` is not yet seeded, so drafted letters
have nothing to ground in.

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
| Code | Committed, typechecked, 151 tests green in CI |
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
