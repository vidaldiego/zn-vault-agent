// Path: src/lib/websocket/types.ts
// WebSocket event types and interfaces

import type { DynamicSecretsServerMessage } from '../../services/dynamic-secrets/types.js';

/**
 * Certificate rotation event
 */
export interface CertificateEvent {
  event: 'certificate.rotated' | 'certificate.created' | 'certificate.deleted';
  certificateId: string;
  fingerprint: string;
  version: number;
  timestamp: string;
}

/**
 * Secret update event
 */
export interface SecretEvent {
  event: 'secret.created' | 'secret.updated' | 'secret.rotated' | 'secret.deleted';
  secretId: string;
  alias: string;
  version: number;
  timestamp: string;
  tenantId: string;
}

/**
 * Agent update availability event
 */
export interface AgentUpdateEvent {
  event: 'update.available';
  channel: 'stable' | 'beta' | 'staging';
  version: string;
  releaseNotes?: string;
  timestamp: string;
}

/**
 * API key rotation event
 */
export interface ApiKeyRotationEvent {
  event: 'apikey.rotated';
  apiKeyId: string;
  apiKeyName: string;
  tenantId: string;
  newPrefix: string;
  graceExpiresAt: string;
  rotationMode: 'scheduled' | 'on-use' | 'on-bind';
  rotationCount: number;
  reason: string;
  timestamp: string;
}

/**
 * Degraded connection reason
 */
export type DegradedReason = 'key_expired' | 'key_revoked' | 'key_disabled' | 'auth_failed';

/**
 * Degraded connection info from server
 */
export interface DegradedConnectionInfo {
  isDegraded: true;
  reason: DegradedReason;
  agentId?: string;
  message: string;
  canReceiveReprovision: boolean;
}

/**
 * Reprovision event from server
 */
export interface ReprovisionEvent {
  event: 'agent.reprovision.available' | 'agent.reprovision.cancelled';
  agentId: string;
  tenantId: string;
  expiresAt?: string;
  reason?: string;
  timestamp: string;
}

/**
 * Unified agent event (from /v1/ws/agent)
 */
export interface UnifiedAgentEvent {
  type: 'pong' | 'event' | 'subscribed' | 'registered' | 'error' | 'connection_established' | 'degraded_connection' | 'reprovision_available' | 'dynamic-secrets';
  topic?: 'certificates' | 'secrets' | 'updates' | 'apikeys' | 'reprovision' | 'dynamic-secrets';
  data?: CertificateEvent | SecretEvent | AgentUpdateEvent | ApiKeyRotationEvent | ReprovisionEvent | DegradedConnectionInfo;
  subscriptions?: { certificates: string[]; secrets: string[]; managedKeys: string[]; updates: string | null };
  agentId?: string;
  message?: string;
  timestamp?: string;
  // For reprovision_available message
  reprovisionToken?: string;
  expiresAt?: string;
  // For dynamic-secrets messages
  dynamicSecrets?: DynamicSecretsServerMessage;
  // For vault public key exchange
  vaultPublicKey?: string;
}

/**
 * Subscription update options
 */
export interface SubscriptionUpdate {
  certIds?: string[];
  secretIds?: string[];
  managedKeys?: string[];
  updateChannel?: string;
}

/**
 * Unified WebSocket client interface for /v1/ws/agent
 */
export interface UnifiedWebSocketClient {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  onCertificateEvent(handler: (event: CertificateEvent) => void): void;
  onSecretEvent(handler: (event: SecretEvent) => void): void;
  onUpdateEvent(handler: (event: AgentUpdateEvent) => void): void;
  onApiKeyRotationEvent(handler: (event: ApiKeyRotationEvent) => void): void;
  onDegradedConnection(handler: (info: DegradedConnectionInfo) => void): void;
  onReprovisionAvailable(handler: (expiresAt: string) => void): void;
  onConnect(handler: (agentId: string) => void): void;
  onDisconnect(handler: (reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
  updateSubscriptions(subs: SubscriptionUpdate): void;
  // Handler removal for cleanup
  offCertificateEvent(handler: (event: CertificateEvent) => void): void;
  offSecretEvent(handler: (event: SecretEvent) => void): void;
  removeAllHandlers(): void;
}

/**
 * WebSocket connection constants
 */
export const WS_CONSTANTS = {
  /** Maximum delay between reconnection attempts (ms) */
  MAX_RECONNECT_DELAY: 30000,
  /** Initial delay for first reconnection attempt (ms) */
  INITIAL_RECONNECT_DELAY: 500,
  /** Interval between heartbeat pings (ms) */
  HEARTBEAT_INTERVAL: 15000,
  /** Timeout for pong response (ms) */
  PONG_TIMEOUT: 10000,
  /** WebSocket handshake timeout (ms) */
  HANDSHAKE_TIMEOUT: 10000,
} as const;

/**
 * Event handler arrays type
 */
export interface EventHandlers {
  certificate: ((event: CertificateEvent) => void)[];
  secret: ((event: SecretEvent) => void)[];
  update: ((event: AgentUpdateEvent) => void)[];
  apiKeyRotation: ((event: ApiKeyRotationEvent) => void)[];
  degradedConnection: ((info: DegradedConnectionInfo) => void)[];
  reprovisionAvailable: ((expiresAt: string) => void)[];
  connect: ((agentId: string) => void)[];
  disconnect: ((reason: string) => void)[];
  error: ((error: Error) => void)[];
}
