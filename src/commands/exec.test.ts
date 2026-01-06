// Path: src/commands/exec.test.ts
// Unit tests for exec mode functionality

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseSecretMapping,
  parseSecretMappingFromConfig,
  buildSecretEnv,
  extractSecretIds,
  extractApiKeyNames,
  type SecretMapping,
} from '../lib/secret-env.js';

// Mock the api module
vi.mock('../lib/api.js', () => ({
  getSecret: vi.fn(),
  bindManagedApiKey: vi.fn(),
}));

import { getSecret, bindManagedApiKey } from '../lib/api.js';

const mockGetSecret = vi.mocked(getSecret);
const mockBindManagedApiKey = vi.mocked(bindManagedApiKey);

describe('parseSecretMapping', () => {
  describe('basic parsing', () => {
    it('should parse simple UUID mapping', () => {
      const result = parseSecretMapping('DB_HOST=abc123');
      expect(result.envVar).toBe('DB_HOST');
      expect(result.secretId).toBe('abc123');
      expect(result.key).toBeUndefined();
      expect(result.apiKeyName).toBeUndefined();
      expect(result.literal).toBeUndefined();
    });

    it('should parse UUID with key', () => {
      const result = parseSecretMapping('DB_HOST=abc123.host');
      expect(result.envVar).toBe('DB_HOST');
      expect(result.secretId).toBe('abc123');
      expect(result.key).toBe('host');
    });

    it('should parse alias format', () => {
      const result = parseSecretMapping('DB_HOST=alias:db/credentials');
      expect(result.envVar).toBe('DB_HOST');
      expect(result.secretId).toBe('alias:db/credentials');
      expect(result.key).toBeUndefined();
    });

    it('should parse alias format with key', () => {
      const result = parseSecretMapping('DB_HOST=alias:db/credentials.host');
      expect(result.envVar).toBe('DB_HOST');
      expect(result.secretId).toBe('alias:db/credentials');
      expect(result.key).toBe('host');
    });

    it('should parse alias with nested path and key', () => {
      const result = parseSecretMapping('PASSWORD=alias:db/prod/main.password');
      expect(result.envVar).toBe('PASSWORD');
      expect(result.secretId).toBe('alias:db/prod/main');
      expect(result.key).toBe('password');
    });
  });

  describe('api-key format parsing', () => {
    it('should parse api-key:name format', () => {
      const result = parseSecretMapping('VAULT_API_KEY=api-key:my-managed-key');
      expect(result.envVar).toBe('VAULT_API_KEY');
      expect(result.secretId).toBe('');
      expect(result.apiKeyName).toBe('my-managed-key');
      expect(result.key).toBeUndefined();
      expect(result.literal).toBeUndefined();
    });

    it('should parse api-key with hyphenated name', () => {
      const result = parseSecretMapping('API_KEY=api-key:prod-service-key');
      expect(result.envVar).toBe('API_KEY');
      expect(result.apiKeyName).toBe('prod-service-key');
    });

    it('should parse api-key with underscored name', () => {
      const result = parseSecretMapping('MY_KEY=api-key:my_service_key');
      expect(result.envVar).toBe('MY_KEY');
      expect(result.apiKeyName).toBe('my_service_key');
    });

    it('should parse api-key with numeric suffix', () => {
      const result = parseSecretMapping('KEY=api-key:service-key-v2');
      expect(result.envVar).toBe('KEY');
      expect(result.apiKeyName).toBe('service-key-v2');
    });

    it('should throw for empty api-key name', () => {
      expect(() => parseSecretMapping('VAR=api-key:')).toThrow('Invalid api-key format');
      expect(() => parseSecretMapping('VAR=api-key:')).toThrow('Expected: ENV_VAR=api-key:name');
    });
  });

  describe('literal format parsing', () => {
    it('should parse literal:value format', () => {
      const result = parseSecretMapping('MY_VAR=literal:some-value');
      expect(result.envVar).toBe('MY_VAR');
      expect(result.secretId).toBe('');
      expect(result.literal).toBe('some-value');
      expect(result.apiKeyName).toBeUndefined();
    });

    it('should parse literal with special characters', () => {
      const result = parseSecretMapping('CONFIG=literal:host=localhost;port=5432');
      expect(result.envVar).toBe('CONFIG');
      expect(result.literal).toBe('host=localhost;port=5432');
    });

    it('should handle empty literal value', () => {
      const result = parseSecretMapping('EMPTY=literal:');
      expect(result.envVar).toBe('EMPTY');
      expect(result.literal).toBe('');
    });
  });

  describe('error handling', () => {
    it('should throw for missing equals sign', () => {
      expect(() => parseSecretMapping('DB_HOST')).toThrow('Invalid mapping format');
    });

    it('should throw for empty env var', () => {
      expect(() => parseSecretMapping('=abc123')).toThrow('Invalid mapping format');
    });

    it('should throw for empty secret id', () => {
      expect(() => parseSecretMapping('DB_HOST=')).toThrow('Invalid mapping format');
    });
  });

  describe('edge cases', () => {
    it('should handle env var with underscore', () => {
      const result = parseSecretMapping('MY_DB_HOST=abc123');
      expect(result.envVar).toBe('MY_DB_HOST');
    });

    it('should handle secret id with multiple dots (UUID with key)', () => {
      const result = parseSecretMapping('CONFIG=abc123.nested.key');
      expect(result.envVar).toBe('CONFIG');
      expect(result.secretId).toBe('abc123');
      expect(result.key).toBe('nested.key');
    });

    it('should handle equals sign in value', () => {
      // The first = is the delimiter, rest is part of the secret ID
      const result = parseSecretMapping('VAR=alias:path=with=equals');
      expect(result.envVar).toBe('VAR');
      expect(result.secretId).toBe('alias:path=with=equals');
    });
  });
});

describe('extractSecretIds', () => {
  it('should extract secret IDs excluding literals and api-keys', () => {
    const mappings = [
      { envVar: 'A', secretId: 'secret-1' },
      { envVar: 'B', secretId: '', literal: 'value' },
      { envVar: 'C', secretId: '', apiKeyName: 'my-key' },
      { envVar: 'D', secretId: 'alias:path/secret' },
    ];
    const ids = extractSecretIds(mappings);
    expect(ids).toEqual(['secret-1', 'alias:path/secret']);
  });

  it('should deduplicate secret IDs', () => {
    const mappings = [
      { envVar: 'A', secretId: 'secret-1', key: 'host' },
      { envVar: 'B', secretId: 'secret-1', key: 'port' },
    ];
    const ids = extractSecretIds(mappings);
    expect(ids).toEqual(['secret-1']);
  });
});

describe('extractApiKeyNames', () => {
  it('should extract API key names', () => {
    const mappings = [
      { envVar: 'A', secretId: 'secret-1' },
      { envVar: 'B', secretId: '', apiKeyName: 'key-1' },
      { envVar: 'C', secretId: '', apiKeyName: 'key-2' },
    ];
    const names = extractApiKeyNames(mappings);
    expect(names).toEqual(['key-1', 'key-2']);
  });

  it('should deduplicate API key names', () => {
    const mappings = [
      { envVar: 'A', secretId: '', apiKeyName: 'shared-key' },
      { envVar: 'B', secretId: '', apiKeyName: 'shared-key' },
    ];
    const names = extractApiKeyNames(mappings);
    expect(names).toEqual(['shared-key']);
  });

  it('should return empty array when no API keys', () => {
    const mappings = [
      { envVar: 'A', secretId: 'secret-1' },
      { envVar: 'B', secretId: '', literal: 'value' },
    ];
    const names = extractApiKeyNames(mappings);
    expect(names).toEqual([]);
  });
});

describe('buildSecretEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('vault secrets', () => {
    it('should build environment from single secret', async () => {
      mockGetSecret.mockResolvedValue({
        id: 'test-id',
        alias: 'test',
        type: 'generic',
        version: 1,
        data: { host: 'localhost', port: 5432 },
      });

      const mappings = [
        { envVar: 'DB_HOST', secretId: 'db-secret', key: 'host' },
      ];

      const env = await buildSecretEnv(mappings);
      expect(env.DB_HOST).toBe('localhost');
      expect(mockGetSecret).toHaveBeenCalledTimes(1);
      expect(mockGetSecret).toHaveBeenCalledWith('db-secret');
    });

    it('should cache and reuse secrets', async () => {
      mockGetSecret.mockResolvedValue({
        id: 'test-id',
        alias: 'test',
        type: 'generic',
        version: 1,
        data: { host: 'localhost', port: 5432, password: 'secret' },
      });

      const mappings = [
        { envVar: 'DB_HOST', secretId: 'db-secret', key: 'host' },
        { envVar: 'DB_PORT', secretId: 'db-secret', key: 'port' },
        { envVar: 'DB_PASS', secretId: 'db-secret', key: 'password' },
      ];

      const env = await buildSecretEnv(mappings);
      expect(env.DB_HOST).toBe('localhost');
      expect(env.DB_PORT).toBe('5432');
      expect(env.DB_PASS).toBe('secret');
      // Should only fetch once due to caching
      expect(mockGetSecret).toHaveBeenCalledTimes(1);
    });

    it('should return entire secret as JSON when no key specified', async () => {
      mockGetSecret.mockResolvedValue({
        id: 'test-id',
        alias: 'config',
        type: 'generic',
        version: 1,
        data: { host: 'localhost', port: 5432 },
      });

      const mappings = [{ envVar: 'CONFIG', secretId: 'config-secret' }];

      const env = await buildSecretEnv(mappings);
      expect(env.CONFIG).toBe('{"host":"localhost","port":5432}');
    });

    it('should throw for missing key', async () => {
      mockGetSecret.mockResolvedValue({
        id: 'test-id',
        alias: 'db',
        type: 'generic',
        version: 1,
        data: { host: 'localhost' },
      });

      const mappings = [{ envVar: 'DB_PORT', secretId: 'db-secret', key: 'port' }];

      await expect(buildSecretEnv(mappings)).rejects.toThrow('Key "port" not found');
    });
  });

  describe('literal values', () => {
    it('should use literal value directly', async () => {
      const mappings = [
        { envVar: 'MY_VALUE', secretId: '', literal: 'hardcoded-value' },
      ];

      const env = await buildSecretEnv(mappings);
      expect(env.MY_VALUE).toBe('hardcoded-value');
      expect(mockGetSecret).not.toHaveBeenCalled();
      expect(mockBindManagedApiKey).not.toHaveBeenCalled();
    });

    it('should handle empty literal value', async () => {
      const mappings = [{ envVar: 'EMPTY', secretId: '', literal: '' }];

      const env = await buildSecretEnv(mappings);
      expect(env.EMPTY).toBe('');
    });
  });

  describe('managed API keys', () => {
    it('should bind and get API key value', async () => {
      mockBindManagedApiKey.mockResolvedValue({
        id: 'key-id-123',
        key: 'znv_abc123xyz789',
        prefix: 'znv_abc',
        name: 'my-managed-key',
        expiresAt: '2024-12-31T23:59:59Z',
        gracePeriod: 'PT1H',
        rotationMode: 'scheduled',
        permissions: ['secrets:read', 'secrets:list'],
      });

      const mappings = [
        { envVar: 'VAULT_API_KEY', secretId: '', apiKeyName: 'my-managed-key' },
      ];

      const env = await buildSecretEnv(mappings);
      expect(env.VAULT_API_KEY).toBe('znv_abc123xyz789');
      expect(mockBindManagedApiKey).toHaveBeenCalledTimes(1);
      expect(mockBindManagedApiKey).toHaveBeenCalledWith('my-managed-key');
      expect(mockGetSecret).not.toHaveBeenCalled();
    });

    it('should cache API key bindings', async () => {
      mockBindManagedApiKey.mockResolvedValue({
        id: 'key-id-123',
        key: 'znv_abc123xyz789',
        prefix: 'znv_abc',
        name: 'shared-key',
        expiresAt: '2024-12-31T23:59:59Z',
        gracePeriod: 'PT1H',
        rotationMode: 'on-bind',
        permissions: ['secrets:read'],
      });

      const mappings = [
        { envVar: 'KEY_1', secretId: '', apiKeyName: 'shared-key' },
        { envVar: 'KEY_2', secretId: '', apiKeyName: 'shared-key' },
      ];

      const env = await buildSecretEnv(mappings);
      expect(env.KEY_1).toBe('znv_abc123xyz789');
      expect(env.KEY_2).toBe('znv_abc123xyz789');
      // Should only call bind once due to caching
      expect(mockBindManagedApiKey).toHaveBeenCalledTimes(1);
    });

    it('should handle API key bind error', async () => {
      mockBindManagedApiKey.mockRejectedValue(new Error('Key not found'));

      const mappings = [
        { envVar: 'API_KEY', secretId: '', apiKeyName: 'nonexistent-key' },
      ];

      await expect(buildSecretEnv(mappings)).rejects.toThrow('Key not found');
    });
  });

  describe('mixed formats', () => {
    it('should handle secrets, literals, and API keys together', async () => {
      mockGetSecret.mockResolvedValue({
        id: 'secret-id',
        alias: 'db/creds',
        type: 'generic',
        version: 1,
        data: { password: 'db-password-123' },
      });

      mockBindManagedApiKey.mockResolvedValue({
        id: 'key-id',
        key: 'znv_managed_key_value',
        prefix: 'znv_man',
        name: 'vault-key',
        expiresAt: '2024-12-31T23:59:59Z',
        gracePeriod: 'PT30M',
        rotationMode: 'scheduled',
        permissions: ['secrets:read'],
      });

      const mappings = [
        { envVar: 'DB_PASSWORD', secretId: 'alias:db/creds', key: 'password' },
        { envVar: 'ENV_NAME', secretId: '', literal: 'production' },
        { envVar: 'VAULT_KEY', secretId: '', apiKeyName: 'vault-key' },
      ];

      const env = await buildSecretEnv(mappings);

      expect(env.DB_PASSWORD).toBe('db-password-123');
      expect(env.ENV_NAME).toBe('production');
      expect(env.VAULT_KEY).toBe('znv_managed_key_value');

      expect(mockGetSecret).toHaveBeenCalledTimes(1);
      expect(mockBindManagedApiKey).toHaveBeenCalledTimes(1);
    });

    it('should handle multiple different API keys', async () => {
      mockBindManagedApiKey
        .mockResolvedValueOnce({
          id: 'key-1',
          key: 'znv_first_key',
          prefix: 'znv_fir',
          name: 'first-key',
          expiresAt: '2024-12-31T23:59:59Z',
          gracePeriod: 'PT1H',
          rotationMode: 'scheduled',
          permissions: ['secrets:read'],
        })
        .mockResolvedValueOnce({
          id: 'key-2',
          key: 'znv_second_key',
          prefix: 'znv_sec',
          name: 'second-key',
          expiresAt: '2024-12-31T23:59:59Z',
          gracePeriod: 'PT1H',
          rotationMode: 'on-use',
          permissions: ['kms:encrypt'],
        });

      const mappings = [
        { envVar: 'KEY_A', secretId: '', apiKeyName: 'first-key' },
        { envVar: 'KEY_B', secretId: '', apiKeyName: 'second-key' },
      ];

      const env = await buildSecretEnv(mappings);

      expect(env.KEY_A).toBe('znv_first_key');
      expect(env.KEY_B).toBe('znv_second_key');
      expect(mockBindManagedApiKey).toHaveBeenCalledTimes(2);
      expect(mockBindManagedApiKey).toHaveBeenNthCalledWith(1, 'first-key');
      expect(mockBindManagedApiKey).toHaveBeenNthCalledWith(2, 'second-key');
    });
  });
});

describe('Env File Generation', () => {
  function generateEnvFile(env: Record<string, string>): string {
    return Object.entries(env)
      .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
      .join('\n') + '\n';
  }

  it('should generate valid env file content', () => {
    const env = { DB_HOST: 'localhost', DB_PORT: '5432' };
    const content = generateEnvFile(env);
    expect(content).toBe('DB_HOST="localhost"\nDB_PORT="5432"\n');
  });

  it('should escape quotes in values', () => {
    const env = { PASSWORD: 'pass"word' };
    const content = generateEnvFile(env);
    expect(content).toBe('PASSWORD="pass\\"word"\n');
  });

  it('should handle empty environment', () => {
    const content = generateEnvFile({});
    expect(content).toBe('\n');
  });
});

describe('parseSecretMappingFromConfig', () => {
  describe('secret property', () => {
    it('should parse secret with alias format', () => {
      const result = parseSecretMappingFromConfig({ env: 'DB_PASS', secret: 'alias:db/prod.password' });
      expect(result.envVar).toBe('DB_PASS');
      expect(result.secretId).toBe('alias:db/prod');
      expect(result.key).toBe('password');
    });

    it('should parse secret with api-key prefix', () => {
      const result = parseSecretMappingFromConfig({ env: 'API_KEY', secret: 'api-key:my-service-key' });
      expect(result.envVar).toBe('API_KEY');
      expect(result.secretId).toBe('');
      expect(result.apiKeyName).toBe('my-service-key');
    });
  });

  describe('literal property', () => {
    it('should parse literal value', () => {
      const result = parseSecretMappingFromConfig({ env: 'MODE', literal: 'production' });
      expect(result.envVar).toBe('MODE');
      expect(result.literal).toBe('production');
      expect(result.secretId).toBe('');
    });
  });

  describe('apiKey property', () => {
    it('should parse dedicated apiKey property', () => {
      const result = parseSecretMappingFromConfig({ env: 'VAULT_KEY', apiKey: 'my-managed-key' });
      expect(result.envVar).toBe('VAULT_KEY');
      expect(result.secretId).toBe('');
      expect(result.apiKeyName).toBe('my-managed-key');
      expect(result.literal).toBeUndefined();
    });

    it('should throw for empty apiKey', () => {
      expect(() => parseSecretMappingFromConfig({ env: 'KEY', apiKey: '' }))
        .toThrow('ExecSecret apiKey cannot be empty');
    });
  });

  describe('error handling', () => {
    it('should throw when no property is set', () => {
      expect(() => parseSecretMappingFromConfig({ env: 'VAR' }))
        .toThrow("ExecSecret must have 'secret', 'literal', or 'apiKey' property");
    });
  });
});
