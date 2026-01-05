// Path: test/integration/auth.test.ts

/**
 * Authentication Integration Tests
 *
 * Tests for agent login and authentication functionality.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { AgentRunner } from '../helpers/agent-runner.js';
import { VaultTestClient } from '../helpers/vault-client.js';
import { TEST_ENV, getVaultClient } from '../setup.js';

describe('Authentication', () => {
  let agent: AgentRunner;
  let vault: VaultTestClient;
  let testApiKey: { id: string; key: string } | null = null;

  beforeAll(async () => {
    vault = await getVaultClient();

    // Create a test API key for agent authentication
    testApiKey = await vault.createApiKey({
      name: 'agent-test-key',
      expiresInDays: 1,
      permissions: [
        'certificate:read:metadata',
        'certificate:read:value',
        'secret:read:metadata',
        'secret:read:value',
      ],
      tenantId: TEST_ENV.tenantId,
    });
  });

  afterAll(async () => {
    // Clean up test API key
    if (testApiKey) {
      try {
        await vault.deleteApiKey(testApiKey.id);
      } catch {
        // Ignore errors during cleanup
      }
    }
  });

  beforeEach(() => {
    agent = new AgentRunner(`auth-${Date.now()}`);
    agent.setup();
  });

  afterAll(() => {
    agent?.cleanup();
  });

  describe('API Key Authentication', () => {
    it('AUTH-01: should login successfully with valid API key', async () => {
      const result = await agent.login({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: testApiKey!.key,
        insecure: TEST_ENV.insecure,
        skipTest: false,  // Test actual connection
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('error');

      // Verify config was created
      const config = agent.readConfig();
      expect(config).not.toBeNull();
      expect(config!.vaultUrl).toBe(TEST_ENV.vaultUrl);
      expect(config!.tenantId).toBe(TEST_ENV.tenantId);
      expect(config!.auth).toHaveProperty('apiKey');
    });

    it('AUTH-03: should fail login with invalid API key', async () => {
      // Clear env var so the invalid key from config is used during connection test
      const result = await agent.run(
        ['login', '--url', TEST_ENV.vaultUrl, '--tenant', TEST_ENV.tenantId,
         '--api-key', 'znv_invalid_key_12345', '--yes',
         TEST_ENV.insecure ? '--insecure' : ''].filter(Boolean),
        { env: { ZNVAULT_API_KEY: '' } }  // Clear env override
      );

      expect(result.exitCode).not.toBe(0);
      // Error may be in stdout (JSON logs) or stderr
      const output = (result.stdout + result.stderr).toLowerCase();
      expect(output).toMatch(/unauthorized|invalid|failed|error/);
    });

    it('AUTH-09: should accept all required flags in non-interactive mode', async () => {
      const result = await agent.login({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: testApiKey!.key,
        insecure: true,
        skipTest: false,  // Test actual connection
      });

      expect(result.exitCode).toBe(0);

      const config = agent.readConfig();
      expect(config?.insecure).toBe(true);
    });
  });

  describe('Username/Password Authentication', () => {
    it('AUTH-02: should login successfully with valid credentials', async () => {
      const result = await agent.login({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        username: TEST_ENV.username,
        password: TEST_ENV.password,
        insecure: TEST_ENV.insecure,
        skipTest: false,  // Test actual connection
      });

      expect(result.exitCode).toBe(0);

      const config = agent.readConfig();
      expect(config).not.toBeNull();
      expect(config!.auth).toHaveProperty('username');
      expect(config!.auth).toHaveProperty('password');
    });

    it('AUTH-04: should fail login with invalid password', async () => {
      const result = await agent.login({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        username: TEST_ENV.username,
        password: 'wrong-password',
        insecure: TEST_ENV.insecure,
        skipTest: false,  // Test actual connection (should fail)
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toMatch(/unauthorized|invalid|failed/);
    });
  });

  describe('Configuration Validation', () => {
    it('should reject invalid URL format', async () => {
      const result = await agent.login({
        url: 'not-a-valid-url',
        tenantId: TEST_ENV.tenantId,
        apiKey: testApiKey!.key,
      });

      expect(result.exitCode).not.toBe(0);
    });

    it('should reject empty tenant ID', async () => {
      const result = await agent.login({
        url: TEST_ENV.vaultUrl,
        tenantId: '',
        apiKey: testApiKey!.key,
        insecure: TEST_ENV.insecure,
      });

      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('Status Command', () => {
    it('should show configuration after login', async () => {
      // First login
      await agent.login({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: testApiKey!.key,
        insecure: TEST_ENV.insecure,
      });

      // Then check status
      const result = await agent.status();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(TEST_ENV.vaultUrl);
      expect(result.stdout).toContain(TEST_ENV.tenantId);
    });

    it('should output JSON when --json flag is used', async () => {
      await agent.login({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: testApiKey!.key,
        insecure: TEST_ENV.insecure,
      });

      const result = await agent.status({ json: true });

      expect(result.exitCode).toBe(0);

      const status = JSON.parse(result.stdout);
      expect(status).toHaveProperty('vaultUrl');
      expect(status).toHaveProperty('tenantId');
    });
  });
});
