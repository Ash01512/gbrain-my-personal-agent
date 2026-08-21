-- Adds `track`: which search profile queued this role.
--
-- Two profiles now run against very different rubrics -- an AI/data track and a
-- facilities-leadership track -- and reviewing them in one list is the problem.
-- They compete on a score that does not mean the same thing in both: a 9 on the
-- facilities rubric and a 9 on the AI rubric are not the same claim, so sorting
-- them together silently ranks one against the other. Separating them is the
-- point of the column.
--
-- Nullable on purpose. Rows queued before this migration have no track and must
-- keep working; the Worker treats a null track as "unfiled" rather than guessing.
-- Safe to re-run.

alter table public.applications
  add column if not exists track text;

-- Constrained rather than free text. An agent that invents a third track name
-- should get a 400 from the Worker, not quietly create a category that no filter
-- in the dashboard will ever show.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'applications_track_values'
  ) then
    alter table public.applications
      add constraint applications_track_values
      check (track is null or track in ('ai', 'facilities'));
  end if;
end $$;

-- The queue reads `track = ? and status = 'saved'` ordered by score. Without
-- this the filtered queue degrades to a sequential scan the moment the table is
-- worth filtering.
create index if not exists applications_track_status_score_idx
  on public.applications (track, status, match_score desc nulls last);
