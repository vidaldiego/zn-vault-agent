// Path: zn-vault-agent/src/services/dynamic-secrets/types.ts
// Dynamic Secrets types for agent-side implementation

// ============================================================================
// Server → Agent Messages
// ============================================================================

/**
 * Request agent to generate credentials for a connection/role
 */
export interface DynamicSecretsGenerateRequest {
  event: 'dynamic-secrets.generate';
  requestId: string;
  connectionId: string;
  roleId: string;
  ttlSeconds: number;
  maxTtlSeconds: number;
  usernameTemplate: string;
  expiresAt: string;
  maxExpiresAt: string;
  /** Vault's public key for encrypting the password response (optional, can use stored key as fallback) */
  vaultPublicKey?: string;
  timestamp: string;
  deliveryId?: string;
}

/**
 * Request agent to revoke credentials
 */
export interface DynamicSecretsRevokeRequest {
  event: 'dynamic-secrets.revoke';
  requestId: string;
  leaseId: string;
  connectionId: string;
  username: string;
  reason?: string;
  timestamp: string;
  deliveryId?: string;
}

/**
 * Request agent to renew credentials
 */
export interface DynamicSecretsRenewRequest {
  event: 'dynamic-secrets.renew';
  requestId: string;
  leaseId: string;
  connectionId: string;
  roleId: string;
  username: string;
  newExpiresAt: string;
  timestamp: string;
  deliveryId?: string;
}

/**
 * Push connection configuration to agent (encrypted with agent's public key)
 */
export interface DynamicSecretsConfigPush {
  event: 'dynamic-secrets.config-push';
  connectionId: string;
  configVersion: number;
  encryptedConfig: string;
  roleIds: string[];
  timestamp: string;
  deliveryId?: string;
}

/**
 * Request agent to delete/forget a connection config
 */
export interface DynamicSecretsConfigRevoke {
  event: 'dynamic-secrets.config-revoke';
  connectionId: string;
  reason?: string;
  timestamp: string;
  deliveryId?: string;
}

// ============================================================================
// Agent → Server Messages
// ============================================================================

/**
 * Agent reports successful credential generation
 */
export interface DynamicSecretsGeneratedResponse {
  event: 'dynamic-secrets.generated';
  requestId: string;
  leaseId: string;
  username: string;
  encryptedPassword: string;
  expiresAt: string;
  timestamp: string;
}

/**
 * Agent reports successful revocation
 */
export interface DynamicSecretsRevokedResponse {
  event: 'dynamic-secrets.revoked';
  requestId: string;
  leaseId: string;
  success: boolean;
  timestamp: string;
}

/**
 * Agent reports successful renewal
 */
export interface DynamicSecretsRenewedResponse {
  event: 'dynamic-secrets.renewed';
  requestId: string;
  leaseId: string;
  success: boolean;
  newExpiresAt: string;
  timestamp: string;
}

/**
 * Agent reports an error
 */
export interface DynamicSecretsErrorResponse {
  event: 'dynamic-secrets.error';
  requestId: string;
  code: DynamicSecretsErrorCode;
  error: string;
  timestamp: string;
}

export type DynamicSecretsErrorCode =
  | 'DB_CONNECTION_FAILED'
  | 'SQL_EXECUTION_FAILED'
  | 'CONFIG_NOT_FOUND'
  | 'DECRYPTION_FAILED'
  | 'TIMEOUT'
  | 'UNKNOWN';

/**
 * Agent confirms it received and loaded a config
 */
export interface DynamicSecretsConfigAck {
  event: 'dynamic-secrets.config-ack';
  connectionId: string;
  configVersion: number;
  status: 'loaded' | 'failed';
  error?: string;
  timestamp: string;
}

// ============================================================================
// Union Types
// ============================================================================

export type DynamicSecretsServerMessage =
  | DynamicSecretsGenerateRequest
  | DynamicSecretsRevokeRequest
  | DynamicSecretsRenewRequest
  | DynamicSecretsConfigPush
  | DynamicSecretsConfigRevoke;

export type DynamicSecretsAgentMessage =
  | DynamicSecretsGeneratedResponse
  | DynamicSecretsRevokedResponse
  | DynamicSecretsRenewedResponse
  | DynamicSecretsErrorResponse
  | DynamicSecretsConfigAck;

// ============================================================================
// Config Types (Decrypted)
// ============================================================================

/**
 * Decrypted connection config stored in memory
 */
export interface DynamicSecretsConfig {
  connectionId: string;
  connectionType: 'POSTGRESQL' | 'MYSQL';
  connectionString: string;
  maxOpenConnections: number;
  connectionTimeoutSeconds: number;
  configVersion: number;
  roles: DynamicSecretsRoleConfig[];
}

/**
 * Role configuration within a connection
 */
export interface DynamicSecretsRoleConfig {
  roleId: string;
  roleName: string;
  creationStatements: string[];
  revocationStatements: string[];
  renewStatements: string[];
  defaultTtlSeconds: number | null;
  maxTtlSeconds: number | null;
  usernameTemplate: string;
}

/**
 * Encrypted config envelope received from server
 */
export interface EncryptedConfigEnvelope {
  encryptedKey: string;
  nonce: string;
  authTag: string;
  ciphertext: string;
}
