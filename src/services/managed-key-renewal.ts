// Path: src/services/managed-key-renewal.ts
// Automatic managed API key renewal service
// Schedules key refresh based on rotation metadata from the vault server
// Includes safety rails: grace period polling, connection recovery, heartbeat monitoring

import { loadConfig, updateManagedKey, isManagedKeyMode } from '../lib/config.js';
import { bindManagedApiKey, type ManagedApiKeyBindResponse } from '../lib/api.js';
import { createLogger } from '../lib/logger.js';
import {
  registerCounter,
  registerGauge,
  incCounter,
  setGauge,
} from '../lib/metrics.js';

const log = createLogger({ module: 'managed-key-renewal' });

// ============================================================================
// Configuration Constants
// ============================================================================

// How early before rotation to refresh (30 seconds default)
const DEFAULT_REFRESH_BEFORE_MS = 30 * 1000;

// Minimum refresh interval (don't refresh more than once per minute)
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

// Fallback interval if no rotation time is known (5 minutes)
const FALLBACK_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Grace period polling: poll at 50% of remaining grace time if no WS event
const GRACE_PERIOD_POLL_RATIO = 0.5;

// Minimum grace period poll delay (10 seconds)
const MIN_GRACE_POLL_DELAY_MS = 10 * 1000;

// Heartbeat freshness monitor interval (60 seconds)
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

// Connection recovery delay after reconnect (2 seconds)
const RECONNECT_POLL_DELAY_MS = 2 * 1000;

// Maximum retry attempts for rotation handling
const MAX_RETRY_ATTEMPTS = 5;

// ============================================================================
// State Management
// ============================================================================

let refreshTimer: NodeJS.Timeout | null = null;
let gracePeriodTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let isRunning = false;
let currentKey: string | null = null;
let staleKeyDetected = false;

// Track WebSocket rotation events received
interface RotationTracking {
  lastWsEventAt: number | null;        // When we last received a WS rotation event
  lastPollAt: number | null;           // When we last polled for rotation
  expectedRotationAt: number | null;   // When rotation is expected
  graceExpiresAt: number | null;       // When grace period ends
  wsEventReceived: boolean;            // Did we receive WS event for current rotation?
  missedRotations: number;             // Count of rotations detected via polling (WS missed)
}

const rotationTracking: RotationTracking = {
  lastWsEventAt: null,
  lastPollAt: null,
  expectedRotationAt: null,
  graceExpiresAt: null,
  wsEventReceived: false,
  missedRotations: 0,
};

// Callback for when key changes (used to notify other parts of the system)
let onKeyChangedCallback: ((newKey: string) => void) | null = null;

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

/**
 * Set callback for when the API key changes
 * This allows other parts of the system (e.g., WebSocket) to be notified
 */
export function onKeyChanged(callback: (newKey: string) => void): void {
  onKeyChangedCallback = callback;
}

// ============================================================================
// Core Key Refresh Logic
// ============================================================================

/**
 * Perform a managed key bind and update config
 * @param source - The trigger source for logging/metrics ('scheduled' | 'ws_event' | 'grace_poll' | 'reconnect' | 'heartbeat' | 'manual')
 */
async function refreshManagedKey(
  source: 'scheduled' | 'ws_event' | 'grace_poll' | 'reconnect' | 'heartbeat' | 'manual' = 'scheduled'
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
    } else {
      log.debug({
        prefix: bindResponse.key.substring(0, 8),
        nextRotationAt: bindResponse.nextRotationAt,
        source,
      }, 'Managed key refreshed (no change)');
    }

    return bindResponse;
  } catch (err) {
    const error = err as Error & { statusCode?: number };
    incCounter('znvault_agent_managed_key_refresh_failures_total', { source });

    // Detect authentication failures - key has expired or been revoked
    if (error.statusCode === 401 || error.message?.includes('Unauthorized')) {
      log.error({
        name: config.managedKey.name,
        keyPrefix: config.auth.apiKey?.substring(0, 8),
        source,
      }, 'API key authentication failed - key may have expired while agent was offline');

      // Log recovery instructions
      log.error({}, 'RECOVERY REQUIRED: The stored API key is no longer valid.');
      log.error({}, 'To recover, create a new API key and update the agent config:');
      log.error({}, '  1. Create a new API key: znvault api-key create <name> --tenant <tenant> --permissions "certificate:read:value,certificate:read:metadata,certificate:list"');
      log.error({}, '  2. Update /etc/zn-vault-agent/config.json with the new key');
      log.error({}, '  3. Restart the agent: sudo systemctl restart zn-vault-agent');

      // Mark as stale key for monitoring
      staleKeyDetected = true;
      setGauge('znvault_agent_managed_key_stale', 1);
    } else {
      log.error({ err, name: config.managedKey.name, source }, 'Failed to bind managed key');
    }

    return null;
  }
}

// ============================================================================
// Safety Rail: Grace Period Metrics
// ============================================================================

function updateGraceMetrics(graceExpiresAtMs: number): void {
  const now = Date.now();
  const remainingSeconds = Math.max(0, (graceExpiresAtMs - now) / 1000);
  setGauge('znvault_agent_managed_key_grace_remaining_seconds', remainingSeconds);
}

// ============================================================================
// Safety Rail #1: Grace Period Polling
// ============================================================================

/**
 * Schedule a grace period safety poll.
 * If we haven't received a WebSocket rotation event by the time 50% of the
 * grace period has elapsed, poll the server to detect rotations.
 */
function scheduleGracePeriodPoll(graceExpiresAt: Date | null): void {
  // Clear existing timer
  if (gracePeriodTimer) {
    clearTimeout(gracePeriodTimer);
    gracePeriodTimer = null;
  }

  if (!isRunning || !graceExpiresAt) return;

  const now = Date.now();
  const graceEnd = graceExpiresAt.getTime();

  // Don't schedule if grace period has already expired
  if (graceEnd <= now) {
    log.debug('Grace period already expired, skipping safety poll');
    return;
  }

  const graceDuration = graceEnd - now;
  // Poll at 50% of remaining grace period, with a minimum of 10 seconds
  const pollDelay = Math.max(graceDuration * GRACE_PERIOD_POLL_RATIO, MIN_GRACE_POLL_DELAY_MS);

  gracePeriodTimer = setTimeout(async () => {
    if (!isRunning) return;

    // Only poll if we haven't received a WS event
    if (rotationTracking.wsEventReceived) {
      log.debug('WebSocket rotation event already received, skipping grace period poll');
      return;
    }

    log.info({
      graceExpiresAt: graceExpiresAt.toISOString(),
      graceRemainingMs: graceEnd - Date.now(),
    }, 'Grace period safety poll - no WebSocket event received');

    incCounter('znvault_agent_managed_key_grace_polls_total');

    try {
      const response = await refreshManagedKey('grace_poll');
      if (response) {
        // Schedule next grace period poll based on new response
        scheduleGracePeriodPoll(response.graceExpiresAt ? new Date(response.graceExpiresAt) : null);
      }
    } catch (err) {
      log.error({ err }, 'Grace period poll failed');
      // Retry in 10 seconds on failure
      setTimeout(() => scheduleGracePeriodPoll(graceExpiresAt), MIN_GRACE_POLL_DELAY_MS);
    }
  }, pollDelay);

  log.debug({
    pollDelayMs: pollDelay,
    pollAt: new Date(now + pollDelay).toISOString(),
    graceExpiresAt: graceExpiresAt.toISOString(),
  }, 'Grace period safety poll scheduled');
}

// ============================================================================
// Safety Rail #2: Connection Loss Recovery
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

  if (!isRunning) return;

  try {
    const response = await refreshManagedKey('reconnect');
    if (response) {
      // Reset tracking and reschedule timers
      scheduleNextRefresh(response);
      scheduleGracePeriodPoll(response.graceExpiresAt ? new Date(response.graceExpiresAt) : null);
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
      scheduleNextRefresh(response);
      scheduleGracePeriodPoll(response.graceExpiresAt ? new Date(response.graceExpiresAt) : null);

      return true;
    }

    return false;
  } catch (err) {
    const error = err as Error & { statusCode?: number };

    // If bind also fails with 401, the key is truly gone
    if (error.statusCode === 401 || error.message?.includes('Unauthorized')) {
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

// ============================================================================
// Safety Rail #3: Heartbeat Freshness Monitor
// ============================================================================

/**
 * Start the heartbeat freshness monitor.
 * Every 60 seconds, checks if the current key should have rotated but we missed it.
 */
function startHeartbeatMonitor(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  heartbeatTimer = setInterval(async () => {
    if (!isRunning) return;

    incCounter('znvault_agent_managed_key_heartbeat_checks_total');

    const now = Date.now();

    // Update grace period metrics
    if (rotationTracking.graceExpiresAt) {
      updateGraceMetrics(rotationTracking.graceExpiresAt);
    }

    // Check if key should have rotated by now
    if (rotationTracking.expectedRotationAt && now > rotationTracking.expectedRotationAt) {
      const staleness = now - rotationTracking.expectedRotationAt;

      // Only warn if significantly stale (more than 1 minute past rotation time)
      if (staleness > 60_000 && !rotationTracking.wsEventReceived) {
        log.warn({
          expectedRotationAt: new Date(rotationTracking.expectedRotationAt).toISOString(),
          stalenessMs: staleness,
          wsEventReceived: rotationTracking.wsEventReceived,
        }, 'Key may be stale - expected rotation time has passed without WS event');

        // Trigger a poll to check
        try {
          const response = await refreshManagedKey('heartbeat');
          if (response) {
            scheduleNextRefresh(response);
            scheduleGracePeriodPoll(response.graceExpiresAt ? new Date(response.graceExpiresAt) : null);
          }
        } catch (err) {
          log.error({ err }, 'Heartbeat refresh failed');
        }
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  log.debug({ intervalMs: HEARTBEAT_INTERVAL_MS }, 'Heartbeat freshness monitor started');
}

function stopHeartbeatMonitor(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ============================================================================
// Safety Rail #4: WebSocket Event Handler
// ============================================================================

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
      // Reschedule timers with new rotation info
      scheduleNextRefresh(response);
      scheduleGracePeriodPoll(response.graceExpiresAt ? new Date(response.graceExpiresAt) : null);
    }
  } catch (err) {
    log.error({ err }, 'Failed to refresh after WebSocket rotation event');
    // Schedule retry with exponential backoff
    scheduleRotationRetry(keyName, 1);
  }
}

/**
 * Retry rotation handling with exponential backoff
 */
function scheduleRotationRetry(keyName: string, attempt: number): void {
  if (!isRunning || attempt > MAX_RETRY_ATTEMPTS) {
    if (attempt > MAX_RETRY_ATTEMPTS) {
      log.error({ keyName, attempts: attempt }, 'Max retry attempts reached for rotation handling');
    }
    return;
  }

  const delay = Math.min(1000 * Math.pow(2, attempt), 60_000); // Max 60s

  log.debug({ keyName, attempt, delayMs: delay }, 'Scheduling rotation retry');

  setTimeout(async () => {
    if (!isRunning) return;

    try {
      const response = await refreshManagedKey('ws_event');
      if (response) {
        scheduleNextRefresh(response);
        scheduleGracePeriodPoll(response.graceExpiresAt ? new Date(response.graceExpiresAt) : null);
      }
    } catch (err) {
      log.error({ err, attempt }, 'Rotation retry failed');
      scheduleRotationRetry(keyName, attempt + 1);
    }
  }, delay);
}

// ============================================================================
// Scheduling Logic
// ============================================================================

/**
 * Calculate when to next refresh the key
 */
function calculateNextRefreshMs(bindResponse: ManagedApiKeyBindResponse | null): number {
  const config = loadConfig();
  const now = Date.now();

  // Priority 1: Use nextRotationAt from bind response or config
  const nextRotationAt = bindResponse?.nextRotationAt || config.managedKey?.nextRotationAt;
  if (nextRotationAt) {
    const rotationTime = new Date(nextRotationAt).getTime();
    const refreshTime = rotationTime - DEFAULT_REFRESH_BEFORE_MS;
    const delay = Math.max(refreshTime - now, MIN_REFRESH_INTERVAL_MS);

    log.debug({
      nextRotationAt,
      refreshInMs: delay,
      refreshInMinutes: Math.round(delay / 60000),
    }, 'Scheduled refresh based on nextRotationAt');

    return delay;
  }

  // Priority 2: Use graceExpiresAt (refresh well before grace ends)
  const graceExpiresAt = bindResponse?.graceExpiresAt || config.managedKey?.graceExpiresAt;
  if (graceExpiresAt) {
    const graceEndTime = new Date(graceExpiresAt).getTime();
    // Refresh at 50% of remaining grace period
    const refreshTime = now + (graceEndTime - now) / 2;
    const delay = Math.max(refreshTime - now, MIN_REFRESH_INTERVAL_MS);

    log.debug({
      graceExpiresAt,
      refreshInMs: delay,
      refreshInMinutes: Math.round(delay / 60000),
    }, 'Scheduled refresh based on graceExpiresAt');

    return delay;
  }

  // Fallback: use default interval
  log.debug({
    refreshInMs: FALLBACK_REFRESH_INTERVAL_MS,
    refreshInMinutes: FALLBACK_REFRESH_INTERVAL_MS / 60000,
  }, 'Using fallback refresh interval (no rotation time available)');

  return FALLBACK_REFRESH_INTERVAL_MS;
}

/**
 * Schedule the next key refresh
 */
function scheduleNextRefresh(bindResponse: ManagedApiKeyBindResponse | null): void {
  // Clear any existing timer
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  if (!isRunning) {
    return;
  }

  const delay = calculateNextRefreshMs(bindResponse);

  refreshTimer = setTimeout(async () => {
    if (!isRunning) return;

    try {
      const response = await refreshManagedKey();
      scheduleNextRefresh(response);
    } catch (err) {
      log.error({ err }, 'Managed key refresh failed, retrying in 1 minute');
      // On error, retry in 1 minute
      scheduleNextRefresh(null);
    }
  }, delay);

  log.info({
    refreshInMinutes: Math.round(delay / 60000),
    refreshAt: new Date(Date.now() + delay).toISOString(),
  }, 'Managed key refresh scheduled');
}

/**
 * Start the managed key renewal service
 * Returns the initial bind response or null if not in managed key mode
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
  currentKey = config.auth.apiKey || null;

  // Reset tracking state
  rotationTracking.lastWsEventAt = null;
  rotationTracking.lastPollAt = null;
  rotationTracking.expectedRotationAt = null;
  rotationTracking.graceExpiresAt = null;
  rotationTracking.wsEventReceived = false;
  rotationTracking.missedRotations = 0;

  log.info({
    managedKeyName: config.managedKey?.name,
    rotationMode: config.managedKey?.rotationMode,
  }, 'Starting managed key renewal service with safety rails');

  // Perform initial bind
  const bindResponse = await refreshManagedKey('scheduled');

  // Schedule next refresh (proactive pre-rotation polling)
  scheduleNextRefresh(bindResponse);

  // Start safety rails
  if (bindResponse?.graceExpiresAt) {
    scheduleGracePeriodPoll(new Date(bindResponse.graceExpiresAt));
  }
  startHeartbeatMonitor();

  log.info({
    nextRotationAt: bindResponse?.nextRotationAt,
    graceExpiresAt: bindResponse?.graceExpiresAt,
  }, 'Safety rails initialized');

  return bindResponse;
}

/**
 * Stop the managed key renewal service
 */
export function stopManagedKeyRenewal(): void {
  // Stop all timers
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (gracePeriodTimer) {
    clearTimeout(gracePeriodTimer);
    gracePeriodTimer = null;
  }
  stopHeartbeatMonitor();

  // Reset state
  isRunning = false;
  currentKey = null;
  staleKeyDetected = false;
  onKeyChangedCallback = null;

  // Reset tracking
  rotationTracking.lastWsEventAt = null;
  rotationTracking.lastPollAt = null;
  rotationTracking.expectedRotationAt = null;
  rotationTracking.graceExpiresAt = null;
  rotationTracking.wsEventReceived = false;
  // Note: don't reset missedRotations for debugging purposes

  log.debug('Managed key renewal service stopped');
}

/**
 * Force an immediate key refresh
 */
export async function forceRefresh(): Promise<ManagedApiKeyBindResponse | null> {
  if (!isManagedKeyMode()) {
    log.warn('Cannot force refresh - not in managed key mode');
    return null;
  }

  const response = await refreshManagedKey('manual');
  if (isRunning && response) {
    scheduleNextRefresh(response);
    scheduleGracePeriodPoll(response.graceExpiresAt ? new Date(response.graceExpiresAt) : null);
  }
  return response;
}

/**
 * Get current managed key status with safety rail tracking info
 */
export function getManagedKeyStatus(): {
  isRunning: boolean;
  isManagedMode: boolean;
  staleKeyDetected: boolean;
  managedKeyName?: string;
  currentKeyPrefix?: string;
  nextRotationAt?: string;
  graceExpiresAt?: string;
  safetyRails: {
    lastWsEventAt: string | null;
    lastPollAt: string | null;
    wsEventReceived: boolean;
    missedRotations: number;
    graceRemainingMs: number | null;
  };
} {
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
