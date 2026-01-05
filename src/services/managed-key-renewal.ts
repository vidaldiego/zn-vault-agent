// Path: src/services/managed-key-renewal.ts
// Automatic managed API key renewal service
// Schedules key refresh based on rotation metadata from the vault server

import { loadConfig, updateManagedKey, isManagedKeyMode } from '../lib/config.js';
import { bindManagedApiKey, type ManagedApiKeyBindResponse } from '../lib/api.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger({ module: 'managed-key-renewal' });

// How early before rotation to refresh (30 seconds default)
const DEFAULT_REFRESH_BEFORE_MS = 30 * 1000;

// Minimum refresh interval (don't refresh more than once per minute)
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

// Fallback interval if no rotation time is known (5 minutes)
const FALLBACK_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let refreshTimer: NodeJS.Timeout | null = null;
let isRunning = false;
let currentKey: string | null = null;

// Callback for when key changes (used to notify other parts of the system)
let onKeyChangedCallback: ((newKey: string) => void) | null = null;

/**
 * Set callback for when the API key changes
 * This allows other parts of the system (e.g., WebSocket) to be notified
 */
export function onKeyChanged(callback: (newKey: string) => void): void {
  onKeyChangedCallback = callback;
}

/**
 * Perform a managed key bind and update config
 */
async function refreshManagedKey(): Promise<ManagedApiKeyBindResponse | null> {
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
    log.debug({ name: config.managedKey.name }, 'Binding to managed key');

    const bindResponse = await bindManagedApiKey(config.managedKey.name);

    const oldKey = currentKey;
    currentKey = bindResponse.key;

    // Update config with new key and metadata
    updateManagedKey(bindResponse.key, {
      nextRotationAt: bindResponse.nextRotationAt,
      graceExpiresAt: bindResponse.graceExpiresAt,
      rotationMode: bindResponse.rotationMode,
    });

    // Notify if key changed
    if (oldKey && oldKey !== bindResponse.key) {
      log.info({
        oldPrefix: oldKey.substring(0, 8),
        newPrefix: bindResponse.key.substring(0, 8),
        nextRotationAt: bindResponse.nextRotationAt,
      }, 'Managed key rotated');

      if (onKeyChangedCallback) {
        onKeyChangedCallback(bindResponse.key);
      }
    } else {
      log.debug({
        prefix: bindResponse.key.substring(0, 8),
        nextRotationAt: bindResponse.nextRotationAt,
      }, 'Managed key refreshed (no change)');
    }

    return bindResponse;
  } catch (err) {
    log.error({ err, name: config.managedKey.name }, 'Failed to bind managed key');
    return null;
  }
}

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

  const config = loadConfig();
  isRunning = true;
  currentKey = config.auth.apiKey || null;

  log.info({
    managedKeyName: config.managedKey?.name,
    rotationMode: config.managedKey?.rotationMode,
  }, 'Starting managed key renewal service');

  // Perform initial bind
  const bindResponse = await refreshManagedKey();

  // Schedule next refresh
  scheduleNextRefresh(bindResponse);

  return bindResponse;
}

/**
 * Stop the managed key renewal service
 */
export function stopManagedKeyRenewal(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  isRunning = false;
  currentKey = null;
  onKeyChangedCallback = null;
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

  const response = await refreshManagedKey();
  if (isRunning) {
    scheduleNextRefresh(response);
  }
  return response;
}

/**
 * Get current managed key status
 */
export function getManagedKeyStatus(): {
  isRunning: boolean;
  isManagedMode: boolean;
  managedKeyName?: string;
  currentKeyPrefix?: string;
  nextRotationAt?: string;
  graceExpiresAt?: string;
} {
  const config = loadConfig();

  return {
    isRunning,
    isManagedMode: isManagedKeyMode(),
    managedKeyName: config.managedKey?.name,
    currentKeyPrefix: currentKey ? currentKey.substring(0, 8) + '...' : undefined,
    nextRotationAt: config.managedKey?.nextRotationAt,
    graceExpiresAt: config.managedKey?.graceExpiresAt,
  };
}
