# Changelog

All notable changes to ZnVault Agent will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Note: entries between 1.13.0 and 1.23.0 were tracked in git history and
> `CLAUDE.md` → "Known Issues & Important Fixes" only.

## [Unreleased]

## [1.23.3] - 2026-08-28 - Dynamic Credential Ownership v2

### Security

- Dynamic-secret generation, renewal, and revocation now use distinct v2
  events carrying the exact tenant, connection, role, lease, target, config,
  and lifecycle epochs. The agent refuses stale or mismatched work instead of
  executing it against a changed database identity.
- Database configuration is reloaded at dispatch time and stale clients are
  evicted when the authoritative Vault inventory changes. Raw AGENT roles are
  rejected, and ambiguous target outcomes never return a credential as usable.

## [1.23.2] - 2026-08-27 - Resilient Plugin Key Rotation

### Fixed

- **Payara managed-key rotations no longer depend on an external agent health
  check after cold startup.** Plugin `onStart` now has a dedicated 120-second
  budget (the production WAR deployment takes 50-90 seconds). A
  recovery-critical `keyRotated` event is still delivered when a plugin is in
  `error`, covering an uncancellable startup hook that finishes after its
  timeout.
- Plugin event dispatch now returns exact invoked/succeeded/failed/skipped
  handler counts. Rotation logs report `pluginsNotified` as the number of
  handlers actually invoked instead of a success-shaped boolean; skipped
  handlers produce a warning, and failed or skipped rotation handlers keep the
  propagation incomplete so its bounded retry can self-heal.
- The integration runner now isolates daemon config overrides from the SDK
  harness, preserves tracked fixtures when cleaning temporary plugins, avoids
  deleting other workers' config directories, and bounds daemon shutdown.

## [1.23.0] - 2026-07-05 - Managed Key Rotation Propagation

Fixes the 2026-07-05 production incident: a scheduled managed-key rotation was
never propagated to plugin-deployed API key files (e.g. the payara plugin's
`ZINC_CONFIG_VAULT_API_KEY`) while the agent was running. The WebSocket
`apikey.rotated` event was the ONLY runtime refresh path for those files; when
it was lost, the renewal service's polling rails detected the rotation and
silently fixed the agent's own credentials, but consumers kept the old key
until the grace period expired (401s) — only an agent restart re-rendered the
file. Sync logs reported success throughout because the hourly poll only
covers `secretTargets`, which the key file is not part of.

### Fixed
- **Rail-detected rotations now propagate to all consumers**
  (`src/lib/key-rotation-propagation.ts`): rotations detected by the renewal
  service (scheduled refresh, grace poll, heartbeat, reconnect) run the same
  propagation as the WebSocket event handler — live config mutation (plugins
  read `ctx.config`), plugin `keyRotated` dispatch, exec env-file update, and
  optional child restart. Bounded pickup within one refresh cycle (≤60s
  around a scheduled rotation, ≤5min fallback) even if every WebSocket event
  is lost.
- **Polling rail for ALL tracked keys** (`src/services/managed-key/
  tracked-keys-poller.ts`): managed keys referenced by exec/plugin `api-key:`
  mappings that are NOT the agent's auth key previously had the WebSocket
  event as their single runtime refresh path (the renewal service polls only
  the agent's own key). A `TrackedKeyPoller` now binds each tracked non-own
  key on a per-key schedule derived from its `nextRotationAt` (minimum 60s
  around rotations, 5min fallback) and feeds the result through the
  propagator — unchanged values are no-ops via the per-key dedup. Active in
  daemon mode and exec watch mode.
- **Exec watch mode** (`--output` env-file mode): rail-detected rotations now
  update the output env file; previously only the WebSocket event did.
- **Latent multi-key clobber**: a rotation event for a managed key that is NOT
  the agent's own auth key no longer overwrites `config.auth.apiKey` /
  `managedKey` metadata (previously the WebSocket handler mutated them
  unconditionally).

### Added
- Explicit rotation-pickup logging: `Managed key rotation propagated to
  consumers` with `source` (`ws_event`/`scheduled`/`grace_poll`/`heartbeat`/
  `reconnect`), old/new key prefixes, `pluginsNotified`, `envVarsUpdated`.
- Duplicate suppression across detection channels: propagations are
  serialized and deduplicated per key, so the same rotated value is
  propagated once even when both the WebSocket event and a polling rail fire
  concurrently (previously this could double-dispatch plugins and
  double-restart the child process). Stale detections are discarded — a slow
  bind response can no longer revert consumers to an older key. A
  partially-failed propagation (e.g. plugin error) is retried automatically
  (bounded, 30s apart) since no detection channel re-fires for the same
  rotation.
- Child restarts triggered by rotations detected during startup's initial
  bind are skipped until the child process has started (the initial start
  reads the already-updated config); rail-path propagation participates in
  graceful-shutdown accounting like the WebSocket path.
- `onKeyChanged` callback now receives rotation metadata
  (`KeyChangeMeta`: keyName, prefix, nextRotationAt, graceExpiresAt,
  rotationMode, source).
- TEST-ONLY fault injection `ZNVAULT_TEST_SUPPRESS_WS_TOPICS` (comma-separated
  topics) to simulate lost WebSocket deliveries; logs a warning when active.
  Never set in production.
- Tests: unit coverage for the propagator (`key-rotation-propagation.test.ts`)
  and dispatcher suppression; integration tests
  (`test/integration/rotation-propagation.test.ts`) covering rotate → plugin
  file refresh without restart, via the WebSocket path (ROTATION-01) and via
  the polling rails with WebSocket events suppressed — the incident scenario
  (ROTATION-02). Test fixture `test/fixtures/key-file-plugin.mjs` mirrors the
  payara plugin's API-key-file semantics.

### Notes
- No server-side changes required; safe to roll out agent-first.
- The payara plugin needs no change: its existing `onKeyRotated` hook is now
  reliably invoked regardless of which channel detected the rotation. Plugins
  wanting a generic "secret file changed" signal continue to use
  `onKeyRotated`/`onSecretChanged`.

## [1.13.0] - 2026-01-09 - Degraded State Recovery

### Added
- **DegradedModeHandler Service**
  - New `src/services/degraded-mode-handler.ts` for handling degraded connection states
  - Automatic detection when agent enters degraded mode (expired/revoked keys)
  - Callback system for credential updates and state changes
  - Reprovision token claim functionality

- **WebSocket Degraded Connection Support**
  - Handler for `degraded_connection` messages from server
  - Handler for `reprovision_available` notifications
  - Automatic state tracking and recovery flow
  - Integration with DegradedModeHandler

- **Types for Degraded Connections**
  - `DegradedReason`: `key_expired`, `key_revoked`, `key_disabled`, `auth_failed`
  - `DegradedConnectionInfo`: Server notification structure
  - `ReprovisionAvailableMessage`: Real-time reprovision notification

### Changed
- **WebSocket Client**
  - Added `onDegradedConnection` callback option
  - Added `onReprovisionAvailable` callback option
  - Daemon mode now initializes DegradedModeHandler

### Technical
- Native HTTP/HTTPS for reprovision token claim (no external dependencies)
- Polling mechanism for reprovision status (30s interval)
- Graceful cleanup on shutdown

---

## [1.12.5] - 2026-01-08

### Fixed
- Minor bug fixes and stability improvements

---

## [1.12.0] - 2026-01-05

### Added
- Initial release with certificate distribution
- WebSocket real-time updates
- Plugin system for application integration
- Payara plugin for Java EE servers
