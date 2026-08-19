#!/usr/bin/env bash
# Verifies a deployed Worker actually works, against the real database.
#
#   API_TOKEN='...' ./scripts/smoke-test.sh https://<worker>.workers.dev
#
# The unit suite stubs fetch, so nothing in it proves a PostgREST round trip
# ever happens. This does. It also checks the security boundary holds in
# production, which is the claim that matters most if the URL is ever guessed.

set -euo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "usage: API_TOKEN=... $0 https://<worker>.workers.dev" >&2
  exit 1
fi
BASE="${BASE%/}"

if [ -z "${API_TOKEN:-}" ]; then
  echo "API_TOKEN is not set; the authenticated checks cannot run." >&2
  exit 1
fi

pass=0
fail=0

# Prints the status, then a verdict line. Never prints the token.
check() {
  local label="$1" expected="$2" actual="$3" detail="${4:-}"
  if [ "$actual" = "$expected" ]; then
    echo "    ok    $label ($actual)"
    pass=$((pass + 1))
  else
    echo "    FAIL  $label — expected $expected, got $actual"
    [ -n "$detail" ] && echo "          $detail"
    fail=$((fail + 1))
  fi
}

status() { curl -sS -o /dev/null -w '%{http_code}' -m 20 "$@"; }
body() { curl -sS -m 20 "$@"; }

echo "==> $BASE"
echo
echo "==> Configuration"

health_code=$(status "$BASE/api/health")
health_body=$(body "$BASE/api/health")
check "/api/health reports configured" 200 "$health_code" \
  "503 means a variable is unset. Response: $health_body"

echo
echo "==> Security boundary"

# The whole design rests on this: the Worker holds a service-role key that
# bypasses RLS, so an unauthenticated caller must get nothing.
check "no token is refused" 401 "$(status "$BASE/api/applications")"
check "wrong token is refused" 401 \
  "$(status -H 'Authorization: Bearer definitely-not-the-token' "$BASE/api/applications")"

# A leaked key would be the worst outcome, so assert none reaches a caller who
# has not authenticated. Matching key *material*, not variable names:
# /api/health says "service_role_key": true by design — that is the point of
# the endpoint, and an earlier version of this check flagged it.
public_bodies="$(body "$BASE/")$health_body$(body "$BASE/api/applications")"
leaks=""
# Supabase keys are JWTs (eyJ...header.payload.sig) or sb_secret_-prefixed.
printf '%s' "$public_bodies" | grep -qE 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' &&
  leaks="JWT-shaped string"
printf '%s' "$public_bodies" | grep -q 'sb_secret_' && leaks="${leaks:+$leaks, }sb_secret_ key"
# The API token is not a secret from the browser — the dashboard sends it — but
# it must never be in a response served to someone who did not present it.
printf '%s' "$public_bodies" | grep -qF "$API_TOKEN" && leaks="${leaks:+$leaks, }the API token"

if [ -n "$leaks" ]; then
  echo "    FAIL  unauthenticated responses contain: $leaks"
  fail=$((fail + 1))
else
  echo "    ok    no key material in unauthenticated responses"
  pass=$((pass + 1))
fi

echo
echo "==> Database round trip"

auth=(-H "Authorization: Bearer $API_TOKEN")
apps_code=$(status "${auth[@]}" "$BASE/api/applications")
apps_body=$(body "${auth[@]}" "$BASE/api/applications")
check "authenticated list succeeds" 200 "$apps_code" \
  "502 means the Worker cannot reach Supabase; 400 usually means a migration did not run. Response: $apps_body"

if printf '%s' "$apps_body" | grep -q '"data"'; then
  echo "    ok    list returns a data array"
  pass=$((pass + 1))
else
  echo "    FAIL  list response has no data key: $apps_body"
  fail=$((fail + 1))
fi

# These two exercise the columns 0001 adds. A raw PostgREST 400 here is the
# signature of a skipped migration, which is otherwise invisible until the
# agent posts its first candidate.
check "queue ordering works (0001 applied)" 200 \
  "$(status "${auth[@]}" "$BASE/api/applications?queue=true")" \
  "400 here means match_score is missing — run ./scripts/migrate.sh"
check "daily counts work" 200 "$(status "${auth[@]}" "$BASE/api/stats/daily")"

# Punctuation in a search term used to break the PostgREST filter grammar.
check "search survives a comma" 200 \
  "$(status "${auth[@]}" "$BASE/api/applications?q=Smith%2C%20Jones")" \
  "400 means the or= logic tree is being split by the comma again"

echo
echo "==> Dashboard"
ui_code=$(status "$BASE/")
check "dashboard is served" 200 "$ui_code"

echo
if [ "$fail" -eq 0 ]; then
  echo "==> $pass checks passed. The Worker is live and talking to the database."
  echo "    Open $BASE and paste your API token to connect."
else
  echo "==> $fail of $((pass + fail)) checks FAILED."
  exit 1
fi
