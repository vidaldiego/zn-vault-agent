// Path: zn-vault-agent/src/services/dynamic-secrets/handler.ts
// Dynamic secrets message handler - processes requests from vault

import { createLogger } from '../../lib/logger.js';
import type {
  DynamicSecretsServerMessage,
  DynamicSecretsAgentMessage,
  DynamicSecretsGenerateRequest,
  DynamicSecretsRevokeRequest,
  DynamicSecretsRenewRequest,
  DynamicSecretsConfigPush,
  DynamicSecretsConfigRevoke,
  DynamicSecretsGeneratedResponse,
  DynamicSecretsRevokedResponse,
  DynamicSecretsRenewedResponse,
  DynamicSecretsErrorResponse,
  DynamicSecretsConfigAck,
  DynamicSecretsErrorCode,
} from './types.js';
import {
  getConfig,
  getRoleConfig,
  decryptAndStoreConfig,
  removeConfig,
} from './config-store.js';
import {
  getOrCreateClient,
  closeClient,
  generateUsername,
  generatePassword,
} from './db-clients/index.js';
import { encryptPassword } from './keypair.js';

const log = createLogger({ module: 'dynamic-secrets-handler' });

// ============================================================================
// Types
// ============================================================================

/**
 * Send function to send messages back to vault
 */
export type SendFunction = (message: DynamicSecretsAgentMessage) => void;

/**
 * Vault public key provider (for encrypting passwords)
 */
let vaultPublicKey: string | null = null;

// ============================================================================
// Vault Public Key
// ============================================================================

/**
 * Set the vault's public key (received during connection)
 */
export function setVaultPublicKey(publicKey: string): void {
  vaultPublicKey = publicKey;
  log.info('Vault public key set');
}

/**
 * Get the vault's public key
 */
export function getVaultPublicKey(): string | null {
  return vaultPublicKey;
}

// ============================================================================
// Message Handler
// ============================================================================

/**
 * Handle a dynamic secrets message from vault
 */
export async function handleDynamicSecretsMessage(
  message: DynamicSecretsServerMessage,
  send: SendFunction
): Promise<void> {
  log.debug({ event: message.event }, 'Handling dynamic secrets message');

  try {
    switch (message.event) {
      case 'dynamic-secrets.config-push':
        handleConfigPush(message, send);
        break;

      case 'dynamic-secrets.config-revoke':
        await handleConfigRevoke(message, send);
        break;

      case 'dynamic-secrets.generate':
        await handleGenerate(message, send);
        break;

      case 'dynamic-secrets.revoke':
        await handleRevoke(message, send);
        break;

      case 'dynamic-secrets.renew':
        await handleRenew(message, send);
        break;

      default:
        log.warn({ event: (message as { event: string }).event }, 'Unknown dynamic secrets event');
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err: errorMessage, event: message.event }, 'Error handling dynamic secrets message');

    // Send error response if we have a requestId
    if ('requestId' in message) {
      sendError(send, message.requestId, 'UNKNOWN', errorMessage);
    }
  }
}

// ============================================================================
// Config Handlers
// ============================================================================

function handleConfigPush(
  message: DynamicSecretsConfigPush,
  send: SendFunction
): void {
  log.info({
    connectionId: message.connectionId,
    configVersion: message.configVersion,
    roleCount: message.roleIds.length,
  }, 'Received config push');

  const result = decryptAndStoreConfig(
    message.connectionId,
    message.configVersion,
    message.encryptedConfig
  );

  const ack: DynamicSecretsConfigAck = {
    event: 'dynamic-secrets.config-ack',
    connectionId: message.connectionId,
    configVersion: message.configVersion,
    status: result.success ? 'loaded' : 'failed',
    error: result.error,
    timestamp: new Date().toISOString(),
  };

  send(ack);
}

async function handleConfigRevoke(
  message: DynamicSecretsConfigRevoke,
  _send: SendFunction
): Promise<void> {
  log.info({
    connectionId: message.connectionId,
    reason: message.reason,
  }, 'Received config revoke');

  // Close any cached database clients for this connection
  await closeClient(message.connectionId);

  // Remove config from store
  removeConfig(message.connectionId);

  // No response needed for config revoke
}

// ============================================================================
// Credential Handlers
// ============================================================================

async function handleGenerate(
  message: DynamicSecretsGenerateRequest,
  send: SendFunction
): Promise<void> {
  const { requestId, connectionId, roleId, usernameTemplate, expiresAt, vaultPublicKey: requestVaultPublicKey } = message;

  log.info({ requestId, connectionId, roleId }, 'Generating credentials');

  // Get config
  const config = getConfig(connectionId);
  if (!config) {
    sendError(send, requestId, 'CONFIG_NOT_FOUND', `Config not found for connection: ${connectionId}`);
    return;
  }

  // Get role config
  const roleConfig = getRoleConfig(connectionId, roleId);
  if (!roleConfig) {
    sendError(send, requestId, 'CONFIG_NOT_FOUND', `Role not found: ${roleId}`);
    return;
  }

  // Get vault public key for encrypting password (prefer from request, fallback to stored)
  const vaultKey = requestVaultPublicKey ?? vaultPublicKey;
  if (!vaultKey) {
    sendError(send, requestId, 'DECRYPTION_FAILED', 'Vault public key not available');
    return;
  }

  try {
    // Generate username and password
    const username = generateUsername(usernameTemplate || roleConfig.usernameTemplate, roleConfig.roleName);
    const password = generatePassword();

    // Get database client
    const client = getOrCreateClient(connectionId, config.connectionType, {
      connectionString: config.connectionString,
      connectionTimeoutSeconds: config.connectionTimeoutSeconds,
      maxConnections: config.maxOpenConnections,
    });

    // Create credential
    await client.createCredential(
      roleConfig.creationStatements,
      username,
      password,
      expiresAt
    );

    // Encrypt password with vault's public key
    const encryptedPassword = encryptPassword(password, vaultKey);

    // Generate lease ID
    const leaseId = `dbl_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`;

    const response: DynamicSecretsGeneratedResponse = {
      event: 'dynamic-secrets.generated',
      requestId,
      leaseId,
      username,
      encryptedPassword,
      expiresAt,
      timestamp: new Date().toISOString(),
    };

    send(response);

    log.info({ requestId, leaseId, username }, 'Credentials generated');
  } catch (err: unknown) {
    // Extract error details - PostgreSQL errors may have additional properties
    let errorMessage: string;
    if (err instanceof Error) {
      // PostgreSQL errors have code, detail, hint properties
      const pgErr = err as Error & { code?: string; detail?: string; hint?: string };
      // Use || for message (which could be empty string), ?? for optional properties
      errorMessage = pgErr.message || (pgErr.detail ?? pgErr.hint ?? 'Unknown error');
      if (pgErr.code) {
        errorMessage = `[${pgErr.code}] ${errorMessage}`;
      }
    } else if (err !== null && err !== undefined) {
      if (typeof err === 'object') {
        try {
          errorMessage = JSON.stringify(err);
        } catch {
          errorMessage = 'Unknown error (could not serialize)';
        }
      } else if (typeof err === 'string') {
        errorMessage = err;
      } else {
        // Other primitive types: number, boolean, symbol, bigint
        errorMessage = `Unknown error (${typeof err})`;
      }
    } else {
      errorMessage = 'Unknown error (no error object)';
    }

    const errorCode: DynamicSecretsErrorCode = errorMessage.toLowerCase().includes('connection')
      ? 'DB_CONNECTION_FAILED'
      : 'SQL_EXECUTION_FAILED';

    log.error({ err, requestId, errorMessage }, 'Credential generation failed');
    sendError(send, requestId, errorCode, errorMessage);
  }
}

async function handleRevoke(
  message: DynamicSecretsRevokeRequest,
  send: SendFunction
): Promise<void> {
  const { requestId, connectionId, leaseId, username, reason } = message;

  log.info({ requestId, connectionId, leaseId, username, reason }, 'Revoking credentials');

  // Get config
  const config = getConfig(connectionId);
  if (!config) {
    // Config might have been removed - that's OK, just report success
    log.warn({ connectionId, leaseId }, 'Config not found for revocation, reporting success');

    const response: DynamicSecretsRevokedResponse = {
      event: 'dynamic-secrets.revoked',
      requestId,
      leaseId,
      success: true,
      timestamp: new Date().toISOString(),
    };

    send(response);
    return;
  }

  // Find role with revocation statements (use first role, they should all have same statements)
  if (config.roles.length === 0) {
    log.warn({ connectionId, leaseId }, 'No roles found for revocation, reporting success');

    const response: DynamicSecretsRevokedResponse = {
      event: 'dynamic-secrets.revoked',
      requestId,
      leaseId,
      success: true,
      timestamp: new Date().toISOString(),
    };

    send(response);
    return;
  }

  const roleConfig = config.roles[0];

  try {
    // Get database client
    const client = getOrCreateClient(connectionId, config.connectionType, {
      connectionString: config.connectionString,
      connectionTimeoutSeconds: config.connectionTimeoutSeconds,
      maxConnections: config.maxOpenConnections,
    });

    // Revoke credential
    await client.revokeCredential(roleConfig.revocationStatements, username);

    const response: DynamicSecretsRevokedResponse = {
      event: 'dynamic-secrets.revoked',
      requestId,
      leaseId,
      success: true,
      timestamp: new Date().toISOString(),
    };

    send(response);

    log.info({ requestId, leaseId, username }, 'Credentials revoked');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err: errorMessage, requestId, leaseId }, 'Revocation failed');

    // Report success anyway - the lease should be marked as revoked
    // even if we couldn't revoke on the database
    const response: DynamicSecretsRevokedResponse = {
      event: 'dynamic-secrets.revoked',
      requestId,
      leaseId,
      success: false,
      timestamp: new Date().toISOString(),
    };

    send(response);
  }
}

async function handleRenew(
  message: DynamicSecretsRenewRequest,
  send: SendFunction
): Promise<void> {
  const { requestId, connectionId, roleId, leaseId, username, newExpiresAt } = message;

  log.info({ requestId, connectionId, roleId, leaseId, username, newExpiresAt }, 'Renewing credentials');

  // Get config
  const config = getConfig(connectionId);
  if (!config) {
    // Config might have been removed - report success, lease will be renewed anyway
    log.warn({ connectionId, leaseId }, 'Config not found for renewal, reporting success');

    const response: DynamicSecretsRenewedResponse = {
      event: 'dynamic-secrets.renewed',
      requestId,
      leaseId,
      success: true,
      newExpiresAt,
      timestamp: new Date().toISOString(),
    };

    send(response);
    return;
  }

  // Get role config
  const roleConfig = getRoleConfig(connectionId, roleId);
  if (!roleConfig) {
    log.warn({ connectionId, roleId, leaseId }, 'Role not found for renewal, reporting success');

    const response: DynamicSecretsRenewedResponse = {
      event: 'dynamic-secrets.renewed',
      requestId,
      leaseId,
      success: true,
      newExpiresAt,
      timestamp: new Date().toISOString(),
    };

    send(response);
    return;
  }

  try {
    // Get database client
    const client = getOrCreateClient(connectionId, config.connectionType, {
      connectionString: config.connectionString,
      connectionTimeoutSeconds: config.connectionTimeoutSeconds,
      maxConnections: config.maxOpenConnections,
    });

    // Renew credential (if renewal statements are configured)
    if (roleConfig.renewStatements.length > 0) {
      await client.renewCredential(roleConfig.renewStatements, username, newExpiresAt);
    }

    const response: DynamicSecretsRenewedResponse = {
      event: 'dynamic-secrets.renewed',
      requestId,
      leaseId,
      success: true,
      newExpiresAt,
      timestamp: new Date().toISOString(),
    };

    send(response);

    log.info({ requestId, leaseId, username, newExpiresAt }, 'Credentials renewed');
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ err: errorMessage, requestId, leaseId }, 'Renewal failed');

    // Report success anyway - the lease should be renewed even if
    // we couldn't execute renewal statements
    const response: DynamicSecretsRenewedResponse = {
      event: 'dynamic-secrets.renewed',
      requestId,
      leaseId,
      success: false,
      newExpiresAt,
      timestamp: new Date().toISOString(),
    };

    send(response);
  }
}

// ============================================================================
// Error Helper
// ============================================================================

function sendError(
  send: SendFunction,
  requestId: string,
  code: DynamicSecretsErrorCode,
  error: string
): void {
  const response: DynamicSecretsErrorResponse = {
    event: 'dynamic-secrets.error',
    requestId,
    code,
    error,
    timestamp: new Date().toISOString(),
  };

  send(response);

  log.error({ requestId, code, error }, 'Sent error response');
}
