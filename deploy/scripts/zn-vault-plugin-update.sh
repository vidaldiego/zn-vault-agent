#!/usr/bin/env bash
# Root-owned, exact Payara updater. No package/channel comes from the request,
# and this helper never restarts the Agent.
set -euo pipefail

PACKAGE='@zincapp/znvault-plugin-payara'
CHANNEL='dr-m4'
TRIGGER="${1:-/var/lib/zn-vault-agent/.plugin-update-trigger}"
ACTIVE="${2:-/var/lib/zn-vault-agent/.plugin-update-active}"
RECEIPT_DIR="${3:-/var/lib/zn-vault-agent-plugin-updater}"
NPM_BIN="${4:-/usr/bin/npm}"
NODE_BIN="${5:-/usr/bin/node}"
EXPECTED_AGENT_UID="${6:-$(id -u zn-vault-agent)}"
EXPECTED_RECEIPT_UID="${7:-0}"
FLOCK_BIN="${8:-/usr/bin/flock}"
FAILPOINT="${9:-}"
LOCK_FILE="${RECEIPT_DIR}/.update.lock"

fail() {
  printf '%s\n' "plugin-update-wrapper: $1" >&2
  exit "${2:-1}"
}

[[ "$EXPECTED_AGENT_UID" =~ ^[0-9]+$ ]] || fail 'invalid Agent owner configuration'
[[ "$EXPECTED_RECEIPT_UID" =~ ^[0-9]+$ ]] || fail 'invalid receipt owner configuration'
[[ -x "$NPM_BIN" ]] || fail 'npm executable unavailable'
[[ -x "$NODE_BIN" ]] || fail 'node executable unavailable'
[[ -x "$FLOCK_BIN" ]] || fail 'flock executable unavailable'
case "$FAILPOINT" in
  ''|after_intent_link|after_npm|after_receipt_link|short_active_wait) ;;
  *) fail 'invalid test failpoint' ;;
esac

# Validate the privileged parent before creating a lock below it. This avoids
# following a substituted receipt-directory symlink as root.
"$NODE_BIN" - "$RECEIPT_DIR" "$EXPECTED_RECEIPT_UID" <<'NODE' || fail 'untrusted receipt directory' 10
const fs = require('node:fs');
const [directory, uidText] = process.argv.slice(2);
try {
  const state = fs.lstatSync(directory);
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== Number(uidText) ||
      (state.mode & 0o022) !== 0) process.exit(1);
} catch { process.exit(1); }
NODE

# A kernel flock auto-releases on normal exit, SIGKILL and reboot. The durable
# root-owned inode may remain, but can never become an orphaned permanent lock.
(umask 077; : >> "$LOCK_FILE")
chmod 0600 "$LOCK_FILE"
"$NODE_BIN" - "$LOCK_FILE" "$EXPECTED_RECEIPT_UID" <<'NODE' || fail 'untrusted lock inode' 11
const fs = require('node:fs');
const [file, uidText] = process.argv.slice(2);
try {
  const state = fs.lstatSync(file);
  if (!state.isFile() || state.isSymbolicLink() || state.uid !== Number(uidText) ||
      (state.mode & 0o777) !== 0o600 || state.nlink !== 1) process.exit(1);
} catch { process.exit(1); }
NODE
exec 9>"$LOCK_FILE"
"$FLOCK_BIN" -n 9 || fail 'another plugin update helper owns the lock' 11

# Trigger is published before active to close the Agent crash gap. Keep this
# same oneshot alive across the normal systemd Agent restart delay so PathExists
# cannot burn its activation limit before startup reconciliation publishes the
# exact active twin. Absent active still means zero consume/npm/receipt.
active_wait_attempts=600
active_wait_delay=0.1
if [[ "$FAILPOINT" == short_active_wait ]]; then
  active_wait_attempts=20
  active_wait_delay=0.05
fi
for ((_attempt = 0; _attempt < active_wait_attempts; _attempt += 1)); do
  [[ -e "$ACTIVE" || -L "$ACTIVE" ]] && break
  sleep "$active_wait_delay"
done

raw="$($NODE_BIN - "$TRIGGER" "$ACTIVE" "$EXPECTED_AGENT_UID" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [trigger, active, uidText] = process.argv.slice(2);
const expectedUid = Number(uidText);
function readTrusted(file) {
  let before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== expectedUid ||
      (before.mode & 0o777) !== 0o600 ||
      before.size < 1 || before.size > 512) throw new Error('untrusted');
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
            state.ino === before.ino && state.uid === expectedUid &&
            (state.mode & 0o777) === 0o600 && state.nlink === 2 && state.size === before.size;
        } catch { return false; }
      });
    if (candidates.length !== 1) throw new Error('ambiguous');
    fs.unlinkSync(candidates[0]);
    const dirFd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    before = fs.lstatSync(file);
  }
  if (before.nlink !== 1) throw new Error('links');
  if (!fs.constants.O_NOFOLLOW) throw new Error('nofollow');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== expectedUid || (opened.mode & 0o777) !== 0o600 ||
        opened.nlink !== 1 || opened.size !== before.size) throw new Error('changed');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}
try {
  const triggerContent = readTrusted(trigger);
  const activeContent = readTrusted(active);
  if (triggerContent !== activeContent) process.exit(2);
  process.stdout.write(triggerContent);
} catch { process.exit(1); }
NODE
)" || {
  # ACTIVE absent/untrusted/mismatched is intentionally not consumed. No npm
  # mutation is possible, and an exact Agent replay can repair only the safe
  # trigger-before-active window.
  fail 'trigger and active records are not identical trusted inodes' 12
}

[[ "$raw" != *$'\n'* && "$raw" != *$'\r'* ]] || {
  rm -f -- "$TRIGGER"
  fail 'invalid trigger schema' 13
}
IFS=' ' read -r schema request_id from_version target_version requested_at extra <<<"$raw"
[[ -z "${extra:-}" && "$schema" == 'v1' ]] || {
  rm -f -- "$TRIGGER"
  fail 'invalid trigger schema' 13
}
uuid_re='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
semver_re='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
[[ "$request_id" =~ $uuid_re ]] || { rm -f -- "$TRIGGER"; fail 'invalid request id' 14; }
[[ "$from_version" =~ $semver_re ]] || { rm -f -- "$TRIGGER"; fail 'invalid current version' 15; }
[[ "$target_version" =~ $semver_re && "$target_version" == 3.* ]] || {
  rm -f -- "$TRIGGER"
  fail 'invalid Payara target version' 16
}
"$NODE_BIN" - "$requested_at" <<'NODE' || { rm -f -- "$TRIGGER"; fail 'invalid request timestamp' 17; }
const value = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) process.exit(1);
NODE

receipt="${RECEIPT_DIR}/${request_id}.receipt"
intent="${RECEIPT_DIR}/${request_id}.intent"
started_at="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"

# The root-owned intent is the durable authorization boundary. It is published
# only after the fixed dr-m4 tag and the installed-version CAS have both passed.
# A retry may trust this exact tuple even if the registry is unavailable or its
# tag has moved; an Agent-owned trigger alone is never sufficient evidence.
read_intent() {
  "$NODE_BIN" - "$intent" "$EXPECTED_RECEIPT_UID" "$request_id" "$PACKAGE" "$CHANNEL" \
    "$from_version" "$target_version" "$requested_at" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [file, uidText, requestId, packageName, channel, previous, target, requestedAt] = process.argv.slice(2);
const uid = Number(uidText);
const exactTime = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
try {
  if (!fs.constants.O_NOFOLLOW) process.exit(1);
  let before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid ||
      (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 512) process.exit(1);
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
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== uid || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1 ||
        opened.size !== before.size) process.exit(1);
    const content = fs.readFileSync(fd, 'utf8');
    if (!content.endsWith('\n') || content.slice(0, -1).includes('\n') || content.includes('\r')) process.exit(1);
    const fields = content.slice(0, -1).split(' ');
    if (fields.length !== 8 || fields.some(field => field.length === 0)) process.exit(1);
    const [schema, id, recordedPackage, recordedChannel, recordedPrevious,
      recordedTarget, recordedRequestedAt, startedAt] = fields;
    if (schema !== 'v1' || id !== requestId || recordedPackage !== packageName ||
        recordedChannel !== channel || recordedPrevious !== previous || recordedTarget !== target ||
        recordedRequestedAt !== requestedAt || !exactTime(startedAt) ||
        Date.parse(startedAt) < Date.parse(requestedAt)) process.exit(1);
    process.stdout.write(startedAt);
  } finally { fs.closeSync(fd); }
} catch { process.exit(1); }
NODE
}

publish_intent() {
  local content
  content="v1 ${request_id} ${PACKAGE} ${CHANNEL} ${from_version} ${target_version} ${requested_at} ${started_at}"$'\n'
  "$NODE_BIN" - "$intent" "$content" "$EXPECTED_RECEIPT_UID" "$FAILPOINT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [file, content, uidText, failpoint] = process.argv.slice(2);
const uid = Number(uidText);
const directory = path.dirname(file);
const temp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
let fd;
try {
  if (!fs.constants.O_NOFOLLOW) process.exit(1);
  const dirBefore = fs.lstatSync(directory);
  if (!dirBefore.isDirectory() || dirBefore.isSymbolicLink() || dirBefore.uid !== uid ||
      (dirBefore.mode & 0o022) !== 0) process.exit(1);
  const dirCheckFd = fs.openSync(directory, fs.constants.O_RDONLY |
    (fs.constants.O_DIRECTORY || 0) | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(dirCheckFd);
    if (!opened.isDirectory() || opened.dev !== dirBefore.dev || opened.ino !== dirBefore.ino ||
        opened.uid !== uid) process.exit(1);
  } finally { fs.closeSync(dirCheckFd); }
  fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL |
    fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  fs.fchmodSync(fd, 0o600);
  fs.writeFileSync(fd, content, 'utf8');
  fs.fsyncSync(fd);
  const tempState = fs.fstatSync(fd);
  fs.closeSync(fd);
  fd = undefined;
  fs.linkSync(temp, file); // atomic no-replace publication
  const linkedDirFd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(linkedDirFd); } finally { fs.closeSync(linkedDirFd); }
  if (failpoint === 'after_intent_link') {
    process.kill(process.ppid, 'SIGKILL');
    process.kill(process.pid, 'SIGKILL');
  }
  fs.unlinkSync(temp);
  const cleanupDirFd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(cleanupDirFd); } finally { fs.closeSync(cleanupDirFd); }
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.dev !== tempState.dev ||
      before.ino !== tempState.ino || before.uid !== uid || (before.mode & 0o777) !== 0o600 ||
      before.nlink !== 1 || before.size !== Buffer.byteLength(content)) process.exit(1);
  const readFd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(readFd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== uid || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1 ||
        opened.size !== before.size || fs.readFileSync(readFd, 'utf8') !== content) process.exit(1);
  } finally { fs.closeSync(readFd); }
} catch {
  if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  try { fs.unlinkSync(temp); } catch {}
  process.exit(1);
}
NODE
}

clear_intent() {
  [[ -e "$intent" || -L "$intent" ]] || return 0
  local expected
  expected="v1 ${request_id} ${PACKAGE} ${CHANNEL} ${from_version} ${target_version} ${requested_at} ${started_at}"$'\n'
  "$NODE_BIN" - "$intent" "$expected" "$EXPECTED_RECEIPT_UID" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [file, expected, uidText] = process.argv.slice(2);
const uid = Number(uidText);
try {
  if (!fs.constants.O_NOFOLLOW) process.exit(1);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid ||
      (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size !== Buffer.byteLength(expected)) process.exit(1);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== uid || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1 ||
        opened.size !== before.size || fs.readFileSync(fd, 'utf8') !== expected) process.exit(1);
    const current = fs.lstatSync(file);
    if (current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1) process.exit(1);
    fs.unlinkSync(file);
  } finally { fs.closeSync(fd); }
  const dirFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
} catch { process.exit(1); }
NODE
}

finish_record() {
  clear_intent || fail 'could not clear exact privileged intent' 34
  rm -f -- "$TRIGGER"
}

reconcile_receipt_publication() {
  "$NODE_BIN" - "$receipt" "$EXPECTED_RECEIPT_UID" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [file, uidText] = process.argv.slice(2);
const uid = Number(uidText);
try {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid ||
      (before.mode & 0o777) !== 0o644 || before.size < 1 || before.size > 2048) process.exit(1);
  if (before.nlink === 1) process.exit(0);
  if (before.nlink !== 2) process.exit(1);
  const directory = path.dirname(file);
  const prefix = `${path.basename(file)}.tmp.`;
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const suffix = new RegExp(`^[0-9]+(?:\\.${uuid})?$`);
  const candidates = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.startsWith(prefix))
    .filter(entry => suffix.test(entry.name.slice(prefix.length)))
    .map(entry => path.join(directory, entry.name))
    .filter(candidate => {
      const state = fs.lstatSync(candidate);
      return state.isFile() && !state.isSymbolicLink() && state.dev === before.dev &&
        state.ino === before.ino && state.uid === uid && (state.mode & 0o777) === 0o644 &&
        state.nlink === 2 && state.size === before.size;
    });
  if (candidates.length !== 1) process.exit(1);
  fs.unlinkSync(candidates[0]);
  const dirFd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  const after = fs.lstatSync(file);
  if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev ||
      after.ino !== before.ino || after.uid !== uid || (after.mode & 0o777) !== 0o644 ||
      after.nlink !== 1 || after.size !== before.size) process.exit(1);
} catch { process.exit(1); }
NODE
}

read_installed_version() {
  local global_root package_json
  global_root="$($NPM_BIN root -g 2>/dev/null)" || return 1
  [[ "$global_root" == /* && "$global_root" != *$'\n'* && "$global_root" != *$'\r'* ]] || return 1
  package_json="${global_root}/${PACKAGE}/package.json"
  "$NODE_BIN" - "$package_json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
try {
  const state = fs.lstatSync(file);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 ||
      state.size < 2 || state.size > 1024 * 1024) process.exit(1);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof parsed.version !== 'string') process.exit(1);
  process.stdout.write(parsed.version);
} catch { process.exit(1); }
NODE
}

write_receipt() {
  local installed="$1" success="$2" reason="$3" finished_at content
  finished_at="$($NODE_BIN -e 'process.stdout.write(new Date().toISOString())')"
  content="v1 ${request_id} ${PACKAGE} ${CHANNEL} ${from_version} ${target_version} ${installed} ${success} ${requested_at} ${started_at} ${finished_at} ${reason}\n"
  "$NODE_BIN" - "$receipt" "$content" "$EXPECTED_RECEIPT_UID" "$FAILPOINT" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [receipt, escaped, uidText, failpoint] = process.argv.slice(2);
const content = escaped.replace(/\\n$/, '\n');
const directory = path.dirname(receipt);
const temp = `${receipt}.tmp.${process.pid}.${crypto.randomUUID()}`;
let fd;
try {
  const dirState = fs.lstatSync(directory);
  if (!dirState.isDirectory() || dirState.isSymbolicLink() ||
      dirState.uid !== Number(uidText) || (dirState.mode & 0o022) !== 0) process.exit(1);
  fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL |
    fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o644);
  fs.writeFileSync(fd, content, 'utf8');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fd = undefined;
  fs.linkSync(temp, receipt); // atomic no-replace publication
  const dirFd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  if (failpoint === 'after_receipt_link') {
    process.kill(process.ppid, 'SIGKILL');
    process.kill(process.pid, 'SIGKILL');
  }
  fs.unlinkSync(temp);
  const cleanupDirFd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(cleanupDirFd); } finally { fs.closeSync(cleanupDirFd); }
} catch {
  if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  try { fs.unlinkSync(temp); } catch {}
  process.exit(1);
}
NODE
}

# A terminal UUID is immutable. Exact replay removes only the stale trigger;
# identity conflict performs zero npm mutation and cannot overwrite receipt.
if [[ -e "$receipt" || -L "$receipt" ]]; then
  reconcile_receipt_publication || fail 'ambiguous existing receipt publication' 18
  existing="$($NODE_BIN - "$receipt" "$EXPECTED_RECEIPT_UID" <<'NODE'
const fs = require('node:fs');
const [file, uidText] = process.argv.slice(2);
try {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== Number(uidText) ||
      (before.mode & 0o777) !== 0o644 || before.nlink !== 1 || before.size < 1 || before.size > 2048 ||
      !fs.constants.O_NOFOLLOW) process.exit(1);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.uid !== before.uid || (opened.mode & 0o777) !== 0o644 ||
        opened.nlink !== 1 || opened.size !== before.size) process.exit(1);
    const content = fs.readFileSync(fd, 'utf8');
    if (!content.endsWith('\n') || content.slice(0, -1).includes('\n') || content.includes('\r')) process.exit(1);
    const fields = content.slice(0, -1).split(' ');
    if (fields.length !== 12 || fields.some(field => field.length === 0)) process.exit(1);
    const [schema, id, packageName, channel, previous, target, installed, status,
      requestedAt, startedAt, finishedAt, reason] = fields;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
    const exactTime = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
    if (schema !== 'v1' || !uuid.test(id) || packageName !== '@zincapp/znvault-plugin-payara' ||
        channel !== 'dr-m4' || !semver.test(previous) || !semver.test(target) ||
        (installed !== 'none' && !semver.test(installed)) ||
        (status !== 'success' && status !== 'failure') ||
        (status === 'success' && installed !== target) ||
        ![requestedAt, startedAt, finishedAt].every(exactTime) ||
        Date.parse(startedAt) < Date.parse(requestedAt) || Date.parse(finishedAt) < Date.parse(startedAt) ||
        !/^[a-z][a-z0-9_]{1,63}$/.test(reason)) process.exit(1);
    process.stdout.write(content);
  } finally { fs.closeSync(fd); }
} catch { process.exit(1); }
NODE
)" || fail 'untrusted existing receipt' 18
  IFS=' ' read -r r_schema r_id r_package r_channel r_from r_target _r_installed _r_status \
    r_requested_at r_started_at _r_finished_at _r_reason r_extra <<<"$existing"
  if [[ "$r_schema" == v1 && "$r_id" == "$request_id" && "$r_package" == "$PACKAGE" &&
        "$r_channel" == "$CHANNEL" && "$r_from" == "$from_version" && "$r_target" == "$target_version" &&
        "$r_requested_at" == "$requested_at" && -z "${r_extra:-}" ]]; then
    started_at="$r_started_at"
    if [[ -e "$intent" || -L "$intent" ]]; then
      intent_started_at="$(read_intent)" || fail 'untrusted privileged intent during receipt replay' 19
      [[ "$intent_started_at" == "$started_at" ]] || fail 'receipt conflicts with privileged intent' 19
    fi
    finish_record
    printf '%s\n' "plugin-update-wrapper: exact receipt replay ${request_id}" >&2
    exit 0
  fi
  fail 'requestId conflicts with immutable receipt' 19
fi

installed_before="$(read_installed_version 2>/dev/null || true)"
[[ "$installed_before" =~ $semver_re ]] || installed_before='none'

intent_exists=false
if [[ -e "$intent" || -L "$intent" ]]; then
  started_at="$(read_intent)" || fail 'untrusted or conflicting privileged intent' 20
  intent_exists=true
fi

# Once root has durably authorized this exact tuple, the installed target is
# sufficient recovery evidence. Registry availability and a later tag move no
# longer get to turn a completed mutation into a terminal failure.
if [[ "$intent_exists" == true && "$installed_before" == "$target_version" ]]; then
  write_receipt "$installed_before" success recovered_install || fail 'could not publish recovered receipt' 21
  finish_record
  exit 0
fi
if [[ "$intent_exists" == true && "$installed_before" != "$from_version" &&
      "$installed_before" != none ]]; then
  write_receipt "$installed_before" failure current_version_mismatch || fail 'could not publish CAS receipt' 22
  finish_record
  fail 'installed version conflicts with privileged intent' 23
fi

if [[ "$intent_exists" == false ]]; then
  # Re-resolve the fixed release tag under the same root-owned lock immediately
  # before arming the intent. This prevents an arbitrary major-3 artifact request.
  advertised="$($NPM_BIN view "${PACKAGE}@${CHANNEL}" version 2>/dev/null || true)"
  if [[ ! "$advertised" =~ $semver_re || "$advertised" != "$target_version" ]]; then
    write_receipt "$installed_before" failure channel_mismatch || fail 'could not publish channel failure receipt' 24
    finish_record
    fail 'dr-m4 does not resolve to requested target' 25
  fi

  # Strict SemVer ordering (including prerelease identifiers): target must be
  # newer than from. Equality is handled by the Agent as a no-op, never here.
  if ! "$NODE_BIN" - "$from_version" "$target_version" <<'NODE'
function parse(v) {
  const [coreAndPre] = v.split('+');
  const separator = coreAndPre.indexOf('-');
  const core = separator === -1 ? coreAndPre : coreAndPre.slice(0, separator);
  const pre = separator === -1 ? null : coreAndPre.slice(separator + 1).split('.');
  return { core: core.split('.').map(Number), pre };
}
function cmpId(a, b) {
  const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const c = cmpId(a.pre[i], b.pre[i]); if (c) return c;
  }
  return 0;
}
process.exit(compare(parse(process.argv[3]), parse(process.argv[2])) > 0 ? 0 : 1);
NODE
  then
    write_receipt "$installed_before" failure downgrade_refused || fail 'could not publish downgrade receipt' 26
    finish_record
    fail 'target is not newer than expected current version' 27
  fi

  # Without an existing privileged intent, an already-installed target is not
  # accepted: Agent-owned state cannot prove root previously crossed the fence.
  if [[ "$installed_before" != "$from_version" ]]; then
    write_receipt "$installed_before" failure current_version_mismatch || fail 'could not publish CAS receipt' 28
    finish_record
    fail 'installed version does not match expected current version' 29
  fi

  publish_intent || fail 'could not publish privileged update intent' 30
  intent_exists=true
fi

npm_status=0
"$NPM_BIN" install -g -- "${PACKAGE}@${target_version}" || npm_status=$?
if [[ "$FAILPOINT" == after_npm ]]; then
  kill -KILL "$$"
fi

installed_after="$(read_installed_version 2>/dev/null || true)"
if [[ ! "$installed_after" =~ $semver_re ]]; then
  write_receipt none failure readback_failed || fail 'could not publish readback failure receipt' 31
  finish_record
  fail 'installed version readback failed' 32
fi
if [[ "$installed_after" == "$target_version" ]]; then
  if [[ "$npm_status" -eq 0 ]]; then
    write_receipt "$installed_after" success installed || fail 'could not publish success receipt' 33
  else
    write_receipt "$installed_after" success recovered_install || fail 'could not publish recovered receipt' 33
  fi
  finish_record
  printf '%s\n' "plugin-update-wrapper: installed exact Payara target for ${request_id}" >&2
  exit 0
fi
if [[ "$npm_status" -ne 0 ]]; then
  write_receipt "$installed_after" failure npm_install_failed || fail 'could not publish install failure receipt' 35
  finish_record
  fail 'npm install failed' 36
fi
write_receipt "$installed_after" failure version_mismatch || fail 'could not publish mismatch receipt' 37
finish_record
fail 'installed version does not match target' 38
