#!/bin/bash
# SessionStart hook — restores agent tooling in Claude Code on the web.
#
# Containers here are ephemeral: $HOME is rebuilt every session, so gstack,
# gbrain and the Playwright browser bridge all have to be re-established
# before the agent can use them. This repo has no application dependencies;
# the tooling IS the dependency.
#
# Deliberately not `set -e`: a failure in any one stage should degrade that
# stage only, never block the session from starting.
set -uo pipefail

# Local machines already have this tooling installed and managed by hand.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

GSTACK_DIR="$HOME/.claude/skills/gstack"
GSTACK_REPO="https://github.com/garrytan/gstack.git"
PW_ROOT="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"

log() { echo "[session-start] $*"; }
warn() { echo "[session-start] WARNING: $*" >&2; }

# Bun is what gstack and gbrain both build with; make it visible to the
# session as well as to this script.
export PATH="$HOME/.bun/bin:$PATH"
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
fi

# ── 1. gstack ────────────────────────────────────────────────────────────────
if [ -d "$GSTACK_DIR/.git" ]; then
  log "gstack already present, skipping clone"
else
  log "cloning gstack"
  git clone --single-branch --depth 1 "$GSTACK_REPO" "$GSTACK_DIR" \
    || warn "gstack clone failed; skills will be unavailable this session"
fi

# ── 2. Playwright Chromium bridge ────────────────────────────────────────────
# cdn.playwright.dev is blocked by the sandbox network policy, so
# `playwright install` always fails. The image ships a Chromium build at
# $PW_ROOT, but usually a different revision than gstack's Playwright pins,
# and the two use different on-disk layouts. Point the pinned revision's
# paths at the build we actually have. gstack's setup aborts (set -e) the
# moment its launch probe fails, so this has to run BEFORE setup.
bridge_chromium() {
  [ -d "$PW_ROOT" ] || { warn "no Playwright browser root at $PW_ROOT"; return 1; }
  [ -f "$GSTACK_DIR/node_modules/playwright-core/browsers.json" ] || return 1

  local want
  want=$(node -e '
    const b = require(process.argv[1]);
    const c = b.browsers.find(x => x.name === "chromium");
    if (c) process.stdout.write(String(c.revision));
  ' "$GSTACK_DIR/node_modules/playwright-core/browsers.json" 2>/dev/null)
  [ -n "$want" ] || { warn "could not read pinned Chromium revision"; return 1; }

  # Highest installed revision wins; it is the closest match to the pin.
  local have
  have=$(ls -d "$PW_ROOT"/chromium-* 2>/dev/null \
    | sed 's/.*chromium-//' | grep -E '^[0-9]+$' | sort -n | tail -1)
  [ -n "$have" ] || { warn "no installed Chromium under $PW_ROOT"; return 1; }

  if [ "$want" = "$have" ]; then
    log "Chromium revision $want already matches, no bridge needed"
    return 0
  fi
  log "bridging Chromium $have -> pinned $want"

  # $2 is the modern layout Playwright expects; the installed build uses an
  # older one, so link the real files in under the expected names.
  link_build() {
    local src_root="$1" dst_root="$2" inner="$3" want_bin="$4"
    [ -d "$src_root" ] || return 0
    local src_inner
    src_inner=$(find "$src_root" -maxdepth 1 -mindepth 1 -type d | head -1)
    [ -n "$src_inner" ] || return 0

    mkdir -p "$dst_root/$inner"
    local f
    for f in "$src_inner"/*; do
      ln -sfn "$f" "$dst_root/$inner/$(basename "$f")"
    done
    # Binary was renamed between layouts (headless_shell -> chrome-headless-shell).
    if [ ! -e "$dst_root/$inner/$want_bin" ]; then
      local real
      real=$(find "$src_inner" -maxdepth 1 -type f -perm -u+x \
        \( -name 'headless_shell' -o -name 'chrome' \) | head -1)
      [ -n "$real" ] && ln -sfn "$real" "$dst_root/$inner/$want_bin"
    fi
    touch "$dst_root/INSTALLATION_COMPLETE" "$dst_root/DEPENDENCIES_VALIDATED"
  }

  link_build "$PW_ROOT/chromium-$have" \
             "$PW_ROOT/chromium-$want" "chrome-linux64" "chrome"
  link_build "$PW_ROOT/chromium_headless_shell-$have" \
             "$PW_ROOT/chromium_headless_shell-$want" \
             "chrome-headless-shell-linux64" "chrome-headless-shell"
}

probe_chromium() {
  ( cd "$GSTACK_DIR" && node -e '
      const { chromium } = require(process.cwd() + "/node_modules/playwright");
      (async () => { const b = await chromium.launch(); await b.close(); })()
        .then(() => process.exit(0), () => process.exit(1));
    ' ) >/dev/null 2>&1
}

if [ -d "$GSTACK_DIR" ]; then
  # setup runs `bun install` itself, but the bridge needs browsers.json first.
  if [ ! -d "$GSTACK_DIR/node_modules" ]; then
    log "installing gstack dependencies"
    ( cd "$GSTACK_DIR" && bun install --silent ) || warn "bun install failed"
  fi

  if probe_chromium; then
    log "Chromium launches, no bridge needed"
  else
    bridge_chromium || warn "Chromium bridge failed"
    probe_chromium \
      && log "Chromium launches after bridge" \
      || warn "Chromium still not launchable; browser skills will be degraded"
  fi

  # ── 3. gstack setup ────────────────────────────────────────────────────────
  # Idempotent by design, and re-running relinks skills after a $HOME rebuild.
  log "running gstack setup"
  ( cd "$GSTACK_DIR" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ./setup --quiet ) \
    || warn "gstack setup returned non-zero; some skills may be unregistered"
fi

# ── 4. gbrain ────────────────────────────────────────────────────────────────
if command -v gbrain >/dev/null 2>&1; then
  log "gbrain already installed"
elif [ -x "$GSTACK_DIR/bin/gstack-gbrain-install" ]; then
  log "installing gbrain"
  "$GSTACK_DIR/bin/gstack-gbrain-install" >/dev/null 2>&1 \
    || warn "gbrain install failed"
fi

# ── 5. gbrain config ─────────────────────────────────────────────────────────
# The connection string is a secret and is never committed. Set
# GBRAIN_DATABASE_URL in the environment's variables (Claude Code environment
# settings) and the brain reconnects automatically each session. Without it,
# gbrain stays installed but unconfigured, which is a working fallback.
if command -v gbrain >/dev/null 2>&1; then
  if [ -f "$HOME/.gbrain/config.json" ]; then
    log "gbrain already configured"
  elif [ -n "${GBRAIN_DATABASE_URL:-}" ]; then
    log "initializing gbrain from GBRAIN_DATABASE_URL"
    gbrain init --non-interactive --json --skip-embed-check >/dev/null 2>&1 \
      || warn "gbrain init failed; check GBRAIN_DATABASE_URL"
  else
    log "GBRAIN_DATABASE_URL not set; skipping gbrain init"
  fi

  # ── 6. MCP registration ──────────────────────────────────────────────────
  if [ -f "$HOME/.gbrain/config.json" ] && command -v claude >/dev/null 2>&1; then
    if claude mcp list 2>/dev/null | grep -q gbrain; then
      log "gbrain MCP already registered"
    else
      log "registering gbrain MCP"
      claude mcp add --scope user gbrain -- "$(command -v gbrain)" serve \
        >/dev/null 2>&1 || warn "gbrain MCP registration failed"
    fi
  fi
fi

log "done"
