---
name: testing-dxxpcode-cli
description: How to end-to-end test the dxxpcode terminal AI-agent CLI — mock provider scripts, PTY harness for approval prompts, session isolation, and known sharp edges.
---

# Testing the dxxpcode CLI end-to-end

## Build first — dist is often stale
`apps/cli/dist/cli.js` is NOT rebuilt on edit and `dist/` is gitignored. Always run `npm run build` before testing the compiled binary, or run from source: `node --conditions=development apps/cli/src/cli.ts`. Check staleness with `grep -c DXXPCODE_MOCK_SCRIPT packages/providers/dist/select.js` (>0 = current).

IMPORTANT for interactive runs: the TTY UI is ink/React (`apps/cli/src/ui/App.tsx`) — plain `node` cannot load `.tsx`. For interactive dev runs use `npm run dev` (in apps/cli) or `NODE_OPTIONS=--conditions=development tsx apps/cli/src/cli.ts`. Built `dist/` works with plain `node`. Non-interactive paths (piped stdin, `--help`) never load the ink UI, so `node --conditions=development apps/cli/src/cli.ts` still works for them.

## Deterministic agent runs (no API keys needed)
- `DXXPCODE_PROVIDER=mock DXXPCODE_MOCK_SCRIPT=/path/script.json` — script is a JSON array of turns consumed one per provider call: `{text?, toolCalls?: [{name, input}], stopReason?}`.
- A turn with `propose_plan` (`input: {summary, steps: [...], trivial}`) ends the plan phase. `trivial: true` skips the approval prompt entirely but still prints the plan. Use `trivial:false` when you need to drive the plan approval menu. A turn may set `delayMs` to simulate latency (needed to see `◆ Thought for Ns` and the spinner).
- Tools: `read_file`, `write_file`, `edit_file`, `list_directory`, `search_files`, `run_command`, `git_status/diff/log`, `delete_file`, `remember`. Plan phase only allows read-only tools (plus `remember`) — a mock script calling an execute-phase-only tool before `propose_plan` gets `Denied: not available while planning`; emit `propose_plan` (use `trivial:true` to skip approval) first.
- `DXXPCODE_HOME=/tmp/somewhere` isolates sessions/config from `~/.dxxpcode` — always set it in tests.

## Driving interactive prompts under a PTY
`script -qec "<cmd>" /tmp/out.log` (util-linux) gives the child a TTY stdin and records the transcript.

CRITICAL: do NOT feed all input at once (`printf 'n\ny\n' | script ...`). When the feeder hits EOF, `script` tears down the pty and any unanswered `Allow? [y/N]` prompts lose stdin — the CLI then exits 0 silently mid-task. Pace the input so the pty stays alive until the run finishes:

```sh
{ printf 'n\n'; sleep 0.7; printf 'y\n'; sleep 0.7; printf 'y\n'; sleep 0.7; } | script -qec "node .../cli.js task" out.log
```

Interactive prompts are arrow-key menus (ink): `↑/↓` + Enter, or letter shortcuts — `y`, `n`, and `a` (tool approvals: Yes / Always (this session) / No). `esc` denies the pending menu AND aborts the run. With `expect`, match on `navigate · Enter select` (there is no `[y/N]` prompt text anymore). Answering `a` adds the exact `tool:arg` to a session-scoped allowlist; later identical actions show `allowed earlier this session` and skip the menu.

## Non-interactive paths (no PTY needed)
- Positional task or `echo task | dxxpcode` → `stdin.isTTY` false → plan prompts print the plan then auto-deny with "non-interactive run — re-run with --yes"; tool approvals deny with "…re-run with --yes to allow".
- `--yes` auto-approves both plan and tool prompts without a TTY (approval tier only — `restricted` items like `.env`, `../x`, `rm -rf /`, `~/.ssh` are denied regardless and never prompt).
- Empty piped stdin → "no task given" exit 2. Unknown `--flag` → exit 2. Missing provider → exit 1.

## Sessions / resume
Sessions persist to `$DXXPCODE_HOME/sessions/<slug>-<ts>-<rand>.json` keyed by absolute `projectRoot`. `dxxpcode --resume` picks the most recently updated one for the cwd and prints `resumed session <id> (N messages)`.

## Signals
SIGINT during a `run_command` sets an abort flag → run ends `cancelled`, exit 1. `run_command` spawns detached (`detached:true`) and kills the whole process group (`kill(-pid, SIGKILL)`), so grandchildren die too — observed exit ~8ms after SIGINT on `sleep 30`, zero orphans (verify with `pgrep -x sleep`). Ctrl-C/ctrl-D at the REPL `>` prompt exit cleanly with code 0. EOF mid-approval resolves the pending prompt as "" → denied, and subsequent prompts deny cleanly (the readline-close path is guarded — no ERR_USE_AFTER_CLOSE).

## Testing the desktop app (apps/desktop)

- Run `npm run dev` in `apps/desktop` (vite serves on :5173 per tauri.conf devUrl), then launch `apps/desktop/src-tauri/target/debug/dxxpcode-desktop`. Rebuild the sidecar first with `cargo build` in `apps/agent-rs`.
- The sidecar resolution prefers `DXXPCODE_BIN` — always set `DXXPCODE_BIN=<repo>/apps/agent-rs/target/debug/dxxpcode` so it does not spawn a stale `src-tauri/target/debug/dxxpcode` or a PATH-installed binary.
- Launch with a fresh `HOME` (e.g. `env HOME=/tmp/fresh XAUTHORITY=/home/ubuntu/.Xauthority DISPLAY=:0 ./src-tauri/target/debug/dxxpcode-desktop`) to trigger `needsSetup` → the onboarding wizard.
- Onboarding protocol: the UI sends `{"type":"setup","provider":"anthropic"|"openai"|"mock","key"?:...,"base_url"?:...}`; the sidecar validates via `list_models()` BEFORE writing config and replies `{"type":"setup_result","ok":...,"error"?}`. `provider:"mock"` installs a session-only demo provider (model chip shows `demo`) and writes nothing to `~/.dxxpcode/config.json`.
- Verify "not saved" claims by inspecting `$HOME/.dxxpcode/config.json` after a failed validation — it should only contain `installId`.
- Kill the app with `kill $(pgrep -x dxxpcode-deskto)`; focus it with `wmctrl -i -a <winid>` (get the id from `wmctrl -l`).
- To observe startup/`ready==null` states (e.g. the boot mark): point `DXXPCODE_BIN` at a wrapper script that sleeps then execs the real sidecar (`#!/bin/sh\nsleep 12\nexec <repo>/apps/agent-rs/target/debug/dxxpcode "$@"`). Also `pkill -f 'dxxpcode --app'` between launches — orphaned sidecars let the next launch connect instantly and skip boot.

## Testing the site (apps/site) gated/API features
- Vercel PR previews are deployment-protected — don't rely on them. Build `apps/site` (`npm run build`), serve `dist/` statically, and add a tiny node shim for `/api/*` that proxies to `$UPSTASH_REDIS_REST_URL`: POST a JSON command array (e.g. `["HGETALL","tier:1"]`) with `authorization: Bearer $UPSTASH_REDIS_REST_TOKEN`; response is `{"result": ...}`.
- `HGETALL` returns a flat array `[field, value, …]` over REST — convert to an object before field access.
- Seed/cleanup test purchases: `["HSET","purchase:cs_test","consumed",1,"license_key","dxxp-live-…"]` + `["SET","license:dxxp-live-…","cs_test"]`, then `["DEL",…]` after.
