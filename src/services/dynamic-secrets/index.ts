// Path: zn-vault-agent/src/services/dynamic-secrets/index.ts
// Dynamic Secrets service - agent-side implementation

export * from './types.js';
export {
  handleDynamicSecretsMessage,
  setVaultPublicKey,
  getVaultPublicKey,
  type SendFunction,
} from './handler.js';
export {
  getPublicKey,
  initializeKeyPair,
} from './keypair.js';
export {
  getConfig,
  getRoleConfig,
  getConfigCount,
  getAllConfigIds,
  clearAllConfigs,
  getStoreStats,
} from './config-store.js';
export {
  closeAllClients,
} from './db-clients/index.js';
export {
  initializeDynamicSecrets,
  isDynamicSecretsEnabled,
  getAgentPublicKey,
  setWebSocket,
  handleIncomingMessage,
  handleVaultPublicKey,
  cleanupDynamicSecrets,
  getDynamicSecretsCapabilities,
  getDynamicSecretsMetadata,
} from './websocket-integration.js';
