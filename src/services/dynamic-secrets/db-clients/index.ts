// Path: zn-vault-agent/src/services/dynamic-secrets/db-clients/index.ts
// Database client factory for dynamic secrets

import { createLogger } from '../../../lib/logger.js';
import type { DatabaseClient, DatabaseClientConfig, ConnectionType } from './types.js';
import { PostgresClient } from './postgres-client.js';
import { MysqlClient } from './mysql-client.js';

const log = createLogger({ module: 'dynamic-secrets-db' });

// ============================================================================
// Client Cache
// ============================================================================

interface CachedClient {
  client: DatabaseClient;
  connectionId: string;
  lastUsed: number;
}

const clientCache = new Map<string, CachedClient>();
const CLIENT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a database client for the given connection type
 */
export function createDatabaseClient(
  connectionType: ConnectionType,
  config: DatabaseClientConfig
): DatabaseClient {
  switch (connectionType) {
    case 'POSTGRESQL':
      return new PostgresClient(config);
    case 'MYSQL':
      return new MysqlClient(config);
    default: {
      const exhaustiveCheck: never = connectionType;
      throw new Error(`Unsupported connection type: ${exhaustiveCheck as string}`);
    }
  }
}

/**
 * Get or create a cached database client
 */
export function getOrCreateClient(
  connectionId: string,
  connectionType: ConnectionType,
  config: DatabaseClientConfig
): DatabaseClient {
  const cached = clientCache.get(connectionId);

  if (cached && Date.now() - cached.lastUsed < CLIENT_CACHE_TTL_MS) {
    cached.lastUsed = Date.now();
    return cached.client;
  }

  // Close old client if exists
  if (cached) {
    cached.client.close().catch((err: unknown) => {
      log.warn({ err, connectionId }, 'Failed to close old database client');
    });
  }

  // Create new client
  const client = createDatabaseClient(connectionType, config);

  clientCache.set(connectionId, {
    client,
    connectionId,
    lastUsed: Date.now(),
  });

  log.debug({ connectionId, connectionType }, 'Created new database client');

  return client;
}

/**
 * Close and remove a client from cache
 */
export async function closeClient(connectionId: string): Promise<void> {
  const cached = clientCache.get(connectionId);
  if (cached) {
    await cached.client.close();
    clientCache.delete(connectionId);
    log.debug({ connectionId }, 'Closed and removed database client');
  }
}

/**
 * Close all cached clients
 */
export async function closeAllClients(): Promise<void> {
  const closePromises: Promise<void>[] = [];

  for (const [connectionId, cached] of clientCache) {
    closePromises.push(
      cached.client.close().catch((err: unknown) => {
        log.warn({ err, connectionId }, 'Failed to close database client');
      })
    );
  }

  await Promise.all(closePromises);
  clientCache.clear();
  log.info({ count: closePromises.length }, 'Closed all database clients');
}

// ============================================================================
// Exports
// ============================================================================

export type { DatabaseClient, DatabaseClientConfig, ConnectionType } from './types.js';
export { replaceStatementPlaceholders, generateUsername, generatePassword } from './utils.js';
