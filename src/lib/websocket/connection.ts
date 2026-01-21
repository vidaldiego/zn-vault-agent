// Path: src/lib/websocket/connection.ts
// WebSocket connection URL building and sensitive data masking

import os from 'node:os';
import { createRequire } from 'node:module';
import { loadConfig } from '../config.js';
import { getDynamicSecretsCapabilities } from '../../services/dynamic-secrets/index.js';

// ESM-compatible way to read package.json
const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json') as { version: string };

/**
 * Build WebSocket URL with authentication and subscription parameters.
 *
 * @param additionalSecretIds - Additional secret IDs to subscribe to (e.g., exec secrets)
 * @param managedKeyNames - Managed API key names to subscribe to for rotation events
 * @returns WebSocket URL string
 */
export function buildWebSocketUrl(
  additionalSecretIds: string[] = [],
  managedKeyNames: string[] = []
): string {
  const config = loadConfig();
  const url = new URL(config.vaultUrl);

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v1/ws/agent';

  // Build initial subscription query params
  const certIds = config.targets.map(t => t.certId);
  const secretTargets = config.secretTargets ?? [];
  const secretTargetIds = secretTargets.map(t => t.secretId);

  // Combine secret target IDs with additional exec secret IDs
  const allSecretIds = [...new Set([...secretTargetIds, ...additionalSecretIds])];

  if (certIds.length > 0) {
    url.searchParams.set('certIds', certIds.join(','));
  }
  if (allSecretIds.length > 0) {
    url.searchParams.set('secretIds', allSecretIds.join(','));
  }
  // Subscribe to managed API key rotation events
  if (managedKeyNames.length > 0) {
    url.searchParams.set('managedKeys', managedKeyNames.join(','));
  }
  // Subscribe to stable update channel by default
  url.searchParams.set('updateChannel', 'stable');

  // Authentication
  if (config.auth.apiKey) {
    url.searchParams.set('apiKey', config.auth.apiKey);
  }

  // Hostname for registration
  const hostname = process.env.HOSTNAME ?? os.hostname();
  url.searchParams.set('hostname', hostname);
  url.searchParams.set('version', packageJson.version || 'unknown');
  url.searchParams.set('platform', process.platform);

  // Add capabilities (including dynamic-secrets if enabled)
  const capabilities = ['secrets', 'certificates', ...getDynamicSecretsCapabilities()];
  url.searchParams.set('capabilities', capabilities.join(','));

  return url.toString();
}

/**
 * Mask sensitive URL parameters using proper URL parsing.
 * More secure than regex-based masking as it properly handles
 * URL encoding and edge cases.
 *
 * @param url - URL to mask
 * @returns URL with sensitive parameters masked
 */
export function maskSensitiveUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const sensitiveParams = ['apiKey', 'key', 'token', 'secret', 'password', 'auth'];

    for (const param of sensitiveParams) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '***');
      }
    }

    return parsed.toString();
  } catch {
    // If URL parsing fails, fall back to regex (less secure but better than exposing)
    return url.replace(/([?&])(apiKey|key|token|secret|password|auth)=[^&]*/gi, '$1$2=***');
  }
}

/**
 * Get the current agent version.
 */
export function getAgentVersion(): string {
  return packageJson.version || 'unknown';
}

/**
 * Get the current hostname.
 */
export function getHostname(): string {
  return process.env.HOSTNAME ?? os.hostname();
}
