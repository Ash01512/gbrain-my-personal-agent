# job-tracker-worker

A Cloudflare Worker that puts a JSON API and a small dashboard in front of the
`job-tracker` Supabase database. One deployable: no build step, no bundler
config, no static asset hosting.

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
| `GET` | `/api/applications` | List. `?status=&company=&q=&limit=&offset=&order=` |
| `POST` | `/api/applications` | Create. `company` and `role` required |
| `GET` | `/api/applications/:id` | Fetch one |
| `PATCH` | `/api/applications/:id` | Partial update (`PUT` behaves the same) |
| `DELETE` | `/api/applications/:id` | Delete |

`/api/cv-versions` and `/api/cover-letters` expose the same five verbs over
`cv_versions` and `cover_letters`.

`q` searches company and role together; `company` is a substring match;
`limit` is clamped to 1–200 and defaults to 50; `order` defaults to
`created_at.desc`.

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
| Supabase 5xx or unreachable | 502 |

## Deploy

### Option 1 — from the Cloudflare dashboard, no CLI (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/deploy-to-workers&repository=https://github.com/Ash01512/gbrain-my-personal-agent)

Or connect the repository manually, which is the more reliable route because this
Worker lives in a subdirectory:

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Connect to Git**
2. Pick `Ash01512/gbrain-my-personal-agent`
3. Set **root directory** to `job-tracker-worker`
4. Deploy, then add the three secrets under **Settings → Variables and Secrets**:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `API_TOKEN`

Every push to the connected branch redeploys. Free plan covers this.

**Not Cloudflare Pages.** Pages has no Cron Triggers, which this project needs for
the scheduled agent loop, and a Worker already serves the dashboard HTML directly.
See `docs/designs/job-tracker-agent.md`.

### Option 2 — from the CLI

```bash
npm install
npx wrangler login
npx wrangler secret put SUPABASE_URL                # https://<ref>.supabase.co
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY   # Settings > API > service_role
npx wrangler secret put API_TOKEN                   # openssl rand -hex 32
npx wrangler deploy
```

After either route, check `/api/health` — it reports which variables are set
without revealing their values.

## Local development

```bash
npm install
```

Copy `.dev.vars.example` to `.dev.vars` and fill it in.
`.dev.vars` is gitignored — keep it that way, it holds a key that bypasses RLS.

```bash
npm run dev        # http://localhost:8787
```

Open the dashboard, paste the API token into the token field, and hit Connect.
The token is kept in `localStorage` and sent as a header, so it never lands in
the URL, browser history, or server logs.

## Checks

```bash
npm run typecheck
npm test
```

39 tests cover schema validation, route matching, query building, the auth
comparison, and the Supabase error mapping. They stub `fetch`, so they need no
network and no database.

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

## Not yet verified

The Worker has not been run against the real Supabase project — that needs the
service-role key, which is not available in the environment where this was
built. Routing, auth, validation, and error mapping were all exercised against
a live `wrangler dev`; the actual PostgREST round-trip was exercised only
against a stubbed `fetch`. Run `/api/health` and then `GET /api/applications`
after the first deploy to confirm the credentials work.
