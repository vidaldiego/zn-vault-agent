// Path: src/lib/config/loader.ts
// Configuration loading and retrieval

import fs from 'node:fs';
import { configLogger as log } from '../logger.js';
import type { AgentConfig } from './types.js';
import { EMPTY_CONFIG } from './types.js';
import { getConfigFile, userConfig } from './storage.js';

/**
 * Load configuration from file or user config, with environment variable overrides
 *
 * Environment variables:
 * - ZNVAULT_URL: Override vault URL
 * - ZNVAULT_TENANT_ID: Override tenant ID
 * - ZNVAULT_API_KEY: Override API key (preferred over config file)
 * - ZNVAULT_USERNAME: Override username
 * - ZNVAULT_PASSWORD: Override password (preferred over config file)
 * - ZNVAULT_INSECURE: Set to "true" to skip TLS verification
 */
export function loadConfig(): AgentConfig {
  let config: AgentConfig;

  // Try system config first
  const configFile = getConfigFile();
  if (fs.existsSync(configFile)) {
    try {
      const content = fs.readFileSync(configFile, 'utf-8');
      const parsed = JSON.parse(content) as Partial<AgentConfig>;
      // Merge with defaults to ensure all fields are present
      config = {
        ...EMPTY_CONFIG,
        ...parsed,
        auth: { ...EMPTY_CONFIG.auth, ...parsed.auth },
        targets: parsed.targets ?? [],
        secretTargets: parsed.secretTargets ?? [],
      };
      log.debug({ path: configFile }, 'Loaded system config');
    } catch (err) {
      log.error({ err, path: configFile }, 'Failed to load system config');
      // If custom config dir is set, use empty config instead of userConfig
      // This ensures test isolation and custom deployments work correctly
      config = process.env.ZNVAULT_AGENT_CONFIG_DIR ? { ...EMPTY_CONFIG } : userConfig.store;
    }
  } else if (process.env.ZNVAULT_AGENT_CONFIG_DIR) {
    // Custom config dir is set but file doesn't exist yet - use empty config
    // Don't fall back to userConfig to ensure isolation
    config = { ...EMPTY_CONFIG };
    log.debug({ path: configFile }, 'Using empty config for custom config dir');
  } else {
    // Fall back to user config
    config = userConfig.store;
    log.debug({ path: userConfig.path }, 'Loaded user config');
  }

  // Apply environment variable overrides
  if (process.env.ZNVAULT_URL) {
    config.vaultUrl = process.env.ZNVAULT_URL;
  }
  if (process.env.ZNVAULT_TENANT_ID) {
    config.tenantId = process.env.ZNVAULT_TENANT_ID;
  }
  if (process.env.ZNVAULT_API_KEY) {
    config.auth.apiKey = process.env.ZNVAULT_API_KEY;
  }
  if (process.env.ZNVAULT_USERNAME) {
    config.auth.username = process.env.ZNVAULT_USERNAME;
  }
  if (process.env.ZNVAULT_PASSWORD) {
    config.auth.password = process.env.ZNVAULT_PASSWORD;
  }
  if (process.env.ZNVAULT_INSECURE === 'true') {
    config.insecure = true;
  }

  return config;
}

/**
 * Get a specific config value
 */
export function getConfig<K extends keyof AgentConfig>(key: K): AgentConfig[K] {
  const config = loadConfig();
  return config[key];
}

/**
 * Check if agent is configured
 * Considers both config file and environment variables
 */
export function isConfigured(): boolean {
  const config = loadConfig();
  const hasAuth =
    config.auth.apiKey !== undefined ||
    process.env.ZNVAULT_API_KEY !== undefined ||
    config.auth.username !== undefined ||
    process.env.ZNVAULT_USERNAME !== undefined;
  return config.vaultUrl !== '' && config.tenantId !== '' && hasAuth;
}

/**
 * Get config file path for display
 */
export function getConfigPath(): string {
  const configFile = getConfigFile();
  if (process.getuid?.() === 0 && fs.existsSync(configFile)) {
    return configFile;
  }
  return userConfig.path;
}
