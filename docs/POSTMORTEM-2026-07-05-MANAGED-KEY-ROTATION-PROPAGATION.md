# Postmortem: Managed Key Rotation Not Propagated to Deployed Key Files

- **Date of incident:** 2026-07-05
- **Affected component:** `@zincapp/zn-vault-agent` v1.22.5 (payara-staging fleet, 172.16.220.55–.58)
- **Fixed in:** agent v1.23.0 (no server-side changes required)
- **Severity:** staging outage — ZincAPI KMS calls 401, readiness 503, rolling deploy aborted

## Summary

The managed API key `zincapi-staging` (scheduled rotation, 24h interval, 4h
grace) rotated at 11:57. The agents deploying that key's value to
`/var/lib/zn-vault-agent/secrets/ZINC_CONFIG_VAULT_API_KEY` (consumed by
Payara/ZincAPI via `ZINC_CONFIG_VAULT_API_KEY_FILE`) kept the OLD value on
disk for the entire grace period while logging hourly
`Secret sync complete ... success: 3, errors: 0`. When grace expired (~15:57),
the running JVMs started failing KMS calls with 401 and a rolling deploy at
16:01 aborted. Restarting an agent at 16:05 re-rendered the file with the new
key immediately.

## Root cause

Two cooperating defects, both in the agent (server behaved as designed):

### 1. Single point of failure: the file's only runtime refresh path was the live WebSocket event

The plugin-deployed key file is written by the payara plugin, which resolves
`api-key:<name>` entries from the agent's live in-memory config
(`ctx.config.auth.apiKey`, `znvault-plugin-payara/src/secrets-handler.ts`).
At runtime the file was rewritten **only** by this chain:

```
WS 'apikeys' event → handleApiKeyRotationEvent (src/lib/websocket.ts)
  → bind → mutate live config → pluginLoader.dispatchEvent('keyRotated')
  → payara plugin fetchSecrets → writeApiKeyToFile
```

Nothing else could repair the file while the agent ran:

- The hourly poll iterates only cert targets and `secretTargets`
  (`websocket.ts` `poll()`); the payara-staging config has 3 subscribe-only
  alias secrets — hence the truthful-but-blind `success: 3` log.
- The 60s `syncManagedKeyFile` check requires `config.managedKey.filePath`,
  which this fleet does not set (the plugin owns the file), and it only
  reconciles file↔config — it cannot detect a server-side rotation.
- A managed-key rotation changes no secret version and does not bump the host
  config version, so no poll-visible signal exists at all.

### 2. The polling rails detected the rotation but propagated it nowhere

The managed-key renewal service (`src/services/managed-key/`) is designed
exactly for missed events: scheduled refresh at `nextRotationAt`−30s (60s
minimum re-loop), grace poller, heartbeat monitor, reconnect hook. In the
incident it **did** detect the rotation (this is why the 16:05 restart's
initial bind succeeded after grace expiry: config.json already held the new
key). But `handleRotationDetected` only invoked the `onKeyChanged` callback,
which was wired to a bare WebSocket disconnect/reconnect:

- no plugin `keyRotated` dispatch,
- no exec env-file update,
- and in disk-config mode `updateManagedKey` mutates a fresh `loadConfig()`
  object, never the startup-captured object plugins read via `ctx.config`.

So the agent silently healed **itself** and left every consumer stale.

### Why restart fixed it

Startup awaits the renewal service's initial bind before plugins load
(`websocket.ts`), so the live config holds the current key; the payara
plugin's `onInit`/`onStart` then rewrites and verifies the key file from
`ctx.config.auth.apiKey`.

### Why the WebSocket event was lost (not fully determined)

The server emits `apikey.rotated` from the scheduled-rotation job path
(`forceRotate` → `notifyRotationEvent`), with store-first persistence in
`agent_pending_events` plus Redis cross-node fan-out, and redelivery on
reconnect. All four agents missing both the live event AND redelivery points
to a systematic delivery-layer failure. Candidates (production journal greps
to discriminate are in the incident annex):

- **Delivery never reached the agents** — e.g. Redis relay from the worker
  leader, or server-side subscription scoping (a known anomaly is tracked as
  P9 in the 2026-06-12 incident report: a misdirected `archon-master`
  broadcast).
- **Live handling failed once and dedup ate the redelivery** — the agent
  dispatcher registers the `deliveryId` BEFORE handlers run
  (`src/lib/websocket/dispatcher.ts`), so a mid-chain failure at 11:57 would
  permanently swallow the redelivered copy (same id is preserved across
  nodes by design).

The fix makes this question non-blocking: with rail propagation in place, any
lost event is healed within one refresh cycle. Follow-ups worth filing
server/agent-side: ack-after-success semantics for `apikeys` deliveryId dedup
(weighed against the 2026-05-03 event-storm protection), and closing P9.

Note: `znvault apikey managed show` printing `Last Bound: Never` is a red
herring — the server neither tracks nor returns `last_bound_at`; the CLI
prints `Never` unconditionally.

## The fix (agent v1.23.0)

`src/lib/key-rotation-propagation.ts` — one propagation path both detection
channels go through:

1. Mutate the live config object (plugins see the new key) — own key only;
   fixes a latent clobber where events for OTHER tracked keys overwrote agent
   auth.
2. Persist (WebSocket path; the rails already persisted).
3. Dispatch plugin `keyRotated` (payara rewrites its file — plugin unchanged).
4. Update exec env-file vars mapped to the key.
5. Optional child restart (combined mode `restartOnChange`).
6. Explicit log: `Managed key rotation propagated to consumers`
   (`source`, old/new prefix, `pluginsNotified`, `envVarsUpdated`).

Propagations are serialized and deduplicated per key (both channels routinely
fire for the same rotation; unserialized they double-dispatch plugins and can
double-restart the child process), stale detections are discarded (a slow
bind response cannot revert consumers to an older key), and a
partially-failed propagation is retried automatically with bounded backoff —
the rails cannot re-detect the same rotation, so the propagator retries
itself. Exec watch mode routes both channels through the same propagator.

**Bounded pickup time after a rotation, even with all WebSocket events
lost:** for the agent's own managed key, the renewal service's
scheduled-refresh rail polls at 60s granularity around `nextRotationAt`. For
every OTHER tracked key (exec/plugin `api-key:` mappings), a dedicated
`TrackedKeyPoller` (`src/services/managed-key/tracked-keys-poller.ts`) binds
the key on a per-key schedule derived from its own `nextRotationAt` (min 60s
around rotations, 5min fallback) and feeds the result through the same
propagator — unchanged values are no-ops via the per-key dedup. Consumers
get a rotated key within ~1–2 minutes — well inside any sane grace period
(production: 4h).

## Reproduction and verification

- Live repro (pre-fix, against a local vault): SIGSTOP the agent until the
  server terminates its WS connection, rotate, delete the pending-event rows
  (simulating the lost event), SIGCONT. Result on v1.22.5: config gets the
  new key, file keeps the old one; on v1.23.0: file rewritten ~3s after the
  reconnect-rail bind.
- `test/integration/rotation-propagation.test.ts`:
  - ROTATION-01 — rotate → WS event → plugin file rewritten, no restart.
  - ROTATION-02 — rotate with `ZNVAULT_TEST_SUPPRESS_WS_TOPICS=apikeys`
    (fault injection added for this) → file rewritten via the rails within
    one refresh cycle. This is the incident scenario and fails pre-fix.
- Unit: `src/lib/key-rotation-propagation.test.ts` (13 cases),
  dispatcher suppression tests.

Manual verification on a host after rollout:

```bash
znvault apikey managed rotate <name>
# within ~60s, WITHOUT restarting the agent:
sudo head -c 8 /var/lib/zn-vault-agent/secrets/ZINC_CONFIG_VAULT_API_KEY
journalctl -u zn-vault-agent | grep "Managed key rotation propagated"
```

## Rollout

- **Target version:** agent v1.23.0 (from 1.22.5). Standard release flow:
  `npm version minor` + tag push → CI publishes to npm; then operator-initiated
  agent update (dashboard/CLI trigger) or the `.path`-trigger self-update.
- **Ordering:** agent-only; no vault server change is required. Safe to roll
  out host-by-host. The payara plugin requires no update.
- **Post-rollout check per host:** force one rotation of a low-stakes managed
  key and confirm the `Managed key rotation propagated to consumers` journal
  line + file prefix change without an agent restart.
