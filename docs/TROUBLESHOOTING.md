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
- API key file contains old key (check with `head -c 20 /path/to/api-key-file`)
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
   sudo grep "Managed API keys tracked" /var/log/zn-vault-agent/agent.log
   # Should show: {"totalManagedKeys":1,"fromAgent":1,...}

   # Check WebSocket subscription includes your key
   sudo grep "managedKeys" /var/log/zn-vault-agent/agent.log | tail -1
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
sudo grep "keyRotated event dispatch completed" /var/log/zn-vault-agent/agent.log

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
sudo grep "Connecting to unified WebSocket" /var/log/zn-vault-agent/agent.log | wc -l

# Check for specific errors
sudo grep -i "websocket.*error\|websocket.*close" /var/log/zn-vault-agent/agent.log | tail -20
```

---

### Not Receiving Events

**Symptoms:**
- Certificate/secret changes in vault don't trigger agent actions
- Logs show successful connection but no events

**Diagnosis:**
```bash
# Check what the agent is subscribed to
sudo grep "Subscriptions updated" /var/log/zn-vault-agent/agent.log | tail -1

# Should show your certificates, secrets, and managed keys:
# "subscriptions":{"certificates":[...],"secrets":[...],"managedKeys":[...]}
```

**Common Issues:**

1. **Empty subscriptions:** Agent has no targets configured
2. **Wrong secret IDs:** Check alias matches vault secret path
3. **Missing managed keys:** Upgrade to v1.20.12+ (see above)

---

## Diagnostic Commands

### Quick Health Check
```bash
# Agent service status
sudo systemctl status zn-vault-agent

# Agent health endpoint (if enabled)
curl -s http://localhost:9100/health | jq .

# Recent logs
sudo tail -100 /var/log/zn-vault-agent/agent.log | jq -r '.msg' | tail -20
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
# Check if API key file exists and is recent
ls -la /var/lib/zn-vault-agent/secrets/

# Compare file key prefix with config key prefix
echo "File:   $(head -c 12 /var/lib/zn-vault-agent/secrets/ZINC_CONFIG_VAULT_API_KEY 2>/dev/null)..."
echo "Config: $(cat /etc/zn-vault-agent/config.json | jq -r '.auth.apiKey[:12]')..."
# These should match!
```

### WebSocket Subscription Check
```bash
# Check current subscriptions
sudo grep "Subscriptions updated" /var/log/zn-vault-agent/agent.log | tail -1 | jq '.subscriptions'

# Check managed key tracking (v1.20.12+)
sudo grep "Managed API keys tracked" /var/log/zn-vault-agent/agent.log | tail -1
```

### Force Resync
```bash
# Restart agent to force reconnection and resync
sudo systemctl restart zn-vault-agent

# Watch logs for sync activity
sudo tail -f /var/log/zn-vault-agent/agent.log | jq -r '[.time, .module, .msg] | join(" | ")'
```

---

## Getting Help

If you're still experiencing issues:

1. **Collect diagnostics:**
   ```bash
   zn-vault-agent --version
   cat /etc/zn-vault-agent/config.json | jq 'del(.auth.apiKey)'
   sudo tail -500 /var/log/zn-vault-agent/agent.log > agent-logs.json
   ```

2. **Check release notes** for your version: https://github.com/zincware/zn-vault-agent/releases

3. **Report issues** at: https://github.com/zincware/zn-vault-agent/issues
