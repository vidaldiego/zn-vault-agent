// Path: src/lib/websocket/index.ts
// WebSocket module re-exports

// Types
export type {
  CertificateEvent,
  SecretEvent,
  AgentUpdateEvent,
  ApiKeyRotationEvent,
  DegradedReason,
  DegradedConnectionInfo,
  ReprovisionEvent,
  UnifiedAgentEvent,
  SubscriptionUpdate,
  UnifiedWebSocketClient,
  EventHandlers,
} from './types.js';

export { WS_CONSTANTS } from './types.js';

// Connection utilities
export { buildWebSocketUrl, maskSensitiveUrl, getAgentVersion, getHostname } from './connection.js';

// Client
export { createUnifiedWebSocketClient, setShuttingDown, getIsShuttingDown } from './client.js';

// Managers (for advanced use cases)
export { HeartbeatManager } from './heartbeat.js';
export { ReconnectManager } from './reconnect.js';
export { MessageDispatcher } from './dispatcher.js';
