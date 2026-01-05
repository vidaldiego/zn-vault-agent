// Path: src/lib/validation.test.ts
// Unit tests for config validation

import { describe, it, expect } from 'vitest';
import { validateConfig, formatValidationResult } from './validation.js';
import type { AgentConfig } from './config.js';

describe('validateConfig', () => {
  const validConfig: AgentConfig = {
    vaultUrl: 'https://vault.example.com',
    tenantId: 'my-tenant',
    auth: {
      apiKey: 'test-api-key',
    },
    targets: [
      {
        certId: 'cert-123',
        name: 'test-cert',
        outputs: {
          combined: '/etc/ssl/test.pem',
        },
      },
    ],
    pollInterval: 3600,
  };

  it('should pass for valid configuration', () => {
    const result = validateConfig(validConfig);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should fail when vaultUrl is missing', () => {
    const config = { ...validConfig, vaultUrl: '' };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'vaultUrl')).toBe(true);
  });

  it('should fail when tenantId is missing', () => {
    const config = { ...validConfig, tenantId: '' };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'tenantId')).toBe(true);
  });

  it('should fail when auth is missing', () => {
    // Clear env vars that could provide auth fallback
    const savedApiKey = process.env.ZNVAULT_API_KEY;
    const savedPassword = process.env.ZNVAULT_PASSWORD;
    delete process.env.ZNVAULT_API_KEY;
    delete process.env.ZNVAULT_PASSWORD;

    try {
      const config = { ...validConfig, auth: {} };
      const result = validateConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'auth')).toBe(true);
    } finally {
      // Restore env vars
      if (savedApiKey) process.env.ZNVAULT_API_KEY = savedApiKey;
      if (savedPassword) process.env.ZNVAULT_PASSWORD = savedPassword;
    }
  });

  it('should pass with username/password auth', () => {
    const config = {
      ...validConfig,
      auth: { username: 'user', password: 'pass' },
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(true);
  });

  it('should fail for invalid URL format', () => {
    const config = { ...validConfig, vaultUrl: 'not-a-url' };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'vaultUrl')).toBe(true);
  });

  it('should warn when using HTTP instead of HTTPS', () => {
    const config = { ...validConfig, vaultUrl: 'http://vault.example.com' };
    const result = validateConfig(config);
    expect(result.warnings.some(w => w.field === 'vaultUrl')).toBe(true);
  });

  it('should warn when insecure mode is enabled', () => {
    const config = { ...validConfig, insecure: true };
    const result = validateConfig(config);
    expect(result.warnings.some(w => w.field === 'insecure')).toBe(true);
  });

  it('should warn when API key is in config file', () => {
    const result = validateConfig(validConfig);
    expect(result.warnings.some(w => w.field === 'auth.apiKey')).toBe(true);
  });

  it('should warn when no targets configured', () => {
    const config = { ...validConfig, targets: [] };
    const result = validateConfig(config);
    expect(result.warnings.some(w => w.field === 'targets')).toBe(true);
  });

  it('should fail for target without certId', () => {
    const config = {
      ...validConfig,
      targets: [{ certId: '', name: 'test', outputs: { cert: '/etc/ssl/test.crt' } }],
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field.includes('certId'))).toBe(true);
  });

  it('should fail for target without outputs', () => {
    const config = {
      ...validConfig,
      targets: [{ certId: 'cert-123', name: 'test', outputs: {} }],
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field.includes('outputs'))).toBe(true);
  });

  it('should fail for invalid permissions format', () => {
    const config = {
      ...validConfig,
      targets: [
        {
          certId: 'cert-123',
          name: 'test',
          outputs: { cert: '/etc/ssl/test.crt' },
          mode: '777', // Invalid - should be 0777
        },
      ],
    };
    const result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field.includes('mode'))).toBe(true);
  });

  it('should accept valid octal permissions', () => {
    const config = {
      ...validConfig,
      targets: [
        {
          certId: 'cert-123',
          name: 'test',
          outputs: { cert: '/etc/ssl/test.crt' },
          mode: '0640',
        },
      ],
    };
    const result = validateConfig(config);
    expect(result.errors.filter(e => e.field.includes('mode'))).toHaveLength(0);
  });
});

describe('formatValidationResult', () => {
  it('should format valid result', () => {
    const result = { valid: true, errors: [], warnings: [] };
    const output = formatValidationResult(result);
    expect(output).toContain('valid');
  });

  it('should format errors', () => {
    const result = {
      valid: false,
      errors: [{ field: 'vaultUrl', message: 'Required' }],
      warnings: [],
    };
    const output = formatValidationResult(result);
    expect(output).toContain('vaultUrl');
    expect(output).toContain('Required');
  });

  it('should format warnings', () => {
    const result = {
      valid: true,
      errors: [],
      warnings: [{ field: 'insecure', message: 'TLS disabled', suggestion: 'Enable TLS' }],
    };
    const output = formatValidationResult(result);
    expect(output).toContain('insecure');
    expect(output).toContain('Enable TLS');
  });
});
