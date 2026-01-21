// Path: src/lib/secret-env/index.ts
// Public API for secret-env module

// Types
export type {
  SecretMapping,
  ExecSecret,
  SecretFilesResult,
  ExtendedSecretMapping,
  EnvFileMapping,
} from './types.js';

// Parsing
export {
  parseSecretMapping,
  parseSecretMappingFromConfig,
  parseEnvFileReference,
} from './parser.js';

// Building
export {
  buildSecretEnv,
  extractSecretIds,
  extractApiKeyNames,
  buildSecretEnvWithFiles,
  buildEnvFromEnvFiles,
  extractEnvFileSecretIds,
  SENSITIVE_ENV_VARS,
  isSensitiveEnvVar,
} from './builder.js';

// Env file operations
export {
  updateEnvFile,
  updateEnvFileMultiple,
  findEnvVarsForApiKey,
} from './env-file.js';
