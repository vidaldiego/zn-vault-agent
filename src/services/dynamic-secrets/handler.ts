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
  DynamicSecretsConfigInventory,
  DynamicSecretsGeneratedResponse,
  DynamicSecretsRevokedResponse,
  DynamicSecretsRenewedResponse,
  DynamicSecretsErrorResponse,
  DynamicSecretsConfigAck,
  DynamicSecretsConfigInventoryAck,
  DynamicSecretsConfig,
  DynamicSecretsErrorCode,
} from './types.js';
import {
  getConfig,
  getRoleConfig,
  getAllConfigIds,
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
const CANONICAL_MYSQL_CREATE_USER =
  "CREATE USER '{{username}}'@'%' IDENTIFIED BY '{{password}}'";
const CANONICAL_POSTGRES_CREATE_ROLE =
  "CREATE ROLE \"{{username}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'";

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
    const connectionId = 'connectionId' in message && typeof message.connectionId === 'string'
      ? message.connectionId
      : null;
    const dispatch = async (): Promise<void> => {
      switch (message.event) {
        case 'dynamic-secrets.config-push':
          await handleConfigPush(message, send);
          break;

        case 'dynamic-secrets.config-revoke':
          await handleConfigRevoke(message, send);
          break;

        case 'dynamic-secrets.config-inventory-v2':
          await handleConfigInventory(message, send);
          break;

        case 'dynamic-secrets.generate-v2':
          await handleGenerate(message, send);
          break;

        case 'dynamic-secrets.revoke-v2':
          await handleRevoke(message, send);
          break;

        case 'dynamic-secrets.renew-v2':
          await handleRenew(message, send);
          break;

        default:
          log.warn({ event: (message as { event: string }).event }, 'Unknown dynamic secrets event');
      }
    };
    if (connectionId) {
      await withConnectionMessageLock(connectionId, dispatch);
    } else {
      await dispatch();
    }
  } catch {
    // Driver/config errors may carry rendered SQL or passwords. This protocol
    // boundary exposes only a stable code/message and non-secret request data.
    log.error({ event: message.event }, 'Error handling dynamic secrets message');

    // Send error response if we have a requestId
    if ('requestId' in message) {
      sendError(send, message.requestId, 'UNKNOWN', 'Dynamic secrets request failed');
    }
  }
}

const connectionMessageTails = new Map<string, Promise<void>>();

async function withConnectionMessageLock(
  connectionId: string,
  operation: () => Promise<void>
): Promise<void> {
  const previous = connectionMessageTails.get(connectionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  connectionMessageTails.set(connectionId, current);
  await previous.catch(() => undefined);
  try {
    await operation();
  } finally {
    release();
    if (connectionMessageTails.get(connectionId) === current) {
      connectionMessageTails.delete(connectionId);
    }
  }
}

// ============================================================================
// Config Handlers
// ============================================================================

async function handleConfigPush(
  message: DynamicSecretsConfigPush,
  send: SendFunction
): Promise<void> {
  log.info({
    connectionId: message.connectionId,
    configVersion: message.configVersion,
    roleCount: message.roleIds.length,
  }, 'Received config push');

  const result = await decryptAndStoreConfig(
    message.connectionId,
    message.configVersion,
    message.encryptedConfig,
    async () => {
      await closeClient(message.connectionId);
    }
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
  }, 'Received config revoke');

  // Close any cached database clients for this connection
  await closeClient(message.connectionId);

  // Remove config from store
  removeConfig(message.connectionId);

  // No response needed for config revoke
}

async function handleConfigInventory(
  message: DynamicSecretsConfigInventory,
  send: SendFunction
): Promise<void> {
  const respond = (success: boolean, retainedCount: number, removedCount: number): void => {
    const ack: DynamicSecretsConfigInventoryAck = {
      event: 'dynamic-secrets.config-inventory-ack-v2',
      protocolVersion: 2,
      requestId: message.requestId,
      retainedCount,
      removedCount,
      success,
      timestamp: new Date().toISOString(),
    };
    send(ack);
  };

  if (
    message.protocolVersion !== 2
    || !Array.isArray(message.connectionIds)
    || message.connectionIds.some(id => typeof id !== 'string' || id.length === 0)
  ) {
    respond(false, getAllConfigIds().length, 0);
    return;
  }

  const authoritative = new Set(message.connectionIds);
  let removedCount = 0;
  for (const connectionId of getAllConfigIds()) {
    if (authoritative.has(connectionId)) continue;
    await withConnectionMessageLock(connectionId, async () => {
      // Re-check after waiting: a newer handler could already have removed it.
      if (!getConfig(connectionId) || authoritative.has(connectionId)) return;
      await closeClient(connectionId);
      if (removeConfig(connectionId)) removedCount++;
    });
  }

  const retainedCount = getAllConfigIds()
    .filter(connectionId => authoritative.has(connectionId)).length;
  respond(true, retainedCount, removedCount);
  log.info({retainedCount, removedCount}, 'Applied authoritative dynamic secrets inventory');
}

// ============================================================================
// Credential Handlers
// ============================================================================

async function handleGenerate(
  message: DynamicSecretsGenerateRequest,
  send: SendFunction
): Promise<void> {
  const {
    requestId,
    leaseId,
    connectionId,
    roleId,
    usernameTemplate,
    expiresAt,
    vaultPublicKey: requestVaultPublicKey,
  } = message;

  log.info({ requestId, connectionId, roleId }, 'Generating credentials');

  // Runtime validation precedes config lookup, password generation, client
  // acquisition, and target mutation. Old generate requests use a different
  // event and never reach this handler.
  if (message.protocolVersion !== 2 || typeof leaseId !== 'string' || leaseId.length === 0) {
    sendError(send, requestId, 'UNKNOWN', 'Credential generation protocol is unsupported');
    return;
  }

  // Get config
  const config = getConfig(connectionId);
  if (!config) {
    sendError(send, requestId, 'CONFIG_NOT_FOUND', 'Dynamic secrets config is unavailable');
    return;
  }

  // The request is executable only against the exact config snapshot and
  // durable target epoch selected by vault. This check is deliberately before
  // role lookup, password generation, client acquisition, or target SQL.
  if (
    config.configVersion !== message.configVersion
    || config.targetVersion !== message.targetVersion
  ) {
    sendError(send, requestId, 'CONFIG_NOT_FOUND', 'Dynamic secrets config version mismatch');
    return;
  }

  // Get role config
  const roleConfig = getRoleConfig(connectionId, roleId);
  if (!roleConfig) {
    sendError(send, requestId, 'CONFIG_NOT_FOUND', 'Dynamic secrets role config is unavailable');
    return;
  }
  if (roleConfig.roleVersion !== message.roleVersion) {
    sendError(send, requestId, 'CONFIG_NOT_FOUND', 'Dynamic secrets role version mismatch');
    return;
  }

  if (roleConfig.templateBacked !== true) {
    sendError(send, requestId, 'CONFIG_NOT_FOUND', 'Raw agent credential generation is unsupported');
    return;
  }

  // Disabled roles are intentionally retained in config so historical leases
  // can still be revoked. They must never reach password generation, client
  // acquisition, or target-side CREATE. Legacy configs omit this field and
  // contained enabled roles only, so only an explicit false is rejected.
  if (roleConfig.generationEnabled === false) {
    sendError(send, requestId, 'CONFIG_NOT_FOUND', 'Role is disabled for credential generation');
    return;
  }

  // Get vault public key for encrypting password (prefer from request, fallback to stored)
  const vaultKey = requestVaultPublicKey ?? vaultPublicKey;
  if (!vaultKey) {
    sendError(send, requestId, 'DECRYPTION_FAILED', 'Vault public key not available');
    return;
  }

  if (
    config.connectionType === 'MYSQL'
    && !hasReplaySafeMySqlCredentialLifecycle(
      roleConfig.creationStatements,
      roleConfig.revocationStatements
    )
  ) {
    log.error(
      { requestId, connectionId, roleId, errorCode: 'NON_CANONICAL_MYSQL_IDENTITY' },
      'MySQL credential generation requires canonical account identity'
    );
    sendError(
      send,
      requestId,
      'SQL_EXECUTION_FAILED',
      'MySQL credential generation requires canonical account identity'
    );
    return;
  }

  if (
    config.connectionType === 'POSTGRESQL'
    && roleConfig.creationStatements[0] !== CANONICAL_POSTGRES_CREATE_ROLE
  ) {
    log.error(
      { requestId, connectionId, roleId, errorCode: 'NON_CANONICAL_POSTGRES_IDENTITY' },
      'PostgreSQL credential generation requires canonical account identity'
    );
    sendError(
      send,
      requestId,
      'SQL_EXECUTION_FAILED',
      'PostgreSQL credential generation requires canonical account identity'
    );
    return;
  }

  try {
    // Generate username and password
    const effectiveUsernameTemplate = usernameTemplate || roleConfig.usernameTemplate;
    const username = generateUsername(effectiveUsernameTemplate, roleConfig.roleName);

    // New vaults send the already-generated and validated username literally.
    // A buggy/incompatible agent must fail before password generation or any
    // target mutation if its sanitizer changes that literal identity.
    const literalTemplate = !effectiveUsernameTemplate.includes('{{')
      && !effectiveUsernameTemplate.includes('}}');
    if (literalTemplate && username !== effectiveUsernameTemplate) {
      log.error(
        { requestId, connectionId, roleId, errorCode: 'USERNAME_IDENTITY_MISMATCH' },
        'Generated username did not match requested literal identity'
      );
      sendError(
        send,
        requestId,
        'SQL_EXECUTION_FAILED',
        'Generated username did not match requested literal identity'
      );
      return;
    }

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

    const response: DynamicSecretsGeneratedResponse = {
      event: 'dynamic-secrets.generated-v2',
      protocolVersion: 2,
      requestId,
      leaseId,
      connectionId,
      roleId,
      username,
      configVersion: message.configVersion,
      targetVersion: message.targetVersion,
      roleVersion: message.roleVersion,
      encryptedPassword,
      expiresAt,
      timestamp: new Date().toISOString(),
    };

    send(response);

    log.info({ requestId, leaseId, username }, 'Credentials generated');
  } catch (err: unknown) {
    const errorCode = classifyCredentialGenerationError(err);
    const stableMessage = errorCode === 'DB_CONNECTION_FAILED'
      ? 'Database connection failed while generating credential'
      : 'Database credential generation failed';
    log.error({ requestId, connectionId, roleId, errorCode }, 'Credential generation failed');
    sendError(send, requestId, errorCode, stableMessage);
  }
}

async function handleRevoke(
  message: DynamicSecretsRevokeRequest,
  send: SendFunction
): Promise<void> {
  const { requestId, connectionId, roleId, leaseId, username, reason } = message;

  log.info({ requestId, connectionId, roleId, leaseId, username, reason }, 'Revoking credentials');

  const respond = (success: boolean): void => {
    const response: DynamicSecretsRevokedResponse = {
      event: 'dynamic-secrets.revoked',
      protocolVersion: 2,
      requestId,
      leaseId,
      connectionId,
      roleId,
      username,
      configVersion: message.configVersion,
      targetVersion: message.targetVersion,
      roleVersion: message.roleVersion,
      success,
      timestamp: new Date().toISOString(),
    };
    send(response);
  };

  if (message.protocolVersion !== 2) {
    respond(false);
    return;
  }

  // Get config and validate every freshness/target field before role lookup,
  // client acquisition, catalog probing, or configured revocation SQL.
  const config = getConfig(connectionId);
  if (!config) {
    log.warn({ connectionId, roleId, leaseId }, 'Config not found for revocation');
    respond(false);
    return;
  }
  if (
    config.configVersion !== message.configVersion
    || config.targetVersion !== message.targetVersion
  ) {
    log.warn({ connectionId, roleId, leaseId }, 'Config version mismatch for revocation');
    respond(false);
    return;
  }

  // Revocation statements are role-specific. Selecting roles[0] can execute
  // unrelated SQL when a connection has multiple roles, so require the exact
  // role identity carried by the lease-backed request.
  const roleConfig = getRoleConfig(connectionId, roleId);
  if (
    !roleConfig
    || roleConfig.roleId !== roleId
    || roleConfig.roleVersion !== message.roleVersion
  ) {
    log.warn({ connectionId, roleId, leaseId }, 'Role not found for revocation');
    respond(false);
    return;
  }

  // Migration 096 deliberately keeps disabled legacy roles in agent config so
  // their historical leases remain revocable. A mixed-version vault cannot
  // validate encrypted plaintext and may have written arbitrary raw SQL into
  // such a row. Fail before client acquisition/probing/SQL unless the payload
  // independently proves either the fixed-host recovery contract or the
  // canonical template lifecycle. Never probe and then execute arbitrary SQL.
  const disabledRecoveryIsReplaySafe = config.connectionType === 'MYSQL'
    ? isExactIdempotentMySqlDrop(roleConfig.revocationStatements)
    : isExactIdempotentPostgresDrop(roleConfig.revocationStatements);
  if (
    roleConfig.generationEnabled === false
    && roleConfig.templateBacked !== true
    && !disabledRecoveryIsReplaySafe
  ) {
    log.error(
      {requestId, connectionId, roleId, leaseId, errorCode: 'UNSAFE_DISABLED_MYSQL_LIFECYCLE'},
      'Disabled raw role revocation contract is not replay-safe'
    );
    respond(false);
    return;
  }

  try {
    // Get database client
    const client = getOrCreateClient(connectionId, config.connectionType, {
      connectionString: config.connectionString,
      connectionTimeoutSeconds: config.connectionTimeoutSeconds,
      maxConnections: config.maxOpenConnections,
    });

    // Crash-safe replay: if a prior attempt revoked the account and vault
    // crashed after receiving/sending ACK but before markCompleted, absence is
    // already exact proof and raw revocation SQL must not be executed again.
    const replaySafeMySqlRevocation = config.connectionType === 'MYSQL'
      && isExactIdempotentMySqlDrop(roleConfig.revocationStatements);
    // DROP USER IF EXISTS is already replay-safe and the S1 account need not
    // be granted SELECT on mysql.* merely to prove that. Non-idempotent exact
    // DROP and PostgreSQL use the existence probe when it is authorized.
    if (!replaySafeMySqlRevocation) {
      try {
        if (!await client.credentialExists(username)) {
          respond(true);
          log.info({ requestId, leaseId, roleId, username }, 'Credential already absent');
          return;
        }
      } catch {
        // Some least-privilege deployments cannot introspect account catalogs.
        // Continue with the configured revoke; never infer absence from a failed
        // probe.
      }
    }

    // Revoke credential
    await client.revokeCredential(roleConfig.revocationStatements, username);

    // A driver resolving only proves that its statement batch returned. For
    // PostgreSQL, exact catalog absence is the v2 proof that authorizes vault
    // to terminalize the lease; a no-op/partial teardown or probe failure must
    // remain retryable and fail closed.
    if (config.connectionType === 'POSTGRESQL') {
      if (await client.credentialExists(username) !== false) {
        throw new Error('PostgreSQL credential absence was not confirmed');
      }
    }

    respond(true);

    log.info({ requestId, leaseId, roleId, username }, 'Credentials revoked');
  } catch {
    // The first revoke may actually have succeeded and only its ACK/query
    // failed. Re-probe exact identity; absence converts the retry to an exact
    // v2 success. A failed probe stays fail-closed.
    let credentialAbsent = false;
    if (!credentialAbsent) {
      try {
        const client = getOrCreateClient(connectionId, config.connectionType, {
          connectionString: config.connectionString,
          connectionTimeoutSeconds: config.connectionTimeoutSeconds,
          maxConnections: config.maxOpenConnections,
        });
        credentialAbsent = !await client.credentialExists(username);
      } catch {
        credentialAbsent = false;
      }
    }
    if (
      !credentialAbsent
      && config.connectionType === 'MYSQL'
      && hasReplaySafeMySqlCredentialLifecycle(
        roleConfig.creationStatements,
        roleConfig.revocationStatements
      )
    ) {
      try {
        const client = getOrCreateClient(connectionId, config.connectionType, {
          connectionString: config.connectionString,
          connectionTimeoutSeconds: config.connectionTimeoutSeconds,
          maxConnections: config.maxOpenConnections,
        });
        if (!client.ensureCredentialAbsent) throw new Error('Canonical cleanup unavailable');
        await client.ensureCredentialAbsent(username);
        credentialAbsent = true;
      } catch {
        credentialAbsent = false;
      }
    }
    log.error(
      { requestId, leaseId, roleId, outcome: credentialAbsent ? 'already_absent' : 'unverified' },
      'Revocation did not complete normally'
    );
    respond(credentialAbsent);
  }
}

function classifyCredentialGenerationError(error: unknown): DynamicSecretsErrorCode {
  if (typeof error !== 'object' || error === null) return 'SQL_EXECUTION_FAILED';
  try {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EHOSTUNREACH',
    ].includes(code)
      ? 'DB_CONNECTION_FAILED'
      : 'SQL_EXECUTION_FAILED';
  } catch {
    return 'SQL_EXECUTION_FAILED';
  }
}

function hasReplaySafeMySqlCredentialLifecycle(
  creationStatements: string[],
  revocationStatements: string[]
): boolean {
  if (creationStatements[0] !== CANONICAL_MYSQL_CREATE_USER) return false;
  const creationPreservesIdentity = creationStatements.slice(1).every(statement => {
    let normalized = statement.trim();
    if (normalized.endsWith(';')) normalized = normalized.slice(0, -1).trimEnd();
    if (normalized.includes(';')) return false;
    return /^GRANT\b[\s\S]*$/i.test(normalized)
      || /^FLUSH\s+PRIVILEGES$/i.test(normalized);
  });
  return creationPreservesIdentity && isExactMySqlDrop(revocationStatements);
}

function isExactIdempotentPostgresDrop(statements: string[]): boolean {
  return statements.length === 1
    && /^DROP\s+ROLE\s+IF\s+EXISTS\s+"\{\{username\}\}"\s*;?$/i
      .test(statements[0]?.trim() ?? '');
}

/**
 * Recovery contract for historical raw roles. The account host may be any
 * fixed literal (not necessarily `%`), but the operation must be a single,
 * idempotent DROP for the exact generated username. No catalog privilege is
 * needed, and replay after an ACK/mark-completed crash is safe.
 */
function isExactIdempotentMySqlDrop(revocationStatements: string[]): boolean {
  if (revocationStatements.length !== 1) return false;
  const statement = revocationStatements[0]?.trim() ?? '';
  return /^DROP\s+USER\s+IF\s+EXISTS\s+'\{\{username\}\}'@'[^'\\\s;{}]+'\s*;?$/i
    .test(statement);
}

function isExactMySqlDrop(
  revocationStatements: string[],
  requireIfExists = false
): boolean {
  if (revocationStatements.length !== 1) return false;
  const statement = revocationStatements[0]?.trim() ?? '';
  const ifExists = requireIfExists ? 'IF\\s+EXISTS\\s+' : '(?:IF\\s+EXISTS\\s+)?';
  return new RegExp(
    `^DROP\\s+USER\\s+${ifExists}'\\{\\{username\\}\\}'@'%'\\s*;?$`,
    'i'
  ).test(statement);
}

function hasSafeRenewalContract(
  connectionType: DynamicSecretsConfig['connectionType'],
  statements: string[]
): boolean {
  if (connectionType === 'MYSQL') return statements.length === 0;
  if (statements.length !== 1) return false;
  let statement = statements[0]?.trim() ?? '';
  if (statement.endsWith(';')) statement = statement.slice(0, -1).trimEnd();
  return !statement.includes(';')
    && statement === 'ALTER ROLE "{{username}}" VALID UNTIL \'{{expiration}}\'';
}

async function handleRenew(
  message: DynamicSecretsRenewRequest,
  send: SendFunction
): Promise<void> {
  const { requestId, connectionId, roleId, leaseId, username, newExpiresAt } = message;

  log.info({ requestId, connectionId, roleId, leaseId, username, newExpiresAt }, 'Renewing credentials');

  const respond = (success: boolean): void => {
    const response: DynamicSecretsRenewedResponse = {
      event: 'dynamic-secrets.renewed-v2',
      protocolVersion: 2,
      requestId,
      leaseId,
      connectionId,
      roleId,
      username,
      configVersion: message.configVersion,
      targetVersion: message.targetVersion,
      roleVersion: message.roleVersion,
      success,
      newExpiresAt,
      timestamp: new Date().toISOString(),
    };
    send(response);
  };

  if (message.protocolVersion !== 2) {
    respond(false);
    return;
  }

  // Config and lifecycle freshness are checked before client acquisition or
  // target SQL. Empty renewal statements are an explicit metadata-only renew,
  // but still require the exact current target and role epochs.
  const config = getConfig(connectionId);
  if (!config) {
    log.warn({ connectionId, leaseId }, 'Config not found for renewal');
    respond(false);
    return;
  }
  if (
    config.configVersion !== message.configVersion
    || config.targetVersion !== message.targetVersion
  ) {
    log.warn({ connectionId, roleId, leaseId }, 'Config version mismatch for renewal');
    respond(false);
    return;
  }

  const roleConfig = getRoleConfig(connectionId, roleId);
  if (!roleConfig || roleConfig.roleVersion !== message.roleVersion) {
    log.warn({ connectionId, roleId, leaseId }, 'Role config mismatch for renewal');
    respond(false);
    return;
  }
  if (!hasSafeRenewalContract(config.connectionType, roleConfig.renewStatements)) {
    log.warn({ connectionId, roleId, leaseId }, 'Credential renewal lifecycle is unavailable');
    respond(false);
    return;
  }

  try {
    if (roleConfig.renewStatements.length > 0) {
      const client = getOrCreateClient(connectionId, config.connectionType, {
        connectionString: config.connectionString,
        connectionTimeoutSeconds: config.connectionTimeoutSeconds,
        maxConnections: config.maxOpenConnections,
      });
      await client.renewCredential(roleConfig.renewStatements, username, newExpiresAt);
    }

    respond(true);
    log.info({ requestId, leaseId, username, newExpiresAt }, 'Credentials renewed');
  } catch {
    log.error({ requestId, leaseId }, 'Renewal failed');
    respond(false);
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
