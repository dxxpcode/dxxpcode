/** In-app reference rendered by /docs — kept in sync with apps/site docs. */
export const DOCS_MD = `# install

- download the desktop app from GitHub releases — \`.dmg\` (macOS), \`.msi\`/\`.exe\` (Windows), \`.deb\`/\`.AppImage\` (Linux)
- the app bundles the agent — no Node or separate CLI install required
- first run opens a setup card; re-open it anytime via Settings → Run setup

# in the app

- \`/\` opens the command palette; \`@\` opens file mentions (\`@file#L-M\`, \`@dir/\`)
- \`⌘K\` search sessions · \`⌘B\` collapse the sidebar · \`⌘,\` Settings · \`⇧Tab\` plan mode (Ctrl on Windows/Linux)
- approvals are clickable (Allow / Always / Deny); type mid-run to steer; \`Esc\` interrupts
- the model picker (bottom-left of the composer) sets both model and reasoning effort
- theme lives in Settings → Appearance — light, pure-black dark, or system

# cli engine

- the bundled \`dxxpcode\` binary also works standalone: \`dxxpcode --task "…"\` (or \`--print\`)
- \`dxxpcode --app\` is the NDJSON protocol the app speaks — useful for other front-ends

# connect a provider

- \`/provider\` — connect a key or switch providers; keys save to \`~/.dxxpcode/config.json\` (0600)
- or env: \`ANTHROPIC_API_KEY\`, \`OPENAI_API_KEY\` (+ optional \`OPENAI_BASE_URL\` for compatible endpoints)
- \`/model\` picks a model within the active provider; \`/variant\` picks a named config preset
- \`/setup\` — onboarding wizard: provider, effort, optional \`TYPESAFE_API_KEY\`

# workflow

1. describe a task — \`fix the failing test in math.js\`
2. review the plan → approve
3. the agent works: reads, edits, runs commands with approvals
4. tests run; \`/review\` shows diffs; \`/undo\` reverts the last checkpoint

# commands

- \`/status\` — session, provider, git, usage
- \`/settings\` — Settings + Session tabs (approval mode, provider, model, effort)
- \`/model\` · \`/models\` · \`/variant\` — pickers; \`/provider\` · \`/providers\` — connect or switch
- \`/effort\` — reasoning effort · \`/approval\` — approval mode: ask, always, or smart (Jev)
- \`/review\` — diff of uncommitted changes; \`/review agent\` runs an AI review
- \`/undo\` — restore files from the last checkpoint
- \`/resume\` — resume a previous session for this project; \`/new\` starts a fresh one
- \`/tools\` — custom tools: \`/tools enable <name>\` · \`disable\` · \`remove\`; drop a \`.toml\` in \`~/.dxxpcode/tools/\` (or \`.dxxpcode/tools/\` per project) with \`name\`, \`description\`, \`command\` (\`{arg}\` placeholders under \`[args]\`), \`permission = "auto"|"ask"\`; new tools start disabled until enabled
- \`/compact\` — compress old tool output; \`/license\` — save or show a lifetime license key; \`/clear\` clears the transcript
- \`/changelog\` · \`/docs\` — this reference; \`/help\` · \`/exit\`

# mentions

- \`@file\` attach a file · \`@file#5-10\` line range · \`@dir/\` directory listing
- type \`@\` in the prompt to browse and Tab-complete paths

# flags + env

- \`dxxpcode --task "…"\` · \`--plan\` plan only, no edits · \`--yes\`/\\\`-y\` auto-approve · \`--resume\` · \`--provider <p>\` · \`--model <m>\` · \`--effort <e>\` · \`--variant <v>\` · \`--max-iterations <n>\` · \`--app\` · \`--version\` · \`--help\`
- \`DXXPCODE_PROVIDER\`, \`DXXPCODE_MODEL\`, \`DXXPCODE_HOME\` (default \`~/.dxxpcode\`)
- project instructions live in \`.dxxpcode/instructions.md\` — loaded automatically

# account

- \`TYPESAFE_API_KEY\` enables smart approvals + auto effort routing (Jev)

# config file

- \`~/.dxxpcode/config.json\`: provider, model (+ per-provider \`models\`), approvalMode, effort, keys
`;

/** In-app release history rendered by /changelog — mirror of CHANGELOG.md. */
export const CHANGELOG_MD = `# Unreleased

- \`/compact\` forces context compaction; \`/status\` shows context usage vs the 60k cap
- background processes — \`run_background\`, \`check_process\`, \`kill_process\` with per-name logs
- git-aware checkpoints — \`/undo\` restores files and warns when HEAD moved
- multi-provider sessions — \`/providers\` switcher + per-provider model memory
- \`@mention\` autocomplete, \`@file#L-M\` line ranges, \`@dir/\` listings
- \`todo_write\` live checklists, \`/effort\` shortcut, full effort range (minimal→max)
- opencode-style streaming — tool icons + live verb lines; geometric XX mark
- tabbed \`/settings\` (Settings + Session); model+effort change notes
- \`/docs\` and \`/changelog\` in the app
- \`--resume\` banner indicator; live git state in \`/status\`; \`OPENAI_BASE_URL\` fix

# v0.1.0 — initial release

- interactive terminal UI — boxed input, arrow-key approvals, scrollable transcript, status bar, live turn meter, slash-command autocomplete, persistent history
- agent loop — plan → approve → execute → verify, permission tiers, session "always allow"
- providers — Anthropic + OpenAI-compatible streaming adapters; \`/provider\` connect flow
- tools — filesystem, search, shell, git; \`@file\` mentions; inline diff previews
- context compaction past ~60k tokens; \`--resume\`; \`--plan\`, \`--review\`, \`--yes\`
- update notifications via npm registry (24h cache)
`;
