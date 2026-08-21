-- Schema verification. Changes nothing; raises if the live database does not
-- match what the Worker assumes.
--
-- Why this exists: `create table if not exists` is a total no-op against an
-- existing table, so 0000 reports success without reconciling a single column.
-- Drift then surfaces at runtime as a raw PostgREST 400 on a column that does
-- not exist — or, for `applied_on`, as no error at all: a timestamptz there
-- would break the exact date-string keys the daily rollup counts by, and every
-- day would quietly read zero.
--
-- Run it after 0000 and 0001, and again any time the daily count looks wrong.

do $$
declare
  problem text;
  problems text[] := '{}';
begin
  -- Columns the Worker reads or writes by name, with the type it assumes.
  for problem in
    with expected(tbl, col, typ) as (values
      ('applications', 'id', 'uuid'),
      ('applications', 'company', 'text'),
      ('applications', 'role', 'text'),
      ('applications', 'location', 'text'),
      ('applications', 'job_url', 'text'),
      ('applications', 'source', 'text'),
      ('applications', 'status', 'text'),
      ('applications', 'applied_on', 'date'),
      ('applications', 'last_contact_on', 'date'),
      ('applications', 'salary_range', 'text'),
      ('applications', 'contact_name', 'text'),
      ('applications', 'contact_email', 'text'),
      ('applications', 'notes', 'text'),
      ('applications', 'match_score', 'numeric'),
      ('applications', 'match_rationale', 'text'),
      ('applications', 'cv_version_id', 'uuid'),
      ('applications', 'track', 'text'),
      ('applications', 'created_at', 'timestamp with time zone'),
      ('applications', 'updated_at', 'timestamp with time zone'),
      ('cv_versions', 'id', 'uuid'),
      ('cv_versions', 'label', 'text'),
      ('cv_versions', 'content', 'text'),
      ('cv_versions', 'file_url', 'text'),
      ('cv_versions', 'target_role', 'text'),
      ('cv_versions', 'is_default', 'boolean'),
      ('cover_letters', 'id', 'uuid'),
      ('cover_letters', 'application_id', 'uuid'),
      ('cover_letters', 'cv_version_id', 'uuid'),
      ('cover_letters', 'content', 'text'),
      ('cover_letters', 'status', 'text')
    )
    select case
             when c.column_name is null then
               format('missing column: %s.%s', e.tbl, e.col)
             else
               format('wrong type: %s.%s is %s, expected %s',
                      e.tbl, e.col, c.data_type, e.typ)
           end
    from expected e
    left join information_schema.columns c
      on c.table_schema = 'public'
     and c.table_name = e.tbl
     and c.column_name = e.col
     and c.data_type = e.typ
    where c.column_name is null
  loop
    problems := problems || problem;
  end loop;

  -- The dedupe the queue's 409 depends on. Without it a re-run of the agent
  -- silently duplicates every candidate.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'applications_job_url_key'
  ) then
    problems := problems || 'missing unique index: applications_job_url_key';
  end if;

  -- The status CHECK. Without it the Worker's validation is the only thing
  -- keeping a bad status out of the counts.
  if not exists (
    select 1 from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'applications'
      and con.contype = 'c' and pg_get_constraintdef(con) like '%withdrawn%'
  ) then
    problems := problems || 'missing CHECK constraint on applications.status';
  end if;

  -- RLS with no policies is the security posture the Worker assumes. RLS off
  -- means the anon key can read the whole table straight from the internet.
  for problem in
    select format('RLS is OFF on public.%s — the anon key can read it', c.relname)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('applications', 'cv_versions', 'cover_letters')
      and not c.relrowsecurity
  loop
    problems := problems || problem;
  end loop;

  -- Rows the unique index cannot exist alongside.
  if exists (
    select 1 from public.applications
    where job_url is not null
    group by job_url having count(*) > 1
  ) then
    problems := problems || 'duplicate job_url values present; the unique index cannot be created';
  end if;

  if array_length(problems, 1) is null then
    raise notice 'schema OK: the live database matches what the Worker assumes';
  else
    raise exception E'schema does not match:\n  %', array_to_string(problems, E'\n  ');
  end if;
end
$$;
