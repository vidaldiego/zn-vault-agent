// Path: zn-vault-agent/src/services/dynamic-secrets/db-clients/postgres-client.ts
// PostgreSQL client for dynamic secrets credential operations

import { createLogger } from '../../../lib/logger.js';
import type { DatabaseClient, DatabaseClientConfig } from './types.js';
import { replaceStatementPlaceholders } from './utils.js';

const log = createLogger({ module: 'dynamic-secrets-pg' });

// ============================================================================
// PostgreSQL Client
// ============================================================================

/**
 * PostgreSQL database client for credential operations
 * Uses pg package (must be installed as optional dependency)
 */
export class PostgresClient implements DatabaseClient {
  private pool: import('pg').Pool | null = null;
  private readonly config: DatabaseClientConfig;

  constructor(config: DatabaseClientConfig) {
    this.config = config;
  }

  /**
   * Get or create connection pool
   */
  private async getPool(): Promise<import('pg').Pool> {
    if (this.pool) return this.pool;

    try {
      // Dynamic import to handle optional dependency
      const pg = await import('pg');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- pg module structure varies
      const Pool = pg.default?.Pool ?? pg.Pool;

      this.pool = new Pool({
        connectionString: this.config.connectionString,
        connectionTimeoutMillis: (this.config.connectionTimeoutSeconds ?? 30) * 1000,
        max: this.config.maxConnections ?? 5,
        idleTimeoutMillis: 30000,
      });

      // Handle pool errors
      this.pool.on('error', (err) => {
        log.error({ err }, 'PostgreSQL pool error');
      });

      return this.pool;
    } catch {
      throw new Error(
        'PostgreSQL client (pg) is not installed. Install it with: npm install pg'
      );
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const pool = await this.getPool();
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
        return true;
      } finally {
        client.release();
      }
    } catch (err) {
      log.error({ err }, 'PostgreSQL connection test failed');
      return false;
    }
  }

  async createCredential(
    statements: string[],
    username: string,
    password: string,
    expiresAt: string
  ): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();

    try {
      // Execute each statement in order
      for (const statement of statements) {
        const sql = replaceStatementPlaceholders(statement, username, password, expiresAt);
        log.debug({ sql: sql.replace(password, '***') }, 'Executing creation statement');
        await client.query(sql);
      }

      log.info({ username }, 'Created PostgreSQL credential');
    } finally {
      client.release();
    }
  }

  async revokeCredential(statements: string[], username: string): Promise<void> {
    const pool = await this.getPool();
    const client = await pool.connect();

    try {
      // Execute each statement in order
      for (const statement of statements) {
        const sql = replaceStatementPlaceholders(statement, username, '', '');
        log.debug({ sql }, 'Executing revocation statement');
        await client.query(sql);
      }

      log.info({ username }, 'Revoked PostgreSQL credential');
    } finally {
      client.release();
    }
  }

  async renewCredential(
    statements: string[],
    username: string,
    expiresAt: string
  ): Promise<void> {
    if (statements.length === 0) {
      log.debug({ username }, 'No renewal statements configured');
      return;
    }

    const pool = await this.getPool();
    const client = await pool.connect();

    try {
      // Execute each statement in order
      for (const statement of statements) {
        const sql = replaceStatementPlaceholders(statement, username, '', expiresAt);
        log.debug({ sql }, 'Executing renewal statement');
        await client.query(sql);
      }

      log.info({ username, expiresAt }, 'Renewed PostgreSQL credential');
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      log.debug('PostgreSQL pool closed');
    }
  }
}
