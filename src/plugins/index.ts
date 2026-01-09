// Path: src/plugins/index.ts
// Plugin system public exports

// Types
export type {
  AgentPlugin,
  PluginFactory,
  PluginConfig,
  PluginContext,
  PluginStorage,
  SecretValue,
  CertificateContent,
  CertificateDeployedEvent,
  SecretDeployedEvent,
  KeyRotatedEvent,
  ChildProcessEvent,
  SecretChangedEvent,
  PluginHealthStatus,
  LoadedPlugin,
  PluginEventMap,
} from './types.js';

// Loader
export {
  PluginLoader,
  createPluginLoader,
  getPluginLoader,
  clearPluginLoader,
  type AgentInternals,
  type PluginLoaderOptions,
} from './loader.js';

// Context
export {
  createPluginContext,
  getPluginEventEmitter,
  clearPluginEventListeners,
} from './context.js';

// Storage
export {
  getPluginStorage,
  deletePluginStorage,
  listPluginsWithStorage,
  clearStorageCache,
} from './storage.js';
