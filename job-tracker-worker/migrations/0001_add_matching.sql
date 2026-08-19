-- Adds the columns the matching agent writes, plus the indexes the queue and
-- daily-count views read. Safe to re-run.

alter table public.applications
  add column if not exists match_score numeric(4,1),
  add column if not exists match_rationale text,
  add column if not exists cv_version_id uuid references public.cv_versions(id);

-- Scores are 0-10. Enforced here so a bad score is a 400 from the Worker
-- rather than silently poisoning the queue ordering.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'applications_match_score_range'
  ) then
    alter table public.applications
      add constraint applications_match_score_range
      check (match_score is null or (match_score >= 0 and match_score <= 10));
  end if;
end $$;

-- Queue view: highest-scoring unapplied roles first.
create index if not exists applications_queue_idx
  on public.applications (status, match_score desc nulls last, created_at desc);

-- Daily-count view: applications grouped by the day they were sent.
create index if not exists applications_applied_on_idx
  on public.applications (applied_on)
  where applied_on is not null;
