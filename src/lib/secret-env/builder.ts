// Path: src/lib/secret-env/builder.ts
// Secret environment building and extraction functions

import { getSecret, bindManagedApiKey } from '../api.js';
import { execLogger as log } from '../logger.js';
import { initializeSecretFiles } from '../secret-file-manager.js';
import type { SecretMapping, SecretFilesResult, ExtendedSecretMapping, EnvFileMapping } from './types.js';

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
  mappings: ExtendedSecretMapping[]
): Promise<SecretFilesResult> {
  const env: Record<string, string> = {};
  const files: string[] = [];

  // Initialize secret file manager
  const manager = initializeSecretFiles();
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
      const filePath = manager.writeSecret(mapping.envVar, value);
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

/**
 * Build environment variables from env file secrets
 * Each env file secret should contain key-value pairs that become env vars
 * Later mappings override earlier ones
 */
export async function buildEnvFromEnvFiles(
  mappings: EnvFileMapping[]
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const mapping of mappings) {
    const secret = await getSecret(mapping.secretId);

    // Validate data is an object (not null, not array, not primitive)
    // Runtime check needed because API could return unexpected data
    const data: unknown = secret.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error(
        `Env file secret "${mapping.secretId}" must contain key-value pairs, ` +
        `got ${Array.isArray(data) ? 'array' : typeof data}`
      );
    }

    // Flatten to env vars
    for (const [key, value] of Object.entries(secret.data)) {
      const envKey = mapping.prefix ? `${mapping.prefix}${key}` : key;

      // Convert value to string
      if (value === null || value === undefined) {
        result[envKey] = '';
      } else if (typeof value === 'string') {
        result[envKey] = value;
      } else {
        // Numbers, booleans, objects -> JSON.stringify
        result[envKey] = JSON.stringify(value);
      }
    }

    log.debug(
      {
        secretId: mapping.secretId,
        prefix: mapping.prefix,
        keyCount: Object.keys(secret.data).length,
      },
      'Injected env file secret'
    );
  }

  return result;
}

/**
 * Extract unique secret IDs from env file mappings (for WebSocket subscription)
 */
export function extractEnvFileSecretIds(mappings: EnvFileMapping[]): string[] {
  return mappings.map((m) => m.secretId);
}
