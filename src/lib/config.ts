import Conf from 'conf';
import fs from 'node:fs';
import path from 'node:path';
import { configLogger as log } from './logger.js';
import type { ExecSecret } from './secret-env.js';
import type { PluginConfig } from '../plugins/types.js';

/**
 * Certificate target configuration
 */
export interface CertTarget {
  /** Certificate ID in vault */
  certId: string;
  /** Human-readable name */
  name: string;
  /** Output paths for certificate components */
  outputs: {
    /** Combined cert+key (for HAProxy) */
    combined?: string;
    /** Certificate only */
    cert?: string;
    /** Private key only */
    key?: string;
    /** CA chain */
    chain?: string;
    /** Full chain (cert + chain) */
    fullchain?: string;
  };
  /** File ownership (user:group) */
  owner?: string;
  /** File permissions (e.g., "0640") */
  mode?: string;
  /** Command to run after cert update */
  reloadCmd?: string;
  /** Health check command (must return 0 for success) */
  healthCheckCmd?: string;
  /** Last known fingerprint */
  lastFingerprint?: string;
  /** Last sync timestamp */
  lastSync?: string;
}

/**
 * Secret target configuration
 */
export interface SecretTarget {
  /** Secret ID or alias in vault (e.g., "alias:db/credentials") */
  secretId: string;
  /** Human-readable name */
  name: string;
  /** Output format. Use 'none' for subscribe-only mode (no file output) */
  format: 'env' | 'json' | 'yaml' | 'raw' | 'template' | 'none';
  /** Output file path (not required when format is 'none') */
  output?: string;
  /** For 'raw' format: which key from the secret data to extract */
  key?: string;
  /** For 'template' format: path to template file */
  templatePath?: string;
  /** For 'env' format: prefix for variable names */
  envPrefix?: string;
  /** File ownership (user:group) */
  owner?: string;
  /** File permissions (e.g., "0600") */
  mode?: string;
  /** Command to run after secret update */
  reloadCmd?: string;
  /** Last known version */
  lastVersion?: number;
  /** Last sync timestamp */
  lastSync?: string;
}

/**
 * Exec mode configuration for running child process with secrets
 */
export interface ExecConfig {
  /** Command to execute (as array) */
  command: string[];
  /** Secret mappings for environment variables */
  secrets: ExecSecret[];
  /** Inherit current environment variables (default: true) */
  inheritEnv?: boolean;
  /** Restart child process on cert/secret changes (default: true) */
  restartOnChange?: boolean;
  /** Delay in ms before restarting child (default: 5000) */
  restartDelayMs?: number;
  /** Maximum restarts within window before entering degraded state (default: 10) */
  maxRestarts?: number;
  /** Time window in ms for counting restarts (default: 300000 = 5 minutes) */
  restartWindowMs?: number;
  /** Path to env file to update when secrets/keys rotate (optional, for daemon mode) */
  envFile?: string;
}

/**
 * Default exec configuration values
 */
export const DEFAULT_EXEC_CONFIG: Required<Omit<ExecConfig, 'command' | 'secrets' | 'envFile'>> & { envFile?: string } = {
  inheritEnv: true,
  restartOnChange: true,
  restartDelayMs: 5000,
  maxRestarts: 10,
  restartWindowMs: 300000,
  envFile: undefined,
};

// Re-export ExecSecret for convenience
export type { ExecSecret } from './secret-env.js';

/**
 * Managed API key configuration for automatic rotation
 */
export interface ManagedKeyConfig {
  /** Managed key name in vault */
  name: string;
  /** When the next rotation will occur (ISO timestamp) */
  nextRotationAt?: string;
  /** When the grace period expires (ISO timestamp) */
  graceExpiresAt?: string;
  /** Rotation mode (for informational purposes) */
  rotationMode?: 'scheduled' | 'on-use' | 'on-bind';
  /** Last bind timestamp */
  lastBind?: string;
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  /** Vault server URL */
  vaultUrl: string;
  /** Tenant ID */
  tenantId: string;
  /** Authentication */
  auth: {
    /** API key (current value - updated automatically for managed keys) */
    apiKey?: string;
    /** Or username/password */
    username?: string;
    password?: string;
  };
  /** Managed API key configuration (enables auto-rotation) */
  managedKey?: ManagedKeyConfig;
  /** Skip TLS verification */
  insecure?: boolean;
  /** Certificate targets */
  targets: CertTarget[];
  /** Secret targets */
  secretTargets?: SecretTarget[];
  /** Exec mode configuration (run child process with secrets as env vars) */
  exec?: ExecConfig;
  /** Global reload command (if not set per-target) */
  globalReloadCmd?: string;
  /** Polling interval in seconds (fallback if WebSocket disconnects) */
  pollInterval?: number;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Plugin configurations */
  plugins?: PluginConfig[];
}

// Default config location - computed dynamically to support test isolation
function getConfigDir(): string {
  return process.env.ZNVAULT_AGENT_CONFIG_DIR || '/etc/zn-vault-agent';
}

function getConfigFile(): string {
  return path.join(getConfigDir(), 'config.json');
}

// Use Conf for user-level config (development), file for system-level (production)
const userConfig = new Conf<AgentConfig>({
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

  // Default empty config (used when custom config dir is set but file doesn't exist)
  const emptyConfig: AgentConfig = {
    vaultUrl: '',
    tenantId: '',
    auth: {},
    targets: [],
    secretTargets: [],
    pollInterval: 3600,
    verbose: false,
  };

  // Try system config first
  const configFile = getConfigFile();
  if (fs.existsSync(configFile)) {
    try {
      const content = fs.readFileSync(configFile, 'utf-8');
      const parsed = JSON.parse(content) as Partial<AgentConfig>;
      // Merge with defaults to ensure all fields are present
      config = {
        ...emptyConfig,
        ...parsed,
        auth: { ...emptyConfig.auth, ...parsed.auth },
        targets: parsed.targets ?? [],
        secretTargets: parsed.secretTargets ?? [],
      };
      log.debug({ path: configFile }, 'Loaded system config');
    } catch (err) {
      log.error({ err, path: configFile }, 'Failed to load system config');
      // If custom config dir is set, use empty config instead of userConfig
      // This ensures test isolation and custom deployments work correctly
      config = process.env.ZNVAULT_AGENT_CONFIG_DIR ? emptyConfig : userConfig.store;
    }
  } else if (process.env.ZNVAULT_AGENT_CONFIG_DIR) {
    // Custom config dir is set but file doesn't exist yet - use empty config
    // Don't fall back to userConfig to ensure isolation
    config = emptyConfig;
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
    config.auth = config.auth || {};
    config.auth.apiKey = process.env.ZNVAULT_API_KEY;
  }
  if (process.env.ZNVAULT_USERNAME) {
    config.auth = config.auth || {};
    config.auth.username = process.env.ZNVAULT_USERNAME;
  }
  if (process.env.ZNVAULT_PASSWORD) {
    config.auth = config.auth || {};
    config.auth.password = process.env.ZNVAULT_PASSWORD;
  }
  if (process.env.ZNVAULT_INSECURE === 'true') {
    config.insecure = true;
  }

  return config;
}

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
    return;
  }

  // If running as root, save to system config
  if (process.getuid?.() === 0) {
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  } else {
    // Save to user config
    userConfig.store = config;
  }
}

/**
 * Get a specific config value
 */
export function getConfig<K extends keyof AgentConfig>(key: K): AgentConfig[K] {
  const config = loadConfig();
  return config[key];
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
 * Check if agent is configured
 * Considers both config file and environment variables
 */
export function isConfigured(): boolean {
  const config = loadConfig();
  const hasAuth = !!(
    config.auth.apiKey ||
    process.env.ZNVAULT_API_KEY ||
    config.auth.username ||
    process.env.ZNVAULT_USERNAME
  );
  return !!(config.vaultUrl && config.tenantId && hasAuth);
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

/**
 * Add a certificate target
 */
export function addTarget(target: CertTarget): void {
  const config = loadConfig();

  // Check if target with same certId exists
  const existingIndex = config.targets.findIndex(t => t.certId === target.certId);
  if (existingIndex >= 0) {
    config.targets[existingIndex] = target;
  } else {
    config.targets.push(target);
  }

  saveConfig(config);
}

/**
 * Remove a certificate target
 */
export function removeTarget(certIdOrName: string): boolean {
  const config = loadConfig();
  const initialLength = config.targets.length;

  config.targets = config.targets.filter(
    t => t.certId !== certIdOrName && t.name !== certIdOrName
  );

  if (config.targets.length < initialLength) {
    saveConfig(config);
    return true;
  }
  return false;
}

/**
 * Get all targets
 */
export function getTargets(): CertTarget[] {
  return loadConfig().targets;
}

/**
 * Update target fingerprint after successful sync
 */
export function updateTargetFingerprint(certId: string, fingerprint: string): void {
  const config = loadConfig();
  const target = config.targets.find(t => t.certId === certId);
  if (target) {
    target.lastFingerprint = fingerprint;
    target.lastSync = new Date().toISOString();
    saveConfig(config);
  }
}

/**
 * Add a secret target
 */
export function addSecretTarget(target: SecretTarget): void {
  const config = loadConfig();
  config.secretTargets = config.secretTargets || [];

  // Check if target with same name exists (allows same secret with different output configs)
  const existingIndex = config.secretTargets.findIndex(t => t.name === target.name);
  if (existingIndex >= 0) {
    config.secretTargets[existingIndex] = target;
  } else {
    config.secretTargets.push(target);
  }

  saveConfig(config);
}

/**
 * Remove a secret target
 */
export function removeSecretTarget(secretIdOrName: string): boolean {
  const config = loadConfig();
  if (!config.secretTargets) return false;

  const initialLength = config.secretTargets.length;
  config.secretTargets = config.secretTargets.filter(
    t => t.secretId !== secretIdOrName && t.name !== secretIdOrName
  );

  if (config.secretTargets.length < initialLength) {
    saveConfig(config);
    return true;
  }
  return false;
}

/**
 * Get all secret targets
 */
export function getSecretTargets(): SecretTarget[] {
  return loadConfig().secretTargets || [];
}

/**
 * Update secret target version after successful sync
 */
export function updateSecretTargetVersion(secretId: string, version: number): void {
  const config = loadConfig();
  const target = config.secretTargets?.find(t => t.secretId === secretId);
  if (target) {
    target.lastVersion = version;
    target.lastSync = new Date().toISOString();
    saveConfig(config);
  }
}

/**
 * Update managed key configuration after bind
 * Stores the new key value and rotation metadata
 *
 * IMPORTANT: Also updates process.env.ZNVAULT_API_KEY to ensure that
 * subsequent calls to loadConfig() return the new key, even if the
 * agent was started with the env var set (which would otherwise override
 * the config file value).
 */
export function updateManagedKey(
  newKey: string,
  metadata: {
    nextRotationAt?: string;
    graceExpiresAt?: string;
    rotationMode?: 'scheduled' | 'on-use' | 'on-bind';
  }
): void {
  const config = loadConfig();

  if (!config.managedKey?.name) {
    log.warn('updateManagedKey called but no managed key configured');
    return;
  }

  // Update the API key value
  config.auth = config.auth || {};
  config.auth.apiKey = newKey;

  // Update managed key metadata
  config.managedKey.nextRotationAt = metadata.nextRotationAt;
  config.managedKey.graceExpiresAt = metadata.graceExpiresAt;
  config.managedKey.rotationMode = metadata.rotationMode;
  config.managedKey.lastBind = new Date().toISOString();

  saveConfig(config);

  // CRITICAL: Also update the environment variable so that subsequent
  // loadConfig() calls return the new key. Without this, if the agent
  // was started with ZNVAULT_API_KEY env var, loadConfig() would continue
  // returning the old key even after saveConfig() writes the new one.
  process.env.ZNVAULT_API_KEY = newKey;

  log.info({
    managedKeyName: config.managedKey.name,
    nextRotationAt: metadata.nextRotationAt,
  }, 'Managed key config updated');
}

/**
 * Check if using managed key mode
 */
export function isManagedKeyMode(): boolean {
  const config = loadConfig();
  return !!config.managedKey?.name;
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
    // User config via Conf
    const currentConfig = userConfig.store;
    currentConfig.auth = currentConfig.auth || {};
    currentConfig.auth.apiKey = newKey;
    userConfig.store = currentConfig;
    // Also update env var
    process.env.ZNVAULT_API_KEY = newKey;
    log.info({ path: userConfig.path }, 'API key updated in user config');
    return;
  }

  // Load and update system config file
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(content) as AgentConfig;
    config.auth = config.auth || {};
    config.auth.apiKey = newKey;

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
