// Path: src/services/managed-key/index.ts
// Re-exports for managed API key renewal service

// Main service functions
export {
  startManagedKeyRenewal,
  stopManagedKeyRenewal,
  forceRefresh,
  getManagedKeyStatus,
  onKeyChanged,
  onWebSocketReconnect,
  onWebSocketAuthFailure,
  onWebSocketRotationEvent,
} from './service.js';

// Types
export type {
  RotationTracking,
  RefreshSource,
  ManagedKeyStatus,
} from './types.js';

// Constants (for testing/external use)
export {
  DEFAULT_REFRESH_BEFORE_MS,
  MIN_REFRESH_INTERVAL_MS,
  FALLBACK_REFRESH_INTERVAL_MS,
  GRACE_PERIOD_POLL_RATIO,
  MIN_GRACE_POLL_DELAY_MS,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_POLL_DELAY_MS,
  MAX_RETRY_ATTEMPTS,
} from './types.js';

// Scheduler (for testing/external use)
export { calculateNextRefreshMs } from './scheduler.js';
