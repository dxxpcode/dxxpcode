# DxxpCode Companion (iOS)

LAN-paired companion for `dxxpcode serve` — watch, steer, and approve a running
agent from your iPhone. Phase 1: local network only, QR pairing, no backend.

## Build

```sh
brew install xcodegen   # generates the .xcodeproj from project.yml
xcodegen
open DxxpCodeCompanion.xcodeproj   # or: xcodebuild -scheme DxxpCodeCompanion build
```

Run on a simulator: pick an iPhone 15+ destination (iOS 17+). On a real device
you'll need your own Apple Developer team set in Signing & Capabilities.

## Pair

Desktop: Settings (⌘,) → iPhone companion → on → scan the QR. It encodes
`dxxpcode://pair?host=<lan-ip>&port=8787&token=<dxp_…>`; the token goes to the
Keychain, host/port to UserDefaults. Requires the phone and Mac on the same
network.

Debug launch args (simulator): `-PAIR 'dxxpcode://pair?…'` auto-pairs,
`-OPEN <task_id>` deep-links into a task transcript.

## Screens

Pair → Task list → Task detail (SSE transcript, approvals, steer) →
New task (project picker, prompt, planOnly/autoApprove) → Settings
(server info from /health, unpair).
