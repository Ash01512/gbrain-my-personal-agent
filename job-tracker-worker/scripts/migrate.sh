#!/usr/bin/env bash
# Applies the migrations in order against the job-tracker database.
#
#   SUPABASE_DB_URL='postgresql://...' ./scripts/migrate.sh
#
# The connection string is in the Supabase dashboard under Connect > Session
# pooler. It is a credential: pass it in the environment, do not paste it into
# a file that git can see.
#
# Safe to re-run. Every migration except 0000 is idempotent by construction; 0000 is
# guarded, but two of its statements are one-way, so this script checks for
# both before touching anything and asks before proceeding.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  cat >&2 <<'MSG'
SUPABASE_DB_URL is not set.

  Supabase dashboard > Connect > Session pooler > URI. Then:
    SUPABASE_DB_URL='postgresql://...' ./scripts/migrate.sh

Use the session pooler string, not the direct connection: the direct one is
IPv6-only on the free plan and will simply hang.
MSG
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  cat >&2 <<'MSG'
psql is not installed.

  macOS:  brew install libpq && brew link --force libpq
  Debian: sudo apt-get install -y postgresql-client

Or paste the files in migrations/ into the Supabase SQL editor by hand, applying
_verify last,
in filename order. This script is a convenience, not the only route.
MSG
  exit 1
fi

# ON_ERROR_STOP so a failure halts instead of running the rest against a
# half-migrated database.
psql_run() { psql "$SUPABASE_DB_URL" --no-psqlrc -v ON_ERROR_STOP=1 "$@"; }
psql_val() { psql_run -tAc "$1"; }

echo "==> Connecting"
psql_val 'select 1' >/dev/null
echo "    ok"

echo
echo "==> Pre-flight"

# Guard 1: the unique index aborts if duplicates already exist. Better to find
# out here, named, than mid-migration as a 23505.
dupes=0
if [ "$(psql_val "select to_regclass('public.applications') is not null")" = "t" ]; then
  dupes=$(psql_val "
    select coalesce(count(*), 0) from (
      select job_url from public.applications
      where job_url is not null group by job_url having count(*) > 1
    ) d")
fi
if [ "${dupes:-0}" != "0" ]; then
  echo "    !! $dupes job_url value(s) appear more than once."
  echo "       The unique index cannot be created until they are resolved:"
  psql_run -c "
    select job_url, count(*) as copies from public.applications
    where job_url is not null group by job_url having count(*) > 1
    order by copies desc limit 20"
  exit 1
fi
echo "    no duplicate job_url values"

# Guard 2: enabling RLS is one-way in effect. With RLS on and no policies,
# PostgREST answers the anon key with 200 and an empty array — not a 403 — so
# anything else reading this database silently sees nothing instead of an error.
rls_off=$(psql_val "
  select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('applications','cv_versions','cover_letters')
    and not c.relrowsecurity")

if [ -n "$rls_off" ]; then
  echo
  echo "    !! RLS is currently OFF on: $rls_off"
  echo "       Applying 0000 turns it ON. After that the anon key reads zero"
  echo "       rows from those tables and gets HTTP 200 with [] rather than an"
  echo "       error, so anything else pointed at this database goes quiet"
  echo "       instead of failing loudly. The Worker is unaffected: it holds"
  echo "       the service-role key, which bypasses RLS."
  echo
  if [ -t 0 ]; then
    read -r -p "       Type 'yes' to continue: " reply
    [ "$reply" = "yes" ] || { echo "       Aborted, nothing changed."; exit 1; }
  else
    echo "       Non-interactive shell. Re-run with MIGRATE_ENABLE_RLS=yes to accept."
    [ "${MIGRATE_ENABLE_RLS:-}" = "yes" ] || exit 1
  fi
else
  echo "    RLS already on (or the tables do not exist yet)"
fi

# Every migration except the verifier, in filename order. Discovered rather
# than listed: this loop used to name 0000 and 0001 explicitly, so adding 0003
# left it applying two of three migrations and reporting success. A migration
# you forgot to run fails later, somewhere else, as an opaque PostgREST 400.
#
# The verifier is excluded here and run last on purpose — it asserts the state
# every other migration produces, so running it in filename order would check
# the schema halfway through building it.
for file in $(ls migrations/[0-9]*.sql | grep -v '_verify\.sql$'); do
  echo
  echo "==> $file"
  psql_run -f "$file"
done

echo
echo "==> migrations/0002_verify.sql"
# The verifier raises on mismatch, which set -e turns into a non-zero exit.
# That is the point: a silent pass is the only acceptable outcome.
psql_run -f migrations/0002_verify.sql

echo
echo "==> Done. Schema matches what the Worker assumes."
echo "    Next: ./scripts/deploy.sh"
