#!/usr/bin/env bash
#
# bootstrap-agent-update-fleet.sh — run bootstrap-agent-update.sh across a list of
# agent hosts over SSH. Idempotent: safe to re-run; hosts already on the fixed
# version are left untouched (the per-host script skips the unit install).
#
# Usage:
#   ./bootstrap-agent-update-fleet.sh <user> <host> [host ...]
#   ./bootstrap-agent-update-fleet.sh sysadmin 172.16.211.20 172.16.211.50 ...
#   ./bootstrap-agent-update-fleet.sh sysadmin --file hosts.txt   # one host/IP per line
#
# Each host is processed SEQUENTIALLY (not parallel) so a problem on one host
# stops you before fanning a mistake across the fleet — review and continue.
#
# Requires: SSH access with sudo on each host; the per-host script alongside this one.
#
set -uo pipefail   # NOT -e: we want to continue past a single host failure and report it

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PER_HOST="${SCRIPT_DIR}/bootstrap-agent-update.sh"

[ -f "$PER_HOST" ] || { echo "ERROR: ${PER_HOST} not found"; exit 1; }
[ "$#" -ge 2 ] || { echo "Usage: $0 <ssh-user> <host> [host...]   |   $0 <ssh-user> --file hosts.txt"; exit 1; }

USER="$1"; shift
HOSTS=()
if [ "${1:-}" = "--file" ]; then
  [ -n "${2:-}" ] || { echo "ERROR: --file needs a path"; exit 1; }
  while IFS= read -r line; do
    line="${line%%#*}"; line="$(echo "$line" | xargs)"   # strip comments + whitespace
    [ -n "$line" ] && HOSTS+=("$line")
  done < "$2"
else
  HOSTS=("$@")
fi

echo "Fleet bootstrap: ${#HOSTS[@]} host(s), user=${USER}"
echo "Per-host script: ${PER_HOST}"
echo

OK=0; FAIL=0; FAILED_HOSTS=()
for host in "${HOSTS[@]}"; do
  echo "════════════════════════════════════════════════════════════"
  echo "→ ${host}"
  echo "════════════════════════════════════════════════════════════"
  if ssh -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new \
        "${USER}@${host}" 'sudo bash -s' < "$PER_HOST"; then
    OK=$((OK + 1))
  else
    FAIL=$((FAIL + 1)); FAILED_HOSTS+=("$host")
    echo "  ✗ ${host} FAILED (see output above)"
  fi
  echo
done

echo "════════════════════════════════════════════════════════════"
echo "Summary: ${OK} succeeded, ${FAIL} failed (of ${#HOSTS[@]})"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed hosts: ${FAILED_HOSTS[*]}"
  exit 1
fi
echo "All hosts bootstrapped. Operator-initiated updates now work fleet-wide."
