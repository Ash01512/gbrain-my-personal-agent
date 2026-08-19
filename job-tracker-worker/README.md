# job-tracker-worker

A Cloudflare Worker that puts a JSON API and a small dashboard in front of the
`job-tracker` Supabase database. One deployable: no build step, no bundler
config, no static asset hosting.

## Quickstart

Every command runs from `job-tracker-worker/`, not the repository root. Node 22
or newer (wrangler requires it — `.nvmrc` pins it).

```bash
git clone https://github.com/Ash01512/gbrain-my-personal-agent.git
cd gbrain-my-personal-agent/job-tracker-worker
npm install
cp .dev.vars.example .dev.vars          # then fill in the three values
```

`.dev.vars` holds the Supabase URL, the service-role key, and an API token from
`openssl rand -hex 32`. It is gitignored, it is what `npm run dev` reads, and
`npm run deploy` pushes the same three values to production — so they are typed
once rather than retyped into a dashboard form where a trailing space is
invisible.

Then, in order:

```bash
SUPABASE_DB_URL='postgresql://...' npm run migrate   # 1. schema
npm run check                                        # 2. typecheck + 130 tests
npm run dev                                          # 3. http://localhost:8787
npm run deploy                                       # 4. production + smoke test
```

1. **`npm run migrate`** applies `0000`, `0001` and `0002` in order, but checks
   first: it refuses to run if duplicate `job_url` values would abort the unique
   index, and it asks before enabling RLS, which is one-way in effect — the anon
   key then reads zero rows and gets `200 []` rather than an error. The
   connection string is in the Supabase dashboard under **Connect → Session
   pooler**; use that one, not the direct connection, which is IPv6-only on the
   free plan and simply hangs. Needs `psql`; if you would rather not install it,
   paste the three files into the SQL editor in filename order instead.
   Skipping `0001` makes `POST /api/queue` and `?queue=true` fail with a raw
   PostgREST 400; skipping `0000` loses the unique index, and the agent silently
   re-queues every role on every run.
2. **`npm run deploy`** runs the checks, authenticates with Cloudflare if
   needed, deploys, pushes the three secrets from `.dev.vars` on stdin so no
   value reaches your shell history, then smoke-tests what it just published.
   It stops before deploying if `.dev.vars` still holds placeholders.
3. **`npm run smoke <url>`** on its own re-runs just the verification: config,
   the auth boundary, a real PostgREST round trip, and the two endpoints that
   fail loudly if a migration was missed. Needs `API_TOKEN` in the environment.

The dashboard's own flow: open it, paste the API token, press Connect.

The scheduled agent that fills the queue is specified in `docs/agent-loop.md` —
search tracks, the 0–10 scoring rubric, and the run prompt. Why it runs as a
Claude session rather than inside this Worker is in
`docs/designs/job-tracker-agent.md`. Both are one directory up.

## Security model

Read this before deploying.

The three tables have RLS enabled and no policies, so the anon key can read
nothing. The Worker therefore holds the **service-role key**, which bypasses
RLS entirely. That makes the Worker itself the security boundary:

- Every `/api/*` route requires `API_TOKEN`, sent as `Authorization: Bearer <token>`
  or `X-API-Token`. Without it the deployed URL would be an open read/write
  proxy to the whole database.
- A missing `API_TOKEN` **fails closed** — a deployment that forgot to set the
  secret refuses every request rather than serving the database to the internet.
- Tokens are compared in constant time, so a wrong guess leaks no prefix.
- The service-role key never leaves the Worker. The browser only ever sees
  `API_TOKEN`.
- `/` and `/api/health` are unauthenticated. Health reports only whether each
  variable is *set*, never its value.

Generate a real token: `openssl rand -hex 32`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Dashboard (HTML) |
| `GET` | `/api/health` | Liveness plus which variables are configured |
| `GET` | `/api/stats` | Application count, broken down by status |
| `GET` | `/api/stats/daily` | How many applications were sent today, and per day for 14 days |
| `POST` | `/api/queue` | Agent intake: one scored candidate role |
| `POST` | `/api/applications/:id/apply` | Record that you sent this one; returns the apply URL |
| `GET` | `/api/applications` | List. `?queue=true&status=&company=&q=&limit=&offset=&order=` |
| `POST` | `/api/applications` | Create. `company` and `role` required |
| `GET` | `/api/applications/:id` | Fetch one |
| `PATCH` | `/api/applications/:id` | Partial update (`PUT` behaves the same) |
| `DELETE` | `/api/applications/:id` | Delete |

`?queue=true` is the review list: unsent roles, highest fit score first.

`/api/cv-versions` and `/api/cover-letters` expose the same five verbs over
`cv_versions` and `cover_letters`.

`q` searches company and role together; `company` is a substring match;
`limit` is clamped to 1–200 and defaults to 50; `order` defaults to
`created_at.desc`.

Both stats endpoints read at most 1000 rows and return `truncated: true` when
they hit that cap. The dashboard renders a capped figure as `1000+` rather than
letting it pass for a real total.

`%` and `_` inside `q` or `company` reach Postgres as `LIKE` wildcards. Commas,
quotes and parentheses do not — they are quoted into a single search term, so a
company called `Smith, Jones & Co` searches correctly instead of returning 400.

## The apply loop

This is the part worth understanding before you trust the numbers.

**No API submits applications on your behalf.** Indeed's connector exposes
`search_jobs`, `get_job_details`, `get_company_data` and `get_resume` — there is
no apply endpoint, and its own docs route submission through a human clicking
the apply link. So the loop is:

1. The matching agent `POST`s scored candidates to `/api/queue`. It cannot mark
   anything applied — `parseQueueItem` forces `status` to `saved` and strips
   `applied_on`.
2. You review the queue, sorted by fit. The score carries its tier and scale,
   and the rationale is visible under the role — not a hover tooltip, which does
   not exist on a phone.
3. **Apply** opens the real posting in a new tab and records the application.
   You complete the form there.
4. `/api/stats/daily` counts what was actually recorded.

Guards that keep the daily number honest:

- **Re-applying is a 409.** Clicking apply twice cannot inflate the count.
- **The queue endpoint cannot claim an application.** `parseQueueItem` forces
  `status` to `saved` and strips `applied_on`, so the agent's normal path
  cannot mark anything sent.
- **`status` and `applied_on` move together, in both directions.** Any change to
  `applied` stamps a date — including the dashboard dropdown, and including a
  request that explicitly sends `applied_on: null`, which would otherwise
  produce a row that counts as applied but is invisible to the daily rollup.
  Any change back to `saved` clears the date, so a row recorded by mistake and
  reverted stops inflating that day. Every stage *after* applying — screening,
  interview, offer, rejected, withdrawn — keeps its date, because those describe
  what happened to an application that really was sent.
- **A write that matched nothing is a 404, not a 200.** The apply endpoint reads
  then writes, so the row can be deleted in between.
- **A future `applied_on` is excluded** from the daily rollup rather than
  consuming the row cap and pushing real recent days out of the window.

**What is not guarded:** every caller shares one `API_TOKEN`, so anything
holding it can `PATCH /api/applications/:id` with a back-dated `applied_on` and
move the count. This is a single-user trust model, not an enforced boundary.
Splitting the agent onto a write-restricted token would fix it and is not built.

The count means "applications recorded as sent", not "roles the agent found".
A tracker that inflates that number is worse than no tracker.

## Timezone

`APP_TIMEZONE` (optional, IANA name such as `Asia/Dubai`) decides which calendar
day an application belongs to. It defaults to UTC — which for a UTC+4 user files
anything sent after 20:00 local under the next day and resets "applied today" at
04:00 local. Set it:

```bash
npx wrangler secret put APP_TIMEZONE   # or add as a plain variable
```

An invalid zone falls back to UTC rather than failing the request.

## Database migration

Run these in order in the Supabase SQL editor, **before the first request**.

- `migrations/0000_init.sql` — baseline: the three tables, RLS, and the
  **unique index on `job_url`** that the queue's 409 dedupe depends on.
- `migrations/0001_add_matching.sql` — `match_score`, `match_rationale`,
  `cv_version_id`, the 0-10 check constraint, and the indexes the queue
  ordering and daily rollup read.
- `migrations/0002_verify.sql` — changes nothing, raises if the live schema
  does not match what the Worker assumes.

`0001` is re-runnable. `0000` is not entirely: `create table if not exists` is
a no-op on an existing table and repairs no drift, the unique index aborts if
duplicate `job_url` values already exist, and enabling RLS is a one-way state
change that makes the anon key read zero rows *without* returning an error.
Its header says what to check first. Run `0002` afterwards either way.

### Status values

Enforced by CHECK constraints in the database and validated before the write,
so a bad value returns a 400 naming the field instead of a Postgres error.

- Applications: `saved`, `applied`, `screening`, `interview`, `offer`,
  `rejected`, `withdrawn`
- Cover letters: `draft`, `final`, `sent`

### Error mapping

| Condition | Status |
| --- | --- |
| Validation failure, malformed JSON, bad UUID | 400 |
| Missing or wrong API token | 401 |
| Unknown row | 404 |
| Known path, unsupported verb | 405 |
| Duplicate `job_url` (unique index) | 409 |
| Row created (`POST` to a collection or `/api/queue`) | 201 |
| `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` unset | 503, naming the variable |
| Supabase 5xx or unreachable | 502 |
| Anything unrecognised | 500 `internal error`; detail goes to the Worker log only |

## Deploy

Cloudflare's Git integration owns deployment. `.github/workflows/check-worker.yml`
typechecks and tests but deliberately does **not** deploy: with both paths
connected, every push deploys twice and the run without an API token goes red on
a repository that is in fact deploying fine.

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Connect to Git**
2. Pick `Ash01512/gbrain-my-personal-agent`
3. Set **root directory** to `job-tracker-worker` — the Worker is not at the
   repository root. This is the step that is easy to miss and the reason the
   build fails with "no package.json" if you do
4. Deploy, then add the secrets under **Settings → Variables and Secrets**.
   Three are required, as **Secret** type: `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `API_TOKEN`. Add `APP_TIMEZONE` as a plain
   **Text** variable — it is not a secret, and without it the daily count rolls
   over at 04:00 local for a UTC+4 user
5. Confirm the variables are live rather than staged. The dashboard may hold
   changes behind a **Deploy** button depending on the UI version, so do not
   assume — `/api/health` is the definitive answer: it returns 503 while any of
   the three is missing and 200 once all are set

Every push to the connected branch redeploys. Free plan covers this.

The Worker will answer before the secrets exist. That is deliberate and safe:
without `API_TOKEN` every `/api` route 401s rather than serving the database,
and without the Supabase pair it answers 503 naming the variable. `/api/health`
returns 503 until all three are set, so it is the quickest way to tell a
half-configured deployment from a working one.

**Not Cloudflare Pages.** Pages has no Cron Triggers, which this project needs for
the scheduled agent loop, and a Worker already serves the dashboard HTML directly.
See `docs/designs/job-tracker-agent.md`.

### Or `npm run deploy`, which does the same thing without the clicking

```bash
cd job-tracker-worker
npm run deploy
```

It opens a browser once for `wrangler login`, then needs nothing else: checks,
deploy, secrets from `.dev.vars`, smoke test. No redeploy step — each
`wrangler secret put` creates and deploys a new version by itself. Use it *instead of* the
dashboard route above for the first deploy, not as well — either creates the
Worker, and a Worker created by `wrangler deploy` has no Git connection, so
pushes will not redeploy it until you connect one.

The equivalent by hand, if you want to see what it does:

```bash
npx wrangler login                                  # interactive, opens a browser
npx wrangler secret put SUPABASE_URL                # https://<ref>.supabase.co
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # Settings > API > service_role
npx wrangler secret put API_TOKEN                   # openssl rand -hex 32
npx wrangler deploy
```

`APP_TIMEZONE` is not a secret — uncomment the `[vars]` block in `wrangler.toml`
rather than using `secret put`.

### Confirming it worked

```bash
API_TOKEN='...' npm run smoke https://<worker>.workers.dev
```

Ten checks, and each failure names the likely cause rather than just a status
code. `/api/health` alone is not enough: it reports which variables are set,
never their values, and never touches Supabase — so it proves configuration and
nothing more. The smoke test also asserts the things that would be worst to get
wrong in production:

- an unauthenticated request is refused, and so is a wrong token
- no key material appears in any response a stranger can reach
- an authenticated list actually round-trips to PostgREST
- `?queue=true` and `/api/stats/daily` work, which they do not if `0001` was
  skipped — otherwise that stays invisible until the agent posts its first
  candidate
- a search containing a comma returns 200, not the 400 the unquoted filter
  grammar used to produce

## Local development

```bash
cd job-tracker-worker
npm install
cp .dev.vars.example .dev.vars   # then fill in the three values
```

`.dev.vars` is gitignored — keep it that way, it holds a key that bypasses RLS.

```bash
npm run dev        # http://localhost:8787
```

Everything returning `unauthorized`? Open http://localhost:8787/api/health. If
`api_token` is `false` the Worker has no token at all and the problem is
`.dev.vars`, not what you pasted into the dashboard.

Open the dashboard, paste the API token into the token field, and hit Connect.
The token is kept in `localStorage` and sent as a header, so it never lands in
the URL, browser history, or server logs.

## Checks

```bash
cd job-tracker-worker
npm run typecheck
npm test
```

130 tests. Most cover the pure helpers — schema validation, route matching,
query building, the auth comparison, the Supabase error mapping — and
`test/worker.test.ts` drives the fetch handler itself, which is where the auth
gate, the error mapping and the `applied_on` rules actually compose.
`test/ui.test.ts` evaluates the dashboard's client-side helpers from the exact
source the page ships. Everything stubs `fetch`, so no network and no database.

## Design notes

**No `@supabase/supabase-js`.** This Worker needs CRUD over three tables.
Hand-rolling the PostgREST calls keeps the bundle small, avoids Node polyfill
surprises on Workers, and makes URL building unit-testable without mocking an
SDK.

**Path IDs are UUID-validated** before reaching PostgREST. The id lands in a
filter expression (`id=eq.<value>`), so rejecting anything that is not a UUID
closes off filter injection through the path.

**`updated_at` is stamped on every PATCH.** The column has a default but no
trigger, so the Worker sets it rather than letting it silently go stale.

**`job_url` must be `http` or `https`, checked twice.** The URL comes from
third-party job postings the matching agent ingests, and the dashboard puts it
in an `href` and a `window.open()` the human is told to click. A `javascript:`
URL there runs on the Worker's own origin, where it can read `API_TOKEN` out of
`localStorage` — and that token fronts a service-role key that bypasses RLS.
`schema.ts` refuses to store one; `ui.ts` re-checks before opening anything,
because the apply button reads its URL back from `dataset`, which decodes the
entity escaping that made the attribute safe.

## Not yet verified

The Worker has not been run against the real Supabase project — that needs the
service-role key, which is not available in the environment where this was
built. Routing, auth, validation, and error mapping were all exercised against
a live `wrangler dev`; the actual PostgREST round-trip was exercised only
against a stubbed `fetch`. In particular the double-quoted filter values that
`q` now builds, and `applied_on=lte.<today>` on the daily rollup, are correct
per the PostgREST grammar but have not been run against a live instance.

Run `migrations/0002_verify.sql`, then `/api/health`, then the authenticated
`GET /api/applications` from [Quickstart](#quickstart) after the first deploy.
