// Path: src/lib/config/index.ts
// Public API for configuration module

// Types
export type {
  CertTarget,
  SecretTarget,
  ExecConfig,
  ManagedKeyConfig,
  AgentConfig,
  ExecSecret,
} from './types.js';

export { DEFAULT_EXEC_CONFIG, EMPTY_CONFIG } from './types.js';

// Loading
export {
  loadConfig,
  getConfig,
  isConfigured,
  getConfigPath,
  setConfigInMemory,
  clearConfigInMemory,
  isConfigInMemory,
} from './loader.js';

// Saving
export { saveConfig, setConfig, updateApiKey } from './saver.js';

// Targets
export {
  addTarget,
  removeTarget,
  getTargets,
  updateTargetFingerprint,
  addSecretTarget,
  removeSecretTarget,
  getSecretTargets,
  updateSecretTargetVersion,
} from './targets.js';

// Managed key
export {
  updateManagedKey,
  isManagedKeyMode,
  syncManagedKeyFile,
} from './managed-key.js';

// Vault config loader (config-from-vault mode)
export {
  fetchConfigFromVault,
  isConfigFromVaultEnabled,
  getMinimalConfigForVaultMode,
  type FetchConfigOptions,
  type FetchConfigResult,
} from './vault-loader.js';
