// Path: src/lib/api.ts
// Vault API client with retry logic and observability

import https from 'node:https';
import http from 'node:http';
import { loadConfig } from './config.js';
import { apiLogger as log } from './logger.js';
import { metrics } from './metrics.js';
import { setVaultReachable } from './health.js';

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  token?: string;
  /** Skip retry logic (e.g., for login) */
  noRetry?: boolean;
}

interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    username: string;
    role: string;
    tenantId: string | null;
  };
}

export interface CertificateMetadata {
  id: string;
  tenantId: string;
  clientId: string;
  kind: string;
  alias: string;
  certificateType: 'PEM' | 'P12' | 'DER';
  fingerprintSha256: string;
  subjectCn: string;
  issuerCn: string;
  notBefore: string;
  notAfter: string;
  status: string;
  version: number;
  daysUntilExpiry: number;
}

export interface DecryptedCertificate {
  id: string;
  certificateData: string;
  certificateType: 'PEM' | 'P12' | 'DER';
  fingerprintSha256: string;
}

export interface SecretMetadata {
  id: string;
  alias: string;
  tenantId: string;
  type: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  tags?: string[];
}

export interface DecryptedSecret {
  id: string;
  alias: string;
  type: string;
  version: number;
  data: Record<string, unknown>;
}

export interface ManagedApiKeyBindResponse {
  id: string;
  key: string;
  prefix: string;
  name: string;
  expiresAt: string;
  gracePeriod: string;
  graceExpiresAt?: string;
  rotationMode: 'scheduled' | 'on-use' | 'on-bind';
  permissions: string[];
  nextRotationAt?: string;
  _notice?: string;
}

// Token cache
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_DELAY = 10000; // 10 seconds

/**
 * Check if an error is retryable
 */
function isRetryableError(statusCode: number | undefined, error: Error): boolean {
  // Network errors are retryable
  if (error.message.includes('ECONNREFUSED') ||
      error.message.includes('ENOTFOUND') ||
      error.message.includes('ETIMEDOUT') ||
      error.message.includes('timeout') ||
      error.message.includes('socket hang up')) {
    return true;
  }

  // 5xx errors are retryable
  if (statusCode && statusCode >= 500 && statusCode < 600) {
    return true;
  }

  // 429 Too Many Requests is retryable
  if (statusCode === 429) {
    return true;
  }

  return false;
}

/**
 * Calculate retry delay with exponential backoff and jitter
 */
function getRetryDelay(attempt: number): number {
  const baseDelay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
  const jitter = Math.random() * 1000;
  return Math.min(baseDelay + jitter, MAX_RETRY_DELAY);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make HTTP request to vault API with retry logic
 */
async function request<T>(options: RequestOptions): Promise<T> {
  const config = loadConfig();
  const startTime = Date.now();

  if (!config.vaultUrl) {
    throw new Error('Vault URL not configured. Run: zn-vault-agent login');
  }

  const url = new URL(config.vaultUrl);
  url.pathname = options.path;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // Add authentication
  if (options.token && options.token !== 'skip') {
    headers.Authorization = `Bearer ${options.token}`;
  } else if (options.token !== 'skip') {
    if (config.auth.apiKey) {
      headers['X-API-Key'] = config.auth.apiKey;
    } else if (cachedToken && Date.now() < tokenExpiry) {
      headers.Authorization = `Bearer ${cachedToken}`;
    } else if (config.auth.username && config.auth.password) {
      // Need to login first
      log.debug('Token expired or missing, logging in');
      await login(config.auth.username, config.auth.password);
      if (cachedToken) {
        headers.Authorization = `Bearer ${cachedToken}`;
      }
    }
  }

  const requestOptions: https.RequestOptions = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: options.method,
    headers,
    timeout: 30000,
    rejectUnauthorized: !config.insecure,
  };

  let lastError: Error | null = null;
  let lastStatusCode: number | undefined;
  const maxAttempts = options.noRetry ? 1 : MAX_RETRIES;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = getRetryDelay(attempt - 1);
      log.debug({ attempt, delay, path: options.path }, 'Retrying request');
      await sleep(delay);
    }

    try {
      const result = await executeRequest<T>(requestOptions, options.body, url.protocol === 'https:');
      const duration = Date.now() - startTime;

      // Record metrics
      metrics.apiRequest(options.method, result.statusCode, duration);
      setVaultReachable(true);

      if (result.statusCode >= 400) {
        const error = result.data as unknown as ApiError;
        const errorMessage = error?.message || `Request failed with status ${result.statusCode}`;

        lastStatusCode = result.statusCode;
        lastError = new Error(errorMessage);

        // Don't retry auth errors
        if (result.statusCode === 401 || result.statusCode === 403) {
          log.warn({ path: options.path, status: result.statusCode }, 'Authentication failed');
          throw lastError;
        }

        // Check if retryable
        if (!isRetryableError(result.statusCode, lastError)) {
          log.warn({ path: options.path, status: result.statusCode, error: errorMessage }, 'Request failed');
          throw lastError;
        }

        log.debug({ attempt, status: result.statusCode }, 'Retryable error');
        continue;
      }

      log.debug({ path: options.path, status: result.statusCode, duration }, 'Request completed');
      return result.data;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;

      const duration = Date.now() - startTime;
      metrics.apiRequest(options.method, 0, duration);

      // Network error - vault may be unreachable
      if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOTFOUND')) {
        setVaultReachable(false);
      }

      if (!isRetryableError(undefined, error)) {
        log.error({ path: options.path, err: error }, 'Non-retryable error');
        throw error;
      }

      log.debug({ attempt, err: error.message }, 'Retryable network error');
    }
  }

  // All retries exhausted
  log.error({ path: options.path, attempts: maxAttempts, lastStatus: lastStatusCode }, 'Request failed after retries');
  throw lastError || new Error('Request failed after retries');
}

/**
 * Execute a single HTTP request
 */
function executeRequest<T>(
  requestOptions: https.RequestOptions,
  body: unknown,
  useHttps: boolean
): Promise<{ statusCode: number; data: T }> {
  return new Promise((resolve, reject) => {
    const protocol = useHttps ? https : http;
    const req = protocol.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ statusCode: res.statusCode || 0, data: parsed as T });
        } catch {
          resolve({ statusCode: res.statusCode || 0, data: data as unknown as T });
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
 * Login and get access token
 */
export async function login(username: string, password: string): Promise<LoginResponse> {
  log.info({ username }, 'Logging in to vault');

  const response = await request<LoginResponse>({
    method: 'POST',
    path: '/auth/login',
    body: { username, password },
    token: 'skip', // Don't try to auto-auth
    noRetry: true, // Don't retry login (could lock account)
  });

  // Cache the token
  cachedToken = response.accessToken;
  tokenExpiry = Date.now() + (response.expiresIn * 1000) - 60000; // 1 min buffer

  log.info({ username, expiresIn: response.expiresIn }, 'Login successful');
  setVaultReachable(true);

  return response;
}

/**
 * List certificates
 */
export async function listCertificates(): Promise<{ items: CertificateMetadata[]; total: number }> {
  log.debug('Listing certificates');
  return await request({
    method: 'GET',
    path: '/v1/certificates',
  });
}

/**
 * Get certificate metadata
 */
export async function getCertificate(certId: string): Promise<CertificateMetadata> {
  log.debug({ certId }, 'Getting certificate metadata');
  return await request({
    method: 'GET',
    path: `/v1/certificates/${certId}`,
  });
}

/**
 * Decrypt certificate (get actual cert data)
 */
export async function decryptCertificate(certId: string, purpose: string): Promise<DecryptedCertificate> {
  log.debug({ certId, purpose }, 'Decrypting certificate');
  return await request({
    method: 'POST',
    path: `/v1/certificates/${certId}/decrypt`,
    body: { purpose },
  });
}

/**
 * Acknowledge certificate delivery (for tracking)
 */
export async function ackDelivery(certId: string, hostname: string, version: number): Promise<void> {
  try {
    await request({
      method: 'POST',
      path: `/v1/certificates/${certId}/ack`,
      body: { hostname, version, timestamp: new Date().toISOString() },
      noRetry: true, // ACK is best-effort
    });
    log.debug({ certId, hostname, version }, 'Delivery acknowledged');
  } catch (err) {
    // ACK is best-effort, don't fail if endpoint doesn't exist yet
    log.debug({ certId, err }, 'Failed to acknowledge delivery (best-effort)');
  }
}

/**
 * List secrets
 */
export async function listSecrets(): Promise<{ items: SecretMetadata[]; total: number }> {
  log.debug('Listing secrets');
  const response = await request<SecretMetadata[]>({
    method: 'GET',
    path: '/v1/secrets',
  });
  // API returns array directly, normalize to { items, total }
  const items = Array.isArray(response) ? response : [];
  return { items, total: items.length };
}

/**
 * Get secret by ID or alias
 * @param secretId - UUID or alias (e.g., "alias:db/credentials")
 */
export async function getSecret(secretId: string): Promise<DecryptedSecret> {
  log.debug({ secretId }, 'Getting secret');

  let id = secretId;

  // Handle alias format - resolve to UUID first
  if (secretId.startsWith('alias:')) {
    const aliasPath = secretId.substring(6); // Remove "alias:" prefix
    const metadata = await request<SecretMetadata>({
      method: 'GET',
      path: `/v1/secrets/alias/${encodeURIComponent(aliasPath)}`,
    });
    id = metadata.id;
  }

  // Decrypt using UUID
  return await request({
    method: 'POST',
    path: `/v1/secrets/${id}/decrypt`,
    body: {},  // Empty body required for POST
  });
}

/**
 * Get secret metadata only (without decrypting)
 */
export async function getSecretMetadata(secretId: string): Promise<SecretMetadata> {
  log.debug({ secretId }, 'Getting secret metadata');

  // Handle alias format
  if (secretId.startsWith('alias:')) {
    const aliasPath = secretId.substring(6); // Remove "alias:" prefix
    return await request({
      method: 'GET',
      path: `/v1/secrets/alias/${encodeURIComponent(aliasPath)}`,
    });
  }

  // Use UUID metadata endpoint
  return await request({
    method: 'GET',
    path: `/v1/secrets/${secretId}/meta`,
  });
}

/**
 * Check vault connectivity
 */
export async function checkHealth(): Promise<boolean> {
  try {
    await request({
      method: 'GET',
      path: '/v1/health',
      token: 'skip',
      noRetry: true,
    });
    setVaultReachable(true);
    return true;
  } catch {
    setVaultReachable(false);
    return false;
  }
}

/**
 * Clear cached token
 */
export function clearToken(): void {
  cachedToken = null;
  tokenExpiry = 0;
  log.debug('Token cache cleared');
}

/**
 * Check if we have a valid cached token
 */
export function hasValidToken(): boolean {
  return cachedToken !== null && Date.now() < tokenExpiry;
}

/**
 * Bind to a managed API key and get the current key value
 * @param name - Managed API key name (e.g., "my-api-key")
 * @returns The current API key value
 */
export async function bindManagedApiKey(name: string): Promise<ManagedApiKeyBindResponse> {
  log.debug({ name }, 'Binding to managed API key');

  return await request({
    method: 'POST',
    path: `/auth/api-keys/managed/${encodeURIComponent(name)}/bind`,
    body: {},
  });
}
