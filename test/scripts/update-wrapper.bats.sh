#!/usr/bin/env bash
# Compatibility entrypoint for the real self-wrapper rail tests. Pass an
# extracted package wrapper as argv[1] to test the exact tarball artifact.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
WRAPPER_UNDER_TEST="${1:-$REPO_DIR/deploy/scripts/zn-vault-agent-update.sh}"

[[ -f "$WRAPPER_UNDER_TEST" ]] || {
  printf 'self-update wrapper not found: %s\n' "$WRAPPER_UNDER_TEST" >&2
  exit 2
}

export WRAPPER_UNDER_TEST
cd "$REPO_DIR"
exec npm exec -- vitest run src/services/npm-update-wrapper.test.ts
