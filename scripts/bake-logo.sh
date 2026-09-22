#!/bin/sh
# Regenerate apps/cli/src/ui/logo.ts from assets/logo.png.
# Requires ImageMagick `convert` and python3.
set -e
cd "$(dirname "$0")/.."
convert assets/logo.png -resize 22x14! /tmp/dxxpcode-logo-small.png
python3 - <<'PY'
import subprocess, re, json
out = subprocess.check_output(["convert", "/tmp/dxxpcode-logo-small.png", "txt:-"], text=True)
px = {}
for m in re.finditer(r"(\d+),(\d+): \((\d+),(\d+),(\d+)\)", out):
    x, y, r, g, b = map(int, m.groups())
    px[(x, y)] = "#%02x%02x%02x" % (r, g, b)
W, H = 22, 14
rows = [[px[(x, y)] + ":" + px[(x, y + 1)] for x in range(W)] for y in range(0, H, 2)]
ts = "/** Baked from assets/logo.png (XX mark) — regenerate with scripts/bake-logo.sh. */\n"
ts += "/** Each cell is 'fgColor:bgColor' rendered as a '\u2580' glyph (2 pixel rows per line). */\n"
ts += "export const LOGO_ROWS: string[][] = " + json.dumps(rows, separators=(",", ":")) + ";\n"
open("apps/cli/src/ui/logo.ts", "w").write(ts)
print("baked", len(rows), "rows x", W)
PY
