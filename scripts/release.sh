#!/usr/bin/env bash
# Release a new dxxpcode version: bump, build, test, publish.
# Usage: ./scripts/release.sh 0.2.0
# Requires: npm login on this machine (npm whoami).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: ./scripts/release.sh <version>}"

PKGS=(
  packages/permissions
  packages/project
  packages/providers
  packages/tools
  packages/sessions
  packages/agent
  apps/cli
)

echo "→ bumping all packages to $VERSION"
for pkg in "${PKGS[@]}"; do
  npm version "$VERSION" --no-git-tag-version --prefix "$pkg"
done

echo "→ clean build + tests"
npm run clean
npm run build
npm test

echo "→ publishing (dependency order)"
for pkg in "${PKGS[@]}"; do
  npm publish --prefix "$pkg"
done

echo "✓ published dxxpcode $VERSION — commit the version bumps and tag v$VERSION"
