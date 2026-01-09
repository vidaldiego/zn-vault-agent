// Path: zn-vault-agent/src/services/degraded-mode-handler.ts
// Handles degraded connection mode and reprovisioning flow

import https from 'node:https';
import http from 'node:http';
import { wsLogger as log } from '../lib/logger.js';
import { loadConfig, updateApiKey } from '../lib/config.js';

/**
 * Degraded connection reason
 */
export type DegradedReason = 'key_expired' | 'key_revoked' | 'key_disabled' | 'auth_failed';

/**
 * Degraded connection info from server
 */
export interface DegradedConnectionInfo {
  isDegraded: true;
  reason: DegradedReason;
  agentId?: string;
  message: string;
  canReceiveReprovision: boolean;
}

/**
 * Reprovision available message from server
 */
export interface ReprovisionAvailableMessage {
  type: 'reprovision_available';
  expiresAt: string;
  timestamp: string;
}

/**
 * Reprovision claim response from API
 */
interface ReprovisionClaimResponse {
  success: boolean;
  apiKey: string;
  keyId: string;
  expiresAt: string | null;
}

/**
 * Degraded mode state
 */
interface DegradedState {
  isDegraded: boolean;
  reason?: DegradedReason;
  agentId?: string;
  reprovisionAvailable: boolean;
  reprovisionExpiresAt?: string;
  pollTimer?: NodeJS.Timeout;
}

// Module state
let state: DegradedState = {
  isDegraded: false,
  reprovisionAvailable: false,
};

// Callbacks
let onCredentialsUpdated: ((newKey: string) => void) | null = null;
let onStateChanged: ((isDegraded: boolean, reason?: DegradedReason) => void) | null = null;

// Constants
const REPROVISION_POLL_INTERVAL = 30000; // Poll every 30 seconds

/**
 * Initialize degraded mode handler
 */
export function initDegradedModeHandler(callbacks: {
  onCredentialsUpdated?: (newKey: string) => void;
  onStateChanged?: (isDegraded: boolean, reason?: DegradedReason) => void;
}): void {
  onCredentialsUpdated = callbacks.onCredentialsUpdated ?? null;
  onStateChanged = callbacks.onStateChanged ?? null;

  log.debug('Degraded mode handler initialized');
}

/**
 * Handle degraded connection notification from server
 */
export function handleDegradedConnection(info: DegradedConnectionInfo): void {
  log.warn({
    reason: info.reason,
    agentId: info.agentId,
    message: info.message,
  }, 'Agent entered degraded mode');

  state.isDegraded = true;
  state.reason = info.reason;
  state.agentId = info.agentId;

  // Notify callback
  onStateChanged?.(true, info.reason);

  // Start polling for reprovision status if we can receive it
  if (info.canReceiveReprovision && !state.pollTimer) {
    startReprovisionPolling();
  }
}

/**
 * Handle reprovision available notification
 */
export function handleReprovisionAvailable(expiresAt: string): void {
  log.info({
    expiresAt,
    agentId: state.agentId,
  }, 'Reprovision token available');

  state.reprovisionAvailable = true;
  state.reprovisionExpiresAt = expiresAt;

  // If we have a stored token, attempt to claim immediately
  // Otherwise, the admin needs to provide the token manually
}

/**
 * Make a simple HTTP request to the vault API (no auth required for claim)
 */
async function makeClaimRequest(
  vaultUrl: string,
  path: string,
  body: unknown,
  insecure: boolean
): Promise<ReprovisionClaimResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, vaultUrl);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const requestBody = JSON.stringify(body);

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
      rejectUnauthorized: !insecure,
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(data) as ReprovisionClaimResponse;
          if (res.statusCode === 200) {
            resolve(response);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        } catch {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
}

/**
 * Claim reprovision token and get new credentials
 * Called when the agent has received a reprovision token (e.g., via CLI or config)
 */
export async function claimReprovisionToken(token: string): Promise<boolean> {
  if (!state.agentId) {
    log.error('Cannot claim reprovision: no agent ID');
    return false;
  }

  const config = loadConfig();

  try {
    log.info({ agentId: state.agentId }, 'Claiming reprovision token');

    const response = await makeClaimRequest(
      config.vaultUrl,
      '/v1/agents/claim-reprovision',
      {
        agentId: state.agentId,
        token,
      },
      config.insecure ?? false
    );

    if (response.success && response.apiKey) {
      log.info({
        keyId: response.keyId,
        keyPrefix: response.apiKey.substring(0, 8),
      }, 'Reprovision successful, received new credentials');

      // Update credentials in config
      await updateCredentials(response.apiKey);

      // Clear degraded state
      clearDegradedState();

      // Notify callback
      onCredentialsUpdated?.(response.apiKey);

      return true;
    } else {
      log.error({ response }, 'Reprovision claim failed');
      return false;
    }
  } catch (err) {
    log.error({ err, agentId: state.agentId }, 'Failed to claim reprovision token');
    return false;
  }
}

/**
 * Poll for reprovision status
 *
 * Note: In degraded mode, we rely on WebSocket notifications rather than
 * polling the API, since API calls require valid authentication.
 * This function is kept for potential future use with degraded auth support.
 */
async function pollReprovisionStatus(): Promise<void> {
  if (!state.isDegraded || !state.agentId) {
    return;
  }

  // In degraded mode, we can't poll the API because our credentials are invalid.
  // Instead, we rely on WebSocket reconnection which supports degraded auth.
  // The server will send us reprovision_available messages when a token is ready.
  log.debug({
    agentId: state.agentId,
    reprovisionAvailable: state.reprovisionAvailable,
  }, 'Degraded mode - waiting for reprovision notification via WebSocket');
}

/**
 * Start polling for reprovision status
 */
function startReprovisionPolling(): void {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }

  // Initial poll
  void pollReprovisionStatus();

  // Set up interval
  state.pollTimer = setInterval(() => {
    void pollReprovisionStatus();
  }, REPROVISION_POLL_INTERVAL);

  log.debug({ interval: REPROVISION_POLL_INTERVAL }, 'Started reprovision status polling');
}

/**
 * Stop polling for reprovision status
 */
function stopReprovisionPolling(): void {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = undefined;
  }
}

/**
 * Update credentials after successful reprovision
 */
async function updateCredentials(newKey: string): Promise<void> {
  try {
    // Update API key in config file and environment
    updateApiKey(newKey);

    log.info({ keyPrefix: newKey.substring(0, 8) }, 'Credentials updated successfully');
  } catch (err) {
    log.error({ err }, 'Failed to update credentials');
    throw err;
  }
}

/**
 * Clear degraded state after successful reprovision
 */
function clearDegradedState(): void {
  stopReprovisionPolling();

  state = {
    isDegraded: false,
    reprovisionAvailable: false,
  };

  // Notify callback
  onStateChanged?.(false);

  log.info('Degraded state cleared');
}

/**
 * Check if currently in degraded mode
 */
export function isDegradedMode(): boolean {
  return state.isDegraded;
}

/**
 * Get current degraded state
 */
export function getDegradedState(): {
  isDegraded: boolean;
  reason?: DegradedReason;
  agentId?: string;
  reprovisionAvailable: boolean;
  reprovisionExpiresAt?: string;
} {
  return {
    isDegraded: state.isDegraded,
    reason: state.reason,
    agentId: state.agentId,
    reprovisionAvailable: state.reprovisionAvailable,
    reprovisionExpiresAt: state.reprovisionExpiresAt,
  };
}

/**
 * Manually set agent ID (used when server doesn't provide it)
 */
export function setAgentId(agentId: string): void {
  state.agentId = agentId;
}

/**
 * Cleanup handler
 */
export function cleanupDegradedModeHandler(): void {
  stopReprovisionPolling();
  state = {
    isDegraded: false,
    reprovisionAvailable: false,
  };
  onCredentialsUpdated = null;
  onStateChanged = null;
}
