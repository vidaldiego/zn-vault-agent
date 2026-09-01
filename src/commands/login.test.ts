import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../lib/config.js';
import type { ApiKeySelfInfo } from '../lib/api.js';

const mocks = vi.hoisted(() => ({
  apiLogin: vi.fn(),
  getApiKeySelf: vi.fn(),
  listCertificates: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('../lib/api.js', () => ({
  bindManagedApiKey: vi.fn(),
  getApiKeySelf: mocks.getApiKeySelf,
  listCertificates: mocks.listCertificates,
  login: mocks.apiLogin,
}));

vi.mock('../lib/config.js', () => ({
  getConfigPath: vi.fn(() => '/tmp/test-config/config.json'),
  loadConfig: vi.fn(),
  saveConfig: mocks.saveConfig,
}));

import {
  authenticatePasswordAndDiscoverTenant,
  discoverApiKeyIdentity,
  formatBootstrapTokenForDisplay,
  listCertificatesForLogin,
} from './login.js';

describe('bootstrap credential output safety', () => {
  it('never returns a token value or fragment for display', () => {
    const canary = `zrt_${'a1b2c3d4'.repeat(8)}`;
    const rendered = formatBootstrapTokenForDisplay(canary);

    expect(rendered).toBe('[REDACTED]');
    expect(rendered).not.toContain(canary);
    expect(rendered).not.toContain(canary.substring(0, 8));
  });
});

function testConfig(): AgentConfig {
  return {
    vaultUrl: 'https://vault.test',
    tenantId: '',
    auth: { apiKey: 'znv_test_key' },
    targets: [],
    secretTargets: [],
  };
}

function selfInfo(): ApiKeySelfInfo {
  return {
    id: 'key-id',
    name: 'minimal-agent-key',
    prefix: 'znv_test',
    tenantId: 'sdk-test',
    permissions: ['secret:read:metadata'],
    expiresAt: '2030-01-01T00:00:00.000Z',
    expiresInDays: 30,
    isExpiringSoon: false,
    isManaged: false,
  };
}

describe('API-key login onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates identity and persists tenant before capability probes', async () => {
    const config = testConfig();
    mocks.getApiKeySelf.mockResolvedValue(selfInfo());

    const result = await discoverApiKeyIdentity(config);

    expect(result.tenantId).toBe('sdk-test');
    expect(config.tenantId).toBe('sdk-test');
    expect(mocks.saveConfig).toHaveBeenCalledWith(config);
    expect(mocks.listCertificates).not.toHaveBeenCalled();
  });

  it('treats certificate-list denial as informational after authentication', async () => {
    mocks.listCertificates.mockRejectedValue(new Error('HTTP 403: Forbidden'));

    await expect(listCertificatesForLogin()).resolves.toBeNull();
  });

  it('still rejects an API key when the self endpoint rejects it', async () => {
    const config = testConfig();
    mocks.getApiKeySelf.mockRejectedValue(new Error('HTTP 401: Unauthorized'));

    await expect(discoverApiKeyIdentity(config)).rejects.toThrow('HTTP 401');
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });
});

describe('password login onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists the tenant returned by a successful authenticated login', async () => {
    const config: AgentConfig = {
      ...testConfig(),
      auth: { username: 'operator', password: 'test-only' },
    };
    mocks.apiLogin.mockResolvedValue({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresIn: 3600,
      user: {
        id: 'user-id',
        username: 'operator',
        role: 'operator',
        tenantId: 'sdk-test',
      },
    });

    await expect(
      authenticatePasswordAndDiscoverTenant(config, 'operator', 'test-only')
    ).resolves.toBe('sdk-test');

    expect(mocks.apiLogin).toHaveBeenCalledWith('operator', 'test-only');
    expect(config.tenantId).toBe('sdk-test');
    expect(mocks.saveConfig).toHaveBeenCalledWith(config);
    expect(mocks.listCertificates).not.toHaveBeenCalled();
  });

  it('fails closed when the authenticated account has no tenant', async () => {
    const config: AgentConfig = {
      ...testConfig(),
      auth: { username: 'operator', password: 'test-only' },
    };
    mocks.apiLogin.mockResolvedValue({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresIn: 3600,
      user: {
        id: 'user-id',
        username: 'operator',
        role: 'operator',
        tenantId: null,
      },
    });

    await expect(
      authenticatePasswordAndDiscoverTenant(config, 'operator', 'test-only')
    ).rejects.toThrow('configuration remains incomplete');

    expect(config.tenantId).toBe('');
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(mocks.listCertificates).not.toHaveBeenCalled();
  });
});
