// Path: src/lib/config.ts
// Re-export all config functionality from modularized config directory
// This file maintains backward compatibility with existing imports

export type {
  CertTarget,
  SecretTarget,
  ExecConfig,
  ManagedKeyConfig,
  AgentConfig,
  ExecSecret,
} from './config/index.js';

export {
  DEFAULT_EXEC_CONFIG,
  EMPTY_CONFIG,
  loadConfig,
  getConfig,
  isConfigured,
  getConfigPath,
  setConfigInMemory,
  clearConfigInMemory,
  isConfigInMemory,
  saveConfig,
  setConfig,
  updateApiKey,
  addTarget,
  removeTarget,
  getTargets,
  updateTargetFingerprint,
  addSecretTarget,
  removeSecretTarget,
  getSecretTargets,
  updateSecretTargetVersion,
  updateManagedKey,
  isManagedKeyMode,
  syncManagedKeyFile,
  fetchConfigFromVault,
  isConfigFromVaultEnabled,
  getMinimalConfigForVaultMode,
} from './config/index.js';

export type {
  FetchConfigOptions,
  FetchConfigResult,
} from './config/index.js';
