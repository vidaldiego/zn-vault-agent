// Path: src/lib/secret-env/types.ts
// Type definitions for secret environment variable handling

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
 * Extended mapping with literal and file output support
 */
export type ExtendedSecretMapping = SecretMapping & {
  literal?: string;
  outputToFile?: boolean;
};

/**
 * Env file mapping from CLI -e/--env-file option
 * References an entire secret whose key-value pairs are injected as env vars
 */
export interface EnvFileMapping {
  /** Secret ID (alias:path or UUID) */
  secretId: string;
  /** Optional prefix to apply to all env var names */
  prefix?: string;
}
