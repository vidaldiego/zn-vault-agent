// Path: src/services/api-key-renewal.ts
// Automatic API key renewal before expiry

import https from 'node:https';
import http from 'node:http';
import { loadConfig, updateApiKey } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger({ module: 'api-key-renewal' });

interface ApiKeyStatus {
  id: string;
  name: string;
  prefix: string;
  expiresAt: string;
  expiresInDays: number;
  isExpiringSoon: boolean;
  scope: string;
}

interface ApiKeyRotateResponse {
  key: string;
  apiKey: {
    id: string;
    name: string;
    prefix: string;
    expires_at: string;
    scope: string;
  };
}

// Renewal threshold (days before expiry to renew)
const RENEWAL_THRESHOLD_DAYS = 30;

// Check interval (once per day)
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let checkTimer: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Make HTTP request with proper TLS handling
 */
function makeRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  return new Promise((resolve, reject) => {
    const config = loadConfig();

    if (!config.vaultUrl) {
      reject(new Error('Vault URL not configured'));
      return;
    }

    if (!config.auth.apiKey) {
      reject(new Error('No API key configured'));
      return;
    }

    const url = new URL(config.vaultUrl);
    const urlPath = new URL(path, config.vaultUrl);
    if (config.tenantId) {
      urlPath.searchParams.set('tenantId', config.tenantId);
    }

    const isHttps = url.protocol === 'https:';
    const protocol = isHttps ? https : http;

    const requestOptions: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: urlPath.pathname + urlPath.search,
      method,
      headers: {
        'X-API-Key': config.auth.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
      rejectUnauthorized: !config.insecure,
    };

    const req = protocol.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          if (res.statusCode && res.statusCode >= 400) {
            const error = data ? JSON.parse(data) : { message: res.statusMessage };
            reject(new Error(error.message || `Request failed: ${res.statusCode}`));
            return;
          }
          const parsed = data ? JSON.parse(data) : {};
          resolve(parsed as T);
        } catch (err) {
          reject(new Error(`Failed to parse response: ${err}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Check API key status
 */
async function checkApiKeyStatus(): Promise<ApiKeyStatus | null> {
  const config = loadConfig();

  if (!config.auth.apiKey) {
    log.debug('No API key configured, skipping status check');
    return null;
  }

  try {
    const status = await makeRequest<ApiKeyStatus>('GET', '/auth/api-keys/self');
    return status;
  } catch (err) {
    log.error({ err }, 'Failed to check API key status');
    return null;
  }
}

/**
 * Rotate the API key
 */
async function rotateApiKey(): Promise<string | null> {
  const config = loadConfig();

  if (!config.auth.apiKey) {
    log.error('No API key configured, cannot rotate');
    return null;
  }

  try {
    const result = await makeRequest<ApiKeyRotateResponse>('POST', '/auth/api-keys/self/rotate', {});
    log.info({
      newPrefix: result.apiKey.prefix,
      expiresAt: result.apiKey.expires_at,
    }, 'API key rotated successfully');
    return result.key;
  } catch (err) {
    log.error({ err }, 'Failed to rotate API key');
    return null;
  }
}

/**
 * Check and renew API key if needed
 */
export async function checkAndRenewApiKey(): Promise<boolean> {
  const config = loadConfig();

  // Only works with API key auth
  if (!config.auth.apiKey) {
    return false;
  }

  log.debug('Checking API key expiry...');

  const status = await checkApiKeyStatus();
  if (!status) {
    return false;
  }

  log.info({
    expiresInDays: status.expiresInDays,
    isExpiringSoon: status.isExpiringSoon,
    prefix: status.prefix,
  }, 'API key status');

  // Check if renewal is needed
  if (status.expiresInDays > RENEWAL_THRESHOLD_DAYS) {
    log.debug({ expiresInDays: status.expiresInDays }, 'API key not expiring soon, no renewal needed');
    return false;
  }

  log.info({
    expiresInDays: status.expiresInDays,
    threshold: RENEWAL_THRESHOLD_DAYS,
  }, 'API key expiring soon, initiating rotation');

  // Rotate the key
  const newKey = await rotateApiKey();
  if (!newKey) {
    log.error('Failed to rotate API key');
    return false;
  }

  // Update config file with new key
  try {
    updateApiKey(newKey);
    log.info('Config file updated with new API key');
    return true;
  } catch (err) {
    log.error({ err }, 'Failed to update config file with new API key');
    // The old key is now invalid, this is a critical error
    return false;
  }
}

/**
 * Start the API key renewal service
 */
export function startApiKeyRenewal(): void {
  if (isRunning) {
    log.warn('API key renewal service already running');
    return;
  }

  const config = loadConfig();

  // Only start if using API key auth
  if (!config.auth.apiKey) {
    log.debug('Not using API key auth, renewal service not needed');
    return;
  }

  isRunning = true;
  log.info({
    checkIntervalHours: CHECK_INTERVAL_MS / (60 * 60 * 1000),
    renewalThresholdDays: RENEWAL_THRESHOLD_DAYS,
  }, 'Starting API key renewal service');

  // Check immediately on startup
  checkAndRenewApiKey().catch(err => {
    log.error({ err }, 'Initial API key check failed');
  });

  // Schedule periodic checks
  checkTimer = setInterval(() => {
    checkAndRenewApiKey().catch(err => {
      log.error({ err }, 'Periodic API key check failed');
    });
  }, CHECK_INTERVAL_MS);
}

/**
 * Stop the API key renewal service
 */
export function stopApiKeyRenewal(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  isRunning = false;
  log.debug('API key renewal service stopped');
}
