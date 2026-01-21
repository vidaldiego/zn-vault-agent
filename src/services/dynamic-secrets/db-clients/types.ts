// Path: zn-vault-agent/src/services/dynamic-secrets/db-clients/types.ts
// Database client interface for dynamic secrets

/**
 * Database client interface for credential operations
 */
export interface DatabaseClient {
  /**
   * Test the database connection
   */
  testConnection(): Promise<boolean>;

  /**
   * Create a credential by executing creation statements
   * @param statements - SQL statements with placeholders
   * @param username - Generated username
   * @param password - Generated password
   * @param expiresAt - Expiration timestamp (ISO string)
   */
  createCredential(
    statements: string[],
    username: string,
    password: string,
    expiresAt: string
  ): Promise<void>;

  /**
   * Revoke a credential by executing revocation statements
   * @param statements - SQL statements with placeholders
   * @param username - Username to revoke
   */
  revokeCredential(statements: string[], username: string): Promise<void>;

  /**
   * Renew a credential by executing renewal statements
   * @param statements - SQL statements with placeholders
   * @param username - Username to renew
   * @param expiresAt - New expiration timestamp (ISO string)
   */
  renewCredential(
    statements: string[],
    username: string,
    expiresAt: string
  ): Promise<void>;

  /**
   * Close the database connection
   */
  close(): Promise<void>;
}

/**
 * Database client configuration
 */
export interface DatabaseClientConfig {
  connectionString: string;
  connectionTimeoutSeconds?: number;
  maxConnections?: number;
}

/**
 * Connection type
 */
export type ConnectionType = 'POSTGRESQL' | 'MYSQL';
