// Path: src/plugins/types.ts
// Plugin system type definitions for zn-vault-agent

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { AgentConfig, CertTarget, SecretTarget } from '../lib/config.js';
import type { ChildProcessState } from '../services/child-process-manager.js';

/**
 * Plugin metadata and lifecycle hooks
 */
export interface AgentPlugin {
  /** Unique plugin name (e.g., 'payara', 'kubernetes') */
  name: string;

  /** Semver version */
  version: string;

  /** Optional description */
  description?: string;

  /**
   * Called once when plugin is loaded, before daemon starts.
   * Use for initialization, validation, setting up state.
   */
  onInit?(ctx: PluginContext): Promise<void>;

  /**
   * Called when daemon is starting, after WebSocket is connected.
   * Use for startup tasks like checking external service health.
   */
  onStart?(ctx: PluginContext): Promise<void>;

  /**
   * Called when daemon is shutting down.
   * Use for cleanup, closing connections, etc.
   */
  onStop?(ctx: PluginContext): Promise<void>;

  /**
   * Register HTTP routes on the health server (port 9100).
   * Use for custom endpoints like /deploy, /status, etc.
   * Routes will be registered under /plugins/<name>/
   */
  routes?(fastify: FastifyInstance, ctx: PluginContext): Promise<void>;

  /**
   * React to certificate deployment events.
   * Called AFTER successful deployment.
   */
  onCertificateDeployed?(event: CertificateDeployedEvent, ctx: PluginContext): Promise<void>;

  /**
   * React to secret deployment events.
   * Called AFTER successful deployment.
   */
  onSecretDeployed?(event: SecretDeployedEvent, ctx: PluginContext): Promise<void>;

  /**
   * React to API key rotation events.
   * Called AFTER key is rotated and config updated.
   */
  onKeyRotated?(event: KeyRotatedEvent, ctx: PluginContext): Promise<void>;

  /**
   * React to child process lifecycle events (exec mode).
   */
  onChildProcessEvent?(event: ChildProcessEvent, ctx: PluginContext): Promise<void>;

  /**
   * Contribute to health check response.
   * Return status object that will be merged into /health response.
   */
  healthCheck?(ctx: PluginContext): Promise<PluginHealthStatus>;
}

/**
 * Factory function signature for configurable plugins
 */
export type PluginFactory<TConfig = Record<string, unknown>> = (
  config: TConfig
) => AgentPlugin;

/**
 * Plugin configuration in agent config.json
 */
export interface PluginConfig {
  /** npm package name (e.g., '@zincapp/znvault-plugin-payara') */
  package?: string;

  /** Local file path (alternative to package) */
  path?: string;

  /** Plugin-specific configuration passed to factory */
  config?: Record<string, unknown>;

  /** Enable/disable plugin (default: true) */
  enabled?: boolean;
}

/**
 * Context provided to plugins - safe access to agent internals
 */
export interface PluginContext {
  /** Pino logger scoped to plugin name */
  logger: Logger;

  /** Agent configuration (read-only snapshot) */
  config: Readonly<AgentConfig>;

  /** Vault URL */
  vaultUrl: string;

  /** Current tenant ID */
  tenantId: string;

  /**
   * Fetch a secret from vault by alias or ID.
   * Returns decrypted value.
   */
  getSecret(aliasOrId: string): Promise<SecretValue>;

  /**
   * Get certificate content by ID or name.
   */
  getCertificate(certIdOrName: string): Promise<CertificateContent>;

  /**
   * Get configured certificate targets
   */
  getCertTargets(): CertTarget[];

  /**
   * Get configured secret targets
   */
  getSecretTargets(): SecretTarget[];

  /**
   * Request child process restart (exec mode only).
   * No-op if not in exec mode.
   * @param reason Human-readable reason for restart
   */
  restartChild(reason: string): Promise<void>;

  /**
   * Get current child process state (exec mode only).
   * Returns null if not in exec mode.
   */
  getChildState(): ChildProcessState | null;

  /**
   * Emit custom event to other plugins.
   * @param event Event name
   * @param data Event payload
   */
  emit(event: string, data: unknown): void;

  /**
   * Listen for custom events from other plugins.
   * @param event Event name
   * @param handler Event handler
   */
  on(event: string, handler: (data: unknown) => void): void;

  /**
   * Remove event listener
   * @param event Event name
   * @param handler Handler to remove
   */
  off(event: string, handler: (data: unknown) => void): void;

  /**
   * Plugin-specific persistent storage (JSON file in config dir).
   */
  storage: PluginStorage;
}

/**
 * Secret value returned by getSecret
 */
export interface SecretValue {
  /** Secret ID */
  id: string;
  /** Secret alias (if any) */
  alias?: string;
  /** Decrypted secret data */
  data: Record<string, unknown>;
  /** Secret version */
  version: number;
  /** Secret type */
  type: string;
}

/**
 * Certificate content returned by getCertificate
 */
export interface CertificateContent {
  /** Certificate ID */
  id: string;
  /** Certificate name */
  name: string;
  /** PEM-encoded certificate */
  certificate: string;
  /** PEM-encoded private key */
  privateKey: string;
  /** PEM-encoded CA chain */
  chain?: string;
  /** Full chain (cert + chain) */
  fullchain?: string;
  /** Certificate fingerprint (SHA-256) */
  fingerprint: string;
  /** Expiration date */
  expiresAt: string;
  /** Subject common name */
  commonName: string;
  /** Subject alternative names */
  subjectAltNames?: string[];
}

/**
 * Simple key-value storage for plugins
 */
export interface PluginStorage {
  /**
   * Get a value from storage
   * @param key Storage key
   * @returns Value or undefined if not found
   */
  get<T>(key: string): T | undefined;

  /**
   * Set a value in storage
   * @param key Storage key
   * @param value Value to store (must be JSON-serializable)
   */
  set<T>(key: string, value: T): void;

  /**
   * Delete a value from storage
   * @param key Storage key
   */
  delete(key: string): void;

  /**
   * Clear all storage for this plugin
   */
  clear(): void;

  /**
   * Check if a key exists
   * @param key Storage key
   */
  has(key: string): boolean;

  /**
   * Get all keys
   */
  keys(): string[];
}

// ========================================
// Event Types
// ========================================

/**
 * Emitted after a certificate is successfully deployed to disk
 */
export interface CertificateDeployedEvent {
  /** Certificate ID */
  certId: string;
  /** Certificate name */
  name: string;
  /** Output paths where certificate components were written */
  paths: {
    /** Combined cert+key path (for HAProxy) */
    combined?: string;
    /** Certificate-only path */
    cert?: string;
    /** Private key path */
    key?: string;
    /** CA chain path */
    chain?: string;
    /** Full chain path (cert + chain) */
    fullchain?: string;
  };
  /** Certificate fingerprint (SHA-256) */
  fingerprint: string;
  /** Expiration date (ISO timestamp) */
  expiresAt: string;
  /** Common name from certificate */
  commonName: string;
  /** Whether this was an update (true) or initial sync (false) */
  isUpdate: boolean;
}

/**
 * Emitted after a secret is successfully deployed to disk
 */
export interface SecretDeployedEvent {
  /** Secret ID */
  secretId: string;
  /** Secret alias */
  alias?: string;
  /** Secret name (from target config) */
  name: string;
  /** Output file path */
  path: string;
  /** Output format used */
  format: 'env' | 'json' | 'yaml' | 'raw' | 'template';
  /** Secret version */
  version: number;
  /** Whether this was an update (true) or initial sync (false) */
  isUpdate: boolean;
}

/**
 * Emitted after managed API key is rotated
 */
export interface KeyRotatedEvent {
  /** Managed key name */
  keyName: string;
  /** New key prefix (first 10 chars + ...) for logging */
  newPrefix: string;
  /** When grace period expires (ISO timestamp) */
  graceExpiresAt?: string;
  /** Next rotation time (ISO timestamp) */
  nextRotationAt?: string;
  /** Rotation mode */
  rotationMode: 'scheduled' | 'on-use' | 'on-bind';
}

/**
 * Emitted on child process lifecycle events (exec mode)
 */
export interface ChildProcessEvent {
  /** Event type */
  type: 'started' | 'stopped' | 'restarting' | 'crashed' | 'max_restarts';
  /** Process ID (for 'started') */
  pid?: number;
  /** Exit code (for 'stopped', 'crashed') */
  exitCode?: number;
  /** Signal that killed process (for 'stopped', 'crashed') */
  signal?: string;
  /** Reason for restart (for 'restarting') */
  reason?: string;
  /** Restart count (for 'max_restarts') */
  restartCount?: number;
}

/**
 * Plugin health status for /health endpoint
 */
export interface PluginHealthStatus {
  /** Plugin name */
  name: string;
  /** Health status */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** Human-readable message */
  message?: string;
  /** Additional details */
  details?: Record<string, unknown>;
}

// ========================================
// Internal Types (for plugin loader)
// ========================================

/**
 * Loaded plugin state (internal)
 */
export interface LoadedPlugin {
  /** Plugin instance */
  plugin: AgentPlugin;
  /** Plugin configuration */
  config?: Record<string, unknown>;
  /** Plugin status */
  status: 'loaded' | 'initialized' | 'running' | 'stopped' | 'error';
  /** Error if status is 'error' */
  error?: Error;
}

/**
 * Plugin event type mapping for dispatcher
 */
export type PluginEventMap = {
  certificateDeployed: CertificateDeployedEvent;
  secretDeployed: SecretDeployedEvent;
  keyRotated: KeyRotatedEvent;
  childProcess: ChildProcessEvent;
};

/**
 * Plugin event handler names
 */
export const PLUGIN_EVENT_HANDLERS = {
  certificateDeployed: 'onCertificateDeployed',
  secretDeployed: 'onSecretDeployed',
  keyRotated: 'onKeyRotated',
  childProcess: 'onChildProcessEvent',
} as const;
