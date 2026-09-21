# DxxpCode — Product Specification

DxxpCode is an AI coding agent that lives entirely in the terminal. The CLI **is** the product — it is not a CLI for a larger application.

## Working concept

A lightweight terminal application that lets developers use AI to understand, modify, test, and review software from their existing terminal.

```
$ cd ~/projects/my-app
$ dxxpcode
my-app
> Add password reset using Supabase Auth.
```

## Product principles

1. **Terminal first.** No desktop app, no graphical dashboard, no project-management interface, no embedded editor.
2. **Simple by default.** `npm install -g dxxpcode`, `cd project`, `dxxpcode`. Working in minutes.
3. **Existing workflow compatibility.** Complements VS Code, Cursor, Zed, JetBrains, Neovim, Vim, Emacs, and Git workflows. The developer never changes editors.
4. **Human-controlled execution.** The agent clearly distinguishes Planning → Execution → Verification. The developer understands what will happen before destructive operations run.
5. **Provider-independent.** The model layer is replaceable (OpenAI, Anthropic, Google, OpenRouter, local models). Provider breadth is not part of V0.1.
6. **Local-first.** The repository and execution environment stay on the developer's machine unless a provider requires remote inference.
7. **No product-management sprawl.** The hierarchy stays small: Project → Task → Execution → Result.

## Task lifecycle

1. **Understand** — the agent investigates before changing anything.
2. **Plan** — for meaningful changes, a numbered plan with `Proceed? [y/N]`. Trivial changes may execute directly.
3. **Execute** — concise progress without flooding the screen.
4. **Result** — changed files, test outcome, diff stats, then back to the prompt.

## Essential commands

| Command | Description |
| --- | --- |
| `dxxpcode` | Start interactive agent |
| `dxxpcode "fix the failing auth tests"` | Run a task directly |
| `dxxpcode --plan "refactor the db layer"` | Planning only |
| `dxxpcode --review` | Review working-tree changes |
| `dxxpcode --resume` | Resume previous session |
| `dxxpcode --version` / `--help` | Version / help |

No dozens of commands — the CLI stays small.

## Phase-0 decisions

- **Product name:** DxxpCode
- **CLI binary:** `dxxpcode`
- **Supported OS:** macOS and Linux first; Windows via WSL.
- **Initial providers:** Anthropic (`ANTHROPIC_API_KEY`) and OpenAI (`OPENAI_API_KEY`), auto-detected; `DXXPCODE_PROVIDER` / `DXXPCODE_MODEL` override.
- **Licensing:** Apache License 2.0.
- **Supported languages for project detection:** JavaScript/TypeScript, Python, Rust, Go, Java, .NET (manifest-based).
- **Permission philosophy:** three tiers — safe, approval-required, restricted — see SECURITY.md.
- **Configuration:** `~/.dxxpcode/config.json` (global), `.dxxpcode/` (project). Never required for normal usage.
- **Project instructions:** `.dxxpcode/instructions.md`, auto-loaded (`AGENTS.md` is also honored).

## V0.1 scope — the ten capabilities

1. Interactive terminal
2. Repository inspection
3. File editing
4. Shell execution
5. Git awareness
6. AI planning
7. Permission/approval system
8. Automatic testing
9. Diff/result reporting
10. Local session resume

## Non-goals for V0.1

Desktop app, web dashboard, embedded editor, cloud workspace, team management, billing, marketplace, multi-agent orchestration, elaborate memory, autonomous background agents, project management, task boards, analytics, social features, unnecessary integrations.

The first release answers one question: **can a developer complete real coding tasks from the terminal?**
