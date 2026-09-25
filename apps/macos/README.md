# DxxpCode for macOS

Native SwiftUI shell over the shared agent runtime — sibling of the CLI, not a port. One window per project; talks to `dxxpcode-agent` over newline-delimited JSON-RPC 2.0 on stdio (see `packages/bridge`, `apps/agentd`).

## Prerequisites

- Xcode 15+ (Swift 6) and [XcodeGen](https://github.com/yonsm/XcodeGen) (`brew install xcodegen`)
- The Node runtime for agentd in development (`node`, `npm install` at repo root)

## Build & test

```sh
npm run build                  # compile workspaces incl. apps/agentd → apps/agentd/dist/main.js
cd apps/macos && xcodegen      # generate DxxpCode.xcodeproj
xcodebuild -project DxxpCode.xcodeproj -scheme DxxpCode build
xcodebuild -project DxxpCode.xcodeproj -scheme DxxpCode test
```

`.xcodeproj` is generated — edit `project.yml`, not the project file.

## agentd resolution (dev)

The app needs a `dxxpcode-agent` process. Resolution order:

1. `DXXPCODE_AGENTD` env — path to an executable, or a `.js` file (spawned via `node`)
2. Bundled `Contents/Resources/dxxpcode-agent` (release packaging)
3. `<repo>/apps/agentd/dist/main.js` (dev fallback, via `node`)
4. `<repo>/apps/agentd/src/main.ts` (source fallback, via `node --conditions=development`)

For tests the same locator applies; run `npm run build` first so the dist binary exists.

Environment is inherited: launching with `DXXPCODE_PROVIDER=mock DXXPCODE_MOCK_SCRIPT=…/script.json` runs the app end-to-end offline; `DXXPCODE_HOME=/tmp/x` isolates `~/.dxxpcode` state. Launch the built app via `DxxpCode.app/Contents/MacOS/DxxpCode` from a shell so these vars reach it.
