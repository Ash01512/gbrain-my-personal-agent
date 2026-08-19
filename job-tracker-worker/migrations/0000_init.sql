-- Baseline schema. This mirrors what already exists in the live job-tracker
-- Supabase project; it is written down so a fresh database can be provisioned
-- from this repository alone.
--
-- The unique index on job_url is load-bearing. POST /api/queue relies on it to
-- reject a role the agent has already queued (Postgres 23505, which the Worker
-- maps to 409). Without it a re-run silently duplicates every candidate.
--
-- ── Read before running this against a database that already has data ──
--
-- The `create table if not exists` statements are no-ops on an existing table.
-- They do not add a missing column, default, or CHECK — so this file cannot
-- repair drift, only provision a fresh database. Run `0002_verify.sql` after
-- it to find out whether the live schema actually matches.
--
-- Two statements below are NOT no-ops and are not reversible by re-running:
--
--   1. The unique index aborts if `applications` already holds duplicate
--      non-null job_url values. Check first:
--        select job_url, count(*) from public.applications
--        where job_url is not null group by 1 having count(*) > 1;
--   2. Enabling RLS is a state change. With RLS on and no policies, PostgREST
--      answers the anon key with HTTP 200 and an empty array — not a 403. So
--      anything else reading this database with the anon key stops seeing rows
--      and gets no error saying why. That is the intended posture (the Worker
--      holds the service-role key and is the security boundary), but turn it
--      on knowingly. The DO block below reports what it changed.

create extension if not exists pgcrypto;

create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  role text not null,
  location text,
  job_url text,
  source text,
  status text not null default 'saved'
    check (status in ('saved','applied','screening','interview','offer','rejected','withdrawn')),
  applied_on date,
  last_contact_on date,
  salary_range text,
  contact_name text,
  contact_email text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cv_versions (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  content text,
  file_url text,
  target_role text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cover_letters (
  id uuid primary key default gen_random_uuid(),
  application_id uuid references public.applications(id),
  cv_version_id uuid references public.cv_versions(id),
  content text,
  status text not null default 'draft'
    check (status in ('draft','final','sent')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dedupe key for the agent queue. Partial, so many rows may have no URL.
create unique index if not exists applications_job_url_key
  on public.applications (job_url)
  where job_url is not null;

-- RLS on with no policies: the anon key reads nothing. The Worker holds the
-- service-role key and is itself the security boundary. See README.
--
-- Announced rather than applied silently, because this is the one statement in
-- the file that can change what an existing client sees — and it changes it to
-- an empty result set rather than an error.
do $$
declare
  t text;
begin
  foreach t in array array['applications', 'cv_versions', 'cover_letters'] loop
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
