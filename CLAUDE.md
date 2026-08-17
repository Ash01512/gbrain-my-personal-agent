# gbrain-my-personal-agent

Personal agent workspace.

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

This repo runs in Claude Code on the web, where two things differ from a local install:

- **Chromium.** `cdn.playwright.dev` is blocked by the sandbox network policy, so
  `playwright install` fails. The image ships Chromium at `$PLAYWRIGHT_BROWSERS_PATH`
  (`/opt/pw-browsers`) as build 1194, while gstack's Playwright pins 1234. Build 1234
  paths are symlinked to the 1194 binaries so the launch probe passes. Re-apply after a
  container rebuild if `./setup` fails on the Chromium step.
- **gbrain is not installed**, so brain-aware blocks are suppressed in the planning
  skills. Run `/setup-gbrain`, then re-run `./setup` (or `gstack-config gbrain-refresh`)
  to enable them.
