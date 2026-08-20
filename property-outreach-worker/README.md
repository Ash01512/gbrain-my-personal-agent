# property-outreach-worker

WhatsApp outreach to property owners and buyers, sent through
[LetsBot](https://letsbot.net/en/api.html) on the official WhatsApp Business
Platform, with every message reviewed by a human before it goes out.

A Cloudflare Worker over a Supabase database: a JSON API the drafting agent
posts to, and an approval dashboard you press Send in. Same shape as
`job-tracker-worker/` — agent proposes, human disposes.

## The constraint everything here is built around

WhatsApp lets a business message a person **only after that person has opted
in**, and the burden of proving consent falls on the sender. Meta names missing
or undocumented consent as the leading cause of Business account restrictions,
and a restricted number is not meaningfully appealable.

This matters because of where property contact lists come from. A number lifted
off a listing-agent sheet belongs to someone who has never contacted you, and
the opener that suggests itself — *"you showed interest in one of our
properties"* — is both untrue and the fastest route to a block-and-report.
Block-and-report is what Meta's quality signal is made of. One campaign is
enough.

So the rules are enforced in code rather than left to whoever is clicking
Approve:

| Guard | What it stops |
| --- | --- |
| `NO_OPT_IN` | Messaging anyone without a recorded, evidenced opt-in |
| `OPTED_OUT` | Messaging someone who asked you to stop |
| `UNSUPPORTED_CLAIM` | Copy claiming a past enquiry the database cannot show |
| `TEMPLATE_NOT_APPROVED` | Sending a template Meta has not approved |
| `FREEFORM_OUTSIDE_WINDOW` | Free-form text outside the 24h service window |
| `FREQUENCY_CAP` | The same contact hearing from you too often |
| `INVALID_PHONE` | Local-format numbers that silently never arrive |

`src/consent.ts` holds all of it, as pure functions with no database and no
clock of their own. It is the most closely tested file in this repository.

### The claim guard, specifically

`UNSUPPORTED_CLAIM` blocks a draft whose text asserts a prior relationship when
`contacts.last_inbound_at` is null — that is, when that person has never
messaged you. It catches "you showed interest", "you enquired", "following up
on your enquiry", "as we discussed", "thanks for your interest" and the rest.

Once someone really has messaged you, the same sentence is simply true and
passes. Meta approves the *shape* of a template; it never verified that this
particular recipient did the thing your copy says they did.

## Setup

Steps 1–3 need your phone and your Meta login. Nothing here can do them for
you, and none of the rest works until they are done.

1. **WhatsApp Business app.** Install it and register the number. A number
   cannot be personal and business at once, so use a second number unless you
   are willing to lose personal WhatsApp on that one. Disable Two-Step
   Verification before any API migration or it fails.
2. **Meta Business verification** at business.facebook.com — create the
   Business Portfolio, submit verification, add a privacy policy URL. Both are
   required before you can send any template. Typically 2–5 business days.
3. **LetsBot** — connect the account, migrate the number to the API, and submit
   your templates for approval. LetsBot is an official Meta Business Partner,
   so approvals go through them to Meta.
4. **Database** — run `migrations/0000_init.sql` against your Supabase project,
   then `migrations/0001_verify.sql`, which changes nothing and raises if the
   live schema does not match what the Worker assumes.
5. **Secrets** — copy `.dev.vars.example` to `.dev.vars` for local work; in
   production use `wrangler secret put` for `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `API_TOKEN` and `LETSBOT_API_KEY`.
6. **Deploy** — `npm run deploy` from this directory.

This Worker is deployed by hand on purpose. The repository-root
`wrangler.toml` drives Cloudflare's Git integration for `job-tracker-worker`
only, so a push cannot redeploy the thing that sends WhatsApp messages.

## Before the first real send

`OUTREACH_LIVE` ships as `"false"`, which makes every send a dry run: the
Worker builds the exact payload, returns it, and transmits nothing.

That exists because **LetsBot's request shape is not fully confirmed in this
code.** Their docs at `docs.letsbot.net` were unreachable from the environment
this was written in. What is confirmed, from their published PHP client, is
that authentication uses an `api_key` and that a text send carries `phone` and
`body`. The base URL, the path, and the template payload are inferred — which
is why they are configuration in `wrangler.toml` rather than constants.

So:

1. Read the send endpoint at `docs.letsbot.net`.
2. Fix `LETSBOT_API_BASE` and `LETSBOT_SEND_PATH` in `wrangler.toml`, and the
   field names in `src/letsbot.ts` if they differ.
3. `POST /api/outreach/:id/send` with `OUTREACH_LIVE` still `"false"`. The
   response contains `would_send` — the exact payload. Diff it against the docs.
4. Only then set `OUTREACH_LIVE = "true"`.

Verifying a send path by sending is how a number picks up its first block.

## API

Every `/api` route needs `Authorization: Bearer $API_TOKEN` (or
`X-API-Token`). `/` and `/api/health` do not.

| Route | Purpose |
| --- | --- |
| `GET /` | Approval dashboard |
| `GET /api/health` | Configuration presence, and whether sending is armed |
| `GET /api/stats` | Queue counts, and how many contacts you may actually message |
| `POST /api/draft` | Where the drafting agent posts one message for review |
| `GET /api/queue` | The review list, blocked rows first |
| `POST /api/outreach/:id/approve` | A human accepts this exact text |
| `POST /api/outreach/:id/send` | Transmit (or dry-run) an approved message |
| `POST /api/outreach/:id/cancel` | Drop it |
| `POST /api/contacts/:id/consent` | Append an opt-in or opt-out to the ledger |
| `GET /api/contacts/:id/consent` | Read that contact's consent history |
| `/api/contacts`, `/api/properties`, `/api/templates` | CRUD |

`POST /api/outreach` is deliberately closed with a 405: drafts go through
`/api/draft` so there is exactly one gated way into the queue.

### Why approve and send are separate

Approving is the human's judgement about specific words. Sending is the
transmission. Keeping them apart means a provider-side failure can be retried
without re-asking for approval, and a queue can be approved offline.

The gate runs at draft, at edit, at approve **and again at send** — four times
for one message. Consent is not a fact about the moment a draft was written:
someone can opt out between a human clicking Approve and the send going out,
and the send is the only one of those that can get a number banned. `worker.test.ts`
tests that path directly.

## The consent ledger

`consent_events` is append-only. There is no update or delete route, because an
audit trail you can edit is not an audit trail.

An opt-in must carry `evidence_url` or `evidence_note` — a database CHECK, not
just a Worker rule, so it survives someone inserting rows with `psql`. The one
exception is `method: 'inbound_message'`: their own first message to you *is*
the evidence. Opt-outs are always recordable with no evidence at all; when
someone says stop, recording it must never fail on a paperwork rule.

`contacts.opt_in_state` is a cached read of the ledger. Nothing but the consent
endpoint writes it — `parseContact` drops the field, so a spreadsheet import
cannot mark a cold list as consenting.

## What this does not do

- **Collect opt-ins.** It records them. Getting them is a separate job: a
  click-to-WhatsApp ad, a valuation form on your site, a QR code on a board, or
  simply asking during a call you were already having. Past SMS consent, a
  pre-checked box, and a purchased list do not count.
- **Import sheets.** `POST /api/properties` and `POST /api/contacts` take one
  row at a time. Bulk import is not written yet.
- **Receive messages.** No inbound webhook, so `contacts.last_inbound_at` is
  set by whatever writes it. Wire the LetsBot webhook to keep the 24h window
  and the claim guard accurate.

## Security model

The Worker holds the Supabase service-role key, which bypasses RLS. That makes
the Worker itself the security boundary, which is why `API_TOKEN` guards every
`/api` route and an unset token fails closed. RLS is enabled on all five tables
with no policies, so the anon key reads nothing.

The dashboard stores the token in `localStorage` and sends it per request, so
it stays out of URLs, browser history and logs. Both `schema.ts` and `ui.ts`
reject non-http(s) URLs — listing sheets are untrusted input, and a
`javascript:` URL rendered into an anchor would execute on this origin and
could read that token.

## Tests

```bash
npm run check     # typecheck + tests
```

93 tests. The ones worth reading first are in `test/consent.test.ts` (every way
a campaign gets a number restricted) and `test/worker.test.ts` (proof the gate
is actually wired into the paths that can send — a perfect gate nobody calls
protects nothing).
