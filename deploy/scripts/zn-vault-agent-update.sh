#!/usr/bin/env bash
# Root-owned, exact self-updater for zn-vault-agent. The unprivileged Agent
# publishes one immutable request; this helper is the sole trigger consumer.
set -euo pipefail

PACKAGE='@zincapp/zn-vault-agent'
TRIGGER="${1:-/var/lib/zn-vault-agent/.update-trigger}"
STATE_DIR="${2:-/var/lib/zn-vault-agent-updater}"
NPM_BIN="${3:-/usr/bin/npm}"
NODE_BIN="${4:-/usr/bin/node}"
SYSTEMCTL_BIN="${5:-/usr/bin/systemctl}"
SERVICE_NAME="${6:-zn-vault-agent}"
EXPECTED_AGENT_UID="${7:-$(id -u zn-vault-agent)}"
EXPECTED_ROOT_UID="${8:-0}"
FLOCK_BIN="${9:-/usr/bin/flock}"
FAILPOINT="${10:-}"
LOCK_FILE="${STATE_DIR}/.update.lock"
ACTIVE_STATE="${STATE_DIR}/active.state"

fail() {
  printf '%s\n' "update-wrapper: $1" >&2
  exit "${2:-1}"
}

[[ "$EXPECTED_AGENT_UID" =~ ^[0-9]+$ ]] || fail 'invalid Agent owner configuration'
[[ "$EXPECTED_ROOT_UID" =~ ^[0-9]+$ ]] || fail 'invalid root owner configuration'
[[ -x "$NPM_BIN" ]] || fail 'npm executable unavailable'
[[ -x "$NODE_BIN" ]] || fail 'node executable unavailable'
[[ -x "$SYSTEMCTL_BIN" ]] || fail 'systemctl executable unavailable'
[[ "$SERVICE_NAME" == 'zn-vault-agent' ]] || fail 'invalid restart service configuration'
[[ -x "$FLOCK_BIN" ]] || fail 'flock executable unavailable'
case "$FAILPOINT" in
  ''|after_active_link|after_receipt_link|after_receipt|after_restart|after_clear) ;;
  *) fail 'invalid test failpoint' ;;
esac

inject_fault() {
  if [[ "$FAILPOINT" == "$1" ]]; then
    kill -KILL "$$"
  fi
}

# State is outside the Agent-writable tree. Validate it before creating or
# opening the durable lock, state, or receipt files below it.
"$NODE_BIN" - "$STATE_DIR" "$EXPECTED_ROOT_UID" <<'NODE' || fail 'untrusted updater state directory' 10
const fs = require('node:fs');
const [directory, uidText] = process.argv.slice(2);
try {
  if (!fs.constants.O_NOFOLLOW) process.exit(1);
  const before = fs.lstatSync(directory);
  if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== Number(uidText) ||
      (before.mode & 0o022) !== 0) process.exit(1);
  const fd = fs.openSync(directory, fs.constants.O_RDONLY |
    (fs.constants.O_DIRECTORY || 0) | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== before.uid) process.exit(1);
  } finally { fs.closeSync(fd); }
} catch { process.exit(1); }
NODE

# Create-or-validate the root-owned lock inode without following links.
"$NODE_BIN" - "$LOCK_FILE" "$EXPECTED_ROOT_UID" <<'NODE' || fail 'untrusted updater lock inode' 11
const fs = require('node:fs');
const [file, uidText] = process.argv.slice(2);
const uid = Number(uidText);
let created;
try {
  if (!fs.constants.O_NOFOLLOW) process.exit(1);
  try {
    created = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL |
      fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(created, 0o600);
    fs.fsyncSync(created);
    fs.closeSync(created);
    created = undefined;
    const dirFd = fs.openSync(require('node:path').dirname(file), fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid ||
      (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size > 64) process.exit(1);
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== uid || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1) process.exit(1);
  } finally { fs.closeSync(fd); }
} catch {
  if (created !== undefined) { try { fs.closeSync(created); } catch {} }
  process.exit(1);
}
NODE

exec 9<>"$LOCK_FILE"
"$FLOCK_BIN" -n 9 || fail 'another self-update helper owns the lock' 12

# Read the trigger through O_NOFOLLOW and bind the bytes to the exact inode.
# The parent itself must be the non-writable Agent-owned data directory.
trusted="$($NODE_BIN - "$TRIGGER" "$EXPECTED_AGENT_UID" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [file, uidText] = process.argv.slice(2);
const uid = Number(uidText);
try {
  if (!fs.constants.O_NOFOLLOW) process.exit(1);
  const directory = path.dirname(file);
  const parentBefore = fs.lstatSync(directory);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink() ||
      parentBefore.uid !== uid || (parentBefore.mode & 0o022) !== 0) process.exit(1);
  const parentFd = fs.openSync(directory, fs.constants.O_RDONLY |
    (fs.constants.O_DIRECTORY || 0) | fs.constants.O_NOFOLLOW);
  try {
    const parentOpened = fs.fstatSync(parentFd);
    if (!parentOpened.isDirectory() || parentOpened.dev !== parentBefore.dev ||
        parentOpened.ino !== parentBefore.ino || parentOpened.uid !== uid) process.exit(1);
  } finally { fs.closeSync(parentFd); }
  let before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid ||
      (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 512) process.exit(1);
  if (before.nlink === 2) {
    const escaped = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}\\.tmp\\.[0-9]+\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`);
    const candidates = fs.readdirSync(directory)
      .filter(name => pattern.test(name))
      .map(name => path.join(directory, name))
      .filter(candidate => {
        try {
          const state = fs.lstatSync(candidate);
          return state.isFile() && !state.isSymbolicLink() && state.dev === before.dev &&
            state.ino === before.ino && state.uid === uid &&
            (state.mode & 0o777) === 0o600 && state.nlink === 2 && state.size === before.size;
        } catch { return false; }
      });
    if (candidates.length !== 1) process.exit(1);
    fs.unlinkSync(candidates[0]);
    const syncFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(syncFd); } finally { fs.closeSync(syncFd); }
    before = fs.lstatSync(file);
  }
  if (before.nlink !== 1) process.exit(1);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== uid || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1 ||
        opened.size !== before.size) process.exit(1);
    const content = fs.readFileSync(fd, 'utf8');
    if (!content.endsWith('\n') || content.slice(0, -1).includes('\n') || content.includes('\r')) process.exit(1);
    process.stdout.write(`${before.dev} ${before.ino}\n${content}`);
  } finally { fs.closeSync(fd); }
} catch { process.exit(1); }
NODE
)" || fail 'untrusted self-update trigger' 13

[[ "$trusted" == *$'\n'* ]] || fail 'invalid trusted trigger result' 13
trigger_identity="${trusted%%$'\n'*}"
raw="${trusted#*$'\n'}"
read -r trigger_dev trigger_ino trigger_identity_extra <<<"$trigger_identity"
[[ -n "$trigger_dev" && -n "$trigger_ino" && -z "${trigger_identity_extra:-}" ]] || fail 'invalid trigger inode identity' 13

IFS=' ' read -r schema request_id current_version target_version channel requested_at extra <<<"$raw"
[[ -z "${extra:-}" && "$schema" == 'v1' ]] || fail 'invalid trigger schema' 14
uuid_re='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
semver_re='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
[[ "$request_id" =~ $uuid_re ]] || fail 'invalid request id' 15
[[ "$current_version" =~ $semver_re ]] || fail 'invalid current version' 16
[[ "$target_version" =~ $semver_re ]] || fail 'invalid target version' 17
case "$channel" in latest|beta|next|dr-m4) ;; *) fail 'invalid update channel' 18 ;; esac
"$NODE_BIN" - "$requested_at" <<'NODE' || fail 'invalid request timestamp' 19
const value = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) process.exit(1);
NODE

receipt="${STATE_DIR}/${request_id}.receipt"
started_at="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"

read_trusted_root_record() {
  local file="$1" expected_mode="$2" max_size="$3"
  "$NODE_BIN" - "$file" "$EXPECTED_ROOT_UID" "$expected_mode" "$max_size" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [file, uidText, modeText, maxText] = process.argv.slice(2);
try {
  if (!fs.constants.O_NOFOLLOW) process.exit(1);
  let before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== Number(uidText) ||
      (before.mode & 0o777) !== Number.parseInt(modeText, 8) ||
      before.size < 1 || before.size > Number(maxText)) process.exit(1);
  if (before.nlink === 2) {
    const directory = path.dirname(file);
    const escaped = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}\\.tmp\\.[0-9]+\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`);
    const candidates = fs.readdirSync(directory)
      .filter(name => pattern.test(name))
      .map(name => path.join(directory, name))
      .filter(candidate => {
        try {
          const state = fs.lstatSync(candidate);
          return state.isFile() && !state.isSymbolicLink() && state.dev === before.dev &&
            state.ino === before.ino && state.uid === before.uid &&
            (state.mode & 0o777) === (before.mode & 0o777) &&
            state.nlink === 2 && state.size === before.size;
        } catch { return false; }
      });
    if (candidates.length !== 1) process.exit(1);
    fs.unlinkSync(candidates[0]);
    const syncFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(syncFd); } finally { fs.closeSync(syncFd); }
    before = fs.lstatSync(file);
  }
  if (before.nlink !== 1) process.exit(1);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== before.uid || (opened.mode & 0o777) !== (before.mode & 0o777) ||
        opened.nlink !== 1 || opened.size !== before.size) process.exit(1);
    const content = fs.readFileSync(fd, 'utf8');
    if (!content.endsWith('\n') || content.slice(0, -1).includes('\n') || content.includes('\r')) process.exit(1);
    process.stdout.write(content);
  } finally { fs.closeSync(fd); }
} catch { process.exit(1); }
NODE
}

publish_root_record() {
  local file="$1" content="$2" mode="$3"
  "$NODE_BIN" - "$file" "${content}"$'\n' "$mode" "$EXPECTED_ROOT_UID" "$FAILPOINT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [file, content, modeText, uidText, failpoint] = process.argv.slice(2);
const directory = path.dirname(file);
const temp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
let fd;
try {
  if (!fs.constants.O_NOFOLLOW) process.exit(1);
  const dirState = fs.lstatSync(directory);
  if (!dirState.isDirectory() || dirState.isSymbolicLink() ||
      dirState.uid !== Number(uidText) || (dirState.mode & 0o022) !== 0) process.exit(1);
  fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL |
    fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, Number.parseInt(modeText, 8));
  fs.fchmodSync(fd, Number.parseInt(modeText, 8));
  fs.writeFileSync(fd, content, 'utf8');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fd = undefined;
  fs.linkSync(temp, file);
  const basename = path.basename(file);
  const expectedFailpoint = basename === 'active.state'
    ? 'after_active_link'
    : basename.endsWith('.receipt') ? 'after_receipt_link' : '';
  if (failpoint === expectedFailpoint) process.kill(process.pid, 'SIGKILL');
  fs.unlinkSync(temp);
  const dirFd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
} catch {
  if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  try { fs.unlinkSync(temp); } catch {}
  process.exit(1);
}
NODE
}

consume_trigger() {
  "$NODE_BIN" - "$TRIGGER" "$EXPECTED_AGENT_UID" "$trigger_dev" "$trigger_ino" "${raw}"$'\n' <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [file, uidText, devText, inoText, expected] = process.argv.slice(2);
try {
  if (!fs.constants.O_NOFOLLOW) process.exit(1);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== Number(uidText) ||
      (before.mode & 0o777) !== 0o600 || before.nlink !== 1 ||
      String(before.dev) !== devText || String(before.ino) !== inoText) process.exit(1);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || fs.readFileSync(fd, 'utf8') !== expected) process.exit(1);
  } finally { fs.closeSync(fd); }
  fs.unlinkSync(file);
  const dirFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
} catch { process.exit(1); }
NODE
}

clear_active_state() {
  "$NODE_BIN" - "$ACTIVE_STATE" "$EXPECTED_ROOT_UID" "${raw}"$'\n' <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [file, uidText, expected] = process.argv.slice(2);
try {
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) { if (error?.code === 'ENOENT') process.exit(0); throw error; }
  if (!fs.constants.O_NOFOLLOW || !before.isFile() || before.isSymbolicLink() ||
      before.uid !== Number(uidText) || (before.mode & 0o777) !== 0o644 ||
      before.nlink !== 1 || before.size < 1 || before.size > 512) process.exit(1);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== before.uid || (opened.mode & 0o777) !== 0o644 ||
        opened.nlink !== 1 || opened.size !== before.size ||
        fs.readFileSync(fd, 'utf8') !== expected) process.exit(1);
  } finally { fs.closeSync(fd); }
  fs.unlinkSync(file);
  const dirFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
} catch { process.exit(1); }
NODE
}

read_installed_version() {
  local global_root package_json
  global_root="$($NPM_BIN root -g 2>/dev/null)" || return 1
  [[ "$global_root" == /* && "$global_root" != *$'\n'* && "$global_root" != *$'\r'* ]] || return 1
  package_json="${global_root}/${PACKAGE}/package.json"
  "$NODE_BIN" - "$package_json" "$EXPECTED_ROOT_UID" <<'NODE'
const fs = require('node:fs');
const [file, uidText] = process.argv.slice(2);
try {
  if (!fs.constants.O_NOFOLLOW) process.exit(1);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== Number(uidText) ||
      before.nlink !== 1 || before.size < 2 || before.size > 1024 * 1024) process.exit(1);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== before.uid || opened.nlink !== 1 || opened.size !== before.size) process.exit(1);
    const parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (typeof parsed.version !== 'string') process.exit(1);
    process.stdout.write(parsed.version);
  } finally { fs.closeSync(fd); }
} catch { process.exit(1); }
NODE
}

write_receipt() {
  local installed="$1" status="$2" reason="$3" finished_at content
  finished_at="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"
  content="v1 ${request_id} ${PACKAGE} ${channel} ${current_version} ${target_version} ${installed} ${status} ${requested_at} ${started_at} ${finished_at} ${reason}"
  publish_root_record "$receipt" "$content" 0644
}

finish_success() {
  local installed="$1" reason="$2"
  write_receipt "$installed" success "$reason" || fail 'could not publish success receipt' 30
  inject_fault after_receipt
  "$SYSTEMCTL_BIN" try-restart "$SERVICE_NAME" || fail 'could not restart Agent after successful update' 33
  inject_fault after_restart
  clear_active_state || fail 'active state changed before terminal clear' 34
  inject_fault after_clear
  consume_trigger || fail 'trigger changed before terminal consume' 31
  printf '%s\n' "update-wrapper: installed exact Agent target for ${request_id}" >&2
  exit 0
}

finish_failure() {
  local installed="$1" reason="$2" message="$3" code="$4"
  write_receipt "$installed" failure "$reason" || fail 'could not publish failure receipt' 32
  clear_active_state || fail 'active state changed before terminal clear' 34
  consume_trigger || fail 'trigger changed before terminal consume' 31
  fail "$message" "$code"
}

# A terminal UUID is immutable. Exact replay performs no npm mutation.
if [[ -e "$receipt" || -L "$receipt" ]]; then
  existing="$(read_trusted_root_record "$receipt" 0644 2048)" || fail 'untrusted existing receipt' 20
  terminal="$($NODE_BIN - "$existing" "$request_id" "$channel" "$current_version" "$target_version" "$requested_at" <<'NODE'
const [content, requestId, expectedChannel, current, target, requestedAt] = process.argv.slice(2);
const fields = content.split(' ');
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const exactTime = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
if (fields.length !== 12 || fields.some(field => field.length === 0)) process.exit(1);
const [schema, id, packageName, receiptChannel, previous, receiptTarget, installed, status,
  receiptRequestedAt, startedAt, finishedAt, reason] = fields;
if (schema !== 'v1' || id !== requestId || packageName !== '@zincapp/zn-vault-agent' ||
    receiptChannel !== expectedChannel || previous !== current || receiptTarget !== target ||
    receiptRequestedAt !== requestedAt || (status !== 'success' && status !== 'failure') ||
    (status === 'success' ? !semver.test(installed) : installed !== 'none' && !semver.test(installed)) ||
    (status === 'success' && installed !== target) ||
    ![receiptRequestedAt, startedAt, finishedAt].every(exactTime) ||
    Date.parse(startedAt) < Date.parse(receiptRequestedAt) || Date.parse(finishedAt) < Date.parse(startedAt) ||
    !/^[a-z][a-z0-9_]{1,63}$/.test(reason)) process.exit(1);
process.stdout.write(`${status} ${reason}`);
NODE
)" || fail 'requestId conflicts with immutable receipt' 21
  read -r receipt_status receipt_reason receipt_extra <<<"$terminal"
  [[ -z "${receipt_extra:-}" ]] || fail 'invalid immutable receipt terminal data' 21
  if [[ "$receipt_status" == success ]]; then
    "$SYSTEMCTL_BIN" try-restart "$SERVICE_NAME" || fail 'could not replay Agent restart' 33
    clear_active_state || fail 'active state changed before replay clear' 34
    consume_trigger || fail 'trigger changed before receipt replay consume' 31
    printf '%s\n' "update-wrapper: exact receipt replay ${request_id}" >&2
    exit 0
  fi
  clear_active_state || fail 'active state changed before failure replay clear' 34
  consume_trigger || fail 'trigger changed before failure receipt replay consume' 31
  fail "replayed terminal update failure: ${receipt_reason}" 22
fi

installed_before="$(read_installed_version 2>/dev/null || true)"
[[ "$installed_before" =~ $semver_re ]] || installed_before='none'

state_exists=false
if [[ -e "$ACTIVE_STATE" || -L "$ACTIVE_STATE" ]]; then
  state_content="$(read_trusted_root_record "$ACTIVE_STATE" 0644 512)" || fail 'untrusted active update state' 25
  [[ "$state_content" == "$raw" ]] || fail 'active update state conflicts with trigger' 26
  state_exists=true
fi

# A matching durable state means the original execution already resolved the
# channel, checked ordering/CAS, and crossed the install boundary. Exact target
# readback recovers immediately; the previous version or an absent package can
# resume only the already-authorized exact install without another channel
# lookup. Any third version remains a terminal conflict.
if [[ "$state_exists" == true && "$installed_before" == "$target_version" ]]; then
  finish_success "$installed_before" recovered_install
fi
if [[ "$state_exists" == true ]]; then
  if [[ "$installed_before" != "$current_version" && "$installed_before" != none ]]; then
    finish_failure "$installed_before" current_version_mismatch \
      'installed version conflicts with active update state' 27
  fi
else
  advertised="$($NPM_BIN view "${PACKAGE}@${channel}" version 2>/dev/null || true)"
  if [[ ! "$advertised" =~ $semver_re || "$advertised" != "$target_version" ]]; then
    finish_failure "$installed_before" channel_mismatch 'channel does not resolve to requested target' 23
  fi

  # Reject downgrades while allowing equality for the force-reinstall contract.
  "$NODE_BIN" - "$current_version" "$target_version" <<'NODE' || \
    finish_failure "$installed_before" downgrade_refused 'target is older than expected current version' 24
function parse(v) {
  const [coreAndPre] = v.split('+'); const separator = coreAndPre.indexOf('-');
  const core = separator === -1 ? coreAndPre : coreAndPre.slice(0, separator);
  const pre = separator === -1 ? null : coreAndPre.slice(separator + 1).split('.');
  return { core: core.split('.').map(Number), pre };
}
function cmpId(a, b) {
  const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b); if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1; if (b.pre[i] === undefined) return 1;
    const compared = cmpId(a.pre[i], b.pre[i]); if (compared) return compared;
  }
  return 0;
}
process.exit(compare(parse(process.argv[3]), parse(process.argv[2])) >= 0 ? 0 : 1);
NODE

  if [[ "$installed_before" != "$current_version" ]]; then
    finish_failure "$installed_before" current_version_mismatch \
      'installed version does not match expected current version' 27
  fi
  # Request identity is non-secret and must be readable by the unprivileged
  # Agent so GET status can correlate this operation without trusting global
  # boolean state. Root remains the sole writer in its non-writable directory.
  publish_root_record "$ACTIVE_STATE" "$raw" 0644 || fail 'could not persist active update state' 28
fi

# Trigger and active state remain present throughout npm.
npm_status=0
"$NPM_BIN" install -g -- "${PACKAGE}@${target_version}" || npm_status=$?
installed_after="$(read_installed_version 2>/dev/null || true)"
[[ "$installed_after" =~ $semver_re ]] || installed_after='none'
if [[ "$installed_after" == "$target_version" ]]; then
  if [[ "$npm_status" -eq 0 ]]; then finish_success "$installed_after" installed; fi
  finish_success "$installed_after" recovered_install
fi
if [[ "$npm_status" -ne 0 ]]; then
  finish_failure "$installed_after" npm_install_failed 'npm install failed' 29
fi
finish_failure "$installed_after" version_mismatch 'installed version does not match target' 29
