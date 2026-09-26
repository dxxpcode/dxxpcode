# DxxpCode

An AI coding agent in a desktop app — one install, a custom terminal-native interface, and everything bundled. No terminal, editor, or Node setup required.

```
> Fix the failing authentication tests.
→ Inspecting project…
  → read_file src/auth/session.ts
  ✓ 48 lines
Plan
Fix session expiry handling and cover it with tests
  1. Update session validation
  2. Handle expired sessions
  3. Add regression tests
  4. Run authentication tests
Proceed?   Allow / Always / Deny
```

## Install

Download the app — it bundles the agent; nothing else to install:

- **macOS** — `.dmg`
- **Windows** — `.msi` or `.exe`
- **Linux** — `.deb` or `.AppImage`

Latest installers live on the [releases page](https://github.com/thenextdeveloper/DxxpCode-Terminal/releases).

## Configure a model provider

On first launch a setup card walks you through picking a provider and pasting a key (reopen it anytime via Settings → Run setup). Keys save owner-only to `~/.dxxpcode/config.json`. Or set an env var and go:

```sh
export ANTHROPIC_API_KEY=...   # default model: claude-sonnet-4-5
# or
export OPENAI_API_KEY=...      # default model: gpt-4o
```

OpenAI-compatible endpoints (OpenRouter, local servers) work via `OPENAI_BASE_URL`. Force choices with `DXXPCODE_PROVIDER` / `DXXPCODE_MODEL`, or persist them in `~/.dxxpcode/config.json`:

```json
{ "provider": "anthropic", "model": "claude-sonnet-4-5", "approvalMode": "ask" }
```

## In the app

- Type `/` for the command palette (`/docs`, `/settings`, `/resume`, `/model`, `/effort`, …)
- Type `@` for file mentions — `@file#L-M` attaches a line range, `@dir/` a directory listing
- Type while the agent works to **steer** it mid-run; `Esc` interrupts
- Approvals are clickable (Allow / Always / Deny); gear icon opens the settings panel; sun/moon toggles the black dark theme

### CLI engine

The `dxxpcode` binary ships inside the app and also works standalone for scripting — `dxxpcode "task"`, `--plan`, `--review`, `--resume`, `--undo`, `--yes`. `dxxpcode --app` is the NDJSON protocol the app speaks, usable for other front-ends.

## How it works

Every task runs **Context → Plan → Tools → Verify → Result**:

1. The agent inspects the project (read-only tools only).
2. It proposes a numbered plan you approve before anything changes — or proceeds directly for trivial tasks.
3. It edits files and runs commands inside the project root.
4. It runs the project's own test command and reports changed files plus diff stats.

### Permissions

Actions are classified **safe** / **approval** / **restricted**:

- Reads, searches, `git status/diff`, and test/build commands run freely.
- Deletes, git mutations, dependency installs, config writes, and unrecognized commands open an approval menu (Yes / Always / No — arrows or `y`/`a`/`n`).
- Anything outside the project root, `.env*`, SSH keys, and credential stores are always denied — no flag unlocks them.

See [SECURITY.md](SECURITY.md) for the full policy and known limitations.

### Project instructions

Drop a `.dxxpcode/instructions.md` (or `AGENTS.md`) in your repo to steer the agent:

```
Use pnpm.
Run tests before completing tasks.
Do not modify generated files.
```

### Sessions

History lives in `~/.dxxpcode/sessions/` — tasks, messages, tool calls, changed files, and results. `/resume` restores an earlier session for the current directory.

## Development

```sh
npm install
npm test          # node --test over .ts sources (type stripping)
npm run typecheck # strict tsc across the workspace
npm run build     # emits dist/ per package
```

The desktop app (`apps/desktop`) is Tauri + React and talks to the agent over `dxxpcode --app` (NDJSON protocol). Build it with `npm run tauri:build` from `apps/desktop` — this compiles the CLI into a bundled sidecar binary and produces native installers. The terminal UI is [ink](https://github.com/vadimdemedes/ink)/React under `apps/cli/src/ui/` — run it with `npm run dev -w apps/cli` or the built `dist/`.

Layout — the agent runtime is independent of any interface:

```
apps/desktop           desktop app (Tauri + React)
apps/cli               agent engine + CLI (dxxpcode, embedded in the app)
packages/agent         runtime: context → plan → tools → verify → result
packages/tools         read/write/edit/search/run_command/git_*
packages/providers     Anthropic + OpenAI adapters (fetch-based, zero-dep) + MockProvider
packages/permissions   safe / approval / restricted evaluation
packages/sessions      ~/.dxxpcode persistence + config
packages/project       project detection + instructions
test/                  unit + agent e2e tests + fixture repo
```

See [PRODUCT.md](PRODUCT.md) for scope and [ARCHITECTURE.md](ARCHITECTURE.md) for internals.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
