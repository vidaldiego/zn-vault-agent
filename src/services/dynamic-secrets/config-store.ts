// Path: zn-vault-agent/src/services/dynamic-secrets/config-store.ts
// In-memory store for decrypted dynamic secrets configs

import { createLogger } from '../../lib/logger.js';
import type {
  DynamicSecretsConfig,
  DynamicSecretsRoleConfig,
  EncryptedConfigEnvelope,
} from './types.js';
import { decryptAesKey, decryptConfig } from './keypair.js';

const log = createLogger({ module: 'dynamic-secrets-store' });

// ============================================================================
// State
// ============================================================================

/**
 * In-memory store for decrypted connection configs
 * Key: connectionId, Value: decrypted config
 */
const configStore = new Map<string, DynamicSecretsConfig>();

// ============================================================================
// Store Operations
// ============================================================================

/**
 * Store a decrypted config
 */
export function storeConfig(config: DynamicSecretsConfig): void {
  const existing = configStore.get(config.connectionId);

  if (existing && existing.configVersion >= config.configVersion) {
    log.debug({
      connectionId: config.connectionId,
      existingVersion: existing.configVersion,
      newVersion: config.configVersion,
    }, 'Skipping config update - already have same or newer version');
    return;
  }

  configStore.set(config.connectionId, config);

  log.info({
    connectionId: config.connectionId,
    connectionType: config.connectionType,
    configVersion: config.configVersion,
    roleCount: config.roles.length,
  }, 'Stored dynamic secrets config');
}

/**
 * Get a config by connection ID
 */
export function getConfig(connectionId: string): DynamicSecretsConfig | undefined {
  return configStore.get(connectionId);
}

/**
 * Get a role config by role ID
 */
export function getRoleConfig(connectionId: string, roleId: string): DynamicSecretsRoleConfig | undefined {
  const config = configStore.get(connectionId);
  if (!config) return undefined;

  return config.roles.find(r => r.roleId === roleId);
}

/**
 * Remove a config by connection ID
 */
export function removeConfig(connectionId: string): boolean {
  const existed = configStore.has(connectionId);
  configStore.delete(connectionId);

  if (existed) {
    log.info({ connectionId }, 'Removed dynamic secrets config');
  }

  return existed;
}

/**
 * Get all stored config IDs
 */
export function getAllConfigIds(): string[] {
  return Array.from(configStore.keys());
}

/**
 * Get config count
 */
export function getConfigCount(): number {
  return configStore.size;
}

/**
 * Clear all configs
 */
export function clearAllConfigs(): void {
  const count = configStore.size;
  configStore.clear();
  log.info({ count }, 'Cleared all dynamic secrets configs');
}

// ============================================================================
// Config Decryption
// ============================================================================

/**
 * Decrypt and store a config from encrypted envelope
 */
export function decryptAndStoreConfig(
  connectionId: string,
  configVersion: number,
  encryptedConfigJson: string
): { success: boolean; error?: string } {
  try {
    // Parse encrypted envelope
    const envelope = JSON.parse(encryptedConfigJson) as EncryptedConfigEnvelope;

    // Decrypt AES key using agent's RSA private key
    const aesKey = decryptAesKey(envelope.encryptedKey);

    // Decrypt config using AES-256-GCM
    const configJson = decryptConfig(
      envelope.ciphertext,
      aesKey,
      envelope.nonce,
      envelope.authTag
    );

    // Parse config
    const config = JSON.parse(configJson) as DynamicSecretsConfig;

    // Verify connection ID matches
    if (config.connectionId !== connectionId) {
      throw new Error(`Connection ID mismatch: expected ${connectionId}, got ${config.connectionId}`);
    }

    // Verify config version
    if (config.configVersion !== configVersion) {
      log.warn({
        connectionId,
        expectedVersion: configVersion,
        actualVersion: config.configVersion,
      }, 'Config version mismatch (using actual version)');
    }

    // Store the config
    storeConfig(config);

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err: message, connectionId }, 'Failed to decrypt and store config');
    return { success: false, error: message };
  }
}

// ============================================================================
// Diagnostics
// ============================================================================

/**
 * Get store statistics for health checks
 */
export function getStoreStats(): {
  configCount: number;
  connectionIds: string[];
  versions: Record<string, number>;
} {
  const versions: Record<string, number> = {};

  for (const [id, config] of configStore) {
    versions[id] = config.configVersion;
  }

  return {
    configCount: configStore.size,
    connectionIds: Array.from(configStore.keys()),
    versions,
  };
}
