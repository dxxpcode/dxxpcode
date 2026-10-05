# Changelog

All notable changes to dxxpcode are documented here. Versions follow semver.

## [Unreleased]

## [0.2.3] — 2026-10-05

- Agent: `browse` tool — headless-Chrome CDP driver (navigate, snapshot, click, type, wait, console, screenshot, evaluate) with accessibility-ref grounding and tiered browse permissions
- Agent: custom tools — shell-backed tools declared as `.toml` files in `~/.dxxpcode/tools/` or `.dxxpcode/tools/`; `/tools` lists, enables, disables, removes; `permission = "ask"` per tool
- Agent: OpenAI-compat fix — tool-result images now sent as a following user message (tool-role messages can't carry image parts)
- Desktop: tool-result images render inline for vision-capable providers

## [0.2.2] — 2026-10-04

- Desktop: new app icon — black XX mark on a white squircle, full iconset (.icns/.ico/png)
- Desktop: built-in art gallery in Settings → Appearance — six public-domain backdrops + custom folder
- Desktop: Art backdrop — pick an image folder as the full-window background; art forces dark theme, scrim + text shadows keep text readable over light images
- Desktop: parallel tasks via git worktrees — run sessions side-by-side, merge patches back
- Desktop: task queue — typing during a run queues the next session
- Agent: `/speed` — config-defined model service tiers
- Agent: loop efficiency — read cache, tool budget, thin-completion gate
- Agent: honest waiting — retries and named stalls surface in the statusline; esc interrupts pre-token latency
- Site: premium download gate — lifetime license key unlocks installers, email delivery + key recovery
- Desktop: onboarding "See it work" step — suggested first task

## [0.2.1] — 2026-09-27

- Desktop: in-app updates via tauri-plugin-updater — background check + download, "Update ready — restart" in Settings
- Desktop: "Open a project" onboarding step + Settings row — folder picker respawns the sidecar at the chosen directory
- Desktop: onboarding wizard — provider picker, live key validation, demo mode; default model picked from the endpoint's live list

## [0.2.0] — 2026-09-27

- `/compact` forces context compaction and `/status` shows `~Nk tok / 60k` context usage
- Background processes: `run_background`, `check_process`, `kill_process` tools with per-name logs under `~/.dxxpcode/bg/`
- Git-aware checkpoints: each records HEAD; `/undo` warns when HEAD moved since the checkpoint
- Multi-provider sessions: `/providers` switcher (Settings → Provider) with per-provider model memory
- `@mention` autocomplete with `@file#L-M` line ranges and `@dir/` directory listing
- `todo_write` live checklists, `/effort` shortcut, `/undo` file checkpoints, full effort range (minimal→max)
- Opencode-inspired streaming: per-tool icons and live verb lines; crisp geometric XX banner mark
- Tabbed `/settings` surface (Settings + Session tabs); `model: X · effort Y` change notes
- `/docs` and `/changelog` site pages; dark mode + animated terminal on the landing page
- `--resume` banner indicator, live git state in `/status`, `OPENAI_BASE_URL` trailing-slash fix
- `scripts/release.sh`: one-command release — changelog move, version bumps, commit, tag, publish


## [0.1.0] — initial release

- Interactive terminal UI (ink/React): boxed input, arrow-key approvals,
  scrollable transcript, status bar, live turn meter, slash-command
  autocomplete, persistent history
- Agent loop: plan → approve → execute → verify, with `propose_plan`,
  permission tiers (safe / approval / restricted), and session "always allow"
- Providers: Anthropic + OpenAI-compatible streaming adapters, scripted mock;
  first-run `/provider` connect flow, keys in `~/.dxxpcode/config.json` (0600)
- Tools: filesystem, search, shell, git; `@file` mentions; markdown-styled
  streamed output; inline diff previews; token/time footer
- Context compaction past ~60k estimated tokens; sessions persisted to
  `~/.dxxpcode/` with `--resume`; `--plan`, `--review`, `--yes` modes;
  ESC-to-interrupt; update notifications via npm registry (24h cache)

