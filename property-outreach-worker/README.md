# property-outreach-worker

Autonomous WhatsApp outreach to property owners and buyers, sent through
[LetsBot](https://letsbot.net/en/api.html) on the official WhatsApp Business
Platform.

A Cloudflare Worker over a Supabase database. An hourly cron advances every
active campaign by one batch: it selects contacts, personalises a
Meta-approved template, runs the consent gate, sends, and records the result.
Nobody is in the loop. There is a dashboard, but it is a record of what
happened rather than a gate the system waits on.

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

Removing the human reviewer does not remove any of that. It moves the entire
weight of it onto `src/consent.ts`, which is why that file is written as pure
functions with no database and no clock of its own, and why it is the most
heavily tested thing in this repository.

| Guard | What it stops |
| --- | --- |
| `NO_OPT_IN` | Messaging anyone without a recorded, evidenced opt-in |
| `OPTED_OUT` | Messaging someone who asked you to stop |
| `UNSUPPORTED_CLAIM` | Copy claiming a past enquiry the database cannot evidence |
| `ALREADY_MESSAGED` | A second message to someone who already had theirs |
| `TEMPLATE_REQUIRED` | Free-form text going out unattended |
| `TEMPLATE_NOT_APPROVED` | Sending a template Meta has not approved, or has paused |
| `FREQUENCY_CAP` | The same contact hearing from you too often |
| `INVALID_PHONE` | Local-format numbers that silently never arrive |

The gate runs at draft, at edit, at approve **and again at send** — and the
autopilot re-runs it immediately before every single message. Consent is not a
fact about the moment a draft was written: someone can opt out in the seconds
between selection and transmission, and only the send can cost the number.

### One message, once

You asked for a single message per person, and that is enforced in three
independent places:

1. `oncePerContact` in the gate, which is **not configurable** — there is no
   environment variable that turns it off.
2. A unique index on `(campaign_id, contact_id)`, so a duplicate is impossible
   even if two cron ticks overlap or a retry replays.
3. The campaign runner writes the queue row **before** the send, so an
   interrupted run leaves evidence and the next tick skips that contact.

Belt and braces, because to a recipient a duplicate is indistinguishable from
spam, and unattended systems fail in exactly the ways that produce duplicates.

### The claim guard, and its limit

`UNSUPPORTED_CLAIM` blocks copy asserting a prior relationship when nothing on
file shows the person made contact. Proof is either an inbound WhatsApp message
(`last_inbound_at`) or an opt-in they initiated themselves — a website form, a
click-to-WhatsApp ad. An `imported_documented` or `phone_recorded` opt-in is
consent to message, but it is **not** evidence they enquired about anything, so
the same copy stays blocked for them.

Its limit, stated plainly: it is a heuristic over phrasing, not a fact-checker.
For someone who genuinely signed up on your form, it will not catch a template
that invents a *specific* past event ("you viewed this villa in March"). It
stops the systematic cold-list lie, which is the thing that gets numbers banned.
Writing true copy is still your job.

## Setup

Steps 1–3 need your phone and your Meta login. Nothing in this repository can
do them for you.

1. ~~**WhatsApp Business app**~~ — done. A number cannot be personal and
   business at once, so keep that in mind if it is your personal number.
2. **Meta Business verification** at business.facebook.com — Business
   Portfolio, verification submitted, privacy policy URL added. Both are
   required before you can send any template. Typically 2–5 business days.
3. **LetsBot** — connect the account, migrate the number to the API, and submit
   your templates. LetsBot is an official Meta Business Partner, so approvals
   go through them to Meta. Disable Two-Step Verification before the migration
   or it fails.
4. ~~**Database**~~ — done. The tables are live in the `job-tracker` Supabase
   project, RLS on, constraints verified. `migrations/0001_verify.sql` re-checks
   the live schema against what the Worker assumes and changes nothing.
5. **Secrets** — `wrangler secret put` for `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `API_TOKEN`, `LETSBOT_API_KEY` and
   `INBOUND_WEBHOOK_SECRET`. Generate the last two random ones with
   `openssl rand -hex 32`.
6. **Deploy** — `npm run deploy` from this directory.
7. **Point LetsBot's webhook** at `https://<worker>/hooks/inbound/<secret>`.
   Without it, STOP replies are never recorded — which is the one failure here
   that reliably ends a number.

This Worker is deployed by hand on purpose. The repository-root `wrangler.toml`
drives Cloudflare's Git integration for `job-tracker-worker` only, so a push
cannot redeploy the thing that sends WhatsApp messages.

## Arming it

Two switches, deliberately separate, both defaulting to off:

| | `OUTREACH_AUTOPILOT` | `OUTREACH_LIVE` | Result |
| --- | --- | --- | --- |
| Build | `false` | `false` | Nothing runs. |
| **Rehearsal** | `true` | `false` | Cron runs hourly, selects real contacts, builds real payloads, transmits nothing. Read the logs. |
| Manual | `false` | `true` | Only what you press Send on in the dashboard. |
| **Autonomous** | `true` | `true` | The system you asked for. |

Go through the rehearsal row first. It is free, it exercises every line of the
real path, and it is the only way to find out what your campaign would actually
have sent before it sends it.

### Before the first real send

**LetsBot's request shape is not fully confirmed in this code.** Their docs at
`docs.letsbot.net` were unreachable from the environment this was written in
(blocked by the network egress proxy). Confirmed, from their published PHP
client: authentication uses an `api_key`, and a text send carries `phone` and
`body`. The base URL, the path, and the template payload are inferred — which
is why they are configuration in `wrangler.toml` rather than constants.

1. Read the send endpoint at `docs.letsbot.net`.
2. Fix `LETSBOT_API_BASE` / `LETSBOT_SEND_PATH`, and the field names in
   `src/letsbot.ts` if they differ.
3. `POST /api/outreach/:id/send` in dry run. The response contains
   `would_send` — the exact payload. Diff it against the docs.
4. Then arm it.

Verifying a send path by sending is how a number picks up its first block.

## Getting people onto the list

This is the only thing standing between you and a working system, and no code
can do it for you. The Worker serves a public opt-in page at **`/optin`**.

The page leads with a **"Message us on WhatsApp"** button (a `wa.me` deep link,
configured via `WHATSAPP_NUMBER`) and offers the form underneath. That order is
deliberate, and it is a consent-quality decision rather than a design one:

> A typed phone number is **self-asserted**. Nothing stops someone entering a
> number they do not own, and an unattended sender would then message a stranger
> who never agreed to anything. A message sent from the person's own handset
> cannot be forged that way — it arrives with their real number attached, and
> the inbound webhook records it as `inbound_message` consent with the message
> itself as the evidence.

So prefer, in this order:

1. **Click-to-WhatsApp ads** and the `wa.me` button — consent proven by the
   handset. Meta treats the tap itself as opt-in.
2. **A QR code** on a board, a brochure, a card, pointing at `/optin`.
3. **The form**, for people who will not click through. It records real evidence
   (timestamp, IP, country, user agent, unticked-by-default checkbox), but that
   evidence shows *a submission happened*, not that the submitter owned the
   number.

Numbers from listing sheets are not on this list and cannot be added by
importing them. That is the design working, not a gap.

## API

Every `/api` route needs `Authorization: Bearer $API_TOKEN`. `/`,
`/api/health`, `/optin` and `/hooks/inbound/:secret` do not.

| Route | Purpose |
| --- | --- |
| `GET /` | Dashboard — status, queue, consent entry |
| `GET /optin` | **Public opt-in page** |
| `POST /hooks/inbound/:secret` | LetsBot webhook: STOP handling and inbound consent |
| `GET /api/health` | Configuration, and whether sending and autopilot are armed |
| `GET /api/stats` | Counts, and how many contacts you may actually message |
| `POST /api/campaigns` | Create a campaign |
| `POST /api/campaigns/:id/run` | Run one batch now — same code path as the cron |
| `GET /api/queue` | What went out, and what was blocked |
| `POST /api/outreach/:id/approve` · `/send` · `/cancel` | Manual override |
| `POST /api/contacts/:id/consent` | Append to the consent ledger |
| `GET /api/contacts/:id/consent` | Read a contact's consent history |
| `/api/contacts`, `/api/properties`, `/api/templates` | CRUD |

`POST /api/outreach` is closed with a 405: drafts go through `/api/draft` so
there is exactly one gated way into the queue.

### Campaigns

A campaign is a standing instruction — this template, to this audience, at this
pace. `variable_sources` maps template placeholders to columns, e.g.
`["contact.full_name", "property.area"]`. A contact whose values are missing is
**skipped, not sent a message with a hole in it**: "Hi ," reads as a botched
mail-merge, and the response to a botched mail-merge is Block.

`daily_cap` (default 20) and `batch_size` (default 5) set the pace. Meta rates a
number partly on how it ramps, and a new number that sends its whole list on day
one is the classic way to get restricted. Start lower than feels necessary.

If Meta pauses your template mid-campaign, the runner notices on its next tick,
parks the campaign, and stops. Nobody has to be watching.

## The consent ledger

`consent_events` is append-only. No update or delete route, because an audit
trail you can edit is not an audit trail.

An opt-in must carry `evidence_url` or `evidence_note` — a database CHECK, not
just a Worker rule, so it survives someone inserting rows with `psql`. The
exception is `inbound_message`: their own message is the evidence. Opt-outs are
always recordable with no evidence at all; when someone says stop, recording it
must never fail on a paperwork rule.

`contacts.opt_in_state` is a cached read of the ledger. Nothing but the consent
paths write it — `parseContact` drops the field, so an import cannot mark a cold
list as consenting.

STOP is handled in English and Arabic (إيقاف, الغاء, توقف, لا تراسلني…), with
alef forms normalised so a different keyboard still opts someone out. A message
that contains a stop word opts out even if it also asks a question: being wrong
that way costs a lead, being wrong the other way costs the number.

## Known limits

Found in review and deliberately not fixed. Each is a real edge, stated so it is
a decision rather than a surprise:

- **The opt-in form cannot verify number ownership.** Mitigated by leading with
  the `wa.me` button (above), not eliminated. If you need certainty, drop the
  form and run `/optin` as a WhatsApp link only.
- **`/optin` has no rate limit.** A script could create thousands of contact
  rows. They would all be `opted_in`, so a campaign would message them. Fixing
  it properly needs a KV namespace or Durable Object for counters; until then,
  watch `GET /api/stats` for a contact count that moves without a campaign
  behind it.
- **`campaigns.sent_count` is a read-modify-write.** Two overlapping ticks could
  lose an increment. It is a display counter only — nothing gates on it; the
  caps read `outreach_messages` directly.
- **A campaign past 20,000 messages** truncates its dedupe set and logs a
  warning. The unique index still prevents duplicates; the run just does more
  wasted work.

## What this still does not do

- **Import sheets.** `POST /api/properties` and `/api/contacts` take one row at
  a time. Bulk import is not written — and importing contacts would not make
  them messageable anyway.
- **Reply to anyone.** Inbound messages are recorded, not answered. LetsBot's
  own AI bot or shared inbox is the right tool for that.

## Security model

The Worker holds the Supabase service-role key, which bypasses RLS. That makes
the Worker the security boundary, which is why `API_TOKEN` guards every `/api`
route and an unset token fails closed. RLS is on for all six tables with no
policies, so the anon key reads nothing.

Two routes are public by necessity. `/optin` can only ever create an opt-in for
a number the submitter typed — it never reads one back. `/hooks/inbound/:secret`
is authenticated by a path secret compared in constant time; a wrong secret gets
a 404, not a 403, so probing reveals nothing.

The opt-in page ships a strict CSP and uses no inline scripts. Both `schema.ts`
and `ui.ts` reject non-http(s) URLs — listing sheets are untrusted input, and a
`javascript:` URL rendered into an anchor would execute on this origin and could
read the API token out of localStorage.

## Tests

```bash
npm run check     # typecheck + tests
```

188 tests. Read these first:

- `test/consent.test.ts` — every way a campaign gets a number restricted.
- `test/autopilot.test.ts` — the unattended path end to end. It proves the cron
  will not message someone without consent, will not message anyone twice
  across two ticks, parks itself when Meta pauses a template, and stops the
  batch on a provider failure rather than hammering a suspended number.
- `test/inbound.test.ts` — every way a person types "stop", and the ways that
  look like one but are not ("can I cancel the viewing?").
- `test/optin.test.ts` — the public page, which is the only door in.
