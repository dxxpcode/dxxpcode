#!/usr/bin/env bash
# Build a standalone dxxpcode CLI binary and place it in src-tauri/binaries/
# so `tauri build` can bundle it via bundle.externalBin (one install, no Node needed).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TRIPLE="$(rustc -vV | awk '/host:/ {print $2}')"
OUT_DIR="$ROOT/apps/desktop/src-tauri/binaries"
OUT="$OUT_DIR/dxxpcode-$TRIPLE"

# 1. Build the workspaces CLI (dist/).
cd "$ROOT"
npm run build

# 2. Stub react-devtools-core — ink imports it dynamically when DEV=true; the
#    bun-compile bundler still resolves the import at build time.
STUB="$ROOT/node_modules/react-devtools-core"
if [ ! -d "$STUB" ]; then
  mkdir -p "$STUB"
  printf '{"name":"react-devtools-core","version":"0.0.0","main":"index.js"}' > "$STUB/package.json"
  printf 'module.exports = { connectToDevTools() {} };\nmodule.exports.default = module.exports;\n' > "$STUB/index.js"
fi

# 3. Compile to a single native binary.
mkdir -p "$OUT_DIR"
bun build "$ROOT/apps/cli/dist/cli.js" --compile --outfile "$OUT"
chmod +x "$OUT"
echo "sidecar: $OUT"
