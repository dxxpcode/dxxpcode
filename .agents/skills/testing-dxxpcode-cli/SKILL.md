---
name: testing-dxxpcode-cli
description: How to end-to-end test the dxxpcode terminal AI-agent CLI — mock provider scripts, PTY harness for approval prompts, session isolation, and known sharp edges.
---

# Testing the dxxpcode CLI end-to-end

## Build first — dist is often stale
`apps/cli/dist/cli.js` is NOT rebuilt on edit and `dist/` is gitignored. Always run `npm run build` before testing the compiled binary, or run from source: `node --conditions=development apps/cli/src/cli.ts`. Check staleness with `grep -c DXXPCODE_MOCK_SCRIPT packages/providers/dist/select.js` (>0 = current).

## Deterministic agent runs (no API keys needed)
- `DXXPCODE_PROVIDER=mock DXXPCODE_MOCK_SCRIPT=/path/script.json` — script is a JSON array of turns consumed one per provider call: `{text?, toolCalls?: [{name, input}], stopReason?}`.
- A turn with `propose_plan` (`input: {summary, steps: [...], trivial}`) ends the plan phase. `trivial: true` skips the approval prompt entirely but still prints the plan. Use `trivial:false` when you need to drive the `Proceed? [y/N]` prompt.
- Tools: `read_file`, `write_file`, `edit_file`, `list_directory`, `search_files`, `run_command`, `git_status/diff/log`, `delete_file`. Plan phase only allows read-only tools.
- `DXXPCODE_HOME=/tmp/somewhere` isolates sessions/config from `~/.dxxpcode` — always set it in tests.

## Driving interactive prompts under a PTY
`script -qec "<cmd>" /tmp/out.log` (util-linux) gives the child a TTY stdin and records the transcript.

CRITICAL: do NOT feed all input at once (`printf 'n\ny\n' | script ...`). When the feeder hits EOF, `script` tears down the pty and any unanswered `Allow? [y/N]` prompts lose stdin — the CLI then exits 0 silently mid-task. Pace the input so the pty stays alive until the run finishes:

```sh
{ printf 'n\n'; sleep 0.7; printf 'y\n'; sleep 0.7; printf 'y\n'; sleep 0.7; } | script -qec "node .../cli.js task" out.log
```

`expect` is also installed; if you use it, glob-match on `y/N]` — patterns containing `[y/N]` literally fail because `[]` is a glob character class.

## Non-interactive paths (no PTY needed)
- Positional task or `echo task | dxxpcode` → `stdin.isTTY` false → plan prompts print the plan then auto-deny with "non-interactive run — re-run with --yes"; tool approvals deny with "…re-run with --yes to allow".
- `--yes` auto-approves both plan and tool prompts without a TTY (approval tier only — `restricted` items like `.env`, `../x`, `rm -rf /`, `~/.ssh` are denied regardless and never prompt).
- Empty piped stdin → "no task given" exit 2. Unknown `--flag` → exit 2. Missing provider → exit 1.

## Sessions / resume
Sessions persist to `$DXXPCODE_HOME/sessions/<slug>-<ts>-<rand>.json` keyed by absolute `projectRoot`. `dxxpcode --resume` picks the most recently updated one for the cwd and prints `resumed session <id> (N messages)`.

## Signals
SIGINT during a `run_command` sets an abort flag → run ends `cancelled`, exit 1. `run_command` spawns detached (`detached:true`) and kills the whole process group (`kill(-pid, SIGKILL)`), so grandchildren die too — observed exit ~8ms after SIGINT on `sleep 30`, zero orphans (verify with `pgrep -x sleep`). Ctrl-C/ctrl-D at the REPL `>` prompt exit cleanly with code 0. EOF mid-approval resolves the pending prompt as "" → denied, and subsequent prompts deny cleanly (the readline-close path is guarded — no ERR_USE_AFTER_CLOSE).
