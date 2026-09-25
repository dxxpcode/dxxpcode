# DxxpCode for macOS — product & engineering plan

Status: proposal · Scope: v1.0 GA · Supersedes the V0.1 "no desktop app" non-goal in `PRODUCT.md`
Reference: [Apple HIG — Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos)

## 1. What we're building

A **native macOS app that is the sibling of the CLI, not a port of it.** Two surfaces in one window: an **Agent** view (native chat / plan / approval / diff UI over the existing runtime) and a **Terminal** view (a real PTY). It reads and writes the same `~/.dxxpcode/` — config, sessions, checkpoints — so `dxxpcode --resume` in a terminal and the app see identical history and can hand work off to each other.

Positioning: the CLI stays the zero-install, scriptable product; the app is the deep-work version — multi-project windows, glanceable approval cards, persistent sidebar history, and macOS integrations (notifications, Spotlight, menu bar, Shortcuts) a TUI can't provide.

## 2. Decision: native SwiftUI + shared TypeScript runtime

The runtime is already UI-agnostic by design (`ARCHITECTURE.md`: "the terminal UI is extremely thin … other interfaces can be layered on later"). `runTask()` is an async generator emitting JSON-serializable `AgentEvent`s, and approvals are just `approveTool` / `approvePlan` callbacks. A SwiftUI shell gets everything the HIG asks for — menu bar, customizable toolbar, sidebar vibrancy, trackpad precision input, VoiceOver, Spotlight/Shortcuts/notifications — while the agent stays one shared codebase.

| Option | Verdict | Why |
| --- | --- | --- |
| **SwiftUI + bundled agent runtime** (chosen) | ✅ | Full HIG fidelity; runtime untouched; second thin client over the existing seam |
| Tauri 2 + web UI | ❌ | WebView can't deliver native toolbar/vibrancy/menu fidelity without heavy work; adds a third language (Rust) and a second UI stack |
| Electron | ❌ | Worst HIG fit, heaviest binary/memory cost; wrong trade for a tool users keep open all day |
| Full Swift rewrite of the agent | ❌ | Forks providers/tools/permissions onto a second codebase; every future feature lands twice |

## 3. Architecture

```
┌─ DxxpCode.app  (Swift 6 · SwiftUI · macOS 14+) ──────────────────┐
│  Window per project → spawns embedded helper on first task      │
│        │ stdio, newline-delimited JSON-RPC 2.0                  │
└────────┼────────────────────────────────────────────────────────┘
         ▼
  dxxpcode-agent   (apps/agentd — bundled universal2 binary)
         │ packages/bridge wraps runTask() and approval callbacks
         ▼
  packages/agent → tools/permissions/sessions → providers → model APIs
                        │
                        ▼
              ~/.dxxpcode/  (shared with CLI)
```

- **`apps/macos/`** — Xcode project (not SwiftPM executable): needed for `Info.plist`, entitlements, asset catalog, distribution. Deployment target **macOS 14.0 Sonoma** (`.inspector()`, `@Observable`, `MenuBarExtra`, App Intents all available; covers ~all modern Macs).
- **`apps/agentd/`** — new workspace: minimal headless entry point (no ink) exposing the bridge. Built with `bun build --compile --minify` per arch (`bun-darwin-arm64`, `bun-darwin-x64`), merged to universal2 with `lipo`, shipped at `Contents/Resources/dxxpcode-agent`, signed with the same Developer ID + hardened runtime. Fallback if `bun --compile` gives trouble: Node SEA.
- **`packages/bridge/`** — new workspace: JSON-RPC 2.0 server over stdio wrapping `runTask`. Protocol maps 1:1 onto runtime APIs:
  - **Methods:** `run.start {projectRoot, task, planOnly?, effort?, model?, resumeSessionId?}` · `run.cancel {sessionId}` · `plan.respond {requestId, approve}` · `approval.respond {requestId, allow, always?}` · `session.list {projectRoot?}` · `session.get {id}` · `checkpoint.undo {projectRoot, sessionId}` · `config.get` / `config.set` · `providers.list` · `secrets.set {provider, key}`.
  - **Notifications:** `event` = `AgentEvent` serialized verbatim; `plan` / `approval_request` carry a `requestId` the app answers with `*.respond`. The bridge implements `approveTool`/`approvePlan` by emitting the request and awaiting the response — the permission tiers can never be bypassed by the UI. `always` feeds a per-window allowlist mirroring the CLI's in-process `allowlist` set.
- **Secrets:** the app stores provider keys in Keychain (`kSecClassGenericPassword`, service `ai.dxxpcode.keys`, `kSecAttrAccessibleWhenUnlocked`) and injects them into agentd via `secrets.set` over stdio at spawn — never argv, env, or files (`ps` can't see stdin). agentd passes them to `resolveProvider`'s existing `keys` param. On app installs, `~/.dxxpcode/config.json` stops holding keys; the npm CLI keeps file/env keys as today.
- **Lifecycle:** one agentd per project window, spawned lazily on first task. Quitting with a live run shows a standard confirmation alert; the session JSON is already persisted and the conversation resumes cleanly.

## 4. The app, per the HIG

### Window & navigation
- `NavigationSplitView`: sidebar (projects → sessions, filter field, SF Symbols) · content (active session) · inspector ⌥⌘I (changed files + diff, todo checklist, checkpoints, token usage).
- Native window tabs (`tabbingMode = .preferred`): ⌘T / ⌘W / ⌃⇧⇥ come free from AppKit.
- Default 1200×800, min 960×600; frame + sidebar state restored on relaunch; full screen supported.

### Menu bar — every command reachable (HIG best practice)
| Menu | Items |
| --- | --- |
| App | About DxxpCode · Settings… ⌘, · Quit ⌘Q |
| File | New Session ⌘N · New Tab ⌘T · Open Project… ⌘O · Close Window ⇧⌘W |
| Edit | Copy ⌘C · Select All ⌘A (drop a file on the composer → `@`-mention, same permission rules as the CLI) |
| Agent | Approve ⌘⏎ · Deny ⌘. · Cancel Run ⇧⌘. · Undo to Checkpoint ⌥⌘Z · Resume Last Session ⇧⌘R |
| View | Toggle Sidebar ⌃⌘S · Inspector ⌥⌘I · Terminal Drawer ⌃` · Larger Text ⌘+ · Smaller Text ⌘− · Enter Full Screen ⌃⌘F |
| Window / Help | standard Window menu · DxxpCode Help → docs · Report an Issue → GitHub |

### Session UI
- **Transcript:** virtualized markdown stream ([MarkdownUI](https://github.com/gonzalezreal/MarkdownUI), MIT); tool calls render as expandable rows (icon + name + detail); text streams token-by-token.
- **Plan card:** numbered steps with Approve / Reject — the plan phase, natively.
- **Approval card:** the action (command/path), the model's `reason`, and a preview (command text or file diff); buttons **Allow once ⌘⏎** · **Always Allow ⌥⌘A** (enters the allowlist, surfaced in the inspector) · **Deny Esc**. If the app is unfocused, the same card arrives as a `UNUserNotificationCenter` notification with Approve/Deny actions; the Dock tile badges pending approvals.
- **Composer:** task field with `@` fuzzy file-picker (parity with CLI mentions, same restricted-path rules) and `/`-commands routed to native affordances (`/model` → toolbar picker, `/undo` → checkpoint list, `/provider` → Settings).
- **Changed-files inspector:** per-file unified diff (SF Mono, +/− coloring), click-to-open in default editor, per-checkpoint "Restore" action.
- **Toolbar:** customizable (`NSToolbar` customization id): provider/model picker, effort picker, approval-mode menu (ask / smart / always), share, inspector toggle.

### Terminal surface
- [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm) `LocalProcessTerminalView` — MIT, Metal-rendered, powers CodeEdit's terminal. Spawns the user's login shell; an agent action "Run in Terminal" executes visibly in the PTY. Available as a tab type and as a ⌃` drawer on agent tabs.

### System integrations (HIG "system features")
- **Notifications:** approval requests (actionable) and task-complete summaries (Reveal action).
- **Menu Bar Extra:** quick-task field + running-task status; toggle in Settings.
- **Spotlight:** sessions indexed via CoreSpotlight (`ai.dxxpcode.sessions` domain) — reopen via `NSUserActivity`.
- **URL scheme:** `dxxpcode://open?path=…` and `dxxpcode://run?task=…&path=…`; Finder **Services** item "New DxxpCode Session"; folder drop on Dock/window opens a project (`public.folder` type).
- **Shortcuts:** `RunTaskIntent` App Intent (task, path) for Shortcuts.app/Siri.
- **Appearance:** auto/light/dark, system accent color, sidebar vibrancy, SF Mono text; font size ⌘+/⌘−/⌘0.
- **Accessibility:** VoiceOver labels and rotor items on transcript rows, `NSAccessibility` announcements on status changes, full keyboard access, Dynamic Type (11 pt floor), Reduced Motion (no stream fades), Increase Contrast.
- **First run:** welcome sheet = the CLI `/provider` flow (pick provider, paste key → Keychain); drag-a-folder empty state.
- `PrivacyInfo.xcprivacy` (file-access + UserDefaults reasons); English-only at launch, strings in an `.xcstrings` catalog.

## 5. Security & privacy

- **No App Store** — a dev tool that executes arbitrary user commands can't be sandboxed. Notarized Developer ID distribution, like every serious Mac dev tool.
- **Hardened runtime**, minimal entitlements: `com.apple.security.cs.allow-jit` for the Bun-compiled agentd (verify at packaging time).
- Permission tiers preserved end-to-end — the bridge cannot approve, and the app adds no "disable restricted" escape.
- Keys in Keychain → stdio → `resolveProvider`; never in argv, env dumps, or files.
- Telemetry unchanged: the one-shot `trackInstall` ping against `dxxpcode.vercel.app/api/track`, plus `via=app`; opt-out in Settings. No crash/analytics SDK in v1.

## 6. Packaging & distribution

- `DxxpCode.app`, bundle ID `ai.dxxpcode.app`, version synced from the root `package.json`.
- `xcodebuild archive` → Developer ID sign (app + agentd + Sparkle.framework) → `xcrun notarytool submit --wait` (ASC API key) → `xcrun stapler staple` → signed DMG via `create-dmg`.
- **Sparkle 2** auto-updates: `SUFeedURL = https://dxxpcode.vercel.app/appcast.xml` (+ `appcast-beta.xml` for the beta channel toggle), EdDSA via `SUPublicEDKey`.
- **Homebrew Cask** `dxxpcode` after GA.
- Release workflow `.github/workflows/release-macos.yml` on `v*` tags: `macos-15` runner → `oven-sh/setup-bun` → build agentd universal2 → archive → notarize → DMG → GitHub Release + appcast publish.

## 7. Repo changes

```
apps/macos/        Xcode project, SwiftUI sources, XCUITests, asset catalog
apps/agentd/       headless bridge entry → dxxpcode-agent binary
packages/bridge/   JSON-RPC protocol + server (runTask adapter)
packages/agent/    unchanged — runTask/AgentEvent is already the seam
.github/workflows/release-macos.yml
```

No structural changes to the runtime: the bridge only needs TypeScript types mirroring `AgentEvent`/`RunOptions`/`ApprovalRequest` (which it already exports) plus `requestId` correlation for approvals.

## 8. Testing & quality bar

- **Bridge contract tests** in the existing `node --test` suite: golden NDJSON transcripts through `run.start` → approval → `done` with `MockProvider` (`DXXPCODE_MOCK_SCRIPT`); cancellation, denial, and always-allow cases.
- **Swift:** XCTest for view models/state machine (replay recorded `AgentEvent` streams), XCUITest for the golden path — open fixture project → run task → approve → diff inspector.
- **CI:** macOS lane running `xcodebuild -scheme DxxpCode test`; release lane adds notarization.
- **Perf bars:** <1 s to interactive window; 60 fps while streaming; 500-message transcript scrolls smoothly (virtualized list).

## 9. Milestones

| # | Deliverable | Done when | Est. |
| --- | --- | --- | --- |
| 0 | `packages/bridge` + `apps/agentd` binary | Golden-transcript tests pass; start/approve/cancel over stdio | 1 session |
| 1 | App shell — window, sidebar, composer, stream, approvals, diff | Task end-to-end on a fixture repo with MockProvider | 1–2 sessions |
| 2 | Terminal tab + drawer (SwiftTerm) | Login-shell PTY; agent "Run in Terminal" | 1 session |
| 3 | System layer — notifications, menu bar extra, Spotlight, URL scheme, Services, onboarding, Settings | HIG checklist in §4 complete | 1 session |
| 4 | Ship — signing, notarization, DMG, Sparkle feed, release workflow, site download page | Clean install on a fresh Mac from a notarized DMG | 1 session |
| 5 | Launch — Homebrew cask, beta channel, release notes | — | — |

**Total ≈ 5–6 sessions.** External waits: Apple Developer Program account, cert/profile provisioning, first notarization.

## 10. Locked decisions / open questions

**Locked:** SwiftUI (not Tauri/Electron) · shared TS runtime via stdio bridge (no agent rewrite) · no Mac App Store · Sparkle updates · `~/.dxxpcode` shared with the CLI · macOS 14+.

**Open:** app icon artwork · final bundle-ID namespace if a custom domain replaces `dxxpcode.vercel.app` · Handoff/iCloud session sync (deferred) · opt-in crash reporting (deferred).

## 11. Non-goals for v1

No Mac App Store build · no cloud sync · no split panes beyond tab + drawer · no embedded editor · no plugin API · no Windows/Linux (the Tauri path in the sibling `dxxpcode` repo is the answer if cross-platform is ever needed) · no team/admin features.
