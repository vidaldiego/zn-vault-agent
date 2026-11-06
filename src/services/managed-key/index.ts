// Path: src/services/managed-key/index.ts
// Re-exports for managed API key renewal service

// Main service functions
export {
  startManagedKeyRenewal,
  stopManagedKeyRenewal,
  forceRefresh,
  getManagedKeyStatus,
  onKeyChanged,
  setManagedKeyBinder,
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
