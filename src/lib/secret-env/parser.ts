// Path: src/lib/secret-env/parser.ts
// Secret mapping parsing functions

import type { SecretMapping, ExecSecret, EnvFileMapping } from './types.js';

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
 * Parse env file reference from CLI -e/--env-file argument
 * Formats:
 *   alias:path/to/secret        -> secretId only
 *   alias:path/to/secret:PREFIX_ -> secretId with prefix
 *   uuid                        -> secretId only (UUID format)
 *   uuid:PREFIX_                -> secretId with prefix (UUID format)
 */
export function parseEnvFileReference(ref: string): EnvFileMapping {
  if (!ref || ref.trim() === '') {
    throw new Error('Env file reference cannot be empty');
  }

  const trimmed = ref.trim();

  // Check if this is an alias reference
  if (trimmed.startsWith('alias:')) {
    // For alias format, find the last colon that's not part of 'alias:'
    // Format: alias:path/to/secret or alias:path/to/secret:PREFIX_
    const afterAliasPrefix = trimmed.substring(6); // Remove 'alias:'
    const lastColonIndex = afterAliasPrefix.lastIndexOf(':');

    if (lastColonIndex === -1) {
      // No prefix, just alias:path
      return { secretId: trimmed };
    }

    // Check if the colon is followed by a valid prefix (typically ends with _)
    const potentialPrefix = afterAliasPrefix.substring(lastColonIndex + 1);
    const pathPart = afterAliasPrefix.substring(0, lastColonIndex);

    // A prefix should be non-empty and the path should have content
    if (potentialPrefix && pathPart) {
      return {
        secretId: `alias:${pathPart}`,
        prefix: potentialPrefix,
      };
    }

    // Otherwise treat the whole thing as the secretId
    return { secretId: trimmed };
  }

  // For UUID format: uuid or uuid:PREFIX_
  const colonIndex = trimmed.indexOf(':');

  if (colonIndex === -1) {
    // No colon, just UUID
    return { secretId: trimmed };
  }

  const secretId = trimmed.substring(0, colonIndex);
  const prefix = trimmed.substring(colonIndex + 1);

  if (!secretId) {
    throw new Error(`Invalid env file reference format: ${ref}. Secret ID cannot be empty.`);
  }

  return {
    secretId,
    prefix: prefix || undefined,
  };
}
