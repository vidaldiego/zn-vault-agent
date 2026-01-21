// Path: zn-vault-agent/src/services/dynamic-secrets/db-clients/mysql-client.ts
// MySQL client for dynamic secrets credential operations

import { createLogger } from '../../../lib/logger.js';
import type { DatabaseClient, DatabaseClientConfig } from './types.js';
import { replaceStatementPlaceholders } from './utils.js';

const log = createLogger({ module: 'dynamic-secrets-mysql' });

// ============================================================================
// MySQL Client
// ============================================================================

/**
 * MySQL database client for credential operations
 * Uses mysql2 package (must be installed as optional dependency)
 */
export class MysqlClient implements DatabaseClient {
  private pool: import('mysql2/promise').Pool | null = null;
  private readonly config: DatabaseClientConfig;

  constructor(config: DatabaseClientConfig) {
    this.config = config;
  }

  /**
   * Get or create connection pool
   */
  private async getPool(): Promise<import('mysql2/promise').Pool> {
    if (this.pool) return this.pool;

    try {
      // Dynamic import to handle optional dependency
      const mysql = await import('mysql2/promise');

      // Parse connection string to mysql2 config
      const url = new URL(this.config.connectionString);

      this.pool = mysql.createPool({
        host: url.hostname,
        port: url.port ? parseInt(url.port, 10) : 3306,
        user: url.username,
        password: decodeURIComponent(url.password),
        database: url.pathname.replace('/', ''),
        connectTimeout: (this.config.connectionTimeoutSeconds ?? 30) * 1000,
        connectionLimit: this.config.maxConnections ?? 5,
        waitForConnections: true,
        queueLimit: 0,
      });

      return this.pool;
    } catch (err) {
      if (err instanceof Error && err.message.includes('Cannot find module')) {
        throw new Error(
          'MySQL client (mysql2) is not installed. Install it with: npm install mysql2'
        );
      }
      throw err;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const pool = await this.getPool();
      const conn = await pool.getConnection();
      try {
        await conn.query('SELECT 1');
        return true;
      } finally {
        conn.release();
      }
    } catch (err) {
      log.error({ err }, 'MySQL connection test failed');
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
    const conn = await pool.getConnection();

    try {
      // Execute each statement in order
      for (const statement of statements) {
        const sql = replaceStatementPlaceholders(statement, username, password, expiresAt);
        log.debug({ sql: sql.replace(password, '***') }, 'Executing creation statement');
        await conn.query(sql);
      }

      log.info({ username }, 'Created MySQL credential');
    } finally {
      conn.release();
    }
  }

  async revokeCredential(statements: string[], username: string): Promise<void> {
    const pool = await this.getPool();
    const conn = await pool.getConnection();

    try {
      // Execute each statement in order
      for (const statement of statements) {
        const sql = replaceStatementPlaceholders(statement, username, '', '');
        log.debug({ sql }, 'Executing revocation statement');
        await conn.query(sql);
      }

      log.info({ username }, 'Revoked MySQL credential');
    } finally {
      conn.release();
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
    const conn = await pool.getConnection();

    try {
      // Execute each statement in order
      for (const statement of statements) {
        const sql = replaceStatementPlaceholders(statement, username, '', expiresAt);
        log.debug({ sql }, 'Executing renewal statement');
        await conn.query(sql);
      }

      log.info({ username, expiresAt }, 'Renewed MySQL credential');
    } finally {
      conn.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      log.debug('MySQL pool closed');
    }
  }
}
