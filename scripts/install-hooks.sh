#!/usr/bin/env bash
# ============================================================================
# Install GateTest's self-protection git hooks.
# Idempotent — safe to re-run.
# ============================================================================
set -e
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .husky
chmod +x .husky/pre-push
echo "[GateTest] Hooks installed. Hooks path: $(git config core.hooksPath)"
echo "[GateTest] Run 'git config --unset core.hooksPath' to disable."
