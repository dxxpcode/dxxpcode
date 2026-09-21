# DxxpCode — Security Model

The application assumes the agent can make mistakes. Every capability the model can reach passes through a permission check before execution.

## Permission tiers

| Tier | Behavior | Examples |
| --- | --- | --- |
| **safe** | Executes without prompting | read/list/search files in project, `git status`, `git diff`, `git log`, test/build commands |
| **approval** | Prompts `Allow? [y/N]` with the reason | delete/rename files, `git commit`/`push`, package installs, config writes, `rm`, `sudo`, any unrecognized command |
| **restricted** | Always denied | paths outside the project root, SSH keys, `.env*`, credential stores, `*.pem`/`*.key`, system directories |

When the agent asks for approval the prompt shows the action and the stated reason:

```
The agent wants to run: rm -rf ./build
Reason: Remove generated build artifacts.
Allow? [y/N]
```

`--yes` auto-approves `approval`-tier actions for the session (use with care). `restricted` can never be approved — there is no flag that unlocks it.

## Filesystem boundary

All file tools resolve paths against the project root and reject anything that escapes it (`..`, absolute paths elsewhere, symlinked targets outside the root). The default access is the current project — never the whole computer.

## Secret protection

Reads *and* writes to these are restricted by pattern:

- `.env`, `.env.*`
- `id_rsa`, `id_ed25519`, `*.pem`, `*.key`, `*.p12`, `*.pfx`
- `.ssh/`, `.aws/`, `.gnupg/` (inside or outside the project)
- `credentials`, `secrets`, password-store paths

The agent receives a denial, not the file contents.

## Command safety

`run_command` evaluates the command string before spawning:

- A table of known-safe prefixes (`git status`, `npm test`, `pnpm test`, `cargo test`, `go test`, `pytest`, `tsc`, `node --test`, `ls`, `cat`, `rg`…) executes directly.
- Known-risky commands (`rm`, `mv`, `git push/commit/reset/clean`, `npm install`, `pnpm add`, `curl|wget` pipes, `chmod`, `docker`, `kill`, `apt`…) require approval.
- **Unknown commands default to approval** — the policy fails closed.
- Commands touching restricted paths are denied even when otherwise safe.

Execution happens with `cwd` pinned to the project root, a timeout, and captured output — no detached processes.

## Environment isolation

V0.1 uses a controlled local execution layer: workspace-jailed filesystem access, command evaluation, timeouts, and iteration caps. The agent loop never receives unrestricted system access. Stronger sandboxing (containers) can be added behind the same tool interface without redesigning the CLI.

## Credential handling

Provider API keys come from environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) or `~/.dxxpcode/config.json`. Keys are never logged, written to sessions, or sent anywhere besides the configured provider endpoint.

## Known limitations (V0.1)

- Command classification is pattern-based, not a sandbox — `--yes` trades safety for speed.
- A determined command (e.g. `make`, scripts inside `package.json`) can wrap risky behavior; approval prompts exist so a human sees the command first.
- Session files are plaintext JSON under `~/.dxxpcode/` — do not paste secrets into prompts.
