// Path: src/lib/secret-env.ts
// Re-export all secret-env functionality from modularized directory
// This file maintains backward compatibility with existing imports

export type {
  SecretMapping,
  ExecSecret,
  SecretFilesResult,
  ExtendedSecretMapping,
  EnvFileMapping,
} from './secret-env/index.js';

export {
  parseSecretMapping,
  parseSecretMappingFromConfig,
  parseEnvFileReference,
  buildSecretEnv,
  extractSecretIds,
  extractApiKeyNames,
  buildSecretEnvWithFiles,
  buildEnvFromEnvFiles,
  extractEnvFileSecretIds,
  SENSITIVE_ENV_VARS,
  isSensitiveEnvVar,
  updateEnvFile,
  updateEnvFileMultiple,
  findEnvVarsForApiKey,
} from './secret-env/index.js';
