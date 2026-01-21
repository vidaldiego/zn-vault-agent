// Path: src/services/managed-key/service.ts
// Main managed API key renewal service orchestration

import { loadConfig, updateManagedKey, isManagedKeyMode } from '../../lib/config.js';
import { bindManagedApiKey, type ManagedApiKeyBindResponse } from '../../lib/api.js';
import { createLogger } from '../../lib/logger.js';
import {
  registerCounter,
  registerGauge,
  incCounter,
  setGauge,
} from '../../lib/metrics.js';
import { ManagedTimer } from '../../utils/timer.js';

import {
  type RotationTracking,
  type RefreshSource,
  type ManagedKeyStatus,
  createInitialRotationTracking,
  resetRotationTracking,
  RECONNECT_POLL_DELAY_MS,
  MAX_RETRY_ATTEMPTS,
} from './types.js';
import { calculateNextRefreshMs } from './scheduler.js';
import {
  GracePeriodPoller,
  HeartbeatMonitor,
  RotationRetryHandler,
  updateGraceMetrics,
} from './safety-rails.js';

const log = createLogger({ module: 'managed-key-renewal' });

// ============================================================================
// State Management
// ============================================================================

const refreshTimer = new ManagedTimer();
let isRunning = false;
let currentKey: string | null = null;
let staleKeyDetected = false;
let onKeyChangedCallback: ((newKey: string) => void) | null = null;

const rotationTracking: RotationTracking = createInitialRotationTracking();

// Safety rail instances (initialized on start)
let gracePeriodPoller: GracePeriodPoller | null = null;
let heartbeatMonitor: HeartbeatMonitor | null = null;
let rotationRetryHandler: RotationRetryHandler | null = null;

// ============================================================================
// Metrics Registration
// ============================================================================

let metricsRegistered = false;

function registerRotationMetrics(): void {
  if (metricsRegistered) return;
  metricsRegistered = true;

  // Counters
  registerCounter('znvault_agent_managed_key_rotations_total', 'Total managed key rotations detected');
  registerCounter('znvault_agent_managed_key_ws_events_total', 'Total WebSocket rotation events received');
  registerCounter('znvault_agent_managed_key_poll_fallbacks_total', 'Total rotations detected via polling (WS missed)');
  registerCounter('znvault_agent_managed_key_refresh_failures_total', 'Total key refresh failures');
  registerCounter('znvault_agent_managed_key_grace_polls_total', 'Total grace period safety polls');
  registerCounter('znvault_agent_managed_key_heartbeat_checks_total', 'Total heartbeat freshness checks');

  // Gauges
  registerGauge('znvault_agent_managed_key_stale', 'Whether a stale key has been detected (1=stale, 0=fresh)');
  registerGauge('znvault_agent_managed_key_grace_remaining_seconds', 'Seconds remaining in grace period');
  registerGauge('znvault_agent_managed_key_last_rotation_timestamp', 'Timestamp of last rotation');

  log.debug('Managed key rotation metrics registered');
}

// ============================================================================
// Public API: Callback Registration
// ============================================================================

/**
 * Set callback for when the API key changes.
 * This allows other parts of the system (e.g., WebSocket) to be notified.
 */
export function onKeyChanged(callback: (newKey: string) => void): void {
  onKeyChangedCallback = callback;
}

// ============================================================================
// Core Key Refresh Logic
// ============================================================================

/**
 * Perform a managed key bind and update config.
 * @param source - The trigger source for logging/metrics
 */
async function refreshManagedKey(
  source: RefreshSource = 'scheduled'
): Promise<ManagedApiKeyBindResponse | null> {
  const config = loadConfig();

  if (!config.managedKey?.name) {
    log.debug('No managed key configured, skipping refresh');
    return null;
  }

  if (!config.auth.apiKey) {
    log.error('No API key available to perform bind');
    return null;
  }

  try {
    log.debug({ name: config.managedKey.name, source }, 'Binding to managed key');

    const bindResponse = await bindManagedApiKey(config.managedKey.name);

    const oldKey = currentKey;
    currentKey = bindResponse.key;
    rotationTracking.lastPollAt = Date.now();

    // Update tracking info
    if (bindResponse.nextRotationAt) {
      rotationTracking.expectedRotationAt = new Date(bindResponse.nextRotationAt).getTime();
    }
    if (bindResponse.graceExpiresAt) {
      rotationTracking.graceExpiresAt = new Date(bindResponse.graceExpiresAt).getTime();
      updateGraceMetrics(rotationTracking.graceExpiresAt);
    }

    // Update config with new key and metadata
    updateManagedKey(bindResponse.key, {
      nextRotationAt: bindResponse.nextRotationAt,
      graceExpiresAt: bindResponse.graceExpiresAt,
      rotationMode: bindResponse.rotationMode,
    });

    // Detect rotation
    if (oldKey && oldKey !== bindResponse.key) {
      handleRotationDetected(oldKey, bindResponse, source);
    } else {
      log.debug({
        prefix: bindResponse.key.substring(0, 8),
        nextRotationAt: bindResponse.nextRotationAt,
        source,
      }, 'Managed key refreshed (no change)');
    }

    return bindResponse;
  } catch (err) {
    return handleRefreshError(err, source);
  }
}

function handleRotationDetected(
  oldKey: string,
  bindResponse: ManagedApiKeyBindResponse,
  source: RefreshSource
): void {
  const wasWsTriggered = source === 'ws_event';
  const wasPollTriggered = source === 'grace_poll' || source === 'reconnect' || source === 'heartbeat';

  log.info({
    oldPrefix: oldKey.substring(0, 8),
    newPrefix: bindResponse.key.substring(0, 8),
    nextRotationAt: bindResponse.nextRotationAt,
    source,
    wasWsTriggered,
  }, 'Managed key rotated');

  // Update metrics
  incCounter('znvault_agent_managed_key_rotations_total', { source });
  setGauge('znvault_agent_managed_key_last_rotation_timestamp', Date.now() / 1000);
  setGauge('znvault_agent_managed_key_stale', 0);
  staleKeyDetected = false;

  // Track if we detected rotation via polling (WS missed)
  if (wasPollTriggered && !rotationTracking.wsEventReceived) {
    rotationTracking.missedRotations++;
    incCounter('znvault_agent_managed_key_poll_fallbacks_total', { source });
    log.warn({
      source,
      missedRotations: rotationTracking.missedRotations,
    }, 'Rotation detected via polling - WebSocket event may have been missed');
  }

  // Reset WS event tracking for next rotation cycle
  rotationTracking.wsEventReceived = false;

  if (onKeyChangedCallback) {
    onKeyChangedCallback(bindResponse.key);
  }
}

function handleRefreshError(err: unknown, source: RefreshSource): null {
  const error = err as Error & { statusCode?: number };
  const config = loadConfig();

  incCounter('znvault_agent_managed_key_refresh_failures_total', { source });

  // Detect authentication failures - key has expired or been revoked
  if (error.statusCode === 401 || error.message.includes('Unauthorized')) {
    log.error({
      name: config.managedKey?.name,
      keyPrefix: config.auth.apiKey?.substring(0, 8),
      source,
    }, 'API key authentication failed - key may have expired while agent was offline');

    // Log recovery instructions
    log.error({}, 'RECOVERY REQUIRED: The stored API key is no longer valid.');
    log.error({}, 'To recover, create a new API key and update the agent config:');
    log.error({}, '  1. Create a new API key in the vault dashboard or CLI');
    log.error({}, '  2. Re-run: zn-vault-agent login --url <vault-url> --api-key <new-key>');
    log.error({}, '  3. Restart the agent: sudo systemctl restart zn-vault-agent');

    // Mark as stale key for monitoring
    staleKeyDetected = true;
    setGauge('znvault_agent_managed_key_stale', 1);
  } else {
    log.error({ err, name: config.managedKey?.name, source }, 'Failed to bind managed key');
  }

  return null;
}

// ============================================================================
// Scheduling
// ============================================================================

function scheduleNextRefresh(bindResponse: ManagedApiKeyBindResponse | null): void {
  refreshTimer.clear();

  if (!isRunning) {
    return;
  }

  const delay = calculateNextRefreshMs(bindResponse);

  refreshTimer.setTimeout(() => {
    if (!isRunning) return;

    void (async () => {
      try {
        const response = await refreshManagedKey();
        scheduleNextRefresh(response);
      } catch (err) {
        log.error({ err }, 'Managed key refresh failed, retrying in 1 minute');
        // On error, retry in 1 minute
        scheduleNextRefresh(null);
      }
    })();
  }, delay);

  log.info({
    refreshInMinutes: Math.round(delay / 60000),
    refreshAt: new Date(Date.now() + delay).toISOString(),
  }, 'Managed key refresh scheduled');
}

function handleRefreshSchedule(response: { nextRotationAt?: string; graceExpiresAt?: string } | null): void {
  scheduleNextRefresh(response as ManagedApiKeyBindResponse | null);
  if (response?.graceExpiresAt) {
    gracePeriodPoller?.schedule(new Date(response.graceExpiresAt));
  }
}

// ============================================================================
// Safety Rail Event Handlers
// ============================================================================

/**
 * Called when WebSocket reconnects after a disconnect.
 * Immediately polls to detect any rotations that may have been missed.
 */
export async function onWebSocketReconnect(): Promise<void> {
  if (!isRunning || !isManagedKeyMode()) return;

  log.info('WebSocket reconnected - checking for missed rotations');

  // Small delay to allow connection to stabilize
  await new Promise(resolve => setTimeout(resolve, RECONNECT_POLL_DELAY_MS));

  // Re-check after async pause (isRunning may have changed during await)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!isRunning) return;

  try {
    const response = await refreshManagedKey('reconnect');
    if (response) {
      handleRefreshSchedule(response);
    }
  } catch (err) {
    log.error({ err }, 'Reconnection poll failed');
  }
}

/**
 * Called when WebSocket authentication fails (401 Unauthorized).
 * This is a critical safety rail - if the agent's stored key is stale/expired,
 * we need to perform a fresh bind to get the current key BEFORE reconnecting.
 *
 * Returns true if key was refreshed successfully (caller should reconnect).
 * Returns false if refresh failed (key is truly invalid, needs manual intervention).
 */
export async function onWebSocketAuthFailure(): Promise<boolean> {
  if (!isManagedKeyMode()) {
    log.debug('Not in managed key mode, cannot recover from auth failure');
    return false;
  }

  log.warn('WebSocket authentication failed - attempting managed key refresh');

  // Mark as stale
  staleKeyDetected = true;
  setGauge('znvault_agent_managed_key_stale', 1);

  try {
    // Try to refresh the key - this will call bind to get the latest key
    const response = await refreshManagedKey('reconnect');

    if (response) {
      log.info({
        newKeyPrefix: response.key.substring(0, 8),
        nextRotationAt: response.nextRotationAt,
      }, 'Managed key refreshed after auth failure - will reconnect with new key');

      // Clear stale flag
      staleKeyDetected = false;
      setGauge('znvault_agent_managed_key_stale', 0);

      // Reschedule timers with new data
      handleRefreshSchedule(response);

      return true;
    }

    return false;
  } catch (err) {
    const error = err as Error & { statusCode?: number };

    // If bind also fails with 401, the key is truly gone
    if (error.statusCode === 401 || error.message.includes('Unauthorized')) {
      log.error({
        name: loadConfig().managedKey?.name,
      }, 'Managed key bind also failed with 401 - key is invalid and cannot be recovered automatically');
      log.error({}, 'MANUAL RECOVERY REQUIRED: Create a new API key and update agent config');
      return false;
    }

    // Other errors (network, server down) - might recover on retry
    log.error({ err }, 'Failed to refresh managed key after auth failure');
    return false;
  }
}

/**
 * Called when a WebSocket rotation event is received.
 * Marks that we received the WS event and triggers a refresh.
 */
export async function onWebSocketRotationEvent(keyName: string): Promise<void> {
  if (!isRunning) return;

  const config = loadConfig();
  if (config.managedKey?.name !== keyName) {
    log.debug({ receivedKey: keyName, configuredKey: config.managedKey?.name }, 'Ignoring rotation event for different key');
    return;
  }

  log.info({ keyName }, 'WebSocket rotation event received');

  // Mark that we received the WS event
  rotationTracking.wsEventReceived = true;
  rotationTracking.lastWsEventAt = Date.now();
  incCounter('znvault_agent_managed_key_ws_events_total');

  // Immediately refresh to get the new key
  try {
    const response = await refreshManagedKey('ws_event');
    if (response) {
      handleRefreshSchedule(response);
    }
  } catch (err) {
    log.error({ err }, 'Failed to refresh after WebSocket rotation event');
    // Schedule retry with exponential backoff
    rotationRetryHandler?.schedule(keyName, 1);
  }
}

// ============================================================================
// Service Lifecycle
// ============================================================================

/**
 * Start the managed key renewal service.
 * Returns the initial bind response or null if not in managed key mode.
 */
export async function startManagedKeyRenewal(): Promise<ManagedApiKeyBindResponse | null> {
  if (isRunning) {
    log.warn('Managed key renewal service already running');
    return null;
  }

  if (!isManagedKeyMode()) {
    log.debug('Not in managed key mode, service not started');
    return null;
  }

  // Register metrics
  registerRotationMetrics();

  const config = loadConfig();
  isRunning = true;
  currentKey = config.auth.apiKey ?? null;

  // Reset tracking state
  Object.assign(rotationTracking, createInitialRotationTracking());

  log.info({
    managedKeyName: config.managedKey?.name,
    rotationMode: config.managedKey?.rotationMode,
  }, 'Starting managed key renewal service with safety rails');

  // Initialize safety rails
  gracePeriodPoller = new GracePeriodPoller({
    isRunning: () => isRunning,
    getTracking: () => rotationTracking,
    onPoll: () => refreshManagedKey('grace_poll'),
  });

  heartbeatMonitor = new HeartbeatMonitor({
    isRunning: () => isRunning,
    getTracking: () => rotationTracking,
    onStale: () => refreshManagedKey('heartbeat'),
    onRefreshSchedule: handleRefreshSchedule,
  });

  rotationRetryHandler = new RotationRetryHandler({
    isRunning: () => isRunning,
    onRetry: () => refreshManagedKey('ws_event'),
    onSuccess: handleRefreshSchedule,
    maxAttempts: MAX_RETRY_ATTEMPTS,
  });

  // Perform initial bind
  const bindResponse = await refreshManagedKey('scheduled');

  // Schedule next refresh (proactive pre-rotation polling)
  scheduleNextRefresh(bindResponse);

  // Start safety rails
  if (bindResponse?.graceExpiresAt) {
    gracePeriodPoller.schedule(new Date(bindResponse.graceExpiresAt));
  }
  heartbeatMonitor.start();

  log.info({
    nextRotationAt: bindResponse?.nextRotationAt,
    graceExpiresAt: bindResponse?.graceExpiresAt,
  }, 'Safety rails initialized');

  return bindResponse;
}

/**
 * Stop the managed key renewal service.
 */
export function stopManagedKeyRenewal(): void {
  // Stop all timers and safety rails
  refreshTimer.clear();
  gracePeriodPoller?.stop();
  heartbeatMonitor?.stop();

  gracePeriodPoller = null;
  heartbeatMonitor = null;
  rotationRetryHandler = null;

  // Reset state
  isRunning = false;
  currentKey = null;
  staleKeyDetected = false;
  onKeyChangedCallback = null;

  // Reset tracking (preserves missedRotations for debugging)
  resetRotationTracking(rotationTracking);

  log.debug('Managed key renewal service stopped');
}

/**
 * Force an immediate key refresh.
 */
export async function forceRefresh(): Promise<ManagedApiKeyBindResponse | null> {
  if (!isManagedKeyMode()) {
    log.warn('Cannot force refresh - not in managed key mode');
    return null;
  }

  const response = await refreshManagedKey('manual');
  if (isRunning && response) {
    handleRefreshSchedule(response);
  }
  return response;
}

/**
 * Get current managed key status with safety rail tracking info.
 */
export function getManagedKeyStatus(): ManagedKeyStatus {
  const config = loadConfig();
  const now = Date.now();

  // Calculate grace remaining
  let graceRemainingMs: number | null = null;
  if (rotationTracking.graceExpiresAt) {
    graceRemainingMs = Math.max(0, rotationTracking.graceExpiresAt - now);
  }

  return {
    isRunning,
    staleKeyDetected,
    isManagedMode: isManagedKeyMode(),
    managedKeyName: config.managedKey?.name,
    currentKeyPrefix: currentKey ? currentKey.substring(0, 8) + '...' : undefined,
    nextRotationAt: config.managedKey?.nextRotationAt,
    graceExpiresAt: config.managedKey?.graceExpiresAt,
    safetyRails: {
      lastWsEventAt: rotationTracking.lastWsEventAt ? new Date(rotationTracking.lastWsEventAt).toISOString() : null,
      lastPollAt: rotationTracking.lastPollAt ? new Date(rotationTracking.lastPollAt).toISOString() : null,
      wsEventReceived: rotationTracking.wsEventReceived,
      missedRotations: rotationTracking.missedRotations,
      graceRemainingMs,
    },
  };
}
