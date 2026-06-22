# Sudo-free Agent Self-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the non-root, sandboxed agent trigger the root updater oneshot via a systemd `.path` unit (file trigger) instead of `sudo systemctl start`, which the strict profile blocks.

**Architecture:** The agent atomically *creates* a trigger file in a directory it already has `ReadWritePaths` to. A root-owned, enabled `zn-vault-agent-updater.path` unit (`PathExists=`) activates the existing `zn-vault-agent-updater.service` oneshot, whose `ExecStart` is a new root wrapper script that reads+**deletes** the trigger, then runs the targeted `npm install`. A new install strategy in `npm-auto-update.ts` prefers the trigger-file path and falls back to the existing sudo path on un-migrated hosts.

**Tech Stack:** TypeScript (Node, NodeNext ESM), Vitest, systemd, bash.

## Global Constraints

- Package name: `@zincapp/zn-vault-agent` (constant `PACKAGE_NAME` / `NPM_PACKAGE`).
- Update channels (the ONLY valid values): `latest | beta | next` (`UpdateChannel` in `src/types/update.ts`). NOTE: NOT `stable`.
- Trigger file path: `/var/lib/zn-vault-agent/.update-trigger` (under the agent unit's `ReadWritePaths=/var/lib/zn-vault-agent`, owned by `zn-vault-agent`).
- Updater service unit name: `zn-vault-agent-updater.service` (constant `UPDATER_SERVICE_NAME` = `zn-vault-agent-updater`).
- New path unit name: `zn-vault-agent-updater.path`.
- Wrapper script installed path: `/usr/local/lib/zn-vault-agent/zn-vault-agent-update.sh`, root:root, mode `0755`.
- `systemctlSafe(action, serviceName?)` accepts AT MOST 2 tokens — it cannot express `enable --now <unit>`. Use two calls: `systemctlSafe('enable', UNIT)` then `systemctlSafe('start', UNIT)`.
- The strict hardening profile (`NoNewPrivileges`, `PrivateDevices`, empty `CapabilityBoundingSet`) is NOT modified by this plan.
- Keep the existing sudoers rule + sudo strategy for back-compat (fallback for un-migrated hosts). Do not remove them.
- ESLint: no `any` (use `unknown` + narrowing), explicit return types on exported functions, `import type` for type-only imports, `??` over `||`.
- ESM imports use `.js` extension for local files.
- All identifiers and comments in English.

---

### Task 1: Wrapper script `zn-vault-agent-update.sh`

The root-owned script that the updater oneshot runs. Reads + deletes the trigger file, validates the value, installs the target.

**Files:**
- Create: `deploy/scripts/zn-vault-agent-update.sh`
- Test: `test/scripts/update-wrapper.bats.sh` (plain bash test runner — no bats dependency; a shell script that asserts and exits non-zero on failure)

**Interfaces:**
- Consumes: a trigger file at `$1` (arg) or default `/var/lib/zn-vault-agent/.update-trigger`, single line `"<version> <channel>"`.
- Produces: runs `npm install -g @zincapp/zn-vault-agent@<target>`; exits 0 on success, non-zero on validation/no-trigger/install failure. Deletes the trigger file before installing.

- [ ] **Step 1: Write the wrapper script**

Create `deploy/scripts/zn-vault-agent-update.sh`:

```bash
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
```

- [ ] **Step 2: Write the test runner**

Create `test/scripts/update-wrapper.bats.sh`:

```bash
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
```

- [ ] **Step 3: Make both executable and run the test (expect PASS)**

Run:
```bash
cd /Users/diegovidal/Drive/zn-vault/zn-vault-agent
chmod +x deploy/scripts/zn-vault-agent-update.sh test/scripts/update-wrapper.bats.sh
bash test/scripts/update-wrapper.bats.sh
```
Expected: every line `ok: ...`, process exits 0.

- [ ] **Step 4: Commit**

```bash
git add deploy/scripts/zn-vault-agent-update.sh test/scripts/update-wrapper.bats.sh
git commit -m "feat(update): root updater wrapper with validation + delete-on-consume"
```

---

### Task 2: setup.ts — emit `.path` unit, point updater at wrapper, install wrapper, enable path

**Files:**
- Modify: `src/commands/setup.ts` (constants ~27-38; `buildUpdaterUnit()` ~459-472; `handleInstall` install block ~204-239; `handleUninstall` removal block ~317-327)
- Test: `src/commands/setup.test.ts`

**Interfaces:**
- Produces (for tests):
  - `buildUpdaterUnit(): string` — `ExecStart` now points at the wrapper path.
  - `buildUpdaterPathUnit(): string` — new exported function returning the `.path` unit content.
  - New constants: `UPDATER_PATH_FILE`, `WRAPPER_INSTALL_PATH`, `TRIGGER_FILE`.

- [ ] **Step 1: Write failing tests**

Add to `src/commands/setup.test.ts` (import `buildUpdaterPathUnit`, `buildUpdaterUnit` from `./setup.js` — add to the existing import if present, else add an import):

```typescript
import { buildUpdaterUnit, buildUpdaterPathUnit } from './setup.js';

describe('updater path-activation units', () => {
  it('buildUpdaterPathUnit uses PathExists on the trigger and points at the service', () => {
    const unit = buildUpdaterPathUnit();
    expect(unit).toContain('PathExists=/var/lib/zn-vault-agent/.update-trigger');
    expect(unit).not.toContain('PathModified');
    expect(unit).toContain('Unit=zn-vault-agent-updater.service');
    expect(unit).toContain('WantedBy=paths.target');
  });

  it('buildUpdaterUnit ExecStart runs the wrapper script, not inline npm', () => {
    const unit = buildUpdaterUnit();
    expect(unit).toContain('ExecStart=/usr/local/lib/zn-vault-agent/zn-vault-agent-update.sh');
    expect(unit).not.toContain('npm install -g');
    expect(unit).toContain('ExecStartPost=');
    expect(unit).toContain('try-restart zn-vault-agent');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run test:unit -- src/commands/setup.test.ts`
Expected: FAIL — `buildUpdaterPathUnit` is not exported / `ExecStart` still inline npm.

- [ ] **Step 3: Add constants**

In `src/commands/setup.ts`, after the existing const block (near line 38), add:

```typescript
const UPDATER_PATH_NAME = 'zn-vault-agent-updater';
const UPDATER_PATH_FILE = `${SYSTEMD_DIR}/${UPDATER_PATH_NAME}.path`;
const WRAPPER_INSTALL_DIR = '/usr/local/lib/zn-vault-agent';
const WRAPPER_INSTALL_PATH = `${WRAPPER_INSTALL_DIR}/zn-vault-agent-update.sh`;
const TRIGGER_FILE = `${DATA_DIR}/.update-trigger`;
```

- [ ] **Step 4: Rewrite `buildUpdaterUnit()` and add `buildUpdaterPathUnit()`**

Replace the body of `buildUpdaterUnit()` (currently ~459-472) with:

```typescript
export function buildUpdaterUnit(): string {
  const systemctlPath = whichSafe('systemctl') ?? '/usr/bin/systemctl';

  return `[Unit]
Description=Update ${SERVICE_NAME} (root-owned; agent unit sandbox blocks self-update - INC-2026-06-12-01 P4)
Documentation=https://github.com/zincapp/zn-vault

[Service]
Type=oneshot
ExecStart=${WRAPPER_INSTALL_PATH} ${TRIGGER_FILE}
ExecStartPost=${systemctlPath} try-restart ${SERVICE_NAME}
`;
}

/**
 * Build the root-owned `.path` unit that watches the trigger file and activates
 * the updater oneshot. Uses `PathExists` + delete-on-consume (the wrapper
 * deletes the trigger) so it cannot fire-on-enable against a stale file or loop
 * on a truncate. See the design spec.
 */
export function buildUpdaterPathUnit(): string {
  return `[Unit]
Description=Watch for ${SERVICE_NAME} self-update triggers

[Path]
PathExists=${TRIGGER_FILE}
Unit=${UPDATER_PATH_NAME}.service

[Install]
WantedBy=paths.target
`;
}
```

Remove the now-stale `npmPath` line and the version-target NOTE comment in the old `buildUpdaterUnit` (no longer relevant — the wrapper handles the target).

- [ ] **Step 5: Run tests, verify they pass**

Run: `npm run test:unit -- src/commands/setup.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire install flow in `handleInstall`**

In `handleInstall`, in the updater block (after the updater `.service` is written, ~line 214, before the sudoers block), add wrapper install + path unit + stale-trigger guard. Insert:

```typescript
  // Install the root-owned updater wrapper script that the oneshot runs.
  console.log('Installing updater wrapper...');
  if (!existsSync(WRAPPER_INSTALL_DIR)) {
    mkdirSync(WRAPPER_INSTALL_DIR, { recursive: true, mode: 0o755 });
  }
  const wrapperSrc = resolveBundledFile('scripts/zn-vault-agent-update.sh');
  copyFileSync(wrapperSrc, WRAPPER_INSTALL_PATH);
  chownSafe(WRAPPER_INSTALL_PATH, 'root:root');
  chmodSafe(WRAPPER_INSTALL_PATH, '0755');
  console.log(chalk.green(`  Installed ${WRAPPER_INSTALL_PATH}`));

  // Install the .path unit that activates the updater on trigger-file creation.
  console.log('Installing updater path unit...');
  writeFileSync(UPDATER_PATH_FILE, buildUpdaterPathUnit(), { mode: 0o644 });
  chownSafe(UPDATER_PATH_FILE, 'root:root');
  console.log(chalk.green(`  Installed ${UPDATER_PATH_FILE}`));

  // Remove any stale trigger so enabling the .path does not fire-on-enable.
  if (existsSync(TRIGGER_FILE)) {
    unlinkSync(TRIGGER_FILE);
  }
```

Then after the existing `systemctlSafe('daemon-reload')` (line 233) and before/after enabling the main service, enable + start the path unit (two calls — `systemctlSafe` can't do `enable --now`):

```typescript
  // Enable + start the updater .path watcher (enable --now is two calls here).
  console.log('Enabling updater path watcher...');
  systemctlSafe('enable', `${UPDATER_PATH_NAME}.path`);
  systemctlSafe('start', `${UPDATER_PATH_NAME}.path`);
  console.log(chalk.green(`  ${UPDATER_PATH_NAME}.path enabled`));
```

Add a helper `resolveBundledFile(rel: string): string` near the top of the file (mirrors the existing `__dirname`-based lookup used for the service template at ~181-183):

```typescript
const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveBundledFile(rel: string): string {
  const candidates = [
    join(__dirname, '..', '..', 'deploy', rel),
    join(__dirname, '..', 'deploy', rel),
    `/usr/local/lib/node_modules/@zincapp/zn-vault-agent/deploy/${rel}`,
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`Bundled file not found: ${rel} (looked in ${candidates.join(', ')})`);
}
```
(If `__dirname` is already defined in the file, reuse it — do not redeclare.)

- [ ] **Step 7: Wire uninstall cleanup**

In `handleUninstall`, next to the existing `UPDATER_SERVICE_FILE` removal (~317-321), add removal of the path unit, wrapper, and trigger:

```typescript
  if (existsSync(UPDATER_PATH_FILE)) {
    systemctlSafeQuiet('disable', `${UPDATER_PATH_NAME}.path`);
    console.log(`Removing ${UPDATER_PATH_FILE}...`);
    unlinkSync(UPDATER_PATH_FILE);
    console.log(chalk.green(`  Removed ${UPDATER_PATH_FILE}`));
  }
  if (existsSync(WRAPPER_INSTALL_PATH)) {
    unlinkSync(WRAPPER_INSTALL_PATH);
    console.log(chalk.green(`  Removed ${WRAPPER_INSTALL_PATH}`));
  }
  if (existsSync(TRIGGER_FILE)) {
    unlinkSync(TRIGGER_FILE);
  }
```

Wrap the `systemctlSafeQuiet('disable', ...)` in try/catch only if the surrounding uninstall code does (match existing style; if existing removals don't guard, leave as-is — uninstall is best-effort already).

- [ ] **Step 8: Verify build + the dry-run preview text mentions the new artifacts (optional polish)**

Run: `npm run build && npm run test:unit -- src/commands/setup.test.ts`
Expected: build OK, tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/commands/setup.ts src/commands/setup.test.ts
git commit -m "feat(setup): provision updater .path unit + wrapper (sudo-free self-update)"
```

---

### Task 3: npm-auto-update.ts — trigger-file install strategy

**Files:**
- Modify: `src/services/npm-auto-update.ts` (add constants near ~49-54; add `hasUpdaterPathUnit()` + `installViaTriggerFile()`; extend `performUpdate()` ~592-611)
- Test: `src/services/npm-auto-update.test.ts` (extend the `performUpdate install strategy` describe block ~1008-1125)

**Interfaces:**
- Consumes: `this.config.channel` (`UpdateChannel`), `process.getuid`, `execAsync` (promisified `exec`).
- Produces: `performUpdate(targetVersion)` returns `true` when the trigger-file strategy is used (restart handled externally by the oneshot's ExecStartPost), matching the existing updater-unit contract.

- [ ] **Step 1: Write failing tests**

In `src/services/npm-auto-update.test.ts`, inside the `performUpdate install strategy` describe, add tests. Mock `fs` writes by spying — the service writes via `fs/promises`; the test asserts the strategy selection and the trigger content. Add these cases:

```typescript
    it('non-root + .path unit present: writes trigger file, no sudo, no npm install', async () => {
      mockUid(1000); // non-root

      const writes: Array<{ path: string; data: string }> = [];
      // Spy the trigger writer (writeFile + rename happen via fs/promises).
      const fsp = await import('fs/promises');
      vi.spyOn(fsp, 'writeFile').mockImplementation(async (p: unknown, d: unknown) => {
        writes.push({ path: String(p), data: String(d) });
      });
      vi.spyOn(fsp, 'rename').mockResolvedValue(undefined);

      const commands: string[] = [];
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        const c = String(cmd);
        commands.push(c);
        if (c.includes('systemctl cat zn-vault-agent-updater.path')) {
          cb(null, { stdout: '[Path]\n', stderr: '' }); // .path unit exists
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: false, stagedRolloutMaxDelayMs: 0, channel: 'latest' });
      const restartHandledExternally = await (service as unknown as PerformUpdateAccessor).performUpdate('1.21.0');

      // Wrote a trigger with "<version> <channel>".
      const tmpWrite = writes.find((w) => w.path.includes('.update-trigger'));
      expect(tmpWrite).toBeDefined();
      expect(tmpWrite?.data.trim()).toBe('1.21.0 latest');
      // No sudo, no npm install, no systemctl start.
      expect(commands.some((c) => c.includes('sudo '))).toBe(false);
      expect(commands.some((c) => /(^|\s)npm install -g/.test(c))).toBe(false);
      expect(commands.some((c) => c.includes('systemctl start'))).toBe(false);
      // The oneshot (via .path) restarts the agent; caller must not.
      expect(restartHandledExternally).toBe(true);
    });

    it('non-root + no .path but old updater .service present: falls back to sudo systemctl start', async () => {
      mockUid(1000);

      const commands: string[] = [];
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        const c = String(cmd);
        commands.push(c);
        if (c.includes('systemctl cat zn-vault-agent-updater.path')) {
          cb(new Error('not found'), { stdout: '', stderr: 'No files found.' }); // no .path
        } else if (c.includes('systemctl cat zn-vault-agent-updater.service')) {
          cb(null, { stdout: '[Unit]\n', stderr: '' }); // old .service exists
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: false, stagedRolloutMaxDelayMs: 0, channel: 'latest' });
      const restartHandledExternally = await (service as unknown as PerformUpdateAccessor).performUpdate('1.21.0');

      expect(commands.some((c) => c.includes('sudo /usr/bin/systemctl start zn-vault-agent-updater.service'))).toBe(true);
      expect(restartHandledExternally).toBe(true);
    });
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run test:unit -- src/services/npm-auto-update.test.ts -t "performUpdate install strategy"`
Expected: FAIL — trigger-file path not implemented (no `.update-trigger` write; `.path` branch absent).

- [ ] **Step 3: Add constants + imports**

Near the existing constants (~49-54) add:

```typescript
const UPDATER_PATH_UNIT = 'zn-vault-agent-updater.path';
const TRIGGER_FILE = '/var/lib/zn-vault-agent/.update-trigger';
const TRIGGER_TMP_FILE = '/var/lib/zn-vault-agent/.update-trigger.tmp';
```

At the top imports, add (NodeNext ESM, `.js` not needed for node builtins):

```typescript
import { writeFile, rename } from 'fs/promises';
```

- [ ] **Step 4: Add detection + trigger-write methods**

Add these private methods near `hasUpdaterUnit()` (~507):

```typescript
  /**
   * Detect whether the root-owned updater `.path` unit is installed (the
   * sudo-free trigger mechanism). Mirrors hasUpdaterUnit().
   */
  private async hasUpdaterPathUnit(): Promise<boolean> {
    try {
      await execAsync(`systemctl cat ${UPDATER_PATH_UNIT}`, { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Trigger an update by atomically creating the trigger file. The root-owned
   * `.path` unit activates the updater oneshot, which reads + deletes the
   * trigger and installs the target. The agent only ever CREATES the trigger;
   * the root wrapper is the sole deleter.
   */
  private async installViaTriggerFile(targetVersion: string): Promise<void> {
    const channel = this.config.channel;
    const line = `${targetVersion} ${channel}\n`;
    logger.info({ trigger: TRIGGER_FILE, targetVersion, channel }, 'Writing self-update trigger file');
    // Atomic create: write tmp then rename, so .path sees a complete value.
    await writeFile(TRIGGER_TMP_FILE, line, { mode: 0o644 });
    await rename(TRIGGER_TMP_FILE, TRIGGER_FILE);
    logger.info({ trigger: TRIGGER_FILE }, 'Trigger written; updater .path will install + restart the agent');
  }
```

- [ ] **Step 5: Extend `performUpdate()` strategy order**

In `performUpdate()` (~592), insert the trigger-file branch BEFORE the existing updater-unit branch:

```typescript
  private async performUpdate(targetVersion: string): Promise<boolean> {
    // Non-root + .path unit present → sudo-free file trigger (preferred).
    if (!this.isRoot() && (await this.hasUpdaterPathUnit())) {
      logger.info(
        { package: PACKAGE_NAME, targetVersion, strategy: 'trigger-file' },
        'Installing update via updater .path trigger file'
      );
      await this.clearNpmCache();
      await this.installViaTriggerFile(targetVersion);
      return true; // The oneshot restarts the agent; caller must not double-restart.
    }

    // Non-root + only the old updater .service/sudoers → sudo systemctl start.
    if (!this.isRoot() && (await this.hasUpdaterUnit())) {
      logger.info(
        { package: PACKAGE_NAME, channel: this.config.channel, targetVersion, strategy: 'updater-unit' },
        'Installing update via root-owned updater unit'
      );
      await this.clearNpmCache();
      await this.installViaUpdaterUnit();
      return true;
    }

    // Root, or non-root without any unit: npm install (sudo when non-root).
    await this.performNpmInstall(targetVersion);
    return false;
  }
```

(This replaces the existing `performUpdate` body — keep the existing `installViaUpdaterUnit`, `performNpmInstall`, `clearNpmCache` methods unchanged.)

- [ ] **Step 6: Run tests, verify they pass**

Run: `npm run test:unit -- src/services/npm-auto-update.test.ts -t "performUpdate install strategy"`
Expected: PASS (both new cases + the 3 existing cases still pass — the existing "updater unit present" test does NOT mock the `.path` cat, so `hasUpdaterPathUnit` returns false there and it falls through to the sudo path as before).

- [ ] **Step 7: Run the full unit suite + lint**

Run: `npm run test:unit && npm run lint`
Expected: PASS, no lint errors.

- [ ] **Step 8: Commit**

```bash
git add src/services/npm-auto-update.ts src/services/npm-auto-update.test.ts
git commit -m "feat(update): prefer sudo-free .path trigger over sudo updater unit"
```

---

### Task 4: Bundle the wrapper into the npm package + docs

Ensure the wrapper ships in the published package (so `resolveBundledFile` finds it at the `/usr/local/lib/node_modules/...` candidate) and document the mechanism.

**Files:**
- Modify: `package.json` (`files` array — confirm `deploy/` is included)
- Modify: `scripts/bundle.mjs` (if it stages `deploy/` into the release — confirm the new script is copied + chmod +x)
- Modify: `CLAUDE.md` (Known Issues / update section) — short note on the new mechanism

**Interfaces:**
- Consumes: the wrapper at `deploy/scripts/zn-vault-agent-update.sh` from Task 1.
- Produces: a published package whose `deploy/scripts/` includes the wrapper with the executable bit.

- [ ] **Step 1: Verify `deploy/` is in the published files**

Run: `node -e "console.log(JSON.stringify(require('./package.json').files))"`
Expected: array including `deploy` (or `deploy/**`). If absent, add `"deploy"` to the `files` array.

- [ ] **Step 2: Confirm bundle.mjs preserves the wrapper + exec bit**

Read `scripts/bundle.mjs`. If it copies `deploy/` verbatim, no change. If it enumerates files, add `deploy/scripts/zn-vault-agent-update.sh` and ensure mode `0755` is preserved (copy then `chmodSync(dest, 0o755)`).

Run (sanity): `npm pack --dry-run 2>&1 | grep -i 'deploy/scripts/zn-vault-agent-update.sh'`
Expected: the wrapper appears in the pack listing.

- [ ] **Step 3: Document the mechanism**

In `CLAUDE.md`, under the agent update notes, add a short paragraph:

```markdown
### Sudo-free self-update (.path activation, 2026-06-22)

The strict agent systemd profile (empty CapabilityBoundingSet + PrivateDevices)
blocks `sudo`, breaking the old `sudo systemctl start updater` path. Self-update
now uses a file trigger: the agent atomically creates
`/var/lib/zn-vault-agent/.update-trigger` ("<version> <channel>"); a root-owned
`zn-vault-agent-updater.path` (PathExists) activates the updater oneshot, whose
ExecStart is `/usr/local/lib/zn-vault-agent/zn-vault-agent-update.sh` (reads +
DELETES the trigger, validates, `npm install -g @pkg@<target>`); ExecStartPost
`try-restart`s the agent on success only. The sudo path remains as a fallback
for un-migrated hosts. Design: docs/superpowers/specs/2026-06-22-sudo-free-agent-self-update-design.md.
```

- [ ] **Step 4: Build + full test gate**

Run: `npm run build && npm run test:unit && npm run lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/bundle.mjs CLAUDE.md
git commit -m "chore(update): bundle updater wrapper + document sudo-free self-update"
```

---

### Task 5: Release + targeted re-provision + resume rollout (operational — run with the user)

This task is operational (touches production); execute interactively with the user, not autonomously.

**Files:** none (uses release + setup flow).

- [ ] **Step 1: Release the new agent version**

Per the agent release process (GitHub Actions on tag):
```bash
npm version minor --no-git-tag-version
git add -A && git commit -m "feat(release): vX.Y.Z - sudo-free self-update via .path activation"
git push origin main
git tag -a "vX.Y.Z" -m "Release vX.Y.Z"; git push origin vX.Y.Z
```
Wait for `npm view @zincapp/zn-vault-agent version` to show the new version.

- [ ] **Step 2: Re-provision ONE failing host (zn-admin-1) to install the .path + wrapper**

The host must run `zn-vault-agent setup` (as root) from the new package to install the `.path` unit + wrapper WITHOUT relaxing the strict profile. Reach it via SSH-CA. Confirm:
```bash
systemctl cat zn-vault-agent-updater.path   # exists, PathExists=
ls -l /usr/local/lib/zn-vault-agent/zn-vault-agent-update.sh   # 0755 root
```

- [ ] **Step 3: Trigger update on zn-admin-1, verify via tunnel**

Open SSH-CA tunnel, then `agent update 127.0.0.1:<port>` (or the curl-body workaround until the CLI bug is fixed). Verify:
```bash
journalctl -u zn-vault-agent-updater --no-pager | tail   # wrapper ran, installed target
# health shows new version + healthy, uptime small (restarted)
```

- [ ] **Step 4: Resume the fleet rollout**

Re-run the rollout script (`/tmp/agent-rollout.sh`) for the remaining infra hosts. Each must be re-provisioned (setup) first, then triggered. Stop on first failure as before.

- [ ] **Step 5: Confirm all 17 agents on the target version**

```bash
znvault --profile production agent list   # all show the new version
```

---

## Self-Review

**1. Spec coverage:**
- Wrapper script (validation, delete-on-consume) → Task 1. ✓
- `buildUpdaterUnit` ExecStart→wrapper, new `buildUpdaterPathUnit` (PathExists), install/enable/stale-guard, uninstall → Task 2. ✓
- `npm-auto-update` trigger-file strategy + `.path` detection + fallback ordering + return contract → Task 3. ✓
- Bundling so the wrapper ships + docs → Task 4. ✓
- Migration/rollout (release, re-provision, resume) → Task 5. ✓
- Error-handling invariants (fire-on-enable guard, no-feedback-loop, ExecStartPost-on-success-only) → covered by Task 1 (delete-before-install), Task 2 (PathExists + stale-trigger rm + ExecStartPost), Task 3 tests. ✓

**2. Placeholder scan:** No TBD/TODO; all steps have concrete code/commands. ✓

**3. Type consistency:**
- Channel values `latest|beta|next` consistent across wrapper allowlist (Task 1) and `UpdateChannel` (Global Constraints). ✓
- `installViaTriggerFile(targetVersion: string): Promise<void>`, `hasUpdaterPathUnit(): Promise<boolean>` — names match between Task 3 impl and tests. ✓
- `buildUpdaterPathUnit()` / `buildUpdaterUnit()` names match between Task 2 impl and setup.test.ts. ✓
- Constants `TRIGGER_FILE` defined in BOTH setup.ts (Task 2) and npm-auto-update.ts (Task 3) — intentional (separate modules, same literal path; kept in sync via Global Constraints). ✓
- `systemctlSafe` 2-arg limit respected (enable + start as two calls in Task 2). ✓
