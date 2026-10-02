# Contributing to DxxpCode

DxxpCode is an AI coding agent in a desktop app: a Rust agent engine (`dxxpcode` binary) embedded in a Tauri + React shell, speaking a `--app` NDJSON protocol. Contributions are welcome — bug reports, fixes, docs, and features.

## Repository layout

```
apps/agent-rs/   Rust agent engine — providers, tools, permissions, sessions
apps/desktop/    Tauri + React desktop app (the product)
apps/cli/        Legacy TypeScript CLI (superseded by agent-rs)
apps/site/       Landing page (Vite)
```

## Development setup

Requirements: Rust stable, Node 20+, and Tauri prerequisites (`cargo tauri` deps per platform).

```sh
# Agent engine
cd apps/agent-rs
cargo build           # produces target/debug/dxxpcode
cargo test

# Desktop app (serves the React UI at localhost:5173)
cd apps/desktop
npm install
npm run dev           # vite dev server
cargo tauri dev       # or run src-tauri/target/debug/dxxpcode-desktop
npm run build         # typecheck + bundle — must pass before PR
```

The app spawns the agent binary itself; override it during development with `DXXPCODE_BIN=/path/to/target/debug/dxxpcode`.

## Testing without a real provider

The mock provider replays scripted turns — no API key needed:

```sh
DXXPCODE_PROVIDER=mock DXXPCODE_MOCK_SCRIPT=/path/to/script.json dxxpcode --app
```

A script is an array of turns; each turn supports `text`, `think`, `toolCalls`, `stopReason`, `delayMs`, `thinkDelayMs`, `chunkDelayMs`. See `.agents/skills/testing-dxxpcode-cli/SKILL.md` for the full harness notes.

## Agent evaluation

`npm run eval` runs the agent over `eval/fixtures/*` and scores each run mechanically — completion, tests, regression (files changed outside the allowlist), tool-call count, tokens, interventions, wall time. Results land in `eval/results/` (gitignored); `node eval/scoreboard.mjs` prints the table.

A fixture is a directory with real files plus `eval.json` (`task`, `verify` {command, files, grep}, `expect` {max_tool_calls, autoApprove, …}) and `mock.json` — the mock-provider script the runner uses with `--provider mock` (default). With `--provider real` the runner uses the configured provider/env keys, so the same corpus grades real model changes. Add one by copying an existing fixture and adjusting the mock's `old_string` to match your files exactly (mock edits are real edits).

## Conventions

- **Commits**: conventional style (`feat:`, `fix:`, `chore:`, …).
- **PRs**: open against `main`; CI must be green (tests + desktop/site builds).
- **Rust**: `cargo check` and `cargo test` clean; keep the `--app` protocol documented in ARCHITECTURE.md when changing events.
- **Desktop**: `npm run build` must pass; UI changes should be verified live and screenshots attached to the PR.
- **Style**: minimal diffs, match surrounding code, no speculative abstractions.

## Releases

Versioning is driven by `desktop-v*` tags — bump the app, Tauri config, Rust crate, and site download links together, then push the tag to trigger the release matrix (macOS/Windows/Linux installers). Do not publish packages to npm.

## License

By contributing you agree your contributions are licensed under the [Apache-2.0 License](LICENSE).
