// Path: src/services/managed-key/scheduler.ts
// Refresh scheduling logic for managed API keys

import { loadConfig } from '../../lib/config.js';
import { createLogger } from '../../lib/logger.js';
import type { ManagedApiKeyBindResponse } from '../../lib/api.js';
import {
  DEFAULT_REFRESH_BEFORE_MS,
  MIN_REFRESH_INTERVAL_MS,
  FALLBACK_REFRESH_INTERVAL_MS,
} from './types.js';

const log = createLogger({ module: 'managed-key-scheduler' });

/**
 * Calculate when to next refresh the key based on rotation metadata.
 *
 * Priority order:
 * 1. nextRotationAt from bind response or config
 * 2. graceExpiresAt (refresh at 50% of remaining grace)
 * 3. Fallback interval (5 minutes)
 */
export function calculateNextRefreshMs(bindResponse: ManagedApiKeyBindResponse | null): number {
  const config = loadConfig();
  const now = Date.now();

  // Priority 1: Use nextRotationAt from bind response or config
  const nextRotationAt = bindResponse?.nextRotationAt ?? config.managedKey?.nextRotationAt;
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
  const graceExpiresAt = bindResponse?.graceExpiresAt ?? config.managedKey?.graceExpiresAt;
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
