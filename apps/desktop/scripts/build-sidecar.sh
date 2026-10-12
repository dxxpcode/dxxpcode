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
# Cargo's strip = true relies on rust-objcopy, which can fail on some
# toolchains; strip again here so the bundled binary is always stripped.
if command -v strip >/dev/null 2>&1; then strip "$OUT" || true; fi
chmod +x "$OUT"
echo "sidecar: $OUT"
