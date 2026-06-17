#!/usr/bin/env bash
#
# bootstrap-agent-update.sh — one-time bootstrap to get an existing zn-vault-agent
# host onto a version that supports operator-initiated updates (>= 1.20.20), and
# to provision the sudoers entry the agent needs to invoke the root-owned updater
# unit on subsequent updates.
#
# WHY THIS EXISTS (the chicken-and-egg): agents older than the fix cannot
# self-update — the manual trigger 503'd / the WS update-available was dropped /
# the in-process install hit EROFS under the systemd sandbox. So the very first
# hop onto the fixed agent must be done out-of-band, via the root-owned
# `zn-vault-agent-updater.service` oneshot (which installs `@latest` + restarts
# in its own namespace). This script does exactly that, idempotently, plus adds
# the sudoers line so the agent can start that unit itself from then on.
#
# SAFE TO RE-RUN. Each step is idempotent and gated on the host actually matching
# the expected shape (non-root agent, ProtectSystem sandbox, updater unit present).
#
# Run as a user with sudo (e.g. sysadmin), locally on the host OR via:
#   ssh sysadmin@<host> 'sudo bash -s' < scripts/bootstrap-agent-update.sh
# Or loop over hosts — see scripts/bootstrap-agent-update-fleet.sh
#
set -euo pipefail

AGENT_USER="zn-vault-agent"
AGENT_UNIT="zn-vault-agent.service"
UPDATER_UNIT="zn-vault-agent-updater.service"
SUDOERS_FILE="/etc/sudoers.d/${AGENT_USER}"
SYSTEMCTL="/usr/bin/systemctl"
SUDOERS_LINE="${AGENT_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL} start ${UPDATER_UNIT}"
HEALTH_URL="http://127.0.0.1:9100/health"
# Minimum agent version that supports operator-initiated updates end-to-end.
MIN_FIXED_VERSION="1.20.20"

log()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require_root_or_sudo() {
  if [ "$(id -u)" -ne 0 ]; then
    die "must run as root (or via 'sudo bash')"
  fi
}

agent_version() {
  curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("version",""))' 2>/dev/null \
    || echo ""
}

# semver-ish compare: returns 0 if $1 >= $2
version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]
}

main() {
  require_root_or_sudo
  local host; host="$(hostname)"
  printf '\n=== bootstrap-agent-update on %s ===\n' "$host"

  # --- Preconditions: confirm this host has the expected agent shape ---
  systemctl cat "$AGENT_UNIT" >/dev/null 2>&1 || die "${AGENT_UNIT} not installed on this host — not a zn-vault-agent host"

  local unit_user
  unit_user="$(systemctl show "$AGENT_UNIT" -p User --value 2>/dev/null || true)"
  if [ "$unit_user" = "root" ] || [ -z "$unit_user" ]; then
    warn "agent runs as '${unit_user:-root}' (not the sandboxed ${AGENT_USER}); the updater-unit/sudoers steps are unnecessary for a root agent. Will still bootstrap version via the unit if present."
  fi

  if ! systemctl cat "$UPDATER_UNIT" >/dev/null 2>&1; then
    die "${UPDATER_UNIT} is NOT present on this host. Re-run agent setup (zn-vault-agent setup) to install it, or install the unit manually, then re-run this script."
  fi
  ok "${UPDATER_UNIT} present"

  # --- Step 1: provision the sudoers line (idempotent, validated before install) ---
  if [ -f "$SUDOERS_FILE" ] && grep -qF "$SUDOERS_LINE" "$SUDOERS_FILE" 2>/dev/null; then
    ok "sudoers start-line already present"
  else
    local tmp; tmp="$(mktemp)"
    # start from existing file if present, else empty
    if [ -f "$SUDOERS_FILE" ]; then cat "$SUDOERS_FILE" > "$tmp"; fi
    printf '%s\n' "$SUDOERS_LINE" >> "$tmp"
    # validate the WHOLE resulting file before installing it
    if visudo -c -f "$tmp" >/dev/null 2>&1; then
      install -m 0440 -o root -g root "$tmp" "$SUDOERS_FILE"
      rm -f "$tmp"
      ok "added sudoers start-line (validated)"
    else
      rm -f "$tmp"
      die "sudoers validation FAILED — not installing. Check ${SUDOERS_FILE} manually."
    fi
  fi

  # --- Step 2: bootstrap onto the fixed version via the updater unit ---
  local before; before="$(agent_version)"
  log "agent version before: ${before:-unknown}"
  if [ -n "$before" ] && version_ge "$before" "$MIN_FIXED_VERSION"; then
    ok "already on ${before} (>= ${MIN_FIXED_VERSION}); skipping the unit-driven install"
  else
    log "starting ${UPDATER_UNIT} (npm install -g @latest + restart, out-of-sandbox)..."
    systemctl start "$UPDATER_UNIT"
    # the unit is oneshot; ExecStartPost try-restarts the agent. Give it time.
    local result
    result="$(systemctl show "$UPDATER_UNIT" -p Result --value 2>/dev/null || echo unknown)"
    if [ "$result" != "success" ]; then
      die "${UPDATER_UNIT} did not succeed (Result=${result}). Check: journalctl -u ${UPDATER_UNIT}"
    fi
    ok "${UPDATER_UNIT} ran (Result=success)"
  fi

  # --- Step 3: verify the agent is healthy on the fixed version ---
  local after="" tries=0
  while [ "$tries" -lt 15 ]; do
    after="$(agent_version)"
    if [ -n "$after" ] && version_ge "$after" "$MIN_FIXED_VERSION"; then break; fi
    sleep 2; tries=$((tries + 1))
  done

  if [ -z "$after" ]; then
    die "agent health endpoint not responding after bootstrap — check: systemctl status ${AGENT_UNIT}; journalctl -u ${AGENT_UNIT}"
  fi
  if ! version_ge "$after" "$MIN_FIXED_VERSION"; then
    die "agent is on ${after}, expected >= ${MIN_FIXED_VERSION} — bootstrap did not take. Check npm latest dist-tag and ${UPDATER_UNIT} logs."
  fi

  local status
  status="$(curl -s --max-time 5 "$HEALTH_URL" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || echo "")"
  ok "agent now on ${after} (status: ${status:-?})"
  printf '\n\033[32m✓ %s bootstrapped: %s, sudoers provisioned. Operator-initiated updates will work going forward.\033[0m\n' "$host" "$after"
}

main "$@"
