// Path: src/lib/config/storage.ts
// Internal config storage management

import Conf from 'conf';
import path from 'node:path';
import type { AgentConfig } from './types.js';

/**
 * Get config directory path - computed dynamically to support test isolation
 */
export function getConfigDir(): string {
  return process.env.ZNVAULT_AGENT_CONFIG_DIR ?? '/etc/zn-vault-agent';
}

/**
 * Get config file path
 */
export function getConfigFile(): string {
  return path.join(getConfigDir(), 'config.json');
}

/**
 * User-level config store (development/non-root usage)
 * Uses Conf package for cross-platform user config storage
 */
export const userConfig = new Conf<AgentConfig>({
  projectName: 'zn-vault-agent',
  defaults: {
    vaultUrl: '',
    tenantId: '',
    auth: {},
    targets: [],
    secretTargets: [],
    pollInterval: 3600,
    verbose: false,
  },
});
