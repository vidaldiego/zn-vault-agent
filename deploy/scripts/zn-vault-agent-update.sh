#!/usr/bin/env bash
# Root-owned updater wrapper for zn-vault-agent.
# Invoked as ExecStart of zn-vault-agent-updater.service (a root oneshot,
# activated by zn-vault-agent-updater.path when the trigger file appears).
#
# Reads "<version> <channel>" from the trigger file, DELETES the trigger
# (before installing, so a PathExists .path returns to its resting state and a
# failed/looping install cannot re-read a stale value), validates strictly, then
# runs the targeted npm install. The service's ExecStartPost restarts the agent
# on success only.
set -euo pipefail

PACKAGE='@zincapp/zn-vault-agent'
TRIGGER="${1:-/var/lib/zn-vault-agent/.update-trigger}"

if [[ ! -f "$TRIGGER" ]]; then
  echo "update-wrapper: no trigger file at $TRIGGER" >&2
  exit 1
fi

# Read the value, then delete the trigger BEFORE doing anything else.
raw="$(head -n1 "$TRIGGER" 2>/dev/null || true)"
rm -f "$TRIGGER"

version="$(printf '%s' "$raw" | awk '{print $1}')"
channel="$(printf '%s' "$raw" | awk '{print $2}')"

# Validate channel against the allowlist.
case "$channel" in
  latest|beta|next) ;;
  *) echo "update-wrapper: invalid channel '$channel'" >&2; exit 2 ;;
esac

# Validate version: concrete semver, or the literal 'latest'.
semver_re='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
if [[ "$version" == "latest" ]]; then
  target="$channel"
elif [[ "$version" =~ $semver_re ]]; then
  target="$version"
else
  echo "update-wrapper: invalid version '$version'" >&2
  exit 3
fi

echo "update-wrapper: installing ${PACKAGE}@${target}" >&2
exec npm install -g "${PACKAGE}@${target}"
