// Path: test/helpers/vault-client.ts

/**
 * Vault Test Client
 *
 * Helper for setting up test data in the vault server.
 * Used by integration tests to create certificates, secrets, and API keys.
 */

import https from 'https';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface VaultTestConfig {
  url: string;
  username?: string;
  password?: string;
  apiKey?: string;
  insecure?: boolean;
}

export interface Certificate {
  id: string;
  name: string;  // Maps from alias in API response
  alias?: string;
  tenantId?: string;
  clientId?: string;
  expiresAt?: string;
  fingerprint?: string;
}

export interface Secret {
  id: string;
  alias: string;
  tenant: string;
  type: string;
  version: number;
}

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  expiresAt: string;
}

export interface ManagedApiKey {
  id: string;
  name: string;
  prefix: string;
  tenantId: string;
  rotationMode: 'scheduled' | 'on-use' | 'on-bind';
  enabled: boolean;
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
}

export class VaultTestClient {
  private baseUrl: string;
  private accessToken: string | null = null;
  private apiKey: string | null = null;
  private httpsAgent: https.Agent;

  constructor(private config: VaultTestConfig) {
    this.baseUrl = config.url.replace(/\/$/, '');
    this.apiKey = config.apiKey ?? null;
    this.httpsAgent = new https.Agent({
      rejectUnauthorized: !config.insecure,
    });
  }

  /**
   * Login with username/password to get access token
   */
  async login(): Promise<void> {
    if (!this.config.username || !this.config.password) {
      throw new Error('Username and password required for login');
    }

    const response = await this.request('POST', '/auth/login', {
      username: this.config.username,
      password: this.config.password,
    });

    this.accessToken = response.accessToken;
  }

  /**
   * Create a test certificate
   */
  async createCertificate(opts: {
    clientId: string;
    kind?: string;
    alias: string;
    certificateData: string;  // Base64-encoded P12 or PEM
    certificateType: 'P12' | 'PEM' | 'DER';
    passphrase?: string;
    clientName?: string;
    purpose?: 'SIGNING' | 'ENCRYPTION' | 'BOTH';
  }): Promise<Certificate> {
    const response = await this.request<Record<string, unknown>>('POST', '/v1/certificates', {
      clientId: opts.clientId,
      kind: opts.kind || 'CUSTOM',
      alias: opts.alias,
      certificateData: opts.certificateData,
      certificateType: opts.certificateType,
      passphrase: opts.passphrase,
      clientName: opts.clientName,
      purpose: opts.purpose || 'SIGNING',
    });

    // Map alias to name for backward compatibility with tests
    return {
      ...response,
      id: response.id as string,
      name: (response.alias || opts.alias) as string,
    } as Certificate;
  }

  /**
   * Rotate a certificate (create new version)
   */
  async rotateCertificate(id: string, opts: {
    certPem: string;
    keyPem: string;
    chainPem?: string;
    reason?: string;
  }): Promise<Certificate> {
    // Combine cert + key + chain into a single PEM
    let combinedPem = opts.certPem;
    if (opts.keyPem) {
      combinedPem += '\n' + opts.keyPem;
    }
    if (opts.chainPem) {
      combinedPem += '\n' + opts.chainPem;
    }

    const response = await this.request('POST', `/v1/certificates/${id}/rotate`, {
      certificateData: Buffer.from(combinedPem).toString('base64'),
      certificateType: 'PEM',
      reason: opts.reason || 'Test rotation',
    });

    return response;
  }

  /**
   * Get certificate by ID
   */
  async getCertificate(id: string): Promise<Certificate> {
    return await this.request('GET', `/v1/certificates/${id}`);
  }

  /**
   * List certificates for a tenant
   */
  async listCertificates(tenantId?: string): Promise<Certificate[]> {
    const query = tenantId ? `?tenantId=${tenantId}` : '';
    const response = await this.request('GET', `/v1/certificates${query}`);
    return response.data || response;
  }

  /**
   * Delete a certificate
   */
  async deleteCertificate(id: string): Promise<void> {
    await this.request('DELETE', `/v1/certificates/${id}`);
  }

  /**
   * Create a test secret
   */
  async createSecret(opts: {
    alias: string;
    tenant: string;
    type?: 'opaque' | 'credential' | 'setting';
    data: Record<string, unknown>;
  }): Promise<Secret> {
    const response = await this.request('POST', '/v1/secrets', {
      alias: opts.alias,
      tenant: opts.tenant,
      type: opts.type || 'credential',  // Valid types: opaque, credential, setting
      data: opts.data,
    });

    return response;
  }

  /**
   * Update a secret
   */
  async updateSecret(id: string, data: Record<string, unknown>): Promise<Secret> {
    const response = await this.request('PUT', `/v1/secrets/${id}`, { data });
    return response;
  }

  /**
   * Get secret by ID
   */
  async getSecret(id: string): Promise<Secret> {
    return await this.request('GET', `/v1/secrets/${id}/meta`);
  }

  /**
   * Decrypt a secret
   */
  async decryptSecret(id: string): Promise<{ data: Record<string, unknown> }> {
    return await this.request('POST', `/v1/secrets/${id}/decrypt`);
  }

  /**
   * List secrets for a tenant
   */
  async listSecrets(tenantId?: string): Promise<Secret[]> {
    const query = tenantId ? `?tenantId=${tenantId}` : '';
    return await this.request('GET', `/v1/secrets${query}`);
  }

  /**
   * Delete a secret
   */
  async deleteSecret(id: string): Promise<void> {
    await this.request('DELETE', `/v1/secrets/${id}`);
  }

  /**
   * Create an API key
   */
  async createApiKey(opts: {
    name: string;
    expiresInDays?: number;
    permissions?: string[];
    tenantId?: string;
  }): Promise<ApiKey> {
    const query = opts.tenantId ? `?tenantId=${opts.tenantId}` : '';
    const response = await this.request('POST', `/auth/api-keys${query}`, {
      name: opts.name,
      expiresInDays: opts.expiresInDays || 30,
      permissions: opts.permissions || [
        'secret:read:metadata',
        'secret:read:value',
        'certificate:read:metadata',
        'certificate:read:value',
      ],
    });

    return {
      id: response.apiKey.id,
      key: response.key,
      name: response.apiKey.name,
      expiresAt: response.apiKey.expiresAt,
    };
  }

  /**
   * Delete an API key
   */
  async deleteApiKey(id: string): Promise<void> {
    await this.request('DELETE', `/auth/api-keys/${id}`);
  }

  /**
   * Create a managed API key
   * Returns the created key info plus the initial key value from bind
   */
  async createManagedApiKey(opts: {
    name: string;
    permissions?: string[];
    tenantId?: string;
    rotationMode?: 'scheduled' | 'on-use' | 'on-bind';
    rotationInterval?: string;
    gracePeriod?: string;
  }): Promise<ManagedApiKey & { key: string }> {
    const query = opts.tenantId ? `?tenantId=${opts.tenantId}` : '';
    const response = await this.request<{ apiKey: ManagedApiKey }>('POST', `/auth/api-keys${query}`, {
      name: opts.name,
      permissions: opts.permissions || [
        'secret:read:metadata',
        'secret:read:value',
        'api_key:read',
      ],
      managed: {
        rotationMode: opts.rotationMode || 'scheduled',
        rotationInterval: opts.rotationInterval || '24h',
        gracePeriod: opts.gracePeriod || '5m',
      },
    });

    // Bind to get the initial key value
    const bindResponse = await this.bindManagedApiKey(opts.name, opts.tenantId);

    return {
      ...response.apiKey,
      key: bindResponse.key,
    };
  }

  /**
   * Bind to a managed API key to get its current value
   */
  async bindManagedApiKey(name: string, tenantId?: string): Promise<ManagedApiKeyBindResponse> {
    const query = tenantId ? `?tenantId=${tenantId}` : '';
    return await this.request('POST', `/auth/api-keys/managed/${encodeURIComponent(name)}/bind${query}`, {});
  }

  /**
   * Delete a managed API key (same endpoint as regular keys)
   */
  async deleteManagedApiKey(id: string): Promise<void> {
    await this.request('DELETE', `/auth/api-keys/${id}`);
  }

  /**
   * Force rotate a managed API key
   */
  async rotateManagedKey(name: string, tenantId?: string): Promise<{ success: boolean; newPrefix: string; graceExpiresAt: string }> {
    const query = tenantId ? `?tenantId=${tenantId}` : '';
    return await this.request('POST', `/auth/api-keys/managed/${encodeURIComponent(name)}/rotate${query}`, {});
  }

  /**
   * Force expire the grace period for a managed API key
   * This makes the old key stop working immediately instead of waiting for grace period
   */
  async expireGracePeriod(name: string, tenantId?: string): Promise<{ success: boolean; message: string }> {
    const query = tenantId ? `?tenantId=${tenantId}` : '';
    return await this.request('POST', `/auth/api-keys/managed/${encodeURIComponent(name)}/expire-grace${query}`, {});
  }

  /**
   * Create a test tenant
   */
  async createTenant(opts: {
    id: string;
    name: string;
  }): Promise<{ id: string; name: string }> {
    return await this.request('POST', '/v1/tenants', opts);
  }

  /**
   * Create a test user
   */
  async createUser(opts: {
    username: string;
    password: string;
    tenantId: string;
    role?: string;
  }): Promise<{ id: string; username: string }> {
    return await this.request('POST', '/v1/admin/users', {
      username: opts.username,
      password: opts.password,
      tenantId: opts.tenantId,
      role: opts.role || 'admin',
    });
  }

  /**
   * Check server health
   */
  async health(): Promise<{ status: string; version: string }> {
    return await this.request('GET', '/v1/health');
  }

  /**
   * Generic HTTP request helper
   */
  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);

    const headers: Record<string, string> = {};

    // Only set Content-Type when there's a body
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    } else if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method,
          headers,
          agent: this.httpsAgent,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              if (res.statusCode && res.statusCode >= 400) {
                const error = JSON.parse(data);
                reject(
                  new Error(
                    `HTTP ${res.statusCode}: ${error.message || error.error || data}`
                  )
                );
                return;
              }

              if (data && data.trim()) {
                resolve(JSON.parse(data) as T);
              } else {
                resolve(undefined as T);
              }
            } catch (e) {
              reject(new Error(`Failed to parse response: ${data}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }
}

/**
 * Generate a self-signed test certificate
 */
export function generateTestCertificate(): {
  certPem: string;
  keyPem: string;
} {
  const workDir = mkdtempSync(join(tmpdir(), 'zn-vault-agent-cert-'));
  const certPath = join(workDir, 'cert.pem');
  const keyPath = join(workDir, 'key.pem');

  try {
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey', 'rsa:2048',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '2',
      '-nodes',
      '-sha256',
      '-subj', `/CN=znvault-agent-test-${randomUUID()}`,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30_000,
    });

    return {
      certPem: readFileSync(certPath, 'utf-8'),
      keyPem: readFileSync(keyPath, 'utf-8'),
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Wait for vault server to be ready
 */
export async function waitForVault(
  url: string,
  maxAttempts = 30,
  intervalMs = 1000
): Promise<void> {
  const client = new VaultTestClient({ url, insecure: true });

  for (let i = 0; i < maxAttempts; i++) {
    try {
      await client.health();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error(`Vault not ready after ${maxAttempts} attempts`);
}
