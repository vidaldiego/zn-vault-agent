// Path: test/integration/auth.test.ts

/**
 * Authentication Integration Tests
 *
 * Tests for agent login and authentication functionality.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { dirname } from 'node:path';
import { AgentRunner, createIsolatedAgentEnv } from '../helpers/agent-runner.js';
import { VaultTestClient } from '../helpers/vault-client.js';
import { TEST_ENV, getVaultClient } from '../setup.js';

const testRunId = `${process.pid}-${Date.now()}`;

describe('Authentication', () => {
  let agent: AgentRunner;
  let vault: VaultTestClient;
  let testApiKey: { id: string; key: string } | null = null;

  beforeAll(async () => {
    vault = await getVaultClient();

    // Create a test API key for agent authentication
    testApiKey = await vault.createApiKey({
      name: `agent-test-key-${testRunId}`,
      expiresInDays: 90,
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

  afterEach(() => {
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
      const invalidApiKey = ['znv', 'invalid', 'key'].join('_');
      const result = await agent.run(
        ['login', '--url', TEST_ENV.vaultUrl,
         '--api-key', invalidApiKey, '--yes',
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

    it('AUTH-10: should onboard an API key without certificate-list permission', async () => {
      const minimalKey = await vault.createApiKey({
        name: `agent-minimal-key-${Date.now()}`,
        expiresInDays: 90,
        permissions: ['secret:read:metadata'],
        tenantId: TEST_ENV.tenantId,
      });

      try {
        const result = await agent.login({
          url: TEST_ENV.vaultUrl,
          apiKey: minimalKey.key,
          insecure: TEST_ENV.insecure,
          skipTest: false,
        });

        expect(result.exitCode).toBe(0);
        expect(agent.readConfig()?.tenantId).toBe(TEST_ENV.tenantId);
      } finally {
        await vault.deleteApiKey(minimalKey.id);
      }
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
    it('preserves secret targets when merging plugin configuration', () => {
      const secretTarget = {
        secretId: 'secret-id',
        name: 'preserved-secret',
        output: '/tmp/preserved-secret',
      };
      agent.writeConfig({
        vaultUrl: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        auth: { apiKey: testApiKey!.key },
        targets: [],
        secretTargets: [secretTarget],
      });

      agent.setConfig({ plugins: [{ package: 'test-plugin' }] });

      expect(agent.readConfig()?.secretTargets).toEqual([secretTarget]);
    });

    it('gives all runner children one private mutation lock', () => {
      const privateLockPath = agent.getMutationLockPath();
      const env = createIsolatedAgentEnv(
        dirname(agent.getConfigPath()),
        'error',
        {
          HOSTNAME: 'inherited-or-override',
          ZNVAULT_TEST_DEPLOY_LOCK_PATH: '/tmp/inherited-or-override.lock',
        }
      );
      const otherAgent = new AgentRunner(`auth-other-${Date.now()}`);

      try {
        expect(env.ZNVAULT_TEST_DEPLOY_LOCK_PATH).toBe(privateLockPath);
        expect(env.HOSTNAME).toMatch(/^znvault-test-[0-9a-f]{16}$/);
        expect(createIsolatedAgentEnv(dirname(agent.getConfigPath()), 'info').HOSTNAME)
          .toBe(env.HOSTNAME);
        expect(createIsolatedAgentEnv(dirname(otherAgent.getConfigPath()), 'info').HOSTNAME)
          .not.toBe(env.HOSTNAME);
        expect(otherAgent.getMutationLockPath()).not.toBe(privateLockPath);
      } finally {
        otherAgent.cleanup();
      }
    });

    it('should reject invalid URL format', async () => {
      const result = await agent.login({
        url: 'not-a-valid-url',
        tenantId: TEST_ENV.tenantId,
        apiKey: testApiKey!.key,
      });

      expect(result.exitCode).not.toBe(0);
    });

    it('should allow API key login without a tenant ID', async () => {
      const result = await agent.login({
        url: TEST_ENV.vaultUrl,
        apiKey: testApiKey!.key,
        insecure: TEST_ENV.insecure,
      });

      expect(result.exitCode).toBe(0);
      expect(agent.readConfig()?.auth.apiKey).toBe(testApiKey!.key);
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
      expect(status.configured).toBe(true);
      expect(status.configPath).toBe(agent.getConfigPath());
      expect(status).toHaveProperty('vaultUrl');
      expect(status).toHaveProperty('tenantId');
    });
  });
});
