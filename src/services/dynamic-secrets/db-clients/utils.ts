// Path: zn-vault-agent/src/services/dynamic-secrets/db-clients/utils.ts
// Utilities for database clients

import * as crypto from 'node:crypto';

// ============================================================================
// Statement Placeholder Replacement
// ============================================================================

/**
 * Replace placeholders in SQL statements
 * Placeholders:
 * - {{username}} - The generated username
 * - {{password}} - The generated password
 * - {{expiration}} - Expiration timestamp (ISO format)
 * - {{expiration_timestamp}} - Expiration as UNIX timestamp
 */
export function replaceStatementPlaceholders(
  statement: string,
  username: string,
  password: string,
  expiresAt: string
): string {
  let result = statement;

  // Replace username (escape single quotes)
  result = result.replace(/\{\{username\}\}/g, escapeSqlString(username));

  // Replace password (escape single quotes)
  result = result.replace(/\{\{password\}\}/g, escapeSqlString(password));

  // Replace expiration (ISO format)
  result = result.replace(/\{\{expiration\}\}/g, expiresAt);

  // Replace expiration timestamp (UNIX)
  if (expiresAt) {
    const timestamp = Math.floor(new Date(expiresAt).getTime() / 1000);
    result = result.replace(/\{\{expiration_timestamp\}\}/g, String(timestamp));
  }

  return result;
}

/**
 * Escape single quotes in SQL strings
 */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

// ============================================================================
// Username Generation
// ============================================================================

/**
 * Generate a username from template
 * Templates:
 * - {{role}} - Role name (sanitized)
 * - {{random:N}} - N random alphanumeric characters
 * - {{timestamp}} - UNIX timestamp
 * - {{uuid}} - UUID (first 8 chars)
 */
export function generateUsername(template: string, roleName: string): string {
  let result = template;

  // Replace role name (sanitize to alphanumeric + underscore)
  const sanitizedRole = roleName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 16);
  result = result.replace(/\{\{role\}\}/g, sanitizedRole);

  // Replace random characters
  const randomMatch = /\{\{random:(\d+)\}\}/.exec(result);
  if (randomMatch) {
    const length = parseInt(randomMatch[1], 10);
    const randomStr = generateRandomAlphanumeric(length);
    result = result.replace(/\{\{random:\d+\}\}/g, randomStr);
  }

  // Replace timestamp
  const timestamp = Math.floor(Date.now() / 1000);
  result = result.replace(/\{\{timestamp\}\}/g, String(timestamp));

  // Replace UUID
  const uuid = crypto.randomUUID().replace(/-/g, '').substring(0, 8);
  result = result.replace(/\{\{uuid\}\}/g, uuid);

  // Ensure username is valid (max 63 chars for PostgreSQL, alphanumeric + underscore)
  result = result.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 63);

  return result;
}

/**
 * Generate random alphanumeric string
 */
function generateRandomAlphanumeric(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let result = '';

  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }

  return result;
}

// ============================================================================
// Password Generation
// ============================================================================

/**
 * Generate a secure random password
 * 32 bytes = 256 bits of entropy, base64 encoded = 44 characters
 */
export function generatePassword(): string {
  return crypto.randomBytes(32).toString('base64');
}

// ============================================================================
// Connection String Parsing
// ============================================================================

/**
 * Parse connection string to extract components
 */
export function parseConnectionString(connectionString: string): {
  protocol: string;
  username?: string;
  password?: string;
  host: string;
  port?: number;
  database?: string;
  params?: Record<string, string>;
} {
  try {
    const url = new URL(connectionString);

    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      params[key] = value;
    });

    return {
      protocol: url.protocol.replace(':', ''),
      username: url.username || undefined,
      password: url.password || undefined,
      host: url.hostname,
      port: url.port ? parseInt(url.port, 10) : undefined,
      database: url.pathname.replace('/', '') || undefined,
      params: Object.keys(params).length > 0 ? params : undefined,
    };
  } catch {
    throw new Error(`Invalid connection string: ${connectionString.substring(0, 20)}...`);
  }
}
