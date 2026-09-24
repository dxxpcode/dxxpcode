# Changelog

All notable changes to dxxpcode are documented here. Versions follow semver.

## [Unreleased]

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

