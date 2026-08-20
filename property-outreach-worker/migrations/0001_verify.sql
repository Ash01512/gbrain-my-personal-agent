-- Schema verification. Changes nothing; raises if the live database does not
-- match what the Worker assumes.
--
-- Why this exists: `create table if not exists` is a total no-op against an
-- existing table, so 0000 reports success without reconciling a single column.
-- Drift then surfaces at runtime as a raw PostgREST 400 on a column that does
-- not exist — or, worse, silently: if `opt_in_state` were missing its CHECK,
-- a typo'd value would store fine and the gate would read a state it has no
-- branch for.
--
-- The last two blocks are the ones to care about. They verify the two
-- constraints that stop an unevidenced opt-in from existing at all. Without
-- them the application-level checks are the only thing between a cold list and
-- a send, and a single direct SQL insert goes around those.

do $$
declare
  problem text;
  problems text[] := '{}';
begin
  -- Columns the Worker reads or writes by name, with the type it assumes.
  for problem in
    with expected(tbl, col, typ) as (values
      ('contacts', 'id', 'uuid'),
      ('contacts', 'phone_e164', 'text'),
      ('contacts', 'full_name', 'text'),
      ('contacts', 'contact_type', 'text'),
      ('contacts', 'language', 'text'),
      ('contacts', 'source', 'text'),
      ('contacts', 'opt_in_state', 'text'),
      ('contacts', 'opt_in_method', 'text'),
      ('contacts', 'opted_in_at', 'timestamp with time zone'),
      ('contacts', 'opted_out_at', 'timestamp with time zone'),
      ('contacts', 'last_inbound_at', 'timestamp with time zone'),
      ('consent_events', 'id', 'uuid'),
      ('consent_events', 'contact_id', 'uuid'),
      ('consent_events', 'event', 'text'),
      ('consent_events', 'method', 'text'),
      ('consent_events', 'evidence_url', 'text'),
      ('consent_events', 'evidence_note', 'text'),
      ('consent_events', 'occurred_at', 'timestamp with time zone'),
      ('message_templates', 'id', 'uuid'),
      ('message_templates', 'name', 'text'),
      ('message_templates', 'language', 'text'),
      ('message_templates', 'category', 'text'),
      ('message_templates', 'body', 'text'),
      ('message_templates', 'variables', 'jsonb'),
      ('message_templates', 'meta_status', 'text'),
      ('outreach_messages', 'id', 'uuid'),
      ('outreach_messages', 'contact_id', 'uuid'),
      ('outreach_messages', 'property_id', 'uuid'),
      ('outreach_messages', 'template_id', 'uuid'),
      ('outreach_messages', 'rendered_body', 'text'),
      ('outreach_messages', 'variables', 'jsonb'),
      ('outreach_messages', 'status', 'text'),
      ('outreach_messages', 'block_reasons', 'jsonb'),
      ('outreach_messages', 'provider_message_id', 'text'),
      ('outreach_messages', 'sent_at', 'timestamp with time zone'),
      ('outreach_messages', 'campaign_id', 'uuid'),
      ('campaigns', 'id', 'uuid'),
      ('campaigns', 'name', 'text'),
      ('campaigns', 'template_id', 'uuid'),
      ('campaigns', 'status', 'text'),
      ('campaigns', 'variable_sources', 'jsonb'),
      ('campaigns', 'daily_cap', 'integer'),
      ('campaigns', 'batch_size', 'integer'),
      ('campaigns', 'sent_count', 'integer'),
      ('properties', 'id', 'uuid'),
      ('properties', 'title', 'text'),
      ('properties', 'reference', 'text'),
      ('properties', 'listing_type', 'text')
    )
    select case
      when c.column_name is null
        then format('missing column %s.%s', e.tbl, e.col)
      else format('%s.%s is %s, expected %s', e.tbl, e.col, c.data_type, e.typ)
    end
    from expected e
    left join information_schema.columns c
      on c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col
     and c.data_type = e.typ
    where c.column_name is null
  loop
    problems := problems || problem;
  end loop;

  -- The unique index that makes one row mean one human. Without it an import
  -- can create a second row for the same number, and an opt-out recorded
  -- against one of them leaves the other still sendable.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'contacts'
      and indexdef ilike '%unique%phone_e164%'
  ) then
    problems := problems || 'contacts.phone_e164 has no unique index';
  end if;

  -- The constraint that makes an unevidenced opt-in impossible at the storage
  -- layer, not just in the Worker. This is the one that survives someone
  -- inserting rows with psql.
  if not exists (
    select 1 from pg_constraint
    where conname = 'consent_events_evidence_required'
  ) then
    problems := problems || 'consent_events is missing the evidence CHECK — '
      || 'an opt-in with nothing behind it can be stored';
  end if;

  -- The once-per-campaign index. Without it a cron tick that overlaps another,
  -- or a retry that replays, sends the same person the same message twice --
  -- which to the recipient is indistinguishable from spam.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'outreach_messages_campaign_once_key'
  ) then
    problems := problems || 'outreach_messages is missing the once-per-campaign index';
  end if;

  -- The trigger stopping a campaign going active on a template Meta has not
  -- approved. The scheduler runs unattended, so this has to hold in the
  -- database rather than only in the Worker.
  if not exists (
    select 1 from pg_trigger where tgname = 'campaigns_require_approved_template'
  ) then
    problems := problems || 'campaigns is missing the approved-template trigger';
  end if;

  -- RLS. Off means the anon key reads every contact and every phone number.
  for problem in
    select format('RLS is OFF for public.%s', c.relname)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('properties','contacts','consent_events','message_templates',
                        'outreach_messages','campaigns')
      and not c.relrowsecurity
  loop
    problems := problems || problem;
  end loop;

  if array_length(problems, 1) > 0 then
    raise exception E'schema does not match what the Worker assumes:\n  %',
      array_to_string(problems, E'\n  ');
  end if;

  raise notice 'schema OK';
end
$$;
