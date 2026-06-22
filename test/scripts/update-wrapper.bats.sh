#!/usr/bin/env bash
# Plain-bash tests for deploy/scripts/zn-vault-agent-update.sh.
# Stubs `npm` on PATH so no real install happens; asserts validation + delete.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WRAPPER="$HERE/../../deploy/scripts/zn-vault-agent-update.sh"
fail=0

setup() {
  TMP="$(mktemp -d)"
  TRIGGER="$TMP/.update-trigger"
  # Stub npm: record args, succeed.
  STUB="$TMP/bin"; mkdir -p "$STUB"
  cat > "$STUB/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" > "$NPM_LOG"
exit 0
EOF
  chmod +x "$STUB/npm"
  export NPM_LOG="$TMP/npm.log"
  export PATH="$STUB:$PATH"
}
teardown() { rm -rf "$TMP"; }

assert() { if ! eval "$2"; then echo "FAIL: $1"; fail=1; else echo "ok: $1"; fi; }

# 1. Valid concrete version → installs @version, deletes trigger.
setup; printf '1.21.0 latest\n' > "$TRIGGER"
bash "$WRAPPER" "$TRIGGER" >/dev/null 2>&1; rc=$?
assert "valid version exit 0" "[ $rc -eq 0 ]"
assert "installs @1.21.0" "grep -q 'npm install -g @zincapp/zn-vault-agent@1.21.0' '$NPM_LOG'"
assert "trigger deleted" "[ ! -f '$TRIGGER' ]"
teardown

# 2. version 'latest' → installs @channel.
setup; printf 'latest beta\n' > "$TRIGGER"
bash "$WRAPPER" "$TRIGGER" >/dev/null 2>&1; rc=$?
assert "latest+beta installs @beta" "grep -q '@zincapp/zn-vault-agent@beta' '$NPM_LOG'"
teardown

# 3. Injection attempt → rejected, trigger deleted, no npm call.
setup; printf '; rm -rf / latest\n' > "$TRIGGER"
bash "$WRAPPER" "$TRIGGER" >/dev/null 2>&1; rc=$?
assert "injection rejected nonzero" "[ $rc -ne 0 ]"
assert "no npm on injection" "[ ! -f '$NPM_LOG' ]"
assert "trigger deleted on reject" "[ ! -f '$TRIGGER' ]"
teardown

# 4. Bad channel → rejected.
setup; printf '1.21.0 prod\n' > "$TRIGGER"
bash "$WRAPPER" "$TRIGGER" >/dev/null 2>&1; rc=$?
assert "bad channel nonzero" "[ $rc -ne 0 ]"
teardown

# 5. Bad semver → rejected.
setup; printf '1.2 latest\n' > "$TRIGGER"
bash "$WRAPPER" "$TRIGGER" >/dev/null 2>&1; rc=$?
assert "bad semver nonzero" "[ $rc -ne 0 ]"
teardown

# 6. Missing trigger → nonzero.
setup
bash "$WRAPPER" "$TMP/nope" >/dev/null 2>&1; rc=$?
assert "missing trigger nonzero" "[ $rc -ne 0 ]"
teardown

exit $fail
