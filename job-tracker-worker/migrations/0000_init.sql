-- Baseline schema. This mirrors what already exists in the live job-tracker
-- Supabase project; it is written down so a fresh database can be provisioned
-- from this repository alone. Safe to run against the existing project: every
-- statement is guarded.
--
-- The unique index on job_url is load-bearing. POST /api/queue relies on it to
-- reject a role the agent has already queued (Postgres 23505, which the Worker
-- maps to 409). Without it a re-run silently duplicates every candidate.

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
alter table public.applications enable row level security;
alter table public.cv_versions enable row level security;
alter table public.cover_letters enable row level security;
