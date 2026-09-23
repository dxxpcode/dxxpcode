#!/usr/bin/env bash
# Release a new dxxpcode version: bump, changelog, build, test, publish, commit, tag.
# Usage: ./scripts/release.sh 0.2.0
# Requires: npm login on this machine (npm whoami), clean worktree, on the
# branch you want the release commit to land on.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: ./scripts/release.sh <version>}"

if [ -n "$(git status --porcelain)" ]; then
  echo "worktree is dirty — commit or stash first" >&2
  exit 1
fi
if ! npm whoami >/dev/null 2>&1; then
  echo "not logged in to npm — run: npm login" >&2
  exit 1
fi

PKGS=(
  packages/permissions
  packages/project
  packages/providers
  packages/tools
  packages/sessions
  packages/agent
  apps/cli
)

echo "→ moving CHANGELOG [Unreleased] into [$VERSION]"
node -e '
const fs = require("fs");
const v = process.argv[1];
const date = new Date().toISOString().slice(0, 10);
const md = fs.readFileSync("CHANGELOG.md", "utf8");
const m = md.match(/## \[Unreleased\]\n([\s\S]*?)(?=^## \[)/m);
if (!m) { console.error("CHANGELOG.md has no [Unreleased] section"); process.exit(1); }
const notes = m[1].trim();
if (!notes) { console.error("[Unreleased] is empty — write release notes first"); process.exit(1); }
if (md.includes(`## [${v}]`)) { console.error(`CHANGELOG.md already has a [${v}] section`); process.exit(1); }
const out = md.replace(
  /## \[Unreleased\]\n[\s\S]*?(?=^## \[)/m,
  `## [Unreleased]\n\n## [${v}] — ${date}\n\n${notes}\n\n`,
);
fs.writeFileSync("CHANGELOG.md", out);
console.log(`  [${v}] — ${date}`);
' "$VERSION"

echo "→ bumping all packages to $VERSION"
npm version "$VERSION" --no-git-tag-version
for pkg in "${PKGS[@]}"; do
  npm version "$VERSION" --no-git-tag-version --prefix "$pkg"
done

echo "→ clean build + tests"
npm run clean
npm run build
npm test

echo "→ committing + tagging v$VERSION"
git add CHANGELOG.md package.json "${PKGS[@]/%//package.json}"
git commit -qm "release v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"

echo "→ publishing (dependency order)"
for pkg in "${PKGS[@]}"; do
  npm publish --prefix "$pkg"
done

echo "✓ released dxxpcode $VERSION — push it: git push --follow-tags"
