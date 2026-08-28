// Path: zn-vault-agent/src/services/dynamic-secrets/db-clients/mysql-client.ts
// MySQL client for dynamic secrets credential operations

import { createLogger } from '../../../lib/logger.js';
import type { DatabaseClient, DatabaseClientConfig } from './types.js';
import { replaceStatementPlaceholders } from './utils.js';

const log = createLogger({ module: 'dynamic-secrets-mysql' });

function getSafeMySqlFailureMetadata(error: unknown): Record<string, string | number> {
  if (typeof error !== 'object' || error === null) return {};
  try {
    const candidate = error as {code?: unknown; errno?: unknown; sqlState?: unknown; name?: unknown};
    const metadata: Record<string, string | number> = {};
    if (typeof candidate.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(candidate.code)) {
      metadata.databaseErrorCode = candidate.code;
    }
    if (typeof candidate.errno === 'number' && Number.isSafeInteger(candidate.errno)) {
      metadata.databaseErrorNumber = candidate.errno;
    }
    if (typeof candidate.sqlState === 'string' && /^[A-Z0-9]{5}$/.test(candidate.sqlState)) {
      metadata.databaseSqlState = candidate.sqlState;
    }
    if (typeof candidate.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(candidate.name)) {
      metadata.errorType = candidate.name;
    }
    return metadata;
  } catch {
    return {};
  }
}

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
      log.error(getSafeMySqlFailureMetadata(err), 'MySQL client initialization failed');
      throw new Error('MySQL client initialization failed');
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
      log.error(getSafeMySqlFailureMetadata(err), 'MySQL connection test failed');
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
      for (const [index, statement] of statements.entries()) {
        const sql = replaceStatementPlaceholders(statement, username, password, expiresAt);
        log.debug({
          username,
          statementNumber: index + 1,
          statementLength: sql.length,
        }, 'Executing creation statement');
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
      for (const [index, statement] of statements.entries()) {
        const sql = replaceStatementPlaceholders(statement, username, '', '');
        log.debug({
          username,
          statementNumber: index + 1,
          statementLength: sql.length,
        }, 'Executing revocation statement');
        await conn.query(sql);
      }

      log.info({ username }, 'Revoked MySQL credential');
    } finally {
      conn.release();
    }
  }

  async credentialExists(username: string): Promise<boolean> {
    const pool = await this.getPool();
    const conn = await pool.getConnection();
    try {
      // A username can have multiple MySQL Host rows. Absence across all hosts
      // is the only safe proof available in the v2 request (which intentionally
      // carries no caller-controlled host fragment).
      const [rows] = await conn.query(
        'SELECT EXISTS (SELECT 1 FROM mysql.user WHERE User = ?) AS credential_exists',
        [username]
      ) as [{ credential_exists?: number | string | boolean }[], unknown];
      const value = rows[0]?.credential_exists;
      return value === true || value === 1 || value === '1';
    } finally {
      conn.release();
    }
  }

  async ensureCredentialAbsent(username: string): Promise<void> {
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(username)) {
      throw new Error('Unsafe credential identity');
    }
    const pool = await this.getPool();
    const conn = await pool.getConnection();
    try {
      // CREATE USER privilege permits DROP USER. The strict username gate and
      // fixed @'%' host make this safe without granting SELECT on mysql.*.
      await conn.query(`DROP USER IF EXISTS '${username}'@'%'`);
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
      for (const [index, statement] of statements.entries()) {
        const sql = replaceStatementPlaceholders(statement, username, '', expiresAt);
        log.debug({
          username,
          statementNumber: index + 1,
          statementLength: sql.length,
        }, 'Executing renewal statement');
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
