/** In-terminal reference rendered by /docs — kept in sync with apps/site docs. */
export const DOCS_MD = `# install

- \`npm i -g dxxpcode\` — then \`cd your-project && dxxpcode\`
- from source: \`npm install && npm run build && npm i -g ./apps/cli\`

# connect a provider

- \`/provider\` — guided connect; keys save to \`~/.dxxpcode/config.json\` (0600)
- or env: \`ANTHROPIC_API_KEY\`, \`OPENAI_API_KEY\` (+ optional \`OPENAI_BASE_URL\` for compatible endpoints)
- \`/providers\` — switch between configured providers; \`/model\` picks within the active one
- \`/setup\` — onboarding wizard: provider, effort, optional \`TYPESAFE_API_KEY\`

# workflow

1. describe a task — \`fix the failing test in math.js\`
2. review the plan → approve
3. the agent works: reads, edits, runs commands with approvals
4. tests run; \`/review\` shows diffs; \`/undo\` reverts the last checkpoint

# commands

- \`/status\` — session, provider, git, usage
- \`/settings\` — Settings + Session tabs (approval mode, provider, model, effort)
- \`/model\` · \`/providers\` · \`/effort\` — pickers
- \`/undo\` — restore files from the last checkpoint
- \`/compact\` — compress old tool output; \`/settings\` → Approval mode \`smart\` = Jev-decided approvals; effort \`auto (Jev)\` = Jev picks effort per task; \`/clear\` clears the transcript
- \`/review\` — diff of uncommitted changes; \`/provider\` — connect a key
- \`/changelog\` · \`/docs\` — this reference; \`/help\` · \`/exit\`
- \`/login\` sign in via browser · \`/logout\` · \`/upgrade\` billing

# mentions

- \`@file\` attach a file · \`@file#5-10\` line range · \`@dir/\` directory listing
- type \`@\` in the prompt to browse and Tab-complete paths

# flags + env

- \`dxxpcode --plan\` — plan only, no edits · \`--yes\` auto-approve · \`--review\` · \`--undo\` · \`--resume\` · \`--model <m>\` · \`--effort <e>\`
- \`DXXPCODE_PROVIDER\`, \`DXXPCODE_MODEL\`, \`DXXPCODE_HOME\` (default \`~/.dxxpcode\`)
- project instructions live in \`.dxxpcode/instructions.md\` — loaded automatically

# account

- \`/login\` opens the auth server sign-in in your browser and stores the token in config.json (owner-only)
- \`/upgrade\` opens billing/plan management; \`plan\` shows on the \`/status\` Session tab
- auth server defaults to \`https://dxxpcode.vercel.app\` — override with \`DXXPCODE_AUTH_URL\`, \`TYPESAFE_API_KEY\`

# config file

- \`~/.dxxpcode/config.json\`: provider, model (+ per-provider \`models\`), approvalMode, effort, keys, authToken, plan
`;

/** In-terminal release history rendered by /changelog — mirror of CHANGELOG.md. */
export const CHANGELOG_MD = `# Unreleased

- \`/compact\` forces context compaction; \`/status\` shows context usage vs the 60k cap
- background processes — \`run_background\`, \`check_process\`, \`kill_process\` with per-name logs
- git-aware checkpoints — \`/undo\` restores files and warns when HEAD moved
- multi-provider sessions — \`/providers\` switcher + per-provider model memory
- \`@mention\` autocomplete, \`@file#L-M\` line ranges, \`@dir/\` listings
- \`todo_write\` live checklists, \`/effort\` shortcut, full effort range (minimal→max)
- opencode-style streaming — tool icons + live verb lines; geometric XX mark
- tabbed \`/settings\` (Settings + Session); model+effort change notes
- \`/docs\` and \`/changelog\` here in the terminal
- \`--resume\` banner indicator; live git state in \`/status\`; \`OPENAI_BASE_URL\` fix

# v0.1.0 — initial release

- interactive terminal UI — boxed input, arrow-key approvals, scrollable transcript, status bar, live turn meter, slash-command autocomplete, persistent history
- agent loop — plan → approve → execute → verify, permission tiers, session "always allow"
- providers — Anthropic + OpenAI-compatible streaming adapters; \`/provider\` connect flow
- tools — filesystem, search, shell, git; \`@file\` mentions; inline diff previews
- context compaction past ~60k tokens; \`--resume\`; \`--plan\`, \`--review\`, \`--yes\`
- update notifications via npm registry (24h cache)
`;
