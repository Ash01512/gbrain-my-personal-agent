#!/usr/bin/env bash
# Deploys the Worker and pushes its secrets, reading them from .dev.vars.
#
#   ./scripts/deploy.sh
#
# .dev.vars is the file you already fill in for `npm run dev`, and it is
# gitignored. Reusing it means the three values are typed once and the same
# ones reach production, rather than being retyped into a dashboard form where
# a trailing space is invisible.
#
# Idempotent: re-running updates the secrets and redeploys. Secret values are
# piped to wrangler on stdin and never appear in the terminal, the shell
# history, or this script's output.

set -euo pipefail
cd "$(dirname "$0")/.."

WRANGLER="npx --yes wrangler@4"

require_node_22() {
  local major
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -lt 22 ]; then
    echo "Node 22+ required (wrangler needs it); found $(node -v 2>/dev/null || echo none)." >&2
    echo "  nvm use 22   # .nvmrc pins it" >&2
    exit 1
  fi
}

echo "==> Pre-flight"
require_node_22
echo "    node $(node -v)"

if [ ! -f .dev.vars ]; then
  cat >&2 <<'MSG'

.dev.vars not found.

  cp .dev.vars.example .dev.vars     # then fill in the three values

  SUPABASE_URL                https://<ref>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY   Supabase > Settings > API > service_role
  API_TOKEN                   openssl rand -hex 32
MSG
  exit 1
fi

# Parse without sourcing: .dev.vars is dotenv-ish, and sourcing it would
# execute whatever is in there.
read_var() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .dev.vars |
    head -n1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

# A plain string, not an array: macOS still ships bash 3.2, where expanding an
# empty array under `set -u` is an unbound-variable error.
missing=""
for name in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY API_TOKEN; do
  value=$(read_var "$name")
  case "$value" in
    ''|*YOUR_PROJECT_REF*|your-service-role-key|generate-a-long-random-token)
      missing="${missing:+$missing }$name" ;;
  esac
done
if [ -n "$missing" ]; then
  echo "    !! still placeholder or empty in .dev.vars: $missing" >&2
  echo "       Deploying with these would produce a Worker that 401s or 503s" >&2
  echo "       on every request." >&2
  exit 1
fi
echo "    .dev.vars has all three values"

# Authentication is checked BEFORE the test suite. It is the one failure that
# is certain rather than probable, and discovering it after a full run wastes
# the time it was going to waste anyway.
#
# `wrangler whoami` exits 0 whether or not you are logged in, so the exit code
# says nothing — parse what it actually printed. An earlier version of this
# script trusted the status, never called `wrangler login`, and reported
# "cloudflare: authenticated" about a logged-out session.
authed() {
  ! $WRANGLER whoami 2>&1 | grep -qi 'not authenticated'
}

if ! authed; then
  if [ -t 0 ] && [ -t 1 ]; then
    echo
    echo "==> Authenticating with Cloudflare (opens a browser, one time)"
    $WRANGLER login
    if ! authed; then
      echo "    !! login did not complete — nothing was deployed" >&2
      exit 1
    fi
  else
    cat >&2 <<'MSG'
    !! Not authenticated with Cloudflare, and this is not an interactive
       terminal — the browser login cannot run here. Either:

         npx wrangler login          in a real terminal, then re-run this
       or
         export CLOUDFLARE_API_TOKEN=...    ("Edit Cloudflare Workers" token)

       Stopping now rather than after the test suite.
MSG
    exit 1
  fi
fi
account=$($WRANGLER whoami 2>/dev/null |
  grep -iE 'associated with the email|account name' | head -n1 | tr -s ' ' || true)
echo "    cloudflare: ${account:-authenticated}"

echo
echo "==> Checks (never deploy something the suite has not seen)"
npm run --silent check

echo
echo "==> Deploying"
deploy_log=$(mktemp)
trap 'rm -f "$deploy_log"' EXIT
$WRANGLER deploy 2>&1 | tee "$deploy_log"

# wrangler prints the URL on its own line; take the last workers.dev or custom
# route it reports.
WORKER_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' "$deploy_log" | tail -n1 || true)

echo
echo "==> Setting secrets"
# After the deploy, because `wrangler secret put` needs the Worker to exist.
# In the gap it fails closed — every /api route 401s rather than serving the
# database — so the ordering is safe.
#
# Each `secret put` creates and deploys a new version by itself, so no redeploy
# follows. (If you ever move to gradual deployments, that stops being true:
# `wrangler versions secret put` only stages a version, and it needs a
# `wrangler versions deploy` after it.)
#
# Piped on stdin so no value is ever an argv entry or a history line.
for name in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY API_TOKEN; do
  printf '%s' "$(read_var "$name")" | $WRANGLER secret put "$name" >/dev/null
  echo "    $name set"
done

# APP_TIMEZONE is not a secret. It belongs in wrangler.toml [vars], and a
# deploy is what publishes it — mention it rather than smuggling it in.
if ! grep -qE '^\s*APP_TIMEZONE\s*=' wrangler.toml; then
  echo
  echo "    note: APP_TIMEZONE is not set in wrangler.toml, so the daily count"
  echo "          uses UTC. For a UTC+4 user that rolls the day over at 04:00"
  echo "          local. Uncomment the [vars] block and re-run."
fi

if [ -n "$WORKER_URL" ]; then
  echo
  echo "==> Smoke test"
  API_TOKEN="$(read_var API_TOKEN)" ./scripts/smoke-test.sh "$WORKER_URL"
else
  echo
  echo "    Could not read the Worker URL out of the deploy output."
  echo "    Run the smoke test by hand:"
  echo "      API_TOKEN=... ./scripts/smoke-test.sh https://<worker>.workers.dev"
fi
