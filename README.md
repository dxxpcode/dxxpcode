# DxxpCode

An AI coding agent that lives entirely in your terminal. The CLI **is** the product — no desktop app, no dashboard, no embedded editor.

```
$ cd ~/projects/my-app
$ dxxpcode
my-app (JavaScript/TypeScript)  main*
provider: anthropic  model: claude-sonnet-4-5
Ready. Describe a task; ctrl-c to exit.
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
Proceed?  ❯ Yes / No   (↑/↓ navigate · Enter select)
```

## Install

```sh
npm install -g dxxpcode
```

Node.js ≥ 22.6 required.

## Configure a model provider

DxxpCode talks to model providers through a replaceable interface. The easiest way is in the app itself — run `dxxpcode` with no key configured (or `/provider` anytime) and it walks you through picking a provider and pasting a key, saved owner-only to `~/.dxxpcode/config.json`. Or set an env var and go:

```sh
export ANTHROPIC_API_KEY=...   # default model: claude-sonnet-4-5
# or
export OPENAI_API_KEY=...      # default model: gpt-4o
```

OpenAI-compatible endpoints (OpenRouter, local servers) work via `OPENAI_BASE_URL`. Force choices with `DXXPCODE_PROVIDER` / `DXXPCODE_MODEL`, or persist them in `~/.dxxpcode/config.json`:

```json
{ "provider": "anthropic", "model": "claude-sonnet-4-5", "approvalMode": "ask" }
```

## Commands

| Command | Description |
| --- | --- |
| `dxxpcode` | Interactive session in the current project |
| `dxxpcode "<task>"` | One-shot task |
| `dxxpcode --plan "<task>"` | Investigate and print a plan — no changes |
| `dxxpcode --review` | Colored diff of working-tree changes |
| `dxxpcode --resume` | Continue the last session in this directory |
| `dxxpcode --yes "<task>"` | Auto-approve actions that would prompt |
| `dxxpcode --help` | Full option list |

Piped input also works: `echo "add a /health endpoint" | dxxpcode`.

Attach files as task context with `@path` mentions — `dxxpcode "explain @src/math.ts"` appends the file as a `<file>` block. Mentions follow the same permissions as `read_file`: root-escaping and protected paths (`.env`, keys) are skipped with a note. Streamed answers render markdown: `**bold**`, `` `code` ``, `##` headers, `-` bullets, `>` quotes.

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

History lives in `~/.dxxpcode/sessions/` — tasks, messages, tool calls, changed files, and results. `dxxpcode --resume` restores the latest session for the current directory.

## Development

```sh
npm install
npm test          # node --test over .ts sources (type stripping)
npm run typecheck # strict tsc across the workspace
npm run build     # emits dist/ per package
```

Run the CLI from source: `node --conditions=development apps/cli/src/cli.ts` (non-interactive). The interactive UI is [ink](https://github.com/vadimdemedes/ink)/React under `apps/cli/src/ui/` — run it with `npm run dev -w apps/cli` (tsx) or the built `dist/`. Piped/non-TTY output keeps the plain renderer.

Layout — the agent runtime is independent of the terminal UI:

```
apps/cli               terminal interface (dxxpcode)
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
