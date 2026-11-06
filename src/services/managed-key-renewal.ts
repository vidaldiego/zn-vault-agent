// Path: src/services/managed-key-renewal.ts
// Automatic managed API key renewal service
// Re-exports from modular implementation for backward compatibility

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
} from './managed-key/index.js';
