// Path: src/lib/config/saver.ts
// Configuration saving and modification

import fs from 'node:fs';
import { configLogger as log } from '../logger.js';
import type { AgentConfig } from './types.js';
import { getConfigDir, getConfigFile, userConfig } from './storage.js';
import { loadConfig } from './loader.js';

/**
 * Save configuration
 */
export function saveConfig(config: AgentConfig): void {
  const configDir = getConfigDir();
  const configFile = getConfigFile();

  // If ZNVAULT_AGENT_CONFIG_DIR is set, always use that directory
  // This allows tests and custom deployments to override the default behavior
  if (process.env.ZNVAULT_AGENT_CONFIG_DIR) {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    log.debug({ path: configFile }, 'Config saved (env override)');
    return;
  }

  // If running as root, save to system config
  if (process.getuid?.() === 0) {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    log.debug({ path: configFile }, 'Config saved (root)');
    return;
  }

  // If system config file exists and is writable, use it
  // This handles the case where agent runs as non-root user (e.g., zn-vault-agent)
  // but has write access to /etc/zn-vault-agent/config.json
  if (fs.existsSync(configFile)) {
    try {
      fs.accessSync(configFile, fs.constants.W_OK);
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
      log.debug({ path: configFile }, 'Config saved (system config)');
      return;
    } catch {
      // File exists but not writable, fall through to user config
      log.debug({ path: configFile }, 'System config not writable, using user config');
    }
  }

  // Fall back to user config
  userConfig.store = config;
  log.debug({ path: userConfig.path }, 'Config saved (user config)');
}

/**
 * Set a specific config value
 */
export function setConfig<K extends keyof AgentConfig>(key: K, value: AgentConfig[K]): void {
  const config = loadConfig();
  config[key] = value;
  saveConfig(config);
}

/**
 * Update API key in config file after rotation
 * This directly modifies the config file without going through loadConfig
 * to avoid environment variable overrides being persisted.
 *
 * Also updates process.env.ZNVAULT_API_KEY to ensure subsequent
 * loadConfig() calls return the new key.
 */
export function updateApiKey(newKey: string): void {
  let configPath: string;
  let config: AgentConfig;
  const configFile = getConfigFile();

  // Determine which config file to update
  if (process.getuid?.() === 0 && fs.existsSync(configFile)) {
    configPath = configFile;
  } else if (fs.existsSync(configFile)) {
    configPath = configFile;
  } else {
    // User config via Conf - ensure auth object exists
    const currentConfig = userConfig.store as Partial<AgentConfig>;
    currentConfig.auth ??= {};
    currentConfig.auth.apiKey = newKey;
    userConfig.store = currentConfig as AgentConfig;
    // Also update env var
    process.env.ZNVAULT_API_KEY = newKey;
    log.info({ path: userConfig.path }, 'API key updated in user config');
    return;
  }

  // Load and update system config file
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as Partial<AgentConfig>;
    // Ensure auth object exists before assigning
    parsed.auth ??= {};
    parsed.auth.apiKey = newKey;
    config = parsed as AgentConfig;

    // Write back with atomic rename
    const tempPath = `${configPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, configPath);

    // Also update env var so subsequent loadConfig() calls return new key
    process.env.ZNVAULT_API_KEY = newKey;

    log.info({ path: configPath }, 'API key updated in config file');
  } catch (err) {
    log.error({ err, path: configPath }, 'Failed to update API key in config');
    throw err;
  }
}
