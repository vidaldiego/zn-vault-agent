# ZnVault Agent Operations Runbook

Operational reference for fleets running Path A (Host Templates +
Config-from-Vault). Companion to
[CONFIGURATION_GUIDE.md](CONFIGURATION_GUIDE.md) (setup) and
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) (known failures).

This file covers the day-2 questions: how to verify a fleet is healthy
across N nodes, what state survives a reboot vs not, how to recover from
the drift modes that *aren't* caught by `systemctl is-active`, and how
to inspect server-side configuration from the `znvault` CLI.

## Table of Contents

- [Fleet Health Check](#fleet-health-check)
- [Persistent vs Ephemeral State](#persistent-vs-ephemeral-state)
- [Recovering from `lastSync` Drift](#recovering-from-lastsync-drift)
- [Runtime `config.json` Schema](#runtime-configjson-schema)
- [Server-side Inspection (`znvault host`)](#server-side-inspection-znvault-host)
- [Common Gotchas](#common-gotchas)

---

## Fleet Health Check

`systemctl is-active zn-vault-agent` is not enough. The daemon can be
"running" while its persistence is broken, its tmpfs output files are
missing, or its WebSocket subscription is empty. Use this checklist
when you want to know a multi-node fleet is actually delivering
secrets.

### Per-node, from outside

```bash
ssh sysadmin@<node> '
  echo "--- 1. service alive ---"
  sudo systemctl is-active zn-vault-agent

  echo "--- 2. websocket subscription (NOT empty) ---"
  sudo journalctl -u zn-vault-agent --since "24h ago" --no-pager \
    | grep "Subscriptions updated" | tail -1

  echo "--- 3. secret target state ---"
  sudo cat /var/lib/zn-vault-agent/.config/zn-vault-agent-nodejs/config.json \
    | jq ".secretTargets[] | {name, lastSync, lastVersion, output}"

  echo "--- 4. output file fresh ---"
  for f in /run/zn-vault-agent/secrets/*; do
    sudo stat "$f" 2>&1 | grep -E "File:|Modify:"
  done

  echo "--- 5. recent deploys ---"
  sudo journalctl -u zn-vault-agent --since "24h ago" --no-pager \
    | grep "Secret deployed successfully" | wc -l
'
```

### What "healthy" looks like

| Check | Healthy signal |
|---|---|
| 1 | `active` |
| 2 | A line ending with `"secrets":[...non-empty...]` and `"managedKeys":[...]`. An empty `secrets:[]` means the WebSocket reconnected after a managed-key rotation and the subscription wasn't rebuilt — fixed in v1.20.12+. |
| 3 | `lastSync` is a recent ISO timestamp; `lastVersion` is a non-null integer. **`null` or missing here is the lastSync-bug symptom** — see [Recovering from `lastSync` Drift](#recovering-from-lastsync-drift). |
| 4 | `Modify` time is recent (within `pollInterval` for poll-driven secrets, within minutes of last upstream rotation event for push-driven). |
| 5 | A count > 0 on a normally-running agent. Exact number depends on `pollInterval` and rotation frequency, but it should be roughly similar across sibling nodes in the same host template. |

### Cross-node fleet drift

Compare the same secret across N nodes:

```bash
for ip in <node1> <node2> ...; do
  echo "=== $ip ==="
  ssh sysadmin@$ip '
    sudo cat /var/lib/zn-vault-agent/.config/zn-vault-agent-nodejs/config.json \
      | jq -c ".secretTargets[] | {name, lastSync, lastVersion}"
  '
done
```

All nodes should report the same `lastVersion` for each named secret.
The `lastSync` timestamps will differ (each node deploys
independently) but should fall within `pollInterval` of each other for
poll-driven secrets, or within seconds of each other after a
push-driven rotation event.

If you see one node with `null`/missing `lastSync` and others with
real timestamps, you've hit the persistence bug. The output files
on disk may still be correct — but the state-on-disk is wrong, and
the next reboot will deploy nothing.

---

## Persistent vs Ephemeral State

Knowing which files survive what is the biggest source of confusion
in this agent. Pin this:

| File / dir | Survives `systemctl restart`? | Survives reboot? |
|---|---|---|
| `/etc/zn-vault-agent/agent.env` | ✅ | ✅ |
| `/var/lib/zn-vault-agent/.config/zn-vault-agent-nodejs/config.json` | ✅ | ✅ |
| `/var/lib/zn-vault-agent/dynamic-secrets.{key,pub}` | ✅ | ✅ |
| `/run/zn-vault-agent/secrets/<name>` (default `outputPath`) | ✅ | ❌ tmpfs |
| Agent's in-memory subscription state | ❌ rebuilt on start | ❌ |
| Agent's in-memory `lastSync` cache | ❌ reloaded from disk | ❌ |

The bug: `config.json.secretTargets[*].lastVersion` survives reboot,
but the deployed file in `/run/` does not. On boot the agent reads
its persisted `lastVersion`, asks vault "is your version newer", gets
"no" (same version), decides "nothing to do" — and the consumer
service starts up with no file.

If your consumer's `outputPath` is **not** on tmpfs (e.g., you set
`/var/lib/<consumer>/secret.key`), you avoid this entirely — the file
also survives reboot, in sync with the persisted lastVersion.

**For tmpfs output paths, install the reset-state oneshot** (see
[Recovering from `lastSync` Drift](#recovering-from-lastsync-drift)
below) or wait for the upstream fix tracked at
[vidaldiego/zn-vault-agent#1](https://github.com/vidaldiego/zn-vault-agent/issues/1).

---

## Recovering from `lastSync` Drift

### Symptom

- Secret file under `/run/` is missing or has stale mtime.
- `config.json.secretTargets[*].lastSync` is `null`, missing, or
  much older than the rest of the fleet.
- Consumer service errors with "file not found" or starts with stale
  cached value.

### One-shot recovery (no workaround installed)

```bash
sudo systemctl stop zn-vault-agent
sudo python3 -c "
import json
p='/var/lib/zn-vault-agent/.config/zn-vault-agent-nodejs/config.json'
c=json.load(open(p))
for t in c.get('secretTargets',[]):
  t.pop('lastVersion', None)
  t.pop('lastSync', None)
json.dump(c, open(p,'w'), indent='\t')
"
sudo chown zn-vault-agent:zn-vault-agent /var/lib/zn-vault-agent/.config/zn-vault-agent-nodejs/config.json
sudo systemctl start zn-vault-agent

# Verify: lastSync should be a fresh timestamp within seconds.
sudo cat /var/lib/zn-vault-agent/.config/zn-vault-agent-nodejs/config.json \
  | jq '.secretTargets[] | {name, lastSync, lastVersion}'
```

### Permanent workaround: reset-state oneshot

Install a systemd oneshot that clears `lastSync` before the agent
starts. Cost is one extra vault round-trip per secret target on every
agent start; gain is a guaranteed fresh deploy on every reboot.

Three files needed (paths shown for a Debian/Ubuntu system; tailor
for your platform):

```
/etc/systemd/system/zn-vault-agent-reset-state.service
/etc/systemd/system/zn-vault-agent.service.d/reset-state.conf
/usr/local/sbin/zn-vault-agent-reset-state
```

The drop-in adds `Wants=` (not `Requires=`) so a missing or failed
reset doesn't block the agent — the agent's next `pollInterval` would
still eventually deploy the file, just slower.

After installation:

```bash
sudo systemctl daemon-reload
sudo systemctl enable zn-vault-agent-reset-state.service
# Either reboot, or run once now:
sudo systemctl restart zn-vault-agent  # restart triggers reset oneshot via Before= ordering
```

Verify the chain fired:

```bash
sudo journalctl -u zn-vault-agent-reset-state --no-pager | tail -3
# Expect: "reset state on N secret target(s)" then "Deactivated successfully"
```

### Important: use `restart`, not `stop` then `start`

`systemctl stop zn-vault-agent` followed by `start` may be **canceled
by systemd** because the reset oneshot's `Before=zn-vault-agent.service`
ordering can interact with the stop request. Use `systemctl restart`
when the workaround is installed — it triggers the reset oneshot in
the correct order.

`systemctl restart` also **rotates the `agentId`** in `config.json` on
each restart. `agentId` is per-process, not per-host. The stable
identity for vault-side tracking is `hostConfigId`.

---

## Runtime `config.json` Schema

After registration + first run, `config.json` contains both
admin-imported and agent/server-managed fields. Operators reading
this file in the field need to know which is which.

```jsonc
{
  // ── Server-issued at registration, stable per agent process ──
  "agentId":      "agent_<hex>",     // rotates on systemctl restart
  "tenantId":     "<tenant>",
  "hostConfigId": "hcfg_<hex>",      // stable per host template; same value on all sibling agents
  "vaultUrl":     "https://vault.example.com",

  // ── Admin-set on the host template (Path A) ──
  "configFromVault": true,
  "pollInterval":    3600,           // seconds
  "targets":         [...],          // certificate targets
  "secretTargets": [
    {
      // Admin-set
      "name":       "backup-master-key",
      "secretId":   "alias:archon/backups/master-key",
      "refreshOn":  [],               // referenced secrets that re-render this target
      "output":     "/run/zn-vault-agent/secrets/backup-master-key",
      "format":     "raw",           // or "env", "json"
      "mode":       "0440",
      "owner":      "archon:archon",
      "reloadCmd":  null,
      // Agent-managed (this is the persistence bug surface)
      "lastSync":    "2026-05-21T10:06:25.846Z",  // ISO timestamp of last successful deploy
      "lastVersion": 1                            // server's reported version at last deploy
    }
  ],

  // ── Managed API key auth ──
  "auth": {
    "apiKey": "<redacted>"           // current key; rotates on managed-key rotation
  },
  "managedKey": {
    "name":           "<key-name>",
    "lastBind":       "<iso>",
    "nextRotationAt": "<iso>",
    "graceExpiresAt": "<iso>"
  },

  // ── Misc ──
  "insecure": false,
  "verbose":  false,
  "configVersion": <integer>         // bumped when admin pushes a host-template update
}
```

Fields that drift between sibling agents legitimately:
`agentId` (per-process), `auth.apiKey` (per-agent), `managedKey.lastBind`
(per-binding timestamp), `secretTargets[*].lastSync` (per-deploy
timestamp).

Fields that **should be identical** on sibling agents in the same
host template: `hostConfigId`, `pollInterval`, `targets`,
`secretTargets[*]` schema (name/secretId/output/format/mode/owner),
`configVersion`, `managedKey.name`.

If you see drift in the "should-be-identical" set, run `znvault host
outdated-agents <hostname>` to see who's lagging.

---

## Server-side Inspection (`znvault host`)

These commands let you verify the source-of-truth template and which
agents are in sync. Run from any workstation with `znvault` installed
and authenticated.

```bash
# List all host templates
znvault host list

# Detailed view of one template (including its bound managed key)
znvault host get <hostname>

# Show the template's JSON contents (what gets pushed to agents)
znvault host config <hostname> --json

# Statistics: agents registered, last-seen distribution, etc.
znvault host stats

# CRITICAL for fleet-drift triage: which agents are NOT on the
# current configVersion?
znvault host outdated-agents <hostname>

# Force a push to all connected agents (Wants= sync, no stop-the-world)
znvault host sync <hostname>

# After provisioning a new server, link its agent to an existing template:
znvault host link-agent <hostname> --agent-id agent_<hex>

# Inverse: detach an agent without deleting either side
znvault host unlink-agent <hostname> --agent-id agent_<hex>
```

Typical fleet-drift triage flow:

1. `znvault host outdated-agents <hostname>` — server reports
   `configVersion` skew, if any.
2. If outdated agents present: `znvault host sync <hostname>` to
   push the current template.
3. If still skewed after sync: ssh to the laggard, check
   `journalctl -u zn-vault-agent --since '1h ago'`, look for failed
   `Config update` events.

---

## Common Gotchas

### `zn-vault-agent status` CLI fails under `sudo`

```
Error: EACCES: permission denied, mkdir '/home/zn-vault-agent/.config/zn-vault-agent-nodejs'
```

Cause: `sudo -u zn-vault-agent ...` resets `HOME` to `/home/zn-vault-agent`,
which the agent user doesn't have. The systemd unit overrides this via
`Environment=HOME=/var/lib/zn-vault-agent`, but that override only
applies to the daemon — not to ad-hoc CLI invocations.

Workaround:

```bash
sudo -H -u zn-vault-agent HOME=/var/lib/zn-vault-agent zn-vault-agent status
```

Or just read the config file directly:

```bash
sudo cat /var/lib/zn-vault-agent/.config/zn-vault-agent-nodejs/config.json | jq .
```

### Sub-second outage on `systemctl restart` is normal

When the agent restarts, the file under `/run/` is briefly missing
during the atomic-rename window (write to tmp, rename). Consumers
that cache the secret value in-memory at process start (the
recommended pattern) won't notice. Consumers that re-read on every
operation may see a momentary ENOENT.

If your consumer is sensitive to this, either:
- Use `outputPath` outside tmpfs so the file is replaced
  atomically while always present, or
- Have the consumer retry with exponential backoff on ENOENT.

### File perms are tighter than they look

Files in `/run/zn-vault-agent/secrets/` default to mode `0440` owned
by `zn-vault-agent:<group>`. **Root cannot read them via DAC** because
mode `0440` grants no "other" bits, and root reading a file owned by
non-root is gated by capability `CAP_DAC_READ_SEARCH` which most
shells don't have set even under `sudo`.

Practical effect: `sudo cat /run/zn-vault-agent/secrets/<name>`
sometimes returns empty. Use `sudo -u <consumer-user> cat ...` to
verify the consumer can read the file, or check with
`sudo -u <consumer-user> test -r ...`.

### `Restart=always` masks crash-loops

The systemd unit ships with `Restart=always`. If the agent is
crash-looping on, say, an unauthorized API key, systemd will happily
restart it every 5 seconds forever. The systemctl status will show
`active (running)` for the brief windows between crashes.

Symptoms to watch for: a recent restart count in `journalctl -u
zn-vault-agent | grep -c "^.*Started"` that's much higher than the
node's uptime / `StartLimitInterval`.

The unit also ships `StartLimitInterval=60` + `StartLimitBurst=5`,
which means if it crashes 5 times in 60 seconds, systemd will give
up and stop restarting. If you see the unit `failed` rather than
`active`, that's the burst limit firing — investigate before
`systemctl reset-failed` + restart.

---

## Related Documents

- [CONFIGURATION_GUIDE.md](CONFIGURATION_GUIDE.md) — initial setup, the
  three paths (Host Templates / Local Config / Exec)
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — known bugs and recovery
  procedures
- [GUIDE.md](GUIDE.md) — comprehensive reference
- [vidaldiego/zn-vault-agent#1](https://github.com/vidaldiego/zn-vault-agent/issues/1)
  — tracking issue for the lastSync persistence bug
