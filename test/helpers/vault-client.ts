// Path: test/helpers/vault-client.ts

/**
 * Vault Test Client
 *
 * Helper for setting up test data in the vault server.
 * Used by integration tests to create certificates, secrets, and API keys.
 */

import https from 'https';

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
  }): Promise<Certificate> {
    const response = await this.request('POST', `/v1/certificates/${id}/rotate`, {
      certificate: opts.certPem,
      privateKey: opts.keyPem,
      chain: opts.chainPem,
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
   */
  async createManagedApiKey(opts: {
    name: string;
    permissions?: string[];
    tenantId?: string;
    rotationMode?: 'scheduled' | 'on-use' | 'on-bind';
    rotationInterval?: string;
    gracePeriod?: string;
  }): Promise<ManagedApiKey> {
    const query = opts.tenantId ? `?tenantId=${opts.tenantId}` : '';
    const response = await this.request<{ apiKey: ManagedApiKey }>('POST', `/auth/api-keys${query}`, {
      name: opts.name,
      permissions: opts.permissions || [
        'secret:read:metadata',
        'secret:read:value',
        'apikey:read',
      ],
      managed: {
        rotationMode: opts.rotationMode || 'on-bind',
        rotationInterval: opts.rotationInterval || '24h',
        gracePeriod: opts.gracePeriod || '5m',
      },
    });

    return response.apiKey;
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
  // Pre-generated test certificate (valid for 10 years)
  // Generated with: openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=test.cert"
  return {
    certPem: `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUQcbxuAhcEyOYih63rK2QLRVtN6MwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJdGVzdC5jZXJ0MB4XDTI2MDEwNTA1MzAwN1oXDTM2MDEw
MzA1MzAwN1owFDESMBAGA1UEAwwJdGVzdC5jZXJ0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAsT8wfBllDXhw6Kyd9ns8j/Sszp2uJ2CvEYnTrsJbYm7r
Z+A0zNqjj3v8GvIbJmI/SamhnxavtybYxedLkPJROQvIK55euT3Vk+lfc62Ou1rZ
tB49tBGixHLW1DTzYOrG9k5uBDI0Zwhx18+JnJmmh8/JHGdBjheK6QPy68KFCTBC
FThwGyaNm4prwLbHJeMkp2bfkHbNdcG9kUp0iT1mAuLzaR/mGuj7gJhR92VY1k91
CVnBakJULm8B7ShX6M01Oaj58gubie4bF0aci/Y8oGVKYkBlEDTZYfyoEmc/AAEx
o6tQoDVNPs+NzL6wVx6cFpcGSu2J9dKSFuIGtbp4zwIDAQABo1MwUTAdBgNVHQ4E
FgQU45Tf2xilWxoYjm9bKkGuN2bn/xowHwYDVR0jBBgwFoAU45Tf2xilWxoYjm9b
KkGuN2bn/xowDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAjKI3
P9NYX8tCeZKp5+m1vGFJNXnoG1JTcW3yb6v0NF2YBf+g5OQzdPKn/OO+EErGQjvs
3RJhy0Pk+3Mbz1w82B+v6SkU8c4ad6FaI1vQPgUjJZU0TfGYDGF+JMM3CHI1JZAZ
Hya7bXgzV0WrL90m/j9RY1GeIQxFiRsljZS8ERV3ZwYSCDYBpFzdZrJkuYHmpkUq
Adqlsuzz/dBcSoSQX//MiOQe+mkfVbKM6IPfPM1AT8hwKLyA00INl6eQdj8xjDhd
Y/GGSKqcDR2Inso1VvJtJuS+pKVnbSKlp89nZRRP404dyw4Kjk5duxcovKJISRE/
hB6xuPt1nQIZu4r2MQ==
-----END CERTIFICATE-----`,
    keyPem: `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCxPzB8GWUNeHDo
rJ32ezyP9KzOna4nYK8RidOuwltibutn4DTM2qOPe/wa8hsmYj9JqaGfFq+3JtjF
50uQ8lE5C8grnl65PdWT6V9zrY67Wtm0Hj20EaLEctbUNPNg6sb2Tm4EMjRnCHHX
z4mcmaaHz8kcZ0GOF4rpA/LrwoUJMEIVOHAbJo2bimvAtscl4ySnZt+Qds11wb2R
SnSJPWYC4vNpH+Ya6PuAmFH3ZVjWT3UJWcFqQlQubwHtKFfozTU5qPnyC5uJ7hsX
RpyL9jygZUpiQGUQNNlh/KgSZz8AATGjq1CgNU0+z43MvrBXHpwWlwZK7Yn10pIW
4ga1unjPAgMBAAECggEAFJf5a6nNrmt8fuQzdERsTHOKsnTqm6Olo52GbUsisASg
MFECAX0zvMOUjpLrqaGHpejiIOhTYS3PyOqvQneNDVo7lynO6qnvC0D1uKyFJWqQ
WdebprTX2whWwpAmaO/OTybcrHsi0IfQJll0LTBDA4uWW8j5emds2db+HftbVq5F
niM078d6/zJsIN4vgHOfqpOM3GDdJae0Afx+drS/vQoGPxKQhT5exHISFsElE1Ao
FQazlj5goYTQj1LJatbXTqMBXD1qPbamiDKPeaWTnaJA/LjawZalF8F0SZ1kaXuN
U5PmAsIMpJGOfhlp0l9U1bGolmoLJ7E/0MiuavBFoQKBgQDi6E/L8MMu+lNeOBes
Q8UFV0sqzd5cDFcJj+T/d9hUylm3T3/+TDgRzHIOYUtwbG3T+jJDbbttZWCYoDbe
pZZiePdlBInH3Zlk6rSZPneb0GHiYgCFEoBqQZqy7BJz68JpaY2jCZLCXUnzskCW
b53B2yvbpW6rtes14Wrh5Sg+4QKBgQDH+OM517PQLPFY96QnA/gG3UnVvmtGCpAV
S6m5emITsvRn66wfjk/zx3Ps2jly/zbCOCCp2HzJPKCJzng/mZNOoGhssW+Fd/RZ
JwlopLhcn71BAKQ2/CDExua4yFcctnrmt087KEIbTwyiiXEkr855Z8weDaVpRwjP
2A1Z+xgdrwKBgDcHjEKzk0KTZyCUjfkzPlb7QrmQz/qW64zgHvNuB0MZCAUS/MGZ
joeSg57FLdyID2K3bPU5aZkwWurpACWjFwOuvqD7JscYERmOalo38h4RvYt/pQyg
3g/m9TOrWRZP+QhDlxwROEx2/3ZgppVVYHchRlOwnVR7fB3HG3rJbqdBAoGAOPMA
gzCS3O5vrU6ZSSMwN4Q9ysl383J+phHuPAxGciW8xPuxASueSWa79PAQ/FcCWT1y
z+v/XbAOaDCMvlAWS4YTNyExCWmoBNvBKjP+7SHw29o66g3Tpzad7nHfnSW6yonZ
3pcQfIZ+qqtJtZD71EdjMgvg16KLN+Xnp4CC1bECgYAZ2teqi+cEe8Bi2osU+x1i
V6vS0reayDgyuaZlCxG0C3VRQu8rthGj2wmgAIA3uuaWF58P/dqXi1aGN9emXTR7
ODV8o2G0isWoZsdzN8Hq1STn4eEetc87WX+KPANM/QyR684q5WQk82zi9K+Zh0CY
cOafk5Z5L5eY+Be5lbNfpA==
-----END PRIVATE KEY-----`,
  };
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
