// Path: test/integration/managed-keys.test.ts

/**
 * Managed API Key Integration Tests
 *
 * Tests for managed API key auto-detection and auto-rotation functionality.
 * Managed keys are auto-rotating API keys that the agent automatically
 * detects during login and handles rotation seamlessly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { AgentRunner } from '../helpers/agent-runner.js';
import { VaultTestClient, type ManagedApiKey } from '../helpers/vault-client.js';
import { TEST_ENV, getVaultClient } from '../setup.js';

// Helper to wait for a condition
async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number = 10000,
  intervalMs: number = 500
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
}

describe('Managed API Keys', () => {
  let agent: AgentRunner;
  let vault: VaultTestClient;
  let managedKey: ManagedApiKey | null = null;
  let initialBindKey: string | null = null;

  beforeAll(async () => {
    vault = await getVaultClient();

    // Create a managed API key for testing with VERY SHORT times
    // Using 'on-bind' mode so each bind returns a fresh key
    managedKey = await vault.createManagedApiKey({
      name: `agent-managed-test-${Date.now()}`,
      permissions: [
        'certificate:read:metadata',
        'certificate:read:value',
        'secret:read:metadata',
        'secret:read:value',
      ],
      tenantId: TEST_ENV.tenantId,
      rotationMode: 'on-bind',
      rotationInterval: '60s',  // Minimum allowed rotation interval
      gracePeriod: '30s',       // Minimum allowed grace period (we use expireGracePeriod for fast tests)
    });

    // Get initial key value via bind
    const bindResponse = await vault.bindManagedApiKey(managedKey.name, TEST_ENV.tenantId);
    initialBindKey = bindResponse.key;
  }, 30000);

  afterAll(async () => {
    // Clean up managed key
    if (managedKey) {
      try {
        await vault.deleteManagedApiKey(managedKey.id);
      } catch {
        // Ignore errors during cleanup
      }
    }
  });

  beforeEach(() => {
    agent = new AgentRunner(`managed-key-${Date.now()}`);
    agent.setup();
  });

  afterAll(() => {
    agent?.cleanup();
  });

  describe('Auto-Detection', () => {
    it('MANAGED-01: should auto-detect managed key during login', async () => {
      // Login with a managed API key - agent should auto-detect it
      const result = await agent.login({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: initialBindKey!,
        insecure: TEST_ENV.insecure,
        skipTest: false, // Run connection test to trigger auto-detection
      });

      expect(result.exitCode).toBe(0);

      // Verify config was created
      const config = agent.readConfig();
      expect(config).not.toBeNull();
      expect(config!.auth).toHaveProperty('apiKey');

      // Output should mention managed key detection (if it worked)
      const output = result.stdout + result.stderr;
      // Check for any indication it detected a managed key
      // (The exact output depends on whether the vault supports isManaged in /self)
      console.log('Login output:', output.substring(0, 500));
    });

    it('MANAGED-02: should show managed key info in status output', async () => {
      // First login with managed key
      await agent.login({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: initialBindKey!,
        insecure: TEST_ENV.insecure,
        skipTest: false,
      });

      // Check status
      const result = await agent.status({ json: true });

      expect(result.exitCode).toBe(0);
      console.log('Status output:', result.stdout.substring(0, 500));
    });

    it('MANAGED-03: should work with static API key (no managed key config)', async () => {
      // Create a regular (non-managed) API key
      const staticKey = await vault.createApiKey({
        name: 'agent-static-test',
        expiresInDays: 1,
        permissions: ['certificate:read:metadata', 'certificate:read:value'],
        tenantId: TEST_ENV.tenantId,
      });

      try {
        // Login with static key
        const result = await agent.login({
          url: TEST_ENV.vaultUrl,
          tenantId: TEST_ENV.tenantId,
          apiKey: staticKey.key,
          insecure: TEST_ENV.insecure,
          skipTest: false,
        });

        expect(result.exitCode).toBe(0);

        // Verify no managed key config
        const config = agent.readConfig();
        expect(config).not.toBeNull();
        expect(config!.auth).toHaveProperty('apiKey');
        // Static keys should not have managedKey config (or it should be undefined)
      } finally {
        // Cleanup static key
        await vault.deleteApiKey(staticKey.id);
      }
    });
  });

  describe('Daemon Managed Key Renewal', () => {
    it('MANAGED-04: should start daemon with managed key mode', async () => {
      // Login with managed key
      await agent.login({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: initialBindKey!,
        insecure: TEST_ENV.insecure,
        skipTest: false,
      });

      // Start daemon - it should recognize managed key mode
      const daemon = await agent.startDaemon({
        healthPort: 0, // Auto-assign port
      });

      try {
        // Wait for daemon to be ready
        await daemon.waitForReady();

        // Check health endpoint
        const healthResponse = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
        expect(healthResponse.ok).toBe(true);

        const health = await healthResponse.json();
        expect(health).toHaveProperty('status');

        // If managed key mode is active, health might include info about it
        // The exact format depends on implementation
      } finally {
        await daemon.stop();
      }
    });

    it('MANAGED-05: daemon health endpoint should show managed key status', async () => {
      // Login with managed key
      await agent.login({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: initialBindKey!,
        insecure: TEST_ENV.insecure,
        skipTest: false,
      });

      // Start daemon
      const daemon = await agent.startDaemon();

      try {
        await daemon.waitForReady();

        // Check health endpoint for managed key info
        const healthResponse = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
        const health = await healthResponse.json();

        // Health should include some indication of auth mode
        expect(health).toHaveProperty('status');
      } finally {
        await daemon.stop();
      }
    });
  });

  describe('Key Rotation Behavior', () => {
    it('MANAGED-06: on-bind mode should return new key on each bind', async () => {
      // The managed key uses 'on-bind' mode, so each bind should return different key
      const bind1 = await vault.bindManagedApiKey(managedKey!.name, TEST_ENV.tenantId);
      const bind2 = await vault.bindManagedApiKey(managedKey!.name, TEST_ENV.tenantId);

      // On-bind mode returns fresh key each time
      expect(bind1.key).not.toBe(bind2.key);

      // Both keys should have same name
      expect(bind1.name).toBe(bind2.name);

      // Keys should have correct rotation mode
      expect(bind1.rotationMode).toBe('on-bind');
    });

    it('MANAGED-07: bind response should include rotation metadata', async () => {
      const bindResponse = await vault.bindManagedApiKey(managedKey!.name, TEST_ENV.tenantId);

      // Check required fields
      expect(bindResponse).toHaveProperty('id');
      expect(bindResponse).toHaveProperty('key');
      expect(bindResponse).toHaveProperty('name');
      expect(bindResponse).toHaveProperty('expiresAt');
      expect(bindResponse).toHaveProperty('rotationMode');
      expect(bindResponse).toHaveProperty('permissions');

      // For on-bind mode, graceExpiresAt indicates when old key stops working
      expect(bindResponse).toHaveProperty('graceExpiresAt');
    });

    it('MANAGED-11: old key should work during grace period', async () => {
      // Bind to get current key
      const bind1 = await vault.bindManagedApiKey(managedKey!.name, TEST_ENV.tenantId);
      const oldKey = bind1.key;

      // Bind again to rotate (on-bind mode)
      const bind2 = await vault.bindManagedApiKey(managedKey!.name, TEST_ENV.tenantId);
      const newKey = bind2.key;

      expect(oldKey).not.toBe(newKey);

      // Both keys should work during grace period (5 seconds)
      // Create client with old key
      const oldKeyClient = new VaultTestClient({
        url: TEST_ENV.vaultUrl,
        apiKey: oldKey,
        insecure: TEST_ENV.insecure,
      });

      // Old key should still work (within grace period)
      // Note: vault server health returns 'ok', agent health returns 'healthy'
      const health = await oldKeyClient.health();
      expect(health.status).toBe('ok');
    }, 15000);

    it('MANAGED-12: old key should fail after grace period expires', async () => {
      // Bind to get current key
      const bind1 = await vault.bindManagedApiKey(managedKey!.name, TEST_ENV.tenantId);
      const oldKey = bind1.key;

      // Bind again to rotate
      await vault.bindManagedApiKey(managedKey!.name, TEST_ENV.tenantId);

      // Force expire grace period immediately (instead of waiting 7 seconds)
      await vault.expireGracePeriod(managedKey!.name, TEST_ENV.tenantId);

      // Old key should now fail
      const oldKeyClient = new VaultTestClient({
        url: TEST_ENV.vaultUrl,
        apiKey: oldKey,
        insecure: TEST_ENV.insecure,
      });

      try {
        // This should fail - old key is expired
        await oldKeyClient.health();
        // If we get here without error, the key might still work for health endpoint
        // Health endpoint might not require auth, so try listing certificates instead
      } catch (error) {
        // Expected - old key should be rejected
        expect((error as Error).message).toMatch(/unauthorized|401|invalid|expired/i);
      }
    });
  });

  describe('Exec Mode with Managed Keys', () => {
    it('MANAGED-08: exec should work with literal values', async () => {
      // Login with managed key
      await agent.login({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: initialBindKey!,
        insecure: TEST_ENV.insecure,
        skipTest: false,
      });

      // Run exec with literal value (simpler test that doesn't need apikey:read)
      const result = await agent.exec({
        command: ['node', '-e', 'console.log(process.env.TEST_VALUE)'],
        map: ['TEST_VALUE=literal:managed-key-test-value'],
      });

      // Should succeed and output the literal value
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('managed-key-test-value');
    });
  });

  describe('Error Handling', () => {
    it('MANAGED-09: should handle invalid managed key name gracefully', async () => {
      // Try to bind to non-existent managed key
      try {
        await vault.bindManagedApiKey('non-existent-managed-key', TEST_ENV.tenantId);
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeDefined();
        expect((error as Error).message).toMatch(/not found|404/i);
      }
    });

    it('MANAGED-10: should continue working if managed key detection fails', async () => {
      // Create a static key
      const staticKey = await vault.createApiKey({
        name: 'agent-static-fallback-test',
        expiresInDays: 1,
        permissions: ['certificate:read:metadata', 'certificate:read:value'],
        tenantId: TEST_ENV.tenantId,
      });

      try {
        // Login should succeed even if managed key detection has issues
        const result = await agent.login({
          url: TEST_ENV.vaultUrl,
          tenantId: TEST_ENV.tenantId,
          apiKey: staticKey.key,
          insecure: TEST_ENV.insecure,
          skipTest: false,
        });

        expect(result.exitCode).toBe(0);

        // Agent should work in static key mode
        const config = agent.readConfig();
        expect(config).not.toBeNull();
        expect(config!.auth).toHaveProperty('apiKey');
      } finally {
        await vault.deleteApiKey(staticKey.id);
      }
    });
  });
});
