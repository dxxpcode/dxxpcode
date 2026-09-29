# Diff-review flow — spec

Every agent file mutation lands in the transcript as a reviewable diff card instead of silently touching disk. The user can review, apply, or discard each change.

## Current state

- `write_file`, `edit_file`, `delete_file` write directly; `take_checkpoint` snapshots pre-write state for `/undo` (agent.rs).
- Approvals today are per-tool via `approve_tool` (ask/always/smart modes).

## Design

### Protocol

New events/commands in the NDJSON app protocol:

- Sidecar emits `{type:"diff_review", id, path, kind:"write"|"edit"|"delete", diff}` where `diff` is a unified diff (old → proposed new) computed before the write.
- UI sends `{type:"diff_decide", id, decision:"apply"|"discard"|"apply_all"}` to resolve.
- `apply_all` auto-applies remaining diffs in the session (same trust semantics as "always allow").

### Rust side (agent.rs/tools.rs)

- In the write path (agent.rs ~line 821 where checkpoints are taken), when review mode is on: compute the proposed change without touching disk, emit `diff_review`, then block on a decision channel (same mechanism `sh.ask` uses for approvals).
- For `edit_file` this is natural — the tool already computes old/new content. For `write_file`, diff is `existing-file → new` or `∅ → new` for creates.
- Checkpoints still record the decision outcome so `/undo` keeps working for applied changes.
- In `ask` approval mode this effectively replaces the tool-approval prompt for write-family tools (the diff IS the thing being approved). In `always-approve` mode diffs stream into the transcript already-applied, marked "applied" for visibility — review UI without blocking.

### UI (App.tsx + styles)

- `diff_review` renders a `DiffCard` transcript item: file path header (icon + path + "+N −M" summary), collapsed unified-diff body with syntax-tinted +/- lines, action row.
- Actions: `Apply` (primary), `Discard` (ghost), `Apply all` (secondary). Keyboard: Enter = apply, Esc = discard while card is focused.
- After decide, card state flips to "applied"/"discarded" — the diff body stays expandable for the record.
- Applied-all mode: subsequent cards render instantly resolved with an "applied" badge.

### Settings

- New toggle in Settings → Approvals: "Review diffs before writing" — on by default in `ask` mode; off means current behavior (approve the tool call, not the diff).

## Why this shape

- Builds on the approval plumbing that already exists (`sh.ask` blocking decision channel, session allowlist) — no new IPC machinery.
- Fits the minimal brief: the diff card is just another transcript row, not a new panel.
- Diff-beats-approve: users read what will actually change rather than approving an opaque `edit_file` call.
