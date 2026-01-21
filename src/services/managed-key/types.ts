// Path: src/services/managed-key/types.ts
// Constants and types for managed API key renewal

// ============================================================================
// Configuration Constants
// ============================================================================

/** How early before rotation to refresh (30 seconds default) */
export const DEFAULT_REFRESH_BEFORE_MS = 30 * 1000;

/** Minimum refresh interval (don't refresh more than once per minute) */
export const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

/** Fallback interval if no rotation time is known (5 minutes) */
export const FALLBACK_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Grace period polling: poll at 50% of remaining grace time if no WS event */
export const GRACE_PERIOD_POLL_RATIO = 0.5;

/** Minimum grace period poll delay (10 seconds) */
export const MIN_GRACE_POLL_DELAY_MS = 10 * 1000;

/** Heartbeat freshness monitor interval (60 seconds) */
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** Connection recovery delay after reconnect (2 seconds) */
export const RECONNECT_POLL_DELAY_MS = 2 * 1000;

/** Maximum retry attempts for rotation handling */
export const MAX_RETRY_ATTEMPTS = 5;

// ============================================================================
// Types
// ============================================================================

/** Rotation tracking state */
export interface RotationTracking {
  /** When we last received a WS rotation event */
  lastWsEventAt: number | null;
  /** When we last polled for rotation */
  lastPollAt: number | null;
  /** When rotation is expected */
  expectedRotationAt: number | null;
  /** When grace period ends */
  graceExpiresAt: number | null;
  /** Did we receive WS event for current rotation? */
  wsEventReceived: boolean;
  /** Count of rotations detected via polling (WS missed) */
  missedRotations: number;
}

/** Source of key refresh trigger */
export type RefreshSource =
  | 'scheduled'
  | 'ws_event'
  | 'grace_poll'
  | 'reconnect'
  | 'heartbeat'
  | 'manual';

/** Managed key service state */
export interface ManagedKeyState {
  isRunning: boolean;
  currentKey: string | null;
  staleKeyDetected: boolean;
  onKeyChangedCallback: ((newKey: string) => void) | null;
}

/** Managed key status response */
export interface ManagedKeyStatus {
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
}

/** Create initial rotation tracking state */
export function createInitialRotationTracking(): RotationTracking {
  return {
    lastWsEventAt: null,
    lastPollAt: null,
    expectedRotationAt: null,
    graceExpiresAt: null,
    wsEventReceived: false,
    missedRotations: 0,
  };
}

/** Reset rotation tracking (preserves missedRotations for debugging) */
export function resetRotationTracking(tracking: RotationTracking): void {
  tracking.lastWsEventAt = null;
  tracking.lastPollAt = null;
  tracking.expectedRotationAt = null;
  tracking.graceExpiresAt = null;
  tracking.wsEventReceived = false;
  // Note: don't reset missedRotations for debugging purposes
}
