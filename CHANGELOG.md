# Changelog

All notable changes to dxxpcode are documented here. Versions follow semver.

## [Unreleased]

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
