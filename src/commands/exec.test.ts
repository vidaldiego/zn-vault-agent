// Path: src/commands/exec.test.ts
// Unit tests for exec mode functionality

import { describe, it, expect, vi } from 'vitest';

// Test the secret mapping parser logic
// Recreate the parsing function for testing (since it's internal to the command)

interface SecretMapping {
  envVar: string;
  secretId: string;
  key?: string;
}

function parseSecretMapping(mapping: string): SecretMapping {
  const eqIndex = mapping.indexOf('=');
  if (eqIndex === -1) {
    throw new Error(`Invalid mapping format: ${mapping}. Expected: ENV_VAR=secret-id[.key]`);
  }

  const envVar = mapping.substring(0, eqIndex);
  let secretPath = mapping.substring(eqIndex + 1);

  if (!envVar || !secretPath) {
    throw new Error(`Invalid mapping format: ${mapping}. Expected: ENV_VAR=secret-id[.key]`);
  }

  let key: string | undefined;

  if (secretPath.startsWith('alias:')) {
    // Handle alias:path/to/secret.key
    const lastDotIndex = secretPath.lastIndexOf('.');
    if (lastDotIndex > secretPath.indexOf(':') + 1) {
      const potentialKey = secretPath.substring(lastDotIndex + 1);
      if (potentialKey && !potentialKey.includes('/')) {
        key = potentialKey;
        secretPath = secretPath.substring(0, lastDotIndex);
      }
    }
  } else {
    // Handle uuid.key or uuid
    const dotIndex = secretPath.indexOf('.');
    if (dotIndex !== -1) {
      key = secretPath.substring(dotIndex + 1);
      secretPath = secretPath.substring(0, dotIndex);
    }
  }

  return {
    envVar,
    secretId: secretPath,
    key,
  };
}

describe('parseSecretMapping', () => {
  describe('basic parsing', () => {
    it('should parse simple UUID mapping', () => {
      const result = parseSecretMapping('DB_HOST=abc123');
      expect(result.envVar).toBe('DB_HOST');
      expect(result.secretId).toBe('abc123');
      expect(result.key).toBeUndefined();
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

describe('Environment Building', () => {
  // Simulate building environment from secrets
  async function buildSecretEnv(
    mappings: SecretMapping[],
    secretFetcher: (id: string) => Promise<{ data: Record<string, unknown> }>
  ): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    const secretCache = new Map<string, Record<string, unknown>>();

    for (const mapping of mappings) {
      let data = secretCache.get(mapping.secretId);

      if (!data) {
        const secret = await secretFetcher(mapping.secretId);
        data = secret.data;
        secretCache.set(mapping.secretId, data);
      }

      if (mapping.key) {
        const value = data[mapping.key];
        if (value === undefined) {
          throw new Error(`Key "${mapping.key}" not found in secret "${mapping.secretId}"`);
        }
        env[mapping.envVar] = typeof value === 'string' ? value : JSON.stringify(value);
      } else {
        env[mapping.envVar] = JSON.stringify(data);
      }
    }

    return env;
  }

  it('should build environment from single secret', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      data: { host: 'localhost', port: 5432 },
    });

    const mappings: SecretMapping[] = [
      { envVar: 'DB_HOST', secretId: 'db-secret', key: 'host' },
    ];

    const env = await buildSecretEnv(mappings, fetcher);
    expect(env.DB_HOST).toBe('localhost');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('should build environment from multiple keys of same secret', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      data: { host: 'localhost', port: 5432, password: 'secret' },
    });

    const mappings: SecretMapping[] = [
      { envVar: 'DB_HOST', secretId: 'db-secret', key: 'host' },
      { envVar: 'DB_PORT', secretId: 'db-secret', key: 'port' },
      { envVar: 'DB_PASS', secretId: 'db-secret', key: 'password' },
    ];

    const env = await buildSecretEnv(mappings, fetcher);
    expect(env.DB_HOST).toBe('localhost');
    expect(env.DB_PORT).toBe('5432'); // Number converted to string
    expect(env.DB_PASS).toBe('secret');
    // Should only fetch once due to caching
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('should return entire secret as JSON when no key specified', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      data: { host: 'localhost', port: 5432 },
    });

    const mappings: SecretMapping[] = [
      { envVar: 'CONFIG', secretId: 'config-secret' },
    ];

    const env = await buildSecretEnv(mappings, fetcher);
    expect(env.CONFIG).toBe('{"host":"localhost","port":5432}');
  });

  it('should throw for missing key', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      data: { host: 'localhost' },
    });

    const mappings: SecretMapping[] = [
      { envVar: 'DB_PORT', secretId: 'db-secret', key: 'port' },
    ];

    await expect(buildSecretEnv(mappings, fetcher)).rejects.toThrow('Key "port" not found');
  });

  it('should fetch multiple secrets when IDs differ', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ data: { host: 'localhost' } })
      .mockResolvedValueOnce({ data: { key: 'api-key-value' } });

    const mappings: SecretMapping[] = [
      { envVar: 'DB_HOST', secretId: 'db-secret', key: 'host' },
      { envVar: 'API_KEY', secretId: 'api-secret', key: 'key' },
    ];

    const env = await buildSecretEnv(mappings, fetcher);
    expect(env.DB_HOST).toBe('localhost');
    expect(env.API_KEY).toBe('api-key-value');
    expect(fetcher).toHaveBeenCalledTimes(2);
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
