-- Property outreach schema.
--
-- The shape here is driven by one constraint that is not negotiable: WhatsApp
-- lets a business message a person only after that person has opted in, and
-- the burden of proving it falls on the sender. Meta's stated leading cause of
-- Business account restrictions is missing or undocumented consent. A banned
-- number is not appealable in practice, so consent is modelled as an
-- append-only ledger of evidence rather than a boolean on a contact row.
--
-- Read that again before adding a shortcut that writes contacts.opt_in_state
-- directly. The denormalised column exists so the queue can filter cheaply;
-- consent_events is the record that answers "prove it", and the Worker only
-- ever writes the column as a consequence of appending to the ledger.
--
-- ── Read before running this against a database that already has data ──
--
-- `create table if not exists` is a no-op on an existing table: it will not
-- add a missing column, default or CHECK. Run 0001_verify.sql afterwards to
-- find out whether the live schema actually matches this file.
--
-- Enabling RLS at the bottom is a state change. With RLS on and no policies,
-- PostgREST answers the anon key with HTTP 200 and an empty array rather than
-- a 403 — so anything else reading this database with the anon key stops
-- seeing rows and gets no error saying why. That is the intended posture (the
-- Worker holds the service-role key and is the security boundary), but turn it
-- on knowingly. The DO block reports what it changed.

create extension if not exists pgcrypto;

-- ── Properties ───────────────────────────────────────────────────────────
-- Sourced from listing-agent sheets. A property is not a person and carries
-- no consent of its own; it is only ever the subject of a message.

create table if not exists public.properties (
  id uuid primary key default gen_random_uuid(),
  reference text,
  title text not null,
  property_type text,
  area text,
  city text,
  bedrooms integer,
  bathrooms integer,
  size_sqft numeric,
  price numeric,
  currency text not null default 'AED',
  listing_type text not null default 'sale'
    check (listing_type in ('sale','rent')),
  listing_agent text,
  source_sheet text,
  url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dedupe key for sheet imports. Partial, so rows without a reference are fine.
create unique index if not exists properties_reference_key
  on public.properties (reference)
  where reference is not null;

-- ── Contacts ─────────────────────────────────────────────────────────────

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  -- E.164, the only format WhatsApp accepts. Unique: one row per human.
  phone_e164 text not null unique,
  full_name text,
  email text,
  contact_type text not null default 'unknown'
    check (contact_type in ('owner','buyer','both','unknown')),
  language text not null default 'en',

  -- Where this row came from. Not decoration: when Meta or a regulator asks
  -- how you got the number, this column and the consent ledger are the answer.
  source text,
  source_detail text,

  -- Derived from consent_events. Never written directly by an import; see the
  -- header note. 'unknown' is the correct state for a number lifted off a
  -- listing sheet, and it blocks every send.
  opt_in_state text not null default 'unknown'
    check (opt_in_state in ('unknown','opted_in','opted_out')),

  -- How the current opt-in was obtained, denormalised from consent_events.
  -- The gate needs it to answer a question last_inbound_at cannot: did this
  -- person come to US? A website-form or click-to-WhatsApp opt-in is the
  -- person reaching out, so copy referring to their enquiry is true. An
  -- imported or phone-recorded opt-in is not, so the same copy is a false
  -- claim and stays blocked. See SELF_INITIATED_METHODS in src/consent.ts.
  opt_in_method text,

  opted_in_at timestamptz,
  opted_out_at timestamptz,

  -- Last time THIS PERSON messaged us, set by the inbound webhook. It is the
  -- only evidence that a "you contacted us earlier" claim is true, and the
  -- gate refuses copy making that claim when this is null.
  last_inbound_at timestamptz,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Consent ledger ───────────────────────────────────────────────────────
-- Append-only. The Worker exposes no update or delete route for this table,
-- because an audit trail you can edit is not an audit trail.

create table if not exists public.consent_events (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  event text not null check (event in ('opt_in','opt_out')),
  channel text not null default 'whatsapp' check (channel in ('whatsapp')),

  -- How consent was obtained. 'imported_documented' is the only one that
  -- covers a pre-existing list, and it requires evidence_url or evidence_note
  -- (enforced by the CHECK below) — an unevidenced import is not consent.
  method text not null check (method in (
    'website_form',
    'click_to_whatsapp_ad',
    'inbound_message',
    'in_person_written',
    'phone_recorded',
    'imported_documented',
    'user_request'
  )),
  evidence_url text,
  evidence_note text,
  occurred_at timestamptz not null default now(),
  recorded_by text,
  created_at timestamptz not null default now(),

  -- An opt-in with nothing behind it is the exact thing that gets numbers
  -- banned, so the database refuses to store one. Opt-outs are exempt: when
  -- someone says stop, recording it must never fail on a paperwork rule.
  constraint consent_events_evidence_required check (
    event = 'opt_out'
    or method = 'inbound_message'
    or evidence_url is not null
    or evidence_note is not null
  )
);

create index if not exists consent_events_contact_idx
  on public.consent_events (contact_id, occurred_at desc);

-- ── Message templates ────────────────────────────────────────────────────
-- Mirrors what Meta has actually approved. `name` and `language` are the pair
-- the WhatsApp API identifies a template by, so they are unique together.

create table if not exists public.message_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  language text not null default 'en',
  category text not null default 'marketing'
    check (category in ('marketing','utility','authentication')),
  body text not null,
  -- Ordered variable names, e.g. ["name","area"]. The count must match what
  -- Meta approved or the send fails with error 132000.
  variables jsonb not null default '[]'::jsonb,

  -- Meta's verdict, not ours. Only 'approved' may be sent.
  meta_status text not null default 'draft'
    check (meta_status in ('draft','submitted','approved','rejected','paused','disabled')),
  meta_rejection_reason text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name, language)
);

-- ── Outreach queue ───────────────────────────────────────────────────────
-- One row per message, whether drafted for review or produced by the
-- autopilot. Under autopilot the row is written BEFORE the send, so an
-- interrupted run leaves evidence and the once-per-campaign index (0002) stops
-- the next tick sending a duplicate — which to a recipient is spam.

create table if not exists public.outreach_messages (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  property_id uuid references public.properties(id) on delete set null,
  template_id uuid references public.message_templates(id) on delete restrict,

  language text not null default 'en',
  -- What the recipient will actually read, variables already substituted.
  -- Stored so the human approves the real text, not a template with holes.
  rendered_body text not null,
  variables jsonb not null default '[]'::jsonb,

  status text not null default 'draft' check (status in (
    'draft',     -- agent wrote it, nobody has looked
    'blocked',   -- the gate refused it; block_reasons says why
    'approved',  -- a human said send it
    'sending',   -- handed to LetsBot, no reply yet
    'sent',      -- LetsBot accepted it
    'failed',    -- LetsBot rejected it
    'cancelled'  -- a human said no
  )),
  -- Gate codes, e.g. ["NO_OPT_IN","TEMPLATE_NOT_APPROVED"].
  block_reasons jsonb not null default '[]'::jsonb,

  provider text not null default 'letsbot',
  provider_message_id text,
  error text,

  approved_at timestamptz,
  approved_by text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists outreach_messages_queue_idx
  on public.outreach_messages (status, created_at desc);

-- Powers the frequency cap: "how many did this contact already get".
create index if not exists outreach_messages_contact_sent_idx
  on public.outreach_messages (contact_id, sent_at desc)
  where sent_at is not null;

-- One draft per contact per property per template.
--
-- NULLS NOT DISTINCT is load-bearing and was missing in the first version of
-- this file. Postgres treats NULLs as distinct in a unique index by default, so
-- without it (contact, NULL, template) repeats without limit — and a draft with
-- no property attached is the common case, which meant the index did nothing
-- for most rows. Requires Postgres 15+.
create unique index if not exists outreach_messages_dedupe_key
  on public.outreach_messages (contact_id, property_id, template_id)
  nulls not distinct
  where status in ('draft','blocked','approved');

-- ── RLS ──────────────────────────────────────────────────────────────────

do $$
declare
  t text;
begin
  foreach t in array array[
    'properties', 'contacts', 'consent_events', 'message_templates', 'outreach_messages'
  ] loop
    if exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and not c.relrowsecurity
    ) then
      execute format('alter table public.%I enable row level security', t);
      raise notice 'RLS turned ON for public.% — the anon key now reads zero rows there', t;
    end if;
  end loop;
end
$$;
