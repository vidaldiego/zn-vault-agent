# ZnVault Agent Troubleshooting Guide

This guide covers common issues and their solutions.

> For day-2 operations (fleet health checks, `lastSync` drift, reboot
> behavior, server-side inspection via `znvault host`), see
> [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md). The runbook covers
> failure modes that aren't caught by `systemctl is-active`.

---

## Table of Contents

- [Authentication Errors](#authentication-errors)
  - [Stale API Key File After Key Rotation](#stale-api-key-file-after-key-rotation)
  - [401 Authentication Failed](#401-authentication-failed)
  - [Managed Key Not Bound](#managed-key-not-bound)
- [Plugin Issues](#plugin-issues)
  - [Plugin onKeyRotated Not Called](#plugin-onkeyrotated-not-called)
  - [Plugin Start Timeout](#plugin-start-timeout)
- [WebSocket Connection](#websocket-connection)
  - [Connection Drops Frequently](#connection-drops-frequently)
  - [Not Receiving Events](#not-receiving-events)
- [Diagnostic Commands](#diagnostic-commands)

---

## Authentication Errors

### Stale API Key File After Key Rotation

**Symptoms:**
- Application fails with "Valid authentication required (JWT token or API key)"
- API key file contains the old key (compare exact protected values without printing them)
- Agent config has different (newer) key than the file
- Issue occurs after multiple key rotations

**Root Causes (Fixed in v1.20.12 and v1.20.13):**

**v1.20.12 Fix:** The agent had a bug where managed API key rotation events were not dispatched to plugins in daemon mode. The rotation handler only checked `execManagedKeyNames` which was only populated in exec mode.

**v1.20.13 Fix:** Even after v1.20.12, a race condition existed where the plugin could read the old key value before the config was updated. The issue was:

```
Timeline of the race condition (v1.20.12):
1. Key rotation event received via WebSocket
2. Dispatcher calls notifyManagedKeyRotationEvent() with 'void' (fire-and-forget)
3. IMMEDIATELY, handleApiKeyRotationEvent() is called (doesn't wait for step 2)
4. Handler fetches new key via bindManagedApiKey()
5. Handler dispatches event to plugin
6. Plugin reads ctx.config.auth.apiKey - BUT config hasn't been updated yet!
7. Plugin writes the OLD key to the file
8. notifyManagedKeyRotationEvent() eventually finishes and updates config (too late)
```

The v1.20.13 fix ensures the config is updated synchronously BEFORE dispatching to plugins.

**Solution:**

1. **Upgrade to v1.20.13 or later:**
   ```bash
   sudo npm install -g @zincapp/zn-vault-agent@latest
   sudo systemctl restart zn-vault-agent
   ```

2. **Verify the fix is working:**
   ```bash
   # Check agent version
   zn-vault-agent --version

   # Check logs for managed key tracking
   sudo journalctl -u zn-vault-agent -o cat --no-pager | grep "Managed API keys tracked"
   # Should show: {"totalManagedKeys":1,"fromAgent":1,...}

   # Check WebSocket subscription includes your key
   sudo journalctl -u zn-vault-agent -o cat --no-pager | grep "managedKeys" | tail -1
   # Should show: "managedKeys":["your-key-name"]
   ```

3. **Immediate workaround (if upgrade not possible):**
   ```bash
   # Restart the agent - it auto-fixes the API key file on startup
   sudo systemctl restart zn-vault-agent
   ```

**Prevention:**

The fix in v1.20.12 ensures all managed keys are tracked:
- Agent's own managed key (`config.managedKey.name`)
- Plugin secrets with `api-key:` prefix
- Exec mode managed keys

---

### 401 Authentication Failed

**Symptoms:**
- Agent health shows `secrets.errors > 0`
- Logs show "401 Authentication failed" or "Invalid API key"

**Possible Causes:**

1. **Managed key grace period expired while agent was offline:**
   ```bash
   # Check when key was last bound
   cat /etc/zn-vault-agent/config.json | jq '.managedKey'

   # If graceExpiresAt is in the past and agent was offline, key is invalid
   ```

   **Fix:** Re-bootstrap the agent:
   ```bash
   # Get a new bootstrap token from vault admin
   zn-vault-agent login --url https://vault.example.com \
     --bootstrap-token zrt_new_token_here...
   sudo systemctl restart zn-vault-agent
   ```

2. **API key revoked or deleted:**
   ```bash
   # Check if key exists in vault (requires admin access)
   znvault api-key get your-key-name
   ```

3. **Network/TLS issues:**
   ```bash
   # Test connectivity
   curl -sk https://vault.example.com/v1/health
   ```

---

### Managed Key Not Bound

**Symptoms:**
- Agent fails to start with "Managed API key not yet bound"
- Config shows `managedKey.name` but no `auth.apiKey`

**Cause:** The agent was configured with a managed key but never completed the initial bind.

**Solution:**
```bash
# Re-run the bootstrap process
zn-vault-agent login --url https://vault.example.com \
  --bootstrap-token zrt_...
```

---

## Plugin Issues

### Plugin onKeyRotated Not Called

**Symptoms:**
- Key rotations happen but plugin doesn't react
- API key files managed by plugin are stale
- Logs show "Received rotation event for untracked managed key"

**Root Cause:** This was a bug fixed in v1.20.12. See [Stale API Key File After Key Rotation](#stale-api-key-file-after-key-rotation).

**Verification:**
```bash
# After upgrading to v1.20.12+, check logs for plugin event dispatch
sudo journalctl -u zn-vault-agent -o cat --no-pager | grep "keyRotated event dispatch completed"

# You should see:
# "Plugin keyRotated event dispatch completed" with handlersInvoked > 0
```

---

### Plugin Start Timeout

**Symptoms:**
- Log shows "Plugin 'name' onStart timed out after 120000ms"
- Plugin shows status "error" in health endpoint

**Cause:** Plugin's `onStart` hook took longer than 120 seconds. Startup has a larger budget than
other plugin hooks because Payara WAR deployment normally takes 50-90 seconds.

**Solutions:**

1. **Check the plugin's own operation/deploy timeouts (if using Payara):**
   ```json
   {
     "plugins": [{
       "package": "@zincapp/znvault-plugin-payara",
       "config": {
         "operationTimeout": 120000,
         "deployTimeout": 180000
       }
     }]
   }
   ```

   These settings govern Payara operations inside the plugin; the agent's `onStart` lifecycle
   budget is 120 seconds and is not changed by them.

2. **Check the underlying service:**
   ```bash
   # For Payara plugin
   /opt/payara/bin/asadmin list-domains
   /opt/payara/bin/asadmin list-applications
   ```

---

### Payara Mutation Lock Blocks Certificate or Secret Sync

Certificate writes, secret-target writes, reload commands, and Payara plugin
lifecycle/deployment operations share this exclusive lock:

```text
/var/lib/zn-vault-agent/znvault-deploy.lock
```

If another process holds the lock, agent and CLI sync fail closed before
fetching or writing target data and before running a reload command. Re-run an
explicit CLI sync after the Payara operation completes; daemon sync also gets
another opportunity during its configured periodic poll.

The agent never removes an existing lock based on age, malformed contents, or
a dead PID. A leftover lock may represent an interrupted or ambiguous Payara
mutation. Do not delete it until all agent, CLI, and plugin mutation entry
points are quiesced and an operator has verified the exact prior owner and
Payara application state. Lock removal is therefore a recovery procedure, not
automatic cleanup.

---

## WebSocket Connection

### Connection Drops Frequently

**Symptoms:**
- Logs show frequent "WebSocket closed" and "Connecting to unified WebSocket"
- Events are missed during reconnection windows

**Possible Causes:**

1. **Network instability:** Check network path to vault server
2. **Load balancer timeout:** Increase idle timeout on LB
3. **Vault server restarts:** Normal during deployments

**Diagnosis:**
```bash
# Check connection frequency
sudo journalctl -u zn-vault-agent -o cat --no-pager | grep "Connecting to unified WebSocket" | wc -l

# Check for specific errors
sudo journalctl -u zn-vault-agent -o cat --no-pager | grep -Ei "websocket.*(error|close)" | tail -20
```

---

### Not Receiving Events

**Symptoms:**
- Certificate/secret changes in vault don't trigger agent actions
- Logs show successful connection but no events

**Diagnosis:**
```bash
# Check what the agent is subscribed to
sudo journalctl -u zn-vault-agent -o cat --no-pager | grep "Subscriptions updated" | tail -1

# Should show your certificates, secrets, and managed keys:
# "subscriptions":{"certificates":[...],"secrets":[...],"managedKeys":[...]}
```

**Common Issues:**

1. **Empty subscriptions:** Agent has no targets configured
2. **Wrong secret IDs:** Check alias matches vault secret path
3. **Missing managed keys:** Upgrade to v1.20.12+ (see above)

---

## Diagnostic Commands

### Shutdown During Certificate or Secret Deployment

Certificate and secret write/reload operations share
`/var/lib/zn-vault-agent/znvault-deploy.lock` with the Payara plugin. The agent
defers `SIGTERM` and `SIGINT` while it owns that lock, releases it only after the
mutation finishes, and then replays the signal. WebSocket work that collides
with the lock is coalesced to the newest target generation; `/health` reports
`status: "unhealthy"` while such work remains pending.

The packaged and generated systemd units use `TimeoutStopSec=900`. Verify an
installed unit after upgrading:

```bash
systemctl show zn-vault-agent -p TimeoutStopUSec
```

Do not delete an existing `znvault-deploy.lock` automatically. Quiesce every
agent, CLI and Payara mutation entry point first, verify that no owner is still
active, and only then follow the explicit operator recovery procedure.

### Legacy Payara Plugin Enters Bounded Recovery

ZnVault Agent 2.0.0 requires `@zincapp/znvault-plugin-payara` 3.0.0 or newer
for normal operation. An exact globally installed 2.x manifest enters an
`UPDATE_REQUIRED` recovery daemon instead of importing or starting the legacy
plugin. Recovery exposes only the public monitoring routes and the
authenticated exact updater routes (`POST /plugins/update` and
`GET /plugins/update/:requestId`); Agent update, scheduler, plugin mutation,
Vault bootstrap/config fetch, child processes, and deployment work remain off.

The manifest-only probe also covers `configFromVault: true` hosts whose local
bootstrap config has no plugin declaration, but it is only a fallback
candidate. When authentication is available, the Agent still fetches the
authoritative Vault config first: a `200` replaces the local cache and a `304`
validates it. Recovery is selected only when the Agent cannot authenticate,
bootstrap, or fetch that authority. This keeps the safe 2 -> 3 rail reachable
during a Vault outage without allowing stale local plugin state to override a
healthy Vault. An undeclared missing, corrupt, 3.x, or future manifest cannot
authorize fallback. Once local or fetched configuration is authoritative, a
configured missing, corrupt, unversioned, or future manifest remains a fatal
`PLUGIN_INCOMPATIBLE_VERSION` error.

After the root helper installs the exact requested Payara 3 artifact, the
operation is still non-terminal until the new plugin starts. The next boot
forces a complete Vault `200`; `304` is insufficient because the persisted
bootstrap config may never have contained the remote plugin declaration. If
Vault is still unavailable, only the exact active 2 -> 3 operation, matching
successful root receipt, restart marker, absence of a local terminal, and exact
installed target manifest enter `STARTUP_CONFIRMATION_PENDING`. This daemon
keeps the authenticated operation GET at `202` and retries a full authority
probe every 30 seconds, re-reading persisted credentials or bootstrap state. It
does not restart on failed probes, so the systemd start burst is not consumed.
After one full `200`, it requests one graceful restart; the normal remote config
must load and start Payara 3 before GET becomes terminal `200` and active intent
is cleared. Never treat package installation or a root receipt alone as startup
confirmation.

Inspect package metadata without changing the running host:

```bash
npm list -g @zincapp/znvault-plugin-payara --depth=0
```

Use the authenticated exact updater and poll its durable receipt. Do not run a
second global npm mutation beside the root-owned updater, manually restart on a
mere `202`, or delete its intent/receipt files. The Agent itself may request the
two bounded pre-terminal restarts: first after exact root installation evidence,
and then, only if the first boot entered `STARTUP_CONFIRMATION_PENDING`, after a
full authoritative Vault `200` returns. Failed authority probes do not restart.
The operator keeps polling: only successful Payara 3 startup makes GET terminal
`200`. Do not bypass the gate with a local `path`: a local plugin exporting
`name: "payara"` is subject to the same compatibility inspection.

### Control-Plane Requests Return 401

Only `/health`, `/ready`, `/live`, and `/metrics` are public. Agent
version/update, scheduler, unknown, and all plugin routes require the private
local Bearer credential; Payara checks the same credential a second time in its
plugin namespace.

Verify metadata without printing the token:

```bash
sudo stat -c '%U:%G %a %F %h %n' \
  /etc/zn-vault-agent/payara-mutation-token
# Expected: zn-vault-agent owner/group, mode 600, regular file, one link
```

If the file is missing, linked, permissive, or malformed, rerun the normal
`sudo zn-vault-agent setup --yes` preflight; setup preserves an existing valid
credential and refuses unsafe state. Never paste the value into curl argv,
environment variables, logs, shell history, or a temporary header file.
Supported plugin CLI commands read it directly. The optional
`ZNVAULT_CONTROL_TOKEN_FILE` value is a file path for isolated tests/installers,
not the token itself.

### Quick Health Check
```bash
# Agent service status
sudo systemctl status zn-vault-agent

# Agent health endpoint (if enabled)
curl -s http://localhost:9100/health | jq .

# Recent logs
sudo journalctl -u zn-vault-agent -n 100 -o cat --no-pager | jq -r '.msg' | tail -20
```

### Configuration Check
```bash
# View current config (redacts sensitive values)
cat /etc/zn-vault-agent/config.json | jq '{
  vaultUrl,
  tenantId,
  configFromVault,
  managedKey: .managedKey | {name, nextRotationAt, graceExpiresAt},
  plugins: [.plugins[]? | {name: .name, package: .package}],
  targets: .targets | length,
  secretTargets: .secretTargets | length
}'
```

### API Key File Check
```bash
# The Agent writer and Payara reader must share Payara's primary group.
payara_group="$(id -gn payara)"
stat -c '%U:%G %a %n' /var/lib/zn-vault-agent
id -Gn zn-vault-agent
# Expected: owner zn-vault-agent, group "$payara_group", mode 2750, and the
# Agent group list contains "$payara_group".

# Check if API key file exists and is recent
ls -la /var/lib/zn-vault-agent/secrets/

# Compare exact values without printing either credential or a fragment
sudo sh -c '[ "$(cat /var/lib/zn-vault-agent/secrets/ZINC_CONFIG_VAULT_API_KEY)" = "$(jq -r .auth.apiKey /etc/zn-vault-agent/config.json)" ]'
# Exit status 0 means they match.
```

For a configured Payara `apiKeyFilePath`, the plugin enforces the same contract
on every atomic replacement: its directory is setgid `2750`, the file is `0640`,
the Agent owns both, and Payara's primary group owns the group slot. It also
checks every parent-directory traverse permission. A
`PAYARA_API_KEY_PERMISSION_CONTRACT` error is a deliberate fail-closed state:
rerun `sudo zn-vault-agent setup --yes`, restart the Agent so systemd applies
its supplementary group, and repeat the `stat`/`id` checks. Do not weaken the
file to world-readable or make the Payara group writable.

### WebSocket Subscription Check
```bash
# Check current subscriptions
sudo journalctl -u zn-vault-agent -o cat --no-pager | grep "Subscriptions updated" | tail -1 | jq '.subscriptions'

# Check managed key tracking (v1.20.12+)
sudo journalctl -u zn-vault-agent -o cat --no-pager | grep "Managed API keys tracked" | tail -1
```

### Force Resync
```bash
# Restart agent to force reconnection and resync
sudo systemctl restart zn-vault-agent

# Watch logs for sync activity
sudo journalctl -u zn-vault-agent -f -o cat | jq -r '[.time, .module, .msg] | join(" | ")'
```

---

## Getting Help

If you're still experiencing issues:

1. **Collect diagnostics:**
   ```bash
   zn-vault-agent --version
   cat /etc/zn-vault-agent/config.json | jq 'del(.auth.apiKey)'
   sudo journalctl -u zn-vault-agent -n 500 -o cat --no-pager > agent-logs.json
   ```

2. **Check release notes** for your version: https://github.com/zincware/zn-vault-agent/releases

3. **Report issues** at: https://github.com/zincware/zn-vault-agent/issues
