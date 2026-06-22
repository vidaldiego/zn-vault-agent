# Sudo-free agent self-update via systemd `.path` activation

- **Date:** 2026-06-22
- **Status:** Design (approved; adversarially self-reviewed — 2 systemd footguns
  found and fixed: fire-on-enable and truncate-feedback-loop; see "Why
  `PathExists` + delete-on-consume" below)
- **Component:** `zn-vault-agent`
- **Related:** INC-2026-06-12-01 (agent auto-update fix), the operator-initiated
  agent update path (`POST /agent/update` + WebSocket `update-available`).

## Problem

Operator-initiated agent self-update fails on hosts whose agent runs the
**strict systemd profile** that `setup.ts` provisions today.

The agent runs as the unprivileged `zn-vault-agent` user. Its install path
(`npm-auto-update.ts`) delegates to a root-owned oneshot via:

```
sudo /usr/bin/systemctl start zn-vault-agent-updater.service
```

permitted by a NOPASSWD sudoers rule. This worked on hosts running an older,
looser unit, but fails on hosts running the current strict unit:

```
sudo: unable to change to root gid: Operation not permitted
sudo: error initializing audit plugin sudoers_audit
```

### Confirmed root cause

Comparing the **running** systemd properties of a working host
(`payara-staging-1`) vs a failing host (`zn-admin-1`):

| Property | payara-staging-1 (works) | zn-admin-1 (fails) |
|----------|--------------------------|--------------------|
| `CapabilityBoundingSet` | full default set (incl. `cap_setgid cap_setuid cap_audit_write`) | **empty** |
| `PrivateDevices` | `no` | **`yes`** |
| `RestrictNamespaces` | `no` | `yes` |
| `NoNewPrivileges` | `no` | `no` (same on both) |

- **Empty `CapabilityBoundingSet`** removes `cap_setgid`/`cap_setuid` from the
  process bounding set. `sudo` is setuid-root, but the bounding set caps what any
  descendant can hold, so `sudo` cannot `setgid(0)` → `unable to change to root gid`.
- **`PrivateDevices=yes`** breaks the sudo audit plugin's device access →
  `error initializing audit plugin sudoers_audit`.

`NoNewPrivileges` is **not** the cause (both hosts have it `no`).

The strict profile is the **intended** hardening (it is what `setup.ts` writes
today). The defect is that the update path requires `sudo`, which the strict
profile deliberately prevents. These two are mutually incompatible: any host
freshly provisioned with the current `setup.ts` template cannot self-update.

## Goal

Let the non-root, capability-stripped agent trigger the root-owned updater
oneshot **without sudo, caps, polkit, or D-Bus**, while keeping the strict
hardening profile unchanged. Fix `setup.ts` so future provisioning is correct.

## Approach: systemd `.path` activation (file-triggered)

The agent writes a small trigger file in a directory it already has
`ReadWritePaths` access to. A root-owned, enabled `.path` unit watches that file
and activates the updater oneshot. The agent escalates nothing — it only writes
a file.

```
agent (non-root, sandboxed)
  └─ atomically creates "<version> <channel>" at
       /var/lib/zn-vault-agent/.update-trigger      (under ReadWritePaths)
            │ inotify (file now EXISTS)
            ▼
zn-vault-agent-updater.path        [root, enabled, WantedBy=paths.target]
   PathExists=/var/lib/zn-vault-agent/.update-trigger
   Unit=zn-vault-agent-updater.service
            │ activates
            ▼
zn-vault-agent-updater.service     [root, oneshot]
   ExecStart=/usr/local/lib/zn-vault-agent/zn-vault-agent-update.sh
       (wrapper reads trigger → DELETES it → npm install -g <pkg>@<version|channel>)
   ExecStartPost=/usr/bin/systemctl try-restart zn-vault-agent
```

### Why `PathExists` + delete-on-consume (NOT `PathModified` + truncate)

`PathModified` is wrong for this design, for two reasons (adversarial review):

1. **Fire-on-enable.** A `.path` unit evaluates its condition at activation. With
   `PathModified`/`PathExists`, if the watched file **already exists** when the
   `.path` is enabled (`enable --now` during provisioning), systemd **immediately
   triggers the service**. With a trigger file that is *deleted on consume*, the
   resting state is "absent", so re-provisioning never spuriously fires. We also
   guard provisioning by removing any stale trigger before enabling (see §3).
2. **Truncate feedback loop.** Truncating the trigger on success is itself a
   modification, so `PathModified` would **re-fire the unit on every successful
   install** → an update loop. `PathExists` keys off existence, and the wrapper
   **deletes** (not truncates) the file, so consuming the trigger returns the
   system to the non-triggering resting state with no re-fire.

### Why this approach

- **Survives the strict sandbox.** Writing a file needs no capabilities; the
  failure mode that broke sudo (empty `CapabilityBoundingSet` + `PrivateDevices`)
  is irrelevant to a file write.
- **No new trust surface in the agent.** No polkit rule, no D-Bus client, no
  setuid path. The privileged work stays entirely in root-owned units.
- **Decoupled.** The agent never blocks on the install; the oneshot runs in its
  own clean namespace (where `/usr` is writable), exactly as today.

Rejected alternatives:
- **Polkit rule** allowing the agent user to `manage-units` for the updater
  service over D-Bus. Works without caps, but couples to polkit/systemd versions
  and adds a D-Bus client path in the agent. The file trigger is simpler and has
  a smaller trust surface.
- **Relaxing the unit** (re-granting `CAP_SETUID/SETGID/AUDIT_WRITE`,
  `PrivateDevices=no`). Rejected: it rolls back deliberate hardening, which is the
  opposite of the project's intent.

## Components

### 1. Wrapper script — `deploy/scripts/zn-vault-agent-update.sh`

Installed to `/usr/local/lib/zn-vault-agent/zn-vault-agent-update.sh`,
root-owned, mode `0755`.

Responsibilities:
- Read `/var/lib/zn-vault-agent/.update-trigger` (single line:
  `"<version> <channel>"`, e.g. `1.21.0 stable`).
- **Strict validation before use** — never `eval`, never word-split into a shell
  command:
  - `version`: matches semver `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`, or the
    literal `latest`.
  - `channel`: in the allowlist `stable|beta|next`.
  - Any other content → log to journal and exit non-zero (no install).
- Resolve the install target:
  - If `version` is a concrete semver → `@<version>`.
  - Else (`latest` or absent) → `@<channel>`.
- **Delete the trigger file BEFORE running the install** (read the value into a
  shell variable first, then `rm -f` the file). Deleting first — not after —
  means: (a) consuming the trigger returns the `PathExists` unit to its
  non-triggering resting state immediately; (b) a failed/looping install cannot
  re-read a stale trigger; (c) deletion (unlike truncation) does not itself
  re-fire the `.path`.
- Run `npm install -g @zincapp/zn-vault-agent@<target>`.

The script is the updater unit's `ExecStart`. Restart of the agent stays in the
unit's `ExecStartPost` (`systemctl try-restart zn-vault-agent`), unchanged.

### 2. `buildUpdaterUnit()` (setup.ts) — modified

- `ExecStart` changes from the inline `npm install -g <pkg>@latest` to the
  wrapper script path.
- `ExecStartPost=/usr/bin/systemctl try-restart zn-vault-agent` — unchanged.
- Still no `[Install]` section: the `.service` is activated by the `.path`, not
  enabled directly.

### 3. `buildUpdaterPathUnit()` (setup.ts) — new

Emits `zn-vault-agent-updater.path`:

```ini
[Unit]
Description=Watch for zn-vault-agent self-update triggers

[Path]
PathExists=/var/lib/zn-vault-agent/.update-trigger
Unit=zn-vault-agent-updater.service

[Install]
WantedBy=paths.target
```

`handleInstall`:
1. **Removes any stale trigger file** (`rm -f /var/lib/zn-vault-agent/.update-trigger`)
   so enabling the `.path` does not immediately fire on a leftover trigger from a
   previous install.
2. Writes the `.path` and `.service` units + the wrapper.
3. `daemon-reload`.
4. `systemctl enable --now zn-vault-agent-updater.path`.

The trigger directory (`/var/lib/zn-vault-agent`) already exists and is
owned/writable by the agent user.

### 4. `npm-auto-update.ts` — new strategy

New private method `installViaTriggerFile(targetVersion)`:
- Compose the line `"<version> <channel>"` from the resolved target version and
  `this.config.channel`.
- Write atomically: write `<dir>/.update-trigger.tmp`, `fsync`, then `rename` to
  `.update-trigger`. Rename is atomic, so the file appears in one step with a
  complete value — `PathExists` sees a fully-written trigger, never a partial one.
- The agent only ever **creates** the trigger; the root wrapper is the sole
  deleter. The agent never reads it back or deletes it (avoids a create/delete
  race with the wrapper).

New detection `hasUpdaterPathUnit()` mirroring `hasUpdaterUnit()`
(`systemctl cat zn-vault-agent-updater.path` exits 0 when present).

`performUpdate(targetVersion)` strategy order becomes:
1. **root** → direct `npm install -g <pkg>@<tag>` (unchanged).
2. **non-root + `.path` unit present + trigger dir writable** → `installViaTriggerFile`,
   return `restartHandledExternally = true` (the oneshot's `ExecStartPost`
   restarts the agent; caller must not double-restart).
3. **non-root + only the old updater `.service`/sudoers present** → existing
   `sudo systemctl start` path (back-compat for un-migrated hosts).
4. **non-root + no unit** → best-effort `sudo npm install -g` (dev / non-systemd).

This ordering lets a new-code agent update correctly on both migrated and
un-migrated hosts (no flag day).

### 5. Sudoers — retained for now

The existing `/etc/sudoers.d/zn-vault-agent` NOPASSWD rule is **kept** so the
strategy-3 fallback works during migration. Removing it is a separate cleanup
once every host runs the `.path` unit.

## Migration / rollout

1. Ship the new agent code + `setup.ts` changes; release a new agent version.
2. For each affected host: re-run `zn-vault-agent setup` (or a targeted
   provisioning step) to install the wrapper, the `.path` unit, the modified
   `.service`, and enable the `.path`. This does **not** require relaxing the
   strict profile.
3. Trigger the update (operator path). The agent now writes the trigger file;
   the root `.path` → `.service` installs the new version and restarts the agent.
4. Resume the paused fleet rollout (zn-admin / archon / haproxy / minio-proxy
   tiers) to 1.21.0+.

Hosts that already work (payara tier) are unaffected: they hit strategy 1/3 as
before, and gain strategy 2 once re-provisioned.

## Error handling

| Failure | Behavior |
|---------|----------|
| Trigger file has invalid version/channel | Wrapper validates, then exits non-zero, logs to journal; **trigger already deleted** (wrapper deletes before install), so no install, no restart, no re-fire; agent version unchanged (operator observes "version didn't move"). |
| Half-written trigger | Prevented by atomic temp-write + rename (file appears complete or not at all). |
| Stale trigger re-firing | Prevented by `PathExists` semantics + delete-on-consume: the resting state is "file absent", deletion does not re-trigger, and provisioning removes any leftover trigger before `enable --now`. |
| Spurious fire on `enable --now` | Prevented by `handleInstall` step 1 (`rm -f` the trigger before enabling the `.path`). |
| `.path` unit absent (un-migrated host) | Strategy falls back to sudo updater unit (3), then sudo-npm (4). |
| npm install fails inside oneshot | `ExecStart` (the wrapper) exits non-zero; **`ExecStartPost` only runs on `ExecStart` success**, so `try-restart` is NOT reached — the agent keeps running the old version (safe). Logged to journal. (Confirmed against systemd.service semantics.) |
| npm install loops/retries on a stale value | Impossible: the wrapper deletes the trigger **before** installing, so there is no value left to re-read. |

## Testing

### Unit — `src/services/npm-auto-update.test.ts`
- Strategy selection matrix: root / non-root+path-present / non-root+only-old-unit /
  non-root+no-unit.
- `installViaTriggerFile`: composes `"<version> <channel>"`, writes via tmp+rename
  (assert temp path then rename), returns `restartHandledExternally = true`.
- Return-contract: trigger-file and sudo-updater paths return `true`; root and
  sudo-npm return `false`.

### Unit — `src/commands/setup.test.ts`
- `buildUpdaterPathUnit()` emits the expected `[Path]`/`[Install]` content with
  `PathExists=` (not `PathModified=`) and the correct `Unit=`.
- `buildUpdaterUnit()` `ExecStart` now points at the wrapper script path.
- `handleInstall` **removes any stale trigger** before enabling, writes the
  `.path` unit, and enables it (`enable --now`) — assert ordering (rm precedes
  enable).

### Wrapper script
- Shell/bats test for validation: accept `1.21.0 stable` and `latest beta`;
  reject `; rm -rf /`, bad semver (`1.2`), unknown channel (`prod`), empty file.
- **Delete-before-install:** assert the wrapper removes the trigger file before
  invoking npm, and that a validation failure still leaves the trigger removed
  (no re-fire) — this is the invariant that prevents the install loop.

### Manual prod validation
- Re-provision one failing host (zn-admin-1), trigger an update, confirm the
  `.path` fires (`journalctl -u zn-vault-agent-updater`) and the agent reaches the
  target version and returns healthy.

## Scope boundaries (YAGNI)

- No polkit, D-Bus, or socket activation.
- The strict hardening profile is **not** modified.
- The sudoers rule is **not** removed in this change (kept for fallback; separate
  cleanup later).
- The CLI empty-body bug in `znvault-cli` (`triggerAgentUpdate` posts
  `application/json` with no body → agent 400) is a **separate** fix, tracked
  independently; not part of this spec.
