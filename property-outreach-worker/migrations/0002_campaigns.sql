-- Campaigns: what turns this from an API into something that runs by itself.
--
-- A campaign is a standing instruction — this template, to this audience, at
-- this pace — that the Worker's cron handler executes without anyone present.
-- Removing the human from the loop does not remove the rules; it moves the
-- whole weight of them onto the gate in src/consent.ts, which is why the
-- constraints below are stricter than they were when a person was reviewing.
--
-- Two of them are load-bearing:
--
--   1. A campaign cannot reference a template Meta has not approved. Enforced
--      by the trigger at the bottom, not just by the Worker, because an
--      unattended sender has no one to notice.
--   2. One message per contact per campaign, ever. The unique index makes a
--      duplicate physically impossible even if the scheduler runs twice, two
--      cron ticks overlap, or a retry replays — none of which are hypothetical
--      in a distributed runtime.

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  template_id uuid not null references public.message_templates(id) on delete restrict,

  status text not null default 'draft'
    check (status in ('draft','active','paused','done')),

  -- Audience. Null means "do not filter on this".
  audience_contact_type text
    check (audience_contact_type is null
           or audience_contact_type in ('owner','buyer','both','unknown')),
  audience_language text,

  -- Ordered source fields for the template's {{1}}, {{2}} … placeholders,
  -- e.g. ["contact.full_name","property.area"]. Resolved per contact at send
  -- time; a field that is missing or empty skips that contact rather than
  -- sending them a message with a hole in it.
  variable_sources jsonb not null default '[]'::jsonb,

  -- Optional property the copy is about, used to resolve property.* sources.
  property_id uuid references public.properties(id) on delete set null,

  -- Pace. Meta rates a number partly on how it ramps, and a new number that
  -- sends its whole list on day one is the classic way to get restricted.
  daily_cap integer not null default 20 check (daily_cap between 1 and 1000),
  -- Messages per cron tick. Keeps one run from consuming the day's budget in
  -- a single burst.
  batch_size integer not null default 5 check (batch_size between 1 and 100),

  sent_count integer not null default 0,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Which campaign produced a message. Nullable: messages predating campaigns,
-- and any one-off sent by hand, have none.
alter table public.outreach_messages
  add column if not exists campaign_id uuid references public.campaigns(id) on delete set null;

-- The once-ever rule, as a database fact rather than an application intention.
--
-- Covers every row that is not cancelled, so a draft the gate blocked still
-- holds the slot — otherwise a blocked contact would be re-drafted on every
-- single cron tick, forever, and the queue would fill with identical rows.
create unique index if not exists outreach_messages_campaign_once_key
  on public.outreach_messages (campaign_id, contact_id)
  where campaign_id is not null and status <> 'cancelled';

create index if not exists outreach_messages_campaign_idx
  on public.outreach_messages (campaign_id, created_at desc);

-- A campaign may only point at a template Meta approved.
--
-- In the Worker this is a gate check. Here it is a constraint, because the
-- scheduler runs with nobody watching: if a template is later paused or
-- rejected by Meta, this stops the campaign being pointed at it, and the
-- gate stops the sends that are already queued against it.
create or replace function public.campaigns_require_approved_template()
returns trigger
language plpgsql
as $$
declare
  status text;
begin
  if new.status <> 'active' then
    return new;
  end if;
  select meta_status into status
  from public.message_templates where id = new.template_id;
  if status is distinct from 'approved' then
    raise exception 'campaign % cannot be active: template is %, not approved by Meta',
      new.name, coalesce(status, 'missing');
  end if;
  return new;
end
$$;

drop trigger if exists campaigns_require_approved_template on public.campaigns;
create trigger campaigns_require_approved_template
  before insert or update on public.campaigns
  for each row execute function public.campaigns_require_approved_template();

do $$
begin
  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'campaigns' and not c.relrowsecurity
  ) then
    alter table public.campaigns enable row level security;
    raise notice 'RLS turned ON for public.campaigns — the anon key now reads zero rows there';
  end if;
end
$$;
