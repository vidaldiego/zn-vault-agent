// Path: src/services/managed-key/types.ts
// Constants and types for managed API key renewal

import type { KeyRotationMeta, KeyRotationSource } from '../../lib/key-rotation-propagation.js';

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

/** Source of key refresh trigger (canonical union lives with the propagator) */
export type RefreshSource = KeyRotationSource;

/**
 * Rotation metadata passed to the onKeyChanged callback so consumers
 * (plugin keyRotated dispatch, exec env files) can be refreshed regardless
 * of which channel detected the rotation (2026-07-05 incident fix).
 * Same shape the key-rotation propagator consumes.
 */
export type KeyChangeMeta = KeyRotationMeta;

/** Managed key service state */
export interface ManagedKeyState {
  isRunning: boolean;
  currentKey: string | null;
  staleKeyDetected: boolean;
  onKeyChangedCallback: ((newKey: string, meta: KeyChangeMeta) => void) | null;
}

/** Managed key status response */
export interface ManagedKeyStatus {
  isRunning: boolean;
  isManagedMode: boolean;
  staleKeyDetected: boolean;
  managedKeyName?: string;
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
