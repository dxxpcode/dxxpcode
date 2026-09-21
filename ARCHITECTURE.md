# DxxpCode — Architecture

```
                         MODEL
                           │
                           ▼
┌───────────────────────────────────────────┐
│               AGENT RUNTIME               │
│                                           │
│ Context → Plan → Tools → Verify → Result  │
└─────────────────────┬─────────────────────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
      Filesystem     Shell       Git
          │           │           │
          └───────────┼───────────┘
                      ▼
                 LOCAL PROJECT
                      │
                      ▼
                   TERMINAL
```

The most important boundary: **the terminal UI is extremely thin**. The agent runtime owns planning, tool execution, permissions, context, verification, and sessions — the CLI only renders events and collects input. Other interfaces can be layered on later without redesigning the agent.

## Repository layout

```
apps/
  cli/                  terminal interface (`dxxpcode` binary)
packages/
  agent/                runtime: loop, context, planning, verification
  tools/                structured tools: filesystem, shell, git, search
  providers/            model adapters behind a common interface
  permissions/          safe / approval / restricted evaluation
  sessions/             local session persistence (~/.dxxpcode/sessions)
  project/              project detection, instructions, git state
test/                   unit + integration tests, fixture repositories
docs/                   this file and future design notes
```

Dependency direction is one-way:

```
cli → agent → {tools, providers, sessions, project, permissions}
tools → permissions
```

## Agent runtime

Each task runs a bounded loop:

```
user request
  → context gathering (project snapshot + instructions)
  → model call (streaming)
  → tool selection → permission check → tool execution → tool result
  → model … (iterate, max iterations enforced)
  → verification (test command)
  → final response + change summary
```

Two tool sets gate the lifecycle:

- **Plan phase** — read-only tools plus `propose_plan`. The model investigates and returns a numbered plan. The user approves before any mutation (`dxxpcode --plan` stops here). If the model marks the task trivial, it proceeds directly.
- **Execute phase** — full toolset. Mutating tools and risky commands route through the permission system; `approval` items prompt `Allow? [y/N]` (or auto-approve with `--yes`), `restricted` items are denied outright.

Iteration is capped (`maxIterations`, default 40) so the agent cannot loop indefinitely; cancellation flows through `AbortSignal`.

## Model interface

`@dxxpcode/providers` defines `ModelProvider.chat(messages, tools, opts)` returning a normalized event stream (`text`, `tool_use`, `done`). Anthropic and OpenAI adapters are thin `fetch`-based implementations — no SDK dependency. A `MockProvider` (scripted turns) drives tests and offline development. New providers implement the same interface; the runtime never names a provider directly.

## Tool system

Each tool carries `{name, description, inputSchema, permissionHint, execute}`. Implemented: `read_file`, `write_file`, `edit_file`, `list_directory`, `search_files`, `run_command`, `git_status`, `git_diff`, plus `propose_plan`. The registry emits provider-shaped schemas (JSON Schema) so adapters need no tool-specific code.

## Permissions

`@dxxpcode/permissions` classifies every file path and shell command before execution:

- **safe** — read/list/search inside the project; writes to ordinary project files; status/test/build commands.
- **approval** — deletes/renames, writes to manifests/configs (package.json, tsconfig, .github, Dockerfile…), package installs, `git commit/push/reset`, `rm`, `sudo`, unknown commands (fail-closed).
- **restricted** — anything outside the project root, credential/secret patterns (`.env*`, `*.pem`, `id_rsa`, `.ssh`, `.aws`, credential stores), destructive system commands.

## Sessions

`@dxxpcode/sessions` appends each task's record — messages, tool calls, files changed, commands, result — to `~/.dxxpcode/sessions/` as JSON, keyed by project path. `dxxpcode --resume` restores the latest session's conversation for the current directory and continues interactively. No cloud database.

## Technology

- Node.js ≥ 22.6, TypeScript strict, ESM, npm workspaces.
- Published shape: `tsc` emits `dist/` per package; dev/test run `.ts` sources directly via Node type-stripping (`node --conditions=development --test`).
- Zero runtime dependencies. Dev dependencies: `typescript`, `@types/node`.
