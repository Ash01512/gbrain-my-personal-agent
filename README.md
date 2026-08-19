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
| `.github/workflows/check-worker.yml` | Typecheck and test on every push and PR. Deployment is Cloudflare's Git integration, not this |
| `.claude/hooks/session-start.sh` | Rebuilds the agent toolchain in an ephemeral container |
| `CLAUDE.md` | Agent tooling notes for this workspace |

## Status

The Worker is committed, typechecked and covered by 125 tests, and the
dashboard has been exercised against a live `wrangler dev`. It has **not** been
run against the real Supabase project — that needs the service-role key. Run
the migrations and the smoke test in the Worker README before trusting it, and
do not describe it as deployed until it answers on a real URL.
