#!/usr/bin/env bash
# install-workspaces.sh — POSIX-compatible bash workspace installer.
#
# Walks the repo, finds every package.json (excluding node_modules/.next/build),
# and runs `npm ci` if package-lock.json is present, falling back to
# `npm install` if no lockfile exists. Idempotent — safe to run multiple times.
#
# This kills the brittle "remember to cd website && npm ci" pattern.
# Every CI job should call this single script.
#
# Usage:
#   bash scripts/install-workspaces.sh [repo_root]
#
# Exit codes:
#   0 — all installs succeeded
#   1 — at least one install failed (first failure aborts the run)
set -euo pipefail

ROOT_DIR="${1:-$(pwd)}"

if [ ! -d "$ROOT_DIR" ]; then
  echo "install-workspaces: root directory '$ROOT_DIR' does not exist" >&2
  exit 1
fi

echo "install-workspaces: scanning '$ROOT_DIR' for package.json files..."

# Find every package.json, excluding node_modules, .next, build, .git output.
# -print0 + xargs would be safer, but we want a readable per-dir loop.
# Using a temp file avoids subshell scope issues for INSTALLED counter.
TMP_LIST="$(mktemp)"
trap 'rm -f "$TMP_LIST"' EXIT

find "$ROOT_DIR" \
  -type d \( -name node_modules -o -name .next -o -name build -o -name .git \) -prune \
  -o -type f -name package.json -print \
  | sort > "$TMP_LIST"

INSTALLED=0
FAILED=0

while IFS= read -r PKG_JSON; do
  PKG_DIR="$(dirname "$PKG_JSON")"

  # Skip the .claude/ worktrees — they're nested checkouts of the same repo.
  case "$PKG_DIR" in
    *"/.claude/"*)
      continue
      ;;
  esac

  if [ -f "$PKG_DIR/package-lock.json" ]; then
    echo "install-workspaces: npm ci in '$PKG_DIR'"
    if ( cd "$PKG_DIR" && npm ci ); then
      INSTALLED=$((INSTALLED + 1))
    else
      echo "install-workspaces: FAILED npm ci in '$PKG_DIR'" >&2
      FAILED=$((FAILED + 1))
      exit 1
    fi
  else
    echo "install-workspaces: npm install in '$PKG_DIR' (no lockfile)"
    if ( cd "$PKG_DIR" && npm install --no-audit --no-fund ); then
      INSTALLED=$((INSTALLED + 1))
    else
      echo "install-workspaces: FAILED npm install in '$PKG_DIR'" >&2
      FAILED=$((FAILED + 1))
      exit 1
    fi
  fi
done < "$TMP_LIST"

echo "install-workspaces: done. installed=$INSTALLED failed=$FAILED"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
