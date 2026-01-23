// Path: src/lib/config/vault-loader.ts
// Load agent configuration from vault server (config-from-vault mode)

import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import { configLogger as log } from '../logger.js';
import type { AgentConfig, CertTarget, SecretTarget, ExecConfig } from './types.js';
import type { PluginConfig } from '../../plugins/types.js';

/**
 * Response from vault's host config endpoint
 */
interface VaultConfigResponse {
  version: number;
  tenantId: string;
  config: {
    targets?: CertTarget[];
    secretTargets?: SecretTarget[];
    plugins?: PluginConfig[];
    exec?: ExecConfig;
    globalReloadCmd?: string;
    pollInterval?: number;
    verbose?: boolean;
    insecure?: boolean;
  };
  managedKeyName: string | null;
  vaultUrl: string;
}

/**
 * Options for fetching config from vault
 */
export interface FetchConfigOptions {
  /** Vault server URL */
  vaultUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Skip TLS verification */
  insecure?: boolean;
  /** Agent ID (for tracking) */
  agentId?: string;
  /** Host config ID (preferred for fetching config) */
  hostConfigId?: string;
  /** Last known config version (for conditional GET) */
  configVersion?: number;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

/**
 * Result of fetching config from vault
 */
export interface FetchConfigResult {
  /** Whether config was fetched successfully */
  success: boolean;
  /** The merged agent config */
  config?: AgentConfig;
  /** New config version */
  version?: number;
  /** Whether config was modified (false for 304 Not Modified) */
  modified?: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Fetch agent configuration from vault server
 *
 * @param options Fetch options including vaultUrl, apiKey, etc.
 * @returns Fetch result with config or error
 */
export async function fetchConfigFromVault(options: FetchConfigOptions): Promise<FetchConfigResult> {
  const {
    vaultUrl,
    apiKey,
    insecure = false,
    agentId,
    hostConfigId,
    configVersion,
    timeout = 30000,
  } = options;

  // Build URL - prefer hostConfigId, fall back to system hostname
  let url: URL;
  let logContext: Record<string, string | undefined>;

  if (hostConfigId) {
    // Fetch by host config ID (preferred for linked agents)
    url = new URL(`/v1/agent/config`, vaultUrl);
    url.searchParams.set('hostConfigId', hostConfigId);
    logContext = { vaultUrl, hostConfigId };
  } else {
    // Fall back to hostname lookup (legacy mode)
    const hostname = os.hostname();
    url = new URL(`/v1/hosts/${encodeURIComponent(hostname)}/config`, vaultUrl);
    logContext = { vaultUrl, hostname };
  }

  log.debug(logContext, 'Fetching config from vault');

  return new Promise((resolve) => {
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const headers: Record<string, string> = {
      'X-Api-Key': apiKey,
      'Accept': 'application/json',
    };

    // Add conditional GET header
    if (configVersion !== undefined) {
      headers['X-Agent-Config-Version'] = String(configVersion);
    }

    // Add agent ID for tracking
    if (agentId) {
      headers['X-Agent-Id'] = agentId;
    }

    const requestOptions: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers,
      timeout,
    };

    // Skip TLS verification if insecure
    if (isHttps && insecure) {
      requestOptions.rejectUnauthorized = false;
    }

    const req = client.request(requestOptions, (res) => {
      let data = '';

      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });

      res.on('end', () => {
        // Handle 304 Not Modified
        if (res.statusCode === 304) {
          log.debug({ ...logContext, version: configVersion }, 'Config not modified');
          resolve({
            success: true,
            modified: false,
            version: configVersion,
          });
          return;
        }

        // Handle errors
        if (res.statusCode !== 200) {
          let errorMessage = `HTTP ${res.statusCode}`;
          try {
            const errorBody = JSON.parse(data) as { error?: string; message?: string };
            errorMessage = errorBody.error ?? errorBody.message ?? errorMessage;
          } catch {
            // Use status code as error
          }

          log.error({ statusCode: res.statusCode, error: errorMessage }, 'Failed to fetch config from vault');
          resolve({
            success: false,
            error: errorMessage,
          });
          return;
        }

        // Parse response
        try {
          const response = JSON.parse(data) as VaultConfigResponse;

          // Merge with local auth to create full config
          // IMPORTANT: Preserve hostConfigId and agentId from options
          // These are needed for subsequent config fetches after restart
          const config: AgentConfig = {
            vaultUrl: response.vaultUrl,
            tenantId: response.tenantId,
            auth: {
              apiKey, // Keep local API key
            },
            insecure,
            targets: response.config.targets ?? [],
            secretTargets: response.config.secretTargets ?? [],
            exec: response.config.exec,
            globalReloadCmd: response.config.globalReloadCmd,
            pollInterval: response.config.pollInterval ?? 3600,
            verbose: response.config.verbose ?? false,
            plugins: response.config.plugins,
            // Config-from-vault metadata
            configFromVault: true,
            configVersion: response.version,
            // Convert managedKeyName to managedKey object for rotation service
            managedKey: response.managedKeyName ? { name: response.managedKeyName } : undefined,
            // Preserve identifiers for subsequent fetches
            hostConfigId,
            agentId,
          };

          log.info({
            ...logContext,
            version: response.version,
            targets: config.targets.length,
            secretTargets: config.secretTargets?.length ?? 0,
            plugins: config.plugins?.length ?? 0,
          }, 'Config fetched from vault');

          resolve({
            success: true,
            config,
            version: response.version,
            modified: true,
          });
        } catch (err) {
          log.error({ err, data }, 'Failed to parse vault config response');
          resolve({
            success: false,
            error: 'Invalid response from vault',
          });
        }
      });
    });

    req.on('error', (err: Error) => {
      log.error({ err, vaultUrl }, 'Request to vault failed');
      resolve({
        success: false,
        error: err.message,
      });
    });

    req.on('timeout', () => {
      req.destroy();
      log.error({ vaultUrl, timeout }, 'Request to vault timed out');
      resolve({
        success: false,
        error: 'Request timed out',
      });
    });

    req.end();
  });
}

/**
 * Response from vault's agent identity endpoint
 */
interface AgentIdentityResponse {
  agentId: string;
  hostname: string;
  tenantId: string;
  hostConfigId: string | null;
  hostConfigName: string | null;
  configVersion: number | null;
}

/**
 * Discover agent identity from vault
 *
 * Calls GET /v1/agent/identity to get the agent's ID and info.
 * This is useful when migrating to config-from-vault mode without
 * going through the bootstrap flow.
 *
 * @param options Connection options
 * @returns Agent identity or null if not found
 */
export async function discoverAgentIdentity(options: {
  vaultUrl: string;
  apiKey: string;
  hostname?: string;
  tenantId?: string;
  insecure?: boolean;
  timeout?: number;
}): Promise<AgentIdentityResponse | null> {
  const {
    vaultUrl,
    apiKey,
    hostname,
    tenantId,
    insecure = false,
    timeout = 30000,
  } = options;

  log.info({ vaultUrl, hostname }, 'Discovering agent identity from vault');

  return new Promise((resolve) => {
    const url = new URL(vaultUrl);
    const isHttps = url.protocol === 'https:';

    // Build path with query params
    const params = new URLSearchParams();
    if (hostname) params.set('hostname', hostname);
    if (tenantId) params.set('tenantId', tenantId);
    const path = `/v1/agent/identity${params.toString() ? `?${params}` : ''}`;

    const requestOptions: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path,
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json',
        'User-Agent': `zn-vault-agent/${os.hostname()}`,
      },
      rejectUnauthorized: !insecure,
      timeout,
    };

    const httpModule = isHttps ? https : http;
    const req = httpModule.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });

      res.on('end', () => {
        if (res.statusCode === 404) {
          log.info({ hostname }, 'Agent not found in vault (may need to connect first)');
          resolve(null);
          return;
        }

        if (res.statusCode !== 200) {
          log.warn(
            { statusCode: res.statusCode, body: data },
            'Failed to discover agent identity'
          );
          resolve(null);
          return;
        }

        try {
          const response = JSON.parse(data) as AgentIdentityResponse;
          log.info(
            { agentId: response.agentId, hostname: response.hostname },
            'Agent identity discovered'
          );
          resolve(response);
        } catch (err) {
          log.error({ err, data }, 'Failed to parse identity response');
          resolve(null);
        }
      });
    });

    req.on('error', (err: Error) => {
      log.error({ err, vaultUrl }, 'Identity discovery request failed');
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      log.warn({ vaultUrl, timeout }, 'Identity discovery request timed out');
      resolve(null);
    });

    req.end();
  });
}

/**
 * Check if local config has configFromVault enabled
 */
export function isConfigFromVaultEnabled(config: Partial<AgentConfig>): boolean {
  return config.configFromVault === true;
}

/**
 * Get minimal config needed for config-from-vault mode
 * Only vaultUrl, auth, and insecure are used locally
 */
export function getMinimalConfigForVaultMode(config: AgentConfig): Pick<AgentConfig, 'vaultUrl' | 'auth' | 'insecure' | 'configFromVault' | 'configVersion'> {
  return {
    vaultUrl: config.vaultUrl,
    auth: config.auth,
    insecure: config.insecure,
    configFromVault: true,
    configVersion: config.configVersion,
  };
}
