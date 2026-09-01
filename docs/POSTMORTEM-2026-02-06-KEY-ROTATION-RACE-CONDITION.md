# Post-Mortem: Plugin Key Rotation Race Condition

**Date:** 2026-02-06
**Severity:** High
**Affected Versions:** v1.20.12, v1.20.13
**Fixed Version:** v1.20.14
**Author:** Diego Vidal + Claude Opus 4.5

---

## Executive Summary

A race condition in the agent's key rotation handler caused plugins to write stale API keys to files after rotation. This resulted in deployment failures due to authentication errors when applications tried to use the outdated keys.

---

## Timeline

| Time (UTC) | Event |
|------------|-------|
| 2026-02-05 13:10:37 | Scheduled key rotation triggered for `zincapi-staging` |
| 2026-02-05 13:10:40 | Agents logged "API key written and verified" (6 times due to duplicate events) |
| 2026-02-05 13:10:40 | **BUG:** File written with OLD key despite "verified" log message |
| 2026-02-06 11:14:39 | Deployment attempted on payara-staging-1 |
| 2026-02-06 11:15:37 | Deployment failed: `AuthenticationException: Valid authentication required` |
| 2026-02-06 11:17:11 | Second deployment attempt failed with same error |
| 2026-02-06 ~11:30 | Investigation began |
| 2026-02-06 11:56:44 | Fix committed and pushed (v1.20.14) |
| 2026-02-06 11:57:23 | Plugin updated (v1.16.1) |
| 2026-02-06 ~11:58 | npm packages published |
| 2026-02-06 ~12:00 | All 3 agents updated and restarted |
| 2026-02-06 12:02:05 | Manual rotation test confirmed fix working |

---

## Symptoms

1. **Deployment failures** with error:
   ```
   AuthenticationException: Valid authentication required (JWT token or API key)
   ```

2. **API key file mismatch:**
   ```
   File:   znv_004ca4f194c5...  (OLD key)
   Config: znv_c4bce72d2c69...  (NEW key after rotation)
   ```

3. **Misleading logs:** Agent logged "API key written and verified" but file contained wrong key

4. **Affected servers:** 2 of 3 agents (172.16.220.55 and .57) had stale files; .56 was correct (timing luck)

---

## Root Cause Analysis

### The Bug Location

**File:** `src/lib/websocket.ts` → `handleApiKeyRotationEvent()`

### What Should Happen

1. Agent receives `apikey.rotated` WebSocket event
2. Agent binds to get new key value
3. Agent updates config with new key
4. Agent dispatches `keyRotated` event to plugins
5. Plugin reads `ctx.config.auth.apiKey` and writes to file

### What Actually Happened

The `updateManagedKey()` function was supposed to update the config before plugins ran:

```typescript
// CRITICAL: Update config with new key BEFORE dispatching to plugins
updateManagedKey(newKey, { ... });  // ← This was the "fix" in v1.20.13

// Then dispatch to plugins
await pluginLoader.dispatchEvent('keyRotated', keyEvent);
```

**But `updateManagedKey()` did this:**

```typescript
export function updateManagedKey(newKey: string, metadata: {...}): void {
  const config = loadConfig();  // ← Loads NEW object from disk!
  config.auth.apiKey = newKey;  // ← Updates the NEW object
  saveConfig(config);           // ← Saves to disk
  // ...
}
```

The problem: `loadConfig()` creates a **NEW config object** from disk. It does NOT mutate `agentInternals.config` (the in-memory object that plugins read via `ctx.config`).

### The Race Condition

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        BEFORE FIX (v1.20.13)                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  startDaemon():                                                         │
│    config = loadConfig()  ──────────────────┐                          │
│    agentInternals = { config, ... }         │                          │
│                                              │                          │
│  handleApiKeyRotationEvent():                │                          │
│    newKey = await bindManagedApiKey()        │                          │
│                                              │                          │
│    updateManagedKey(newKey):                 │                          │
│      freshConfig = loadConfig() ◄───── NEW OBJECT (not same as above)  │
│      freshConfig.auth.apiKey = newKey        │                          │
│      saveConfig(freshConfig)  ───────► disk  │                          │
│                                              │                          │
│    pluginLoader.dispatchEvent('keyRotated')  │                          │
│      ↓                                       │                          │
│    plugin.onKeyRotated(ctx):                 │                          │
│      ctx.config.auth.apiKey ◄────────────────┘ STILL OLD VALUE!        │
│      writeApiKeyToFile(ctx.config.auth.apiKey)                         │
│      // Writes OLD key to file!                                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## The Fix

**Commit:** `a91d74d` (v1.20.14)

Added direct mutation of the live `config` object BEFORE calling `updateManagedKey()`:

```typescript
// CRITICAL: Mutate the LIVE config object directly so plugins see the new key
// updateManagedKey() only updates the config FILE (via loadConfig() + saveConfig()),
// but does NOT mutate agentInternals.config which plugins read via ctx.config.
// Without this line, plugins would read the OLD key and write stale values to files.
config.auth.apiKey = newKey;
if (config.managedKey) {
  config.managedKey.nextRotationAt = bindResponse.nextRotationAt;
  config.managedKey.graceExpiresAt = bindResponse.graceExpiresAt;
  config.managedKey.rotationMode = bindResponse.rotationMode;
  config.managedKey.lastBind = new Date().toISOString();
}

// Also persist to disk and update environment variable
updateManagedKey(newKey, {
  nextRotationAt: bindResponse.nextRotationAt,
  graceExpiresAt: bindResponse.graceExpiresAt,
  rotationMode: bindResponse.rotationMode,
});
```

### After Fix

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        AFTER FIX (v1.20.14)                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  handleApiKeyRotationEvent():                                           │
│    newKey = await bindManagedApiKey()                                   │
│                                                                         │
│    config.auth.apiKey = newKey  ◄──── MUTATE LIVE OBJECT FIRST         │
│                                                                         │
│    updateManagedKey(newKey)  ───────► disk (also persists)             │
│                                                                         │
│    pluginLoader.dispatchEvent('keyRotated')                            │
│      ↓                                                                  │
│    plugin.onKeyRotated(ctx):                                           │
│      ctx.config.auth.apiKey  ◄──── NOW HAS NEW VALUE!                  │
│      writeApiKeyToFile(ctx.config.auth.apiKey)                         │
│      // Writes NEW key to file ✓                                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Packages Released

| Package | Old Version | New Version | Changes |
|---------|-------------|-------------|---------|
| `@zincapp/zn-vault-agent` | 1.20.13 | 1.20.14 | Fix: mutate live config object |
| `@zincapp/znvault-plugin-payara` | 1.16.0 | 1.16.1 | Peer dep: require agent >=1.20.14 |

---

## Verification

### Before Fix (Rotation Test)
```
Key rotation triggered...
File:   znv_004ca4f194c5...  ← OLD
Config: znv_c4bce72d2c69...  ← NEW
MISMATCH!
```

### After Fix (Rotation Test)
```
Before rotation:
  All servers: znv_c4bce72d2c69...

After rotation:
  All servers: znv_152c5c1bb55f...  (File = Config) ✓
```

---

## Affected Systems

| Server | IP | Status After Fix |
|--------|-----|------------------|
| payara-staging-1 | 172.16.220.55 | ✅ v1.20.14, keys match |
| payara-staging-2 | 172.16.220.56 | ✅ v1.20.14, keys match |
| payara-staging-3 | 172.16.220.57 | ✅ v1.20.14, keys match |

---

## Lessons Learned

### 1. Comments Can Lie
The v1.20.13 code had a comment saying it fixed the issue:
```typescript
// CRITICAL: Update config with new key BEFORE dispatching to plugins
// This ensures plugins see the new key when they read ctx.config.auth.apiKey
```
But the code didn't actually do what the comment claimed.

### 2. Understand Object Identity
JavaScript object references matter. `loadConfig()` returns a NEW object each time - it doesn't mutate the existing one. When passing config to long-lived components like `agentInternals`, mutations must happen on THAT object.

### 3. "Written and Verified" Was Misleading
The log message said the key was "written and verified" - but it was verifying that the WRONG key was written correctly, not that the CORRECT key was written.

### 4. Auto-Fix on Restart Masks Issues
The `syncManagedKeyFile()` function auto-fixes mismatches on restart. This is good for recovery but bad for visibility - problems only surface when you DON'T restart.

---

## Prevention

### Code Review Checklist Addition
- [ ] When updating shared state, verify the EXACT object reference being mutated
- [ ] If a function loads config from disk, it's creating a NEW object
- [ ] Test rotation events without restart to verify real-time behavior

### Future Improvement Ideas
1. Add integration test that verifies key file content AFTER rotation event (not just after restart)
2. Consider making `agentInternals.config` a getter that always returns fresh data
3. Add metrics for "time since last successful key rotation" to detect stale keys

---

## Commands Used for Diagnosis

```bash
# Compare exact values without printing either credential or a fragment
sudo sh -c '[ "$(cat /var/lib/zn-vault-agent/secrets/ZINC_CONFIG_VAULT_API_KEY)" = "$(jq -r .auth.apiKey /etc/zn-vault-agent/config.json)" ]'

# Check rotation logs
sudo grep -E 'rotat|keyFile|mismatch' /var/log/zn-vault-agent/agent.log | tail -50

# Trigger manual rotation for testing
znvault api-key managed rotate zincapi-staging

# Check all agents at once
for ip in 55 56 57; do
  echo "=== 172.16.220.$ip ==="
  ssh sysadmin@172.16.220.$ip "zn-vault-agent --version"
done
```

---

## References

- Fix commit: https://github.com/vidaldiego/zn-vault-agent/commit/a91d74d
- Agent release: https://github.com/vidaldiego/zn-vault-agent/releases/tag/v1.20.14
- Plugin release: https://github.com/vidaldiego/znvault-plugin-payara/releases/tag/v1.16.1
