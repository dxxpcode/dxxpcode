#!/usr/bin/env bash
# Build the Rust dxxpcode agent binary and place it in src-tauri/binaries/
# so `tauri build` can bundle it via bundle.externalBin (one install, no Node needed).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TRIPLE="$(rustc -vV | awk '/host:/ {print $2}')"
OUT_DIR="$ROOT/apps/desktop/src-tauri/binaries"
OUT="$OUT_DIR/dxxpcode-$TRIPLE"

mkdir -p "$OUT_DIR"
cargo build --release --manifest-path "$ROOT/apps/agent-rs/Cargo.toml"
cp "$ROOT/apps/agent-rs/target/release/dxxpcode" "$OUT"
chmod +x "$OUT"
echo "sidecar: $OUT"
