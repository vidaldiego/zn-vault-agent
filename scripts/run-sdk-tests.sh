#!/bin/bash
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
common="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)"
core="${VAULT_CORE_DIR:-$(dirname "$(dirname "$common")")/zn-vault}"
runner="$core/scripts/sdk-test-run.sh"
if [ ! -f "$runner" ]; then
  echo "Vault test runner missing: $runner; set VAULT_CORE_DIR" >&2
  exit 1
fi
cd "$repo"
exec bash "$runner" npm run test:all
