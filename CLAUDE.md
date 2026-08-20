# job-tracker-agent

An agent that finds relevant roles, scores them against a CV, drafts tailored
cover letters, and queues them for human approval. The human presses submit.

- `job-tracker-worker/` — Cloudflare Worker: JSON API and approval dashboard
  over the `job-tracker` Supabase database.
- `property-outreach-worker/` — a second Worker on the same stack, for
  autonomous WhatsApp outreach to property owners and buyers via LetsBot. An
  hourly cron runs campaigns with no human in the loop; a consent gate refuses
  anything without a recorded opt-in, anything claiming a past interaction the
  database cannot evidence, and any second message to the same person.
  Deployed by hand, not by the Git integration.
- `docs/designs/job-tracker-agent.md` — approved design, including why the
  agent loop runs as a scheduled Claude session rather than in the Worker.
- The rest of this file documents the agent tooling the workspace runs on.

## gstack

[gstack](https://github.com/garrytan/gstack) is installed at `~/.claude/skills/gstack` and
registers 55 skills, invoked as slash commands (e.g. `/spec`, `/qa`, `/ship`).

Run `/gstack-upgrade` to update. The `browse` binary lives at
`~/.claude/skills/gstack/browse/dist/browse`.

### Planning & specs

| Skill | Purpose |
| --- | --- |
| `/spec` | Turn vague intent into a precise, executable spec in five phases |
| `/office-hours` | YC Office Hours — two modes |
| `/autoplan` | Runs the CEO, design, eng, and DX reviews sequentially with auto-decisions |
| `/plan-ceo-review` | CEO/founder-mode plan review |
| `/plan-design-review` | Designer's eye plan review — interactive |
| `/plan-eng-review` | Eng manager-mode plan review |
| `/plan-devex-review` | Interactive developer experience plan review |
| `/plan-tune` | Self-tuning question sensitivity + developer psychographic |

### Build, ship & deploy

| Skill | Purpose |
| --- | --- |
| `/ship` | Merge base branch, run tests, review diff, bump VERSION, update CHANGELOG, commit, push, open PR |
| `/land-and-deploy` | Land and deploy workflow |
| `/setup-deploy` | Configure deployment settings for `/land-and-deploy` |
| `/landing-report` | Read-only queue dashboard for workspace-aware ship |
| `/canary` | Post-deploy canary monitoring |

### QA & review

| Skill | Purpose |
| --- | --- |
| `/qa` | Systematically QA a web app and fix the bugs found |
| `/qa-only` | Report-only QA testing (no fixes) |
| `/review` | Pre-landing PR review |
| `/investigate` | Systematic debugging with root cause investigation |
| `/health` | Code quality dashboard |
| `/devex-review` | Live developer experience audit |
| `/cso` | Chief Security Officer mode |
| `/retro` | Weekly engineering retrospective |
| `/benchmark` | Performance regression detection using the browse daemon |
| `/benchmark-models` | Cross-model benchmark for gstack skills |

### Design

| Skill | Purpose |
| --- | --- |
| `/design-consultation` | Proposes a complete design system and generates font + color previews |
| `/design-html` | Design finalization: production-quality Pretext-native HTML/CSS |
| `/design-review` | Finds visual inconsistency, spacing, hierarchy, AI slop — then fixes them |
| `/design-shotgun` | Generate multiple design variants, compare on a board, iterate |

### Browser & data

| Skill | Purpose |
| --- | --- |
| `/browse` | Fast headless browser for QA testing and site dogfooding |
| `/open-gstack-browser` | Launch GStack Browser — AI-controlled Chromium with the sidebar extension (alias: `/connect-chrome`) |
| `/scrape` | Pull data from a web page |
| `/skillify` | Codify the most recent successful `/scrape` flow into a permanent browser-skill |
| `/setup-browser-cookies` | Import cookies from your real Chromium browser into the headless session |
| `/pair-agent` | Pair a remote AI agent with your browser |

### Documentation & diagrams

| Skill | Purpose |
| --- | --- |
| `/document-generate` | Generate missing documentation from scratch |
| `/document-release` | Post-ship documentation update |
| `/diagram` | English or mermaid → `.excalidraw` + rendered SVG/PNG |
| `/make-pdf` | Turn any markdown file into a publication-quality PDF |

### iOS

| Skill | Purpose |
| --- | --- |
| `/ios-qa` | Live-device iOS QA for SwiftUI apps |
| `/ios-fix` | Autonomous iOS bug fixer |
| `/ios-design-review` | Visual design audit for iOS apps on real hardware |
| `/ios-sync` | Regenerate the iOS debug bridge against the latest templates |
| `/ios-clean` | Remove the DebugBridge SPM package and all `#if DEBUG` wiring |

### Context & safety

| Skill | Purpose |
| --- | --- |
| `/context-save` | Save working context |
| `/context-restore` | Restore context saved earlier by `/context-save` |
| `/freeze` | Restrict file edits to a specific directory for the session |
| `/unfreeze` | Clear the freeze boundary set by `/freeze` |
| `/careful` | Safety guardrails for destructive commands |
| `/guard` | Full safety mode: destructive command warnings + directory-scoped edits |

### Setup & meta

| Skill | Purpose |
| --- | --- |
| `/gstack-upgrade` | Upgrade gstack to the latest version |
| `/setup-gbrain` | Install the gbrain CLI, initialize a local PGLite or Supabase brain, register MCP |
| `/sync-gbrain` | Keep gbrain current with this repo and refresh agent search guidance in CLAUDE.md |
| `/learn` | Manage project learnings |
| `/codex` | OpenAI Codex CLI wrapper — three modes |

### Environment notes

This repo runs in Claude Code on the web, where the container is ephemeral: `$HOME` is
rebuilt every session, so gstack, gbrain, and the browser bridge all have to be
re-established before the agent can use them. That is what the session bootstrap below
does. Two quirks it works around:

- **Chromium.** `cdn.playwright.dev` is blocked by the sandbox network policy, so
  `playwright install` always fails. The image ships Chromium at
  `$PLAYWRIGHT_BROWSERS_PATH` (`/opt/pw-browsers`), but usually at a different revision
  than gstack's Playwright pins, and the two use different on-disk layouts. The hook
  reads the pinned revision from `playwright-core/browsers.json` and symlinks the
  installed build into the paths Playwright expects. gstack's `./setup` runs under
  `set -e` and aborts the moment its launch probe fails, so the bridge must be applied
  before setup, not after.
- **gbrain** is installed by the hook but only configured when `GBRAIN_DATABASE_URL` is
  present (see below). Without a brain, brain-aware blocks stay suppressed in the
  planning skills.

## Session bootstrap

`.claude/hooks/session-start.sh` runs on SessionStart (registered in
`.claude/settings.json`) and restores the toolchain: clone gstack → `bun install` →
bridge Chromium → `./setup` → install gbrain → `gbrain init` → register the gbrain MCP.

It is idempotent, so each stage is skipped when already satisfied, and it runs only when
`CLAUDE_CODE_REMOTE=true` — local machines manage their own installs. No stage is fatal:
a failure degrades that stage and warns, rather than blocking the session from starting.

**To connect the brain, set `GBRAIN_DATABASE_URL`** to the Supabase Session Pooler URL in
the environment's variables (Claude Code environment settings). It is a credential and is
never committed to this repo. Without it, gbrain stays installed but unconfigured, which
is a working fallback.

Test it the way a fresh container would:

```bash
HOME=$(mktemp -d) CLAUDE_CODE_REMOTE=true ./.claude/hooks/session-start.sh
```
