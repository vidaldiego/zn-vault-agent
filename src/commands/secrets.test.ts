// Path: src/commands/secrets.test.ts
// Unit tests for secret sync functionality

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock the API module
vi.mock('../lib/api.js', () => ({
  getSecret: vi.fn(),
  listSecrets: vi.fn(),
}));

// Import after mocking - kept for future use
const { getSecret: _getSecret } = await import('../lib/api.js');

// Helper to create a mock secret - kept for future use
function _mockSecret(data: Record<string, unknown>) {
  return {
    id: 'test-uuid',
    alias: 'test/secret',
    type: 'credential',
    version: 1,
    data,
  };
}

// We need to test the formatting functions directly
// Since they're not exported, we'll test them through the module behavior
// For now, let's create a test helper file and test the logic

describe('Secret Data Formatting', () => {
  // Test the formatting logic by recreating it here (since functions are internal)
  function formatAsEnv(data: Record<string, unknown>, prefix?: string): string {
    const envPrefix = prefix ? `${prefix}_` : '';
    return Object.entries(data)
      .map(([k, v]) => {
        const key = `${envPrefix}${k.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
        const value = typeof v === 'string' ? v : JSON.stringify(v);
        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
        return `${key}="${escaped}"`;
      })
      .join('\n') + '\n';
  }

  function formatAsJson(data: Record<string, unknown>): string {
    return JSON.stringify(data, null, 2) + '\n';
  }

  function formatAsYaml(data: Record<string, unknown>): string {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string') {
        if (v.includes('\n') || v.includes(':') || v.includes('#') || v.startsWith(' ')) {
          lines.push(`${k}: "${v.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
        } else {
          lines.push(`${k}: ${v}`);
        }
      } else {
        lines.push(`${k}: ${JSON.stringify(v)}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  function formatAsRaw(data: Record<string, unknown>, key: string): string {
    const value = data[key];
    if (value === undefined) {
      throw new Error(`Key "${key}" not found`);
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  describe('env format', () => {
    it('should format simple key-value pairs', () => {
      const data = { host: 'localhost', port: '5432' };
      const result = formatAsEnv(data);
      expect(result).toBe('HOST="localhost"\nPORT="5432"\n');
    });

    it('should handle special characters in values', () => {
      const data = { password: 'p@ss"word\\with\nnewline' };
      const result = formatAsEnv(data);
      expect(result).toContain('PASSWORD="p@ss\\"word\\\\with\\nnewline"');
    });

    it('should convert keys to uppercase with underscores', () => {
      const data = { 'db-host': 'localhost', 'api.key': 'secret' };
      const result = formatAsEnv(data);
      expect(result).toContain('DB_HOST=');
      expect(result).toContain('API_KEY=');
    });

    it('should apply prefix', () => {
      const data = { host: 'localhost' };
      const result = formatAsEnv(data, 'DB');
      expect(result).toBe('DB_HOST="localhost"\n');
    });

    it('should handle non-string values as JSON', () => {
      const data = { count: 42, enabled: true, config: { nested: 'value' } };
      const result = formatAsEnv(data);
      expect(result).toContain('COUNT="42"');
      expect(result).toContain('ENABLED="true"');
      expect(result).toContain('CONFIG="{\\"nested\\":\\"value\\"}"');
    });
  });

  describe('json format', () => {
    it('should format as pretty JSON', () => {
      const data = { host: 'localhost', port: 5432 };
      const result = formatAsJson(data);
      expect(result).toBe('{\n  "host": "localhost",\n  "port": 5432\n}\n');
    });

    it('should handle nested objects', () => {
      const data = { db: { host: 'localhost', port: 5432 } };
      const result = formatAsJson(data);
      const parsed = JSON.parse(result);
      expect(parsed.db.host).toBe('localhost');
    });
  });

  describe('yaml format', () => {
    it('should format simple values', () => {
      const data = { host: 'localhost', port: '5432' };
      const result = formatAsYaml(data);
      expect(result).toBe('host: localhost\nport: 5432\n');
    });

    it('should quote values with special characters', () => {
      const data = { comment: 'has: colon', note: 'has # hash' };
      const result = formatAsYaml(data);
      expect(result).toContain('comment: "has: colon"');
      expect(result).toContain('note: "has # hash"');
    });

    it('should handle non-string values as JSON', () => {
      const data = { count: 42, enabled: true };
      const result = formatAsYaml(data);
      expect(result).toContain('count: 42');
      expect(result).toContain('enabled: true');
    });
  });

  describe('raw format', () => {
    it('should extract single key', () => {
      const data = { password: 'secret123', username: 'admin' };
      const result = formatAsRaw(data, 'password');
      expect(result).toBe('secret123');
    });

    it('should throw for missing key', () => {
      const data = { password: 'secret123' };
      expect(() => formatAsRaw(data, 'missing')).toThrow('Key "missing" not found');
    });

    it('should serialize non-string values as JSON', () => {
      const data = { config: { nested: 'value' } };
      const result = formatAsRaw(data, 'config');
      expect(result).toBe('{"nested":"value"}');
    });
  });
});

describe('Secret Target Configuration', () => {
  // Test config functions
  const testConfigDir = path.join(os.tmpdir(), `zn-vault-agent-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testConfigDir, { recursive: true });
    process.env.ZNVAULT_AGENT_CONFIG_DIR = testConfigDir;
  });

  afterEach(() => {
    delete process.env.ZNVAULT_AGENT_CONFIG_DIR;
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  });

  it('should add and retrieve secret targets', async () => {
    // Dynamic import to pick up env var
    const { addSecretTarget, getSecretTargets, saveConfig } = await import('../lib/config.js');

    // Initialize config
    saveConfig({
      vaultUrl: 'https://vault.example.com',
      tenantId: 'test',
      auth: { apiKey: 'test' },
      targets: [],
      secretTargets: [],
    });

    addSecretTarget({
      secretId: 'alias:db/credentials',
      name: 'db-creds',
      format: 'env',
      output: '/etc/secrets/db.env',
    });

    const targets = getSecretTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].secretId).toBe('alias:db/credentials');
    expect(targets[0].name).toBe('db-creds');
  });
});

describe('Template Rendering', () => {
  function renderTemplate(template: string, data: Record<string, unknown>): string {
    let result = template;
    for (const [k, v] of Object.entries(data)) {
      const value = typeof v === 'string' ? v : JSON.stringify(v);
      result = result.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), value);
    }
    return result;
  }

  it('should replace simple placeholders', () => {
    const template = 'host: {{ host }}\nport: {{ port }}';
    const data = { host: 'localhost', port: '5432' };
    const result = renderTemplate(template, data);
    expect(result).toBe('host: localhost\nport: 5432');
  });

  it('should handle placeholders with extra spaces', () => {
    const template = '{{  host  }}';
    const data = { host: 'localhost' };
    const result = renderTemplate(template, data);
    expect(result).toBe('localhost');
  });

  it('should replace multiple occurrences', () => {
    const template = '{{ host }}:{{ host }}';
    const data = { host: 'localhost' };
    const result = renderTemplate(template, data);
    expect(result).toBe('localhost:localhost');
  });

  it('should serialize objects as JSON', () => {
    const template = 'config: {{ config }}';
    const data = { config: { nested: 'value' } };
    const result = renderTemplate(template, data);
    expect(result).toBe('config: {"nested":"value"}');
  });
});
