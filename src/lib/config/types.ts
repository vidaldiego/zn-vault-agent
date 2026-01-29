// Path: src/lib/config/types.ts
// Configuration type definitions

import type { ExecSecret } from '../secret-env.js';
import type { PluginConfig } from '../../plugins/types.js';

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
export type { ExecSecret } from '../secret-env.js';

/**
 * Managed API key configuration for automatic rotation
 */
export interface ManagedKeyConfig {
  /** Managed key name in vault */
  name: string;
  /** File path to write the API key to (for apps that read from file) */
  filePath?: string;
  /** File owner (user:group) for the key file */
  fileOwner?: string;
  /** File mode for the key file (e.g., "0640") */
  fileMode?: string;
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
 * TLS configuration for agent HTTPS server
 */
export interface TLSConfig {
  /** Enable HTTPS health server (default: false) */
  enabled: boolean;
  /** Path to TLS certificate file (PEM format, includes private key if issued by vault) */
  certPath?: string;
  /** Path to TLS private key file (PEM format, optional if key is in certPath) */
  keyPath?: string;
  /** Path to CA certificate for client verification (optional, for mTLS) */
  clientCaCertPath?: string;
  /** Auto-renew certificate before expiry in days (default: 7) */
  renewBeforeDays?: number;
  /** HTTPS port for health server (default: 9443) */
  httpsPort?: number;
  /** Keep HTTP server running alongside HTTPS (default: true) */
  keepHttpServer?: boolean;
  /** Last certificate expiry (ISO timestamp, set automatically) */
  certExpiresAt?: string;
  /** Agent TLS certificate ID in vault (set automatically) */
  agentTlsCertId?: string;
}

/**
 * Default TLS configuration values
 */
export const DEFAULT_TLS_CONFIG: Partial<TLSConfig> = {
  enabled: false,
  renewBeforeDays: 7,
  httpsPort: 9443,
  keepHttpServer: true,
};

/**
 * Agent configuration
 */
export interface AgentConfig {
  /** Vault server URL */
  vaultUrl: string;
  /** Tenant ID (can be omitted if using configFromVault) */
  tenantId?: string;
  /** Authentication */
  auth: {
    /** API key (current value - updated automatically for managed keys) */
    apiKey?: string;
    /** Or username/password */
    username?: string;
    password?: string;
    /**
     * Bootstrap token for initial registration (one-time use).
     * When present, agent will call /v1/hosts/:hostname/register to exchange
     * the token for an API key on first startup.
     * After successful registration, this field is removed and apiKey is set.
     */
    bootstrapToken?: string;
  };
  /** Hostname for config-from-vault mode (used in bootstrap registration) */
  hostname?: string;
  /** Managed API key configuration (enables auto-rotation) */
  managedKey?: ManagedKeyConfig;
  /** Skip TLS verification for vault connection */
  insecure?: boolean;
  /** Custom CA certificate for vault connection (PEM path) */
  caCertPath?: string;
  /** TLS configuration for agent HTTPS server */
  tls?: TLSConfig;
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

  // ============================================================================
  // Config-from-vault mode (unified agent deployment)
  // ============================================================================

  /**
   * Pull config from vault at startup instead of using local config file.
   * When true, only vaultUrl, auth, and configFromVault fields are used locally.
   * All other config (targets, plugins, etc.) comes from the vault server.
   */
  configFromVault?: boolean;
  /** Host config ID assigned during bootstrap (set automatically) */
  hostConfigId?: string;
  /** Last known config version from vault (for change detection) */
  configVersion?: number;
  /** Managed key name for this host (used with config-from-vault) */
  managedKeyName?: string;
  /** Agent ID assigned during registration (set automatically) */
  agentId?: string;
}

/**
 * Default empty configuration
 */
export const EMPTY_CONFIG: AgentConfig = {
  vaultUrl: '',
  tenantId: '',
  auth: {},
  targets: [],
  secretTargets: [],
  pollInterval: 3600,
  verbose: false,
  configFromVault: false,
};
