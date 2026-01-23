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
            managedKeyName: response.managedKeyName ?? undefined,
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
