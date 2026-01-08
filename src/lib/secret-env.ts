// Path: src/lib/secret-env.ts
// Shared secret fetching and environment variable building for exec mode

import fs from 'node:fs';
import path from 'node:path';
import { getSecret, bindManagedApiKey } from './api.js';
import { execLogger as log } from './logger.js';
import { getSecretFileManager, initializeSecretFiles } from './secret-file-manager.js';

/**
 * Parsed secret mapping from CLI or config
 */
export interface SecretMapping {
  envVar: string;
  secretId: string;
  key?: string;
  /** For managed API key references (api-key:name format) */
  apiKeyName?: string;
}

/**
 * Exec secret from config file format
 */
export interface ExecSecret {
  env: string;
  secret?: string;  // alias:path.key format
  literal?: string; // literal value (no vault fetch)
  apiKey?: string;  // managed API key name (binds and gets current value)
  /** If true, write to file instead of env var (avoids sudo logging) */
  outputToFile?: boolean;
}

/**
 * Parse secret mapping from CLI argument
 * Formats:
 *   ENV_VAR=alias:secret/path           -> entire secret as JSON
 *   ENV_VAR=alias:secret/path.key       -> specific key from secret
 *   ENV_VAR=uuid                        -> entire secret as JSON
 *   ENV_VAR=uuid.key                    -> specific key from secret
 *   ENV_VAR=literal:value               -> literal value (no vault fetch)
 *   ENV_VAR=api-key:name                -> bind to managed API key, get key value
 */
export function parseSecretMapping(mapping: string): SecretMapping & { literal?: string } {
  const eqIndex = mapping.indexOf('=');
  if (eqIndex === -1) {
    throw new Error(`Invalid mapping format: ${mapping}. Expected: ENV_VAR=secret-id[.key]`);
  }

  const envVar = mapping.substring(0, eqIndex);
  let secretPath = mapping.substring(eqIndex + 1);

  if (!envVar || !secretPath) {
    throw new Error(`Invalid mapping format: ${mapping}. Expected: ENV_VAR=secret-id[.key]`);
  }

  // Check for literal: prefix (no vault fetch)
  if (secretPath.startsWith('literal:')) {
    return {
      envVar,
      secretId: '',
      literal: secretPath.substring(8), // Remove 'literal:' prefix
    };
  }

  // Check for api-key: prefix (managed API key binding)
  if (secretPath.startsWith('api-key:')) {
    const apiKeyName = secretPath.substring(8); // Remove 'api-key:' prefix
    if (!apiKeyName) {
      throw new Error(`Invalid api-key format: ${mapping}. Expected: ENV_VAR=api-key:name`);
    }
    return {
      envVar,
      secretId: '',
      apiKeyName,
    };
  }

  // Check if there's a key after the secret ID
  // For alias format: alias:path/to/secret.key
  // For UUID format: uuid.key
  let key: string | undefined;

  if (secretPath.startsWith('alias:')) {
    // Handle alias:path/to/secret.key
    const lastDotIndex = secretPath.lastIndexOf('.');
    if (lastDotIndex > secretPath.indexOf(':') + 1) {
      // There's a dot after the alias prefix
      const potentialKey = secretPath.substring(lastDotIndex + 1);
      // Check if this looks like a key (not a file extension or path segment)
      if (potentialKey && !potentialKey.includes('/')) {
        key = potentialKey;
        secretPath = secretPath.substring(0, lastDotIndex);
      }
    }
  } else {
    // Handle uuid.key or uuid
    const dotIndex = secretPath.indexOf('.');
    if (dotIndex !== -1) {
      key = secretPath.substring(dotIndex + 1);
      secretPath = secretPath.substring(0, dotIndex);
    }
  }

  return {
    envVar,
    secretId: secretPath,
    key,
  };
}

/**
 * Parse secret mapping from config file format
 */
export function parseSecretMappingFromConfig(config: ExecSecret): SecretMapping & { literal?: string } {
  if (config.literal !== undefined) {
    return {
      envVar: config.env,
      secretId: '',
      literal: config.literal,
    };
  }

  // Handle dedicated apiKey property
  if (config.apiKey !== undefined) {
    if (!config.apiKey) {
      throw new Error(`ExecSecret apiKey cannot be empty`);
    }
    return {
      envVar: config.env,
      secretId: '',
      apiKeyName: config.apiKey,
    };
  }

  if (!config.secret) {
    throw new Error(`ExecSecret must have 'secret', 'literal', or 'apiKey' property`);
  }

  // Use the same parsing logic as CLI (handles api-key: prefix in secret value)
  return parseSecretMapping(`${config.env}=${config.secret}`);
}

/**
 * Fetch secrets and build environment variables
 * Handles vault secrets, literal values, and managed API keys
 */
export async function buildSecretEnv(
  mappings: (SecretMapping & { literal?: string })[]
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  // Group by secretId to minimize API calls
  const secretCache = new Map<string, Record<string, unknown>>();
  // Cache API key bindings by name
  const apiKeyCache = new Map<string, string>();

  for (const mapping of mappings) {
    // Handle literal values (no vault fetch)
    if (mapping.literal !== undefined) {
      env[mapping.envVar] = mapping.literal;
      continue;
    }

    // Handle managed API key references
    if (mapping.apiKeyName) {
      log.debug({ envVar: mapping.envVar, apiKeyName: mapping.apiKeyName }, 'Processing api-key mapping');

      let keyValue = apiKeyCache.get(mapping.apiKeyName);

      if (!keyValue) {
        log.debug({ apiKeyName: mapping.apiKeyName }, 'Binding to managed API key');

        const bindResponse = await bindManagedApiKey(mapping.apiKeyName);
        keyValue = bindResponse.key;

        log.debug(
          { apiKeyName: mapping.apiKeyName, hasKey: !!keyValue, prefix: bindResponse.prefix },
          'Bind response received'
        );

        // Validate that we got a non-empty key value
        if (!keyValue) {
          throw new Error(
            `Failed to bind managed API key "${mapping.apiKeyName}": Server returned empty key value`
          );
        }

        apiKeyCache.set(mapping.apiKeyName, keyValue);
      }

      env[mapping.envVar] = keyValue;
      log.debug({ envVar: mapping.envVar, keyPrefix: keyValue.substring(0, 8) }, 'API key mapped to env var');
      continue;
    }

    // Handle vault secrets
    let data = secretCache.get(mapping.secretId);

    if (!data) {
      const secret = await getSecret(mapping.secretId);
      data = secret.data;
      secretCache.set(mapping.secretId, data);
    }

    if (mapping.key) {
      // Get specific key
      const value = data[mapping.key];
      if (value === undefined) {
        throw new Error(`Key "${mapping.key}" not found in secret "${mapping.secretId}"`);
      }
      env[mapping.envVar] = typeof value === 'string' ? value : JSON.stringify(value);
    } else {
      // Get entire secret as JSON
      env[mapping.envVar] = JSON.stringify(data);
    }
  }

  return env;
}

/**
 * Extract unique secret IDs from mappings (for WebSocket subscription)
 * Excludes literal values and API key references since they don't need vault subscription
 */
export function extractSecretIds(mappings: (SecretMapping & { literal?: string })[]): string[] {
  const ids = new Set<string>();
  for (const mapping of mappings) {
    // Skip literals and API key references
    if (mapping.secretId && !mapping.literal && !mapping.apiKeyName) {
      ids.add(mapping.secretId);
    }
  }
  return Array.from(ids);
}

/**
 * Extract unique API key names from mappings (for potential future renewal tracking)
 */
export function extractApiKeyNames(mappings: (SecretMapping & { literal?: string })[]): string[] {
  const names = new Set<string>();
  for (const mapping of mappings) {
    if (mapping.apiKeyName) {
      names.add(mapping.apiKeyName);
    }
  }
  return Array.from(names);
}

/**
 * Result of building secret files
 */
export interface SecretFilesResult {
  /** Environment variables to set (non-sensitive + file path pointers) */
  env: Record<string, string>;
  /** Paths to secret files that were written */
  files: string[];
  /** Secrets directory path */
  secretsDir: string;
}

/**
 * Fetch secrets and write to secure files instead of env vars
 *
 * This avoids secrets appearing in:
 * - Process command line arguments
 * - sudo logs (when using --preserve-env)
 * - systemd journal
 *
 * For each secret with outputToFile=true:
 * - Writes value to /run/zn-vault-agent/secrets/<ENV_NAME>
 * - Sets <ENV_NAME>_FILE=/run/zn-vault-agent/secrets/<ENV_NAME> in env
 *
 * For secrets with outputToFile=false (default):
 * - Sets <ENV_NAME>=<value> in env (traditional behavior)
 */
export async function buildSecretEnvWithFiles(
  mappings: (SecretMapping & { literal?: string; outputToFile?: boolean })[]
): Promise<SecretFilesResult> {
  const env: Record<string, string> = {};
  const files: string[] = [];

  // Initialize secret file manager
  const manager = await initializeSecretFiles();
  const secretsDir = manager.getSecretsDir();

  // Set the secrets directory env var for child process
  env.ZNVAULT_SECRETS_DIR = secretsDir;

  // Group by secretId to minimize API calls
  const secretCache = new Map<string, Record<string, unknown>>();
  // Cache API key bindings by name
  const apiKeyCache = new Map<string, string>();

  for (const mapping of mappings) {
    let value: string;

    // Handle literal values
    if (mapping.literal !== undefined) {
      value = mapping.literal;
    }
    // Handle managed API key references
    else if (mapping.apiKeyName) {
      log.debug({ envVar: mapping.envVar, apiKeyName: mapping.apiKeyName }, 'Processing api-key mapping');

      let keyValue = apiKeyCache.get(mapping.apiKeyName);

      if (!keyValue) {
        log.debug({ apiKeyName: mapping.apiKeyName }, 'Binding to managed API key');
        const bindResponse = await bindManagedApiKey(mapping.apiKeyName);
        keyValue = bindResponse.key;

        if (!keyValue) {
          throw new Error(
            `Failed to bind managed API key "${mapping.apiKeyName}": Server returned empty key value`
          );
        }

        apiKeyCache.set(mapping.apiKeyName, keyValue);
      }

      value = keyValue;
    }
    // Handle vault secrets
    else if (mapping.secretId) {
      let data = secretCache.get(mapping.secretId);

      if (!data) {
        const secret = await getSecret(mapping.secretId);
        data = secret.data;
        secretCache.set(mapping.secretId, data);
      }

      if (mapping.key) {
        const keyValue = data[mapping.key];
        if (keyValue === undefined) {
          throw new Error(`Key "${mapping.key}" not found in secret "${mapping.secretId}"`);
        }
        value = typeof keyValue === 'string' ? keyValue : JSON.stringify(keyValue);
      } else {
        value = JSON.stringify(data);
      }
    } else {
      throw new Error(`Invalid mapping for ${mapping.envVar}: no source specified`);
    }

    // Decide whether to write to file or env var
    if (mapping.outputToFile) {
      // Write to file, set *_FILE env var
      const filePath = await manager.writeSecret(mapping.envVar, value);
      files.push(filePath);
      env[`${mapping.envVar}_FILE`] = filePath;
      log.debug(
        { envVar: mapping.envVar, filePath },
        'Wrote secret to file (avoiding env var exposure)'
      );
    } else {
      // Traditional: set env var directly
      env[mapping.envVar] = value;
    }
  }

  return { env, files, secretsDir };
}

/**
 * Mark specific environment variable names as requiring file output
 * These are typically sensitive values that shouldn't appear in logs
 */
export const SENSITIVE_ENV_VARS = new Set([
  'ZINC_CONFIG_VAULT_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'DATABASE_PASSWORD',
  'API_KEY',
  'SECRET_KEY',
  'PRIVATE_KEY',
]);

/**
 * Check if an environment variable name is considered sensitive
 */
export function isSensitiveEnvVar(name: string): boolean {
  // Check exact match
  if (SENSITIVE_ENV_VARS.has(name)) return true;

  // Check common patterns
  const lowerName = name.toLowerCase();
  return (
    lowerName.includes('password') ||
    lowerName.includes('secret') ||
    lowerName.includes('api_key') ||
    lowerName.includes('apikey') ||
    lowerName.includes('private_key') ||
    lowerName.includes('token') ||
    lowerName.includes('credential')
  );
}

// ============================================================================
// Env File Update Functions (for managed API key rotation)
// ============================================================================

/**
 * Escape a value for use in an env file
 * Format: KEY="value with escaped \"quotes\""
 */
function escapeEnvValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Parse an env file into a Map of key-value pairs
 * Handles:
 *   KEY=value
 *   KEY="quoted value"
 *   KEY="value with \"escaped\" quotes"
 *   # comments
 *   export KEY=value
 */
function parseEnvFile(content: string): Map<string, { value: string; quoted: boolean; hasExport: boolean }> {
  const result = new Map<string, { value: string; quoted: boolean; hasExport: boolean }>();
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Handle export prefix
    let hasExport = false;
    let processLine = trimmed;
    if (processLine.startsWith('export ')) {
      hasExport = true;
      processLine = processLine.substring(7).trim();
    }

    // Find the = sign
    const eqIndex = processLine.indexOf('=');
    if (eqIndex === -1) continue;

    const key = processLine.substring(0, eqIndex).trim();
    let value = processLine.substring(eqIndex + 1);

    // Check if value is quoted
    let quoted = false;
    if (value.startsWith('"') && value.endsWith('"')) {
      quoted = true;
      value = value.substring(1, value.length - 1);
      // Unescape quotes
      value = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (value.startsWith("'") && value.endsWith("'")) {
      quoted = true;
      value = value.substring(1, value.length - 1);
    }

    result.set(key, { value, quoted, hasExport });
  }

  return result;
}

/**
 * Serialize an env Map back to file content
 */
function serializeEnvFile(entries: Map<string, { value: string; quoted: boolean; hasExport: boolean }>): string {
  const lines: string[] = [];

  for (const [key, { value, quoted, hasExport }] of entries) {
    const exportPrefix = hasExport ? 'export ' : '';
    if (quoted) {
      lines.push(`${exportPrefix}${key}="${escapeEnvValue(value)}"`);
    } else {
      // Check if value needs quoting (contains spaces, special chars, etc.)
      const needsQuotes = /[\s"'$`\\]/.test(value);
      if (needsQuotes) {
        lines.push(`${exportPrefix}${key}="${escapeEnvValue(value)}"`);
      } else {
        lines.push(`${exportPrefix}${key}=${value}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Update a specific key's value in an env file
 * Uses atomic write (temp file + rename) to prevent corruption
 *
 * @param filePath - Path to the env file
 * @param envVar - Environment variable name to update
 * @param newValue - New value for the environment variable
 * @returns true if the file was updated, false if the key was added
 */
export async function updateEnvFile(
  filePath: string,
  envVar: string,
  newValue: string
): Promise<{ updated: boolean; added: boolean }> {
  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);
  const tempPath = `${resolvedPath}.tmp.${Date.now()}.${process.pid}`;

  log.debug({ filePath: resolvedPath, envVar }, 'Updating env file');

  try {
    // Read existing file (may not exist yet)
    let content = '';
    let existingMode = 0o600;
    try {
      content = fs.readFileSync(resolvedPath, 'utf-8');
      const stats = fs.statSync(resolvedPath);
      existingMode = stats.mode & 0o777;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') throw err;
      // File doesn't exist, we'll create it
    }

    // Parse existing content
    const entries = parseEnvFile(content);

    // Check if key exists
    const existing = entries.get(envVar);
    const added = !existing;

    // Update or add the key
    entries.set(envVar, {
      value: newValue,
      quoted: true, // Always quote new values for safety
      hasExport: existing?.hasExport ?? false,
    });

    // Serialize back to content
    const newContent = serializeEnvFile(entries);

    // Ensure directory exists
    fs.mkdirSync(dir, { recursive: true });

    // Write to temp file
    fs.writeFileSync(tempPath, newContent, { mode: existingMode });

    // Atomic rename
    fs.renameSync(tempPath, resolvedPath);

    log.info({
      filePath: resolvedPath,
      envVar,
      valuePrefix: newValue.substring(0, 8),
      added,
    }, 'Env file updated successfully');

    return { updated: !added, added };
  } catch (err) {
    // Clean up temp file if it exists
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }

    log.error({ err, filePath: resolvedPath, envVar }, 'Failed to update env file');
    throw err;
  }
}

/**
 * Update multiple keys in an env file atomically
 *
 * @param filePath - Path to the env file
 * @param updates - Map of envVar -> newValue
 * @returns Summary of updates
 */
export async function updateEnvFileMultiple(
  filePath: string,
  updates: Record<string, string>
): Promise<{ updated: number; added: number }> {
  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);
  const tempPath = `${resolvedPath}.tmp.${Date.now()}.${process.pid}`;

  log.debug({ filePath: resolvedPath, keys: Object.keys(updates) }, 'Updating env file with multiple keys');

  let updated = 0;
  let added = 0;

  try {
    // Read existing file
    let content = '';
    let existingMode = 0o600;
    try {
      content = fs.readFileSync(resolvedPath, 'utf-8');
      const stats = fs.statSync(resolvedPath);
      existingMode = stats.mode & 0o777;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') throw err;
    }

    // Parse existing content
    const entries = parseEnvFile(content);

    // Update each key
    for (const [envVar, newValue] of Object.entries(updates)) {
      const existing = entries.get(envVar);
      if (existing) {
        updated++;
      } else {
        added++;
      }

      entries.set(envVar, {
        value: newValue,
        quoted: true,
        hasExport: existing?.hasExport ?? false,
      });
    }

    // Serialize back
    const newContent = serializeEnvFile(entries);

    // Ensure directory exists
    fs.mkdirSync(dir, { recursive: true });

    // Atomic write
    fs.writeFileSync(tempPath, newContent, { mode: existingMode });
    fs.renameSync(tempPath, resolvedPath);

    log.info({
      filePath: resolvedPath,
      updated,
      added,
    }, 'Env file updated with multiple keys');

    return { updated, added };
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore
    }

    log.error({ err, filePath: resolvedPath }, 'Failed to update env file');
    throw err;
  }
}

/**
 * Find which env var(s) in a file map to a specific API key name
 * This is used when handling rotation events to know which env vars to update
 *
 * @param mappings - The secret mappings from exec config
 * @param apiKeyName - The managed API key name from the rotation event
 * @returns Array of env var names that use this API key
 */
export function findEnvVarsForApiKey(
  mappings: (SecretMapping & { literal?: string })[],
  apiKeyName: string
): string[] {
  return mappings
    .filter(m => m.apiKeyName === apiKeyName)
    .map(m => m.envVar);
}
