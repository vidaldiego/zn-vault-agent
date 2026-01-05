// Path: src/lib/secret-env.ts
// Shared secret fetching and environment variable building for exec mode

import { getSecret } from './api.js';

/**
 * Parsed secret mapping from CLI or config
 */
export interface SecretMapping {
  envVar: string;
  secretId: string;
  key?: string;
}

/**
 * Exec secret from config file format
 */
export interface ExecSecret {
  env: string;
  secret?: string;  // alias:path.key format
  literal?: string; // literal value (no vault fetch)
}

/**
 * Parse secret mapping from CLI argument
 * Formats:
 *   ENV_VAR=alias:secret/path           -> entire secret as JSON
 *   ENV_VAR=alias:secret/path.key       -> specific key from secret
 *   ENV_VAR=uuid                        -> entire secret as JSON
 *   ENV_VAR=uuid.key                    -> specific key from secret
 *   ENV_VAR=literal:value               -> literal value (no vault fetch)
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

  if (!config.secret) {
    throw new Error(`ExecSecret must have either 'secret' or 'literal' property`);
  }

  // Use the same parsing logic as CLI
  return parseSecretMapping(`${config.env}=${config.secret}`);
}

/**
 * Fetch secrets and build environment variables
 * Handles both vault secrets and literal values
 */
export async function buildSecretEnv(
  mappings: (SecretMapping & { literal?: string })[]
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  // Group by secretId to minimize API calls
  const secretCache = new Map<string, Record<string, unknown>>();

  for (const mapping of mappings) {
    // Handle literal values (no vault fetch)
    if (mapping.literal !== undefined) {
      env[mapping.envVar] = mapping.literal;
      continue;
    }

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
 * Excludes literal values since they don't need vault subscription
 */
export function extractSecretIds(mappings: (SecretMapping & { literal?: string })[]): string[] {
  const ids = new Set<string>();
  for (const mapping of mappings) {
    if (mapping.secretId && !mapping.literal) {
      ids.add(mapping.secretId);
    }
  }
  return Array.from(ids);
}
