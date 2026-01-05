// Path: test/integration/secrets.test.ts

/**
 * Secret Management Integration Tests
 *
 * Tests for secret listing, adding, syncing, and removal with various output formats.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { AgentRunner, createTempOutputDir } from '../helpers/agent-runner.js';
import { VaultTestClient } from '../helpers/vault-client.js';
import { TEST_ENV, getVaultClient } from '../setup.js';

describe('Secret Management', () => {
  let agent: AgentRunner;
  let vault: VaultTestClient;
  let testApiKey: { id: string; key: string } | null = null;
  let testSecret: { id: string; alias: string } | null = null;
  let outputDir: string;

  beforeAll(async () => {
    vault = await getVaultClient();

    // Create test API key with secret permissions
    testApiKey = await vault.createApiKey({
      name: 'secret-test-key',
      expiresInDays: 1,
      permissions: [
        'secret:read:metadata',
        'secret:read:value',
      ],
      tenantId: TEST_ENV.tenantId,
    });

    // Create test secret with nested data
    testSecret = await vault.createSecret({
      alias: 'test/db-credentials',
      tenant: TEST_ENV.tenantId,
      type: 'credential',
      data: {
        username: 'testuser',
        password: 'secret123',
        host: 'db.example.com',
        port: 5432,
      },
    });
  });

  afterAll(async () => {
    // Clean up test resources
    if (testSecret) {
      try {
        await vault.deleteSecret(testSecret.id);
      } catch { /* ignore */ }
    }
    if (testApiKey) {
      try {
        await vault.deleteApiKey(testApiKey.id);
      } catch { /* ignore */ }
    }
  });

  beforeEach(async () => {
    const testId = `secret-${Date.now()}`;
    agent = new AgentRunner(testId);
    agent.setup();
    outputDir = createTempOutputDir(testId);

    // Login before each test
    await agent.login({
      url: TEST_ENV.vaultUrl,
      tenantId: TEST_ENV.tenantId,
      apiKey: testApiKey!.key,
      insecure: TEST_ENV.insecure,
    });
  });

  afterEach(() => {
    agent?.cleanup();
  });

  describe('Adding Secret Targets', () => {
    it('SEC-01: should add secret target with JSON format', async () => {
      const outputPath = resolve(outputDir, 'secret.json');

      const result = await agent.addSecret({
        secretId: testSecret!.id,
        name: 'json-secret',
        output: outputPath,
        format: 'json',
      });

      expect(result.exitCode).toBe(0);

      // Verify config was updated
      const config = agent.readConfig();
      expect(config?.secretTargets).toHaveLength(1);
      expect(config?.secretTargets?.[0]).toMatchObject({
        secretId: testSecret!.id,
        name: 'json-secret',
        format: 'json',
      });
    });

    it('SEC-02: should add secret target with env format', async () => {
      const outputPath = resolve(outputDir, '.env');

      const result = await agent.addSecret({
        secretId: testSecret!.id,
        name: 'env-secret',
        output: outputPath,
        format: 'env',
      });

      expect(result.exitCode).toBe(0);

      const config = agent.readConfig();
      expect(config?.secretTargets).toContainEqual(
        expect.objectContaining({
          name: 'env-secret',
          format: 'env',
        })
      );
    });

    it('SEC-03: should add secret target with YAML format', async () => {
      const outputPath = resolve(outputDir, 'secret.yaml');

      const result = await agent.addSecret({
        secretId: testSecret!.id,
        name: 'yaml-secret',
        output: outputPath,
        format: 'yaml',
      });

      expect(result.exitCode).toBe(0);

      const config = agent.readConfig();
      expect(config?.secretTargets).toContainEqual(
        expect.objectContaining({
          name: 'yaml-secret',
          format: 'yaml',
        })
      );
    });

    it('SEC-04: should add secret target with raw format and key', async () => {
      const outputPath = resolve(outputDir, 'password.txt');

      const result = await agent.addSecret({
        secretId: testSecret!.id,
        name: 'raw-secret',
        output: outputPath,
        format: 'raw',
        key: 'password',
      });

      expect(result.exitCode).toBe(0);

      const config = agent.readConfig();
      const target = config?.secretTargets?.find((t: any) => t.name === 'raw-secret');
      expect(target?.format).toBe('raw');
      expect(target?.key).toBe('password');
    });

    it('should add secret with env prefix', async () => {
      const outputPath = resolve(outputDir, 'prefixed.env');

      const result = await agent.addSecret({
        secretId: testSecret!.id,
        name: 'prefixed-secret',
        output: outputPath,
        format: 'env',
        prefix: 'DB_',
      });

      expect(result.exitCode).toBe(0);

      const config = agent.readConfig();
      const target = config?.secretTargets?.find((t: any) => t.name === 'prefixed-secret');
      expect(target?.envPrefix).toBe('DB_');
    });

    it('should add secret with mode option', async () => {
      const outputPath = resolve(outputDir, 'secure.json');

      const result = await agent.addSecret({
        secretId: testSecret!.id,
        name: 'secure-secret',
        output: outputPath,
        mode: '0600',
      });

      expect(result.exitCode).toBe(0);

      const config = agent.readConfig();
      const target = config?.secretTargets?.find((t: any) => t.name === 'secure-secret');
      expect(target?.mode).toBe('0600');
    });
  });

  describe('Syncing Secrets', () => {
    it('SEC-05: should sync secret to JSON file', async () => {
      const outputPath = resolve(outputDir, 'synced.json');

      await agent.addSecret({
        secretId: testSecret!.id,
        name: 'sync-json',
        output: outputPath,
        format: 'json',
      });

      const result = await agent.syncSecrets();

      // Debug: print stderr if sync fails
      if (result.exitCode !== 0) {
        console.log('SEC-05 stderr:', result.stderr);
        console.log('SEC-05 stdout:', result.stdout);
      }

      expect(result.exitCode).toBe(0);
      expect(existsSync(outputPath)).toBe(true);

      const content = JSON.parse(readFileSync(outputPath, 'utf-8'));
      expect(content.username).toBe('testuser');
      expect(content.password).toBe('secret123');
      expect(content.host).toBe('db.example.com');
      expect(content.port).toBe(5432);
    });

    it('SEC-06: should sync secret to env file', async () => {
      const outputPath = resolve(outputDir, 'synced.env');

      await agent.addSecret({
        secretId: testSecret!.id,
        name: 'sync-env',
        output: outputPath,
        format: 'env',
      });

      const result = await agent.syncSecrets();

      expect(result.exitCode).toBe(0);
      expect(existsSync(outputPath)).toBe(true);

      const content = readFileSync(outputPath, 'utf-8');
      // Env format quotes values
      expect(content).toContain('USERNAME="testuser"');
      expect(content).toContain('PASSWORD="secret123"');
    });

    it('SEC-07: should sync secret to YAML file', async () => {
      const outputPath = resolve(outputDir, 'synced.yaml');

      await agent.addSecret({
        secretId: testSecret!.id,
        name: 'sync-yaml',
        output: outputPath,
        format: 'yaml',
      });

      const result = await agent.syncSecrets();

      // Debug: print stderr if sync fails
      if (result.exitCode !== 0) {
        console.log('SEC-07 stderr:', result.stderr);
        console.log('SEC-07 stdout:', result.stdout);
      }

      expect(result.exitCode).toBe(0);
      expect(existsSync(outputPath)).toBe(true);

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('username: testuser');
      expect(content).toContain('password: secret123');
    });

    it('SEC-08: should sync single key with raw format', async () => {
      const outputPath = resolve(outputDir, 'password.txt');

      await agent.addSecret({
        secretId: testSecret!.id,
        name: 'sync-raw',
        output: outputPath,
        format: 'raw',
        key: 'password',
      });

      const result = await agent.syncSecrets();

      // Debug: print stderr if sync fails
      if (result.exitCode !== 0) {
        console.log('SEC-08 stderr:', result.stderr);
        console.log('SEC-08 stdout:', result.stdout);
      }

      expect(result.exitCode).toBe(0);
      expect(existsSync(outputPath)).toBe(true);

      const content = readFileSync(outputPath, 'utf-8').trim();
      expect(content).toBe('secret123');
    });

    it('should apply env prefix during sync', async () => {
      const outputPath = resolve(outputDir, 'prefixed.env');

      await agent.addSecret({
        secretId: testSecret!.id,
        name: 'sync-prefixed',
        output: outputPath,
        format: 'env',
        prefix: 'DB_',
      });

      const result = await agent.syncSecrets();

      // Debug: print stderr if sync fails
      if (result.exitCode !== 0) {
        console.log('env-prefix stderr:', result.stderr);
        console.log('env-prefix stdout:', result.stdout);
      }

      expect(result.exitCode).toBe(0);

      const content = readFileSync(outputPath, 'utf-8');
      // Env format quotes values
      expect(content).toContain('DB_USERNAME="testuser"');
      expect(content).toContain('DB_PASSWORD="secret123"');
    });

    it('should set correct file permissions', async () => {
      const outputPath = resolve(outputDir, 'perms.json');

      await agent.addSecret({
        secretId: testSecret!.id,
        name: 'perms-test',
        output: outputPath,
        mode: '0600',
      });

      await agent.syncSecrets();

      expect(existsSync(outputPath)).toBe(true);
      const stats = statSync(outputPath);
      const mode = (stats.mode & 0o777).toString(8);
      expect(mode).toBe('600');
    });

    it('should sync specific target by name', async () => {
      const output1 = resolve(outputDir, 'target1.json');
      const output2 = resolve(outputDir, 'target2.json');

      const add1 = await agent.addSecret({
        secretId: testSecret!.id,
        name: 'secret-target1',
        output: output1,
      });

      const add2 = await agent.addSecret({
        secretId: testSecret!.id,
        name: 'secret-target2',
        output: output2,
      });


      // Sync only target1
      const result = await agent.syncSecrets({ name: 'secret-target1' });

      // Debug: print stderr if sync fails
      if (result.exitCode !== 0) {
        console.log('specific-target stderr:', result.stderr);
        console.log('specific-target stdout:', result.stdout);
      }

      expect(result.exitCode).toBe(0);
      expect(existsSync(output1)).toBe(true);
      expect(existsSync(output2)).toBe(false);
    });
  });

  describe('Listing Secrets', () => {
    it('should list configured secret targets', async () => {
      await agent.addSecret({
        secretId: testSecret!.id,
        name: 'listed-secret',
        output: resolve(outputDir, 'listed.json'),
      });

      const result = await agent.listSecrets();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('listed-secret');
    });
  });

  describe('Removing Secret Targets', () => {
    it('SEC-09: should remove secret target', async () => {
      await agent.addSecret({
        secretId: testSecret!.id,
        name: 'to-remove-secret',
        output: resolve(outputDir, 'remove.json'),
      });

      // Verify it was added
      let config = agent.readConfig();
      expect(config?.secretTargets?.find((t: any) => t.name === 'to-remove-secret')).toBeDefined();

      // Remove
      const result = await agent.removeSecret('to-remove-secret');
      expect(result.exitCode).toBe(0);

      // Verify it was removed
      config = agent.readConfig();
      expect(config?.secretTargets?.find((t: any) => t.name === 'to-remove-secret')).toBeUndefined();
    });

    it('should fail to remove non-existent target', async () => {
      const result = await agent.removeSecret('does-not-exist');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain('not found');
    });
  });

  describe('Error Handling', () => {
    it('should fail with invalid secret ID', async () => {
      const outputPath = resolve(outputDir, 'invalid.json');

      // Adding an invalid secret should fail during validation
      const result = await agent.addSecret({
        secretId: 'invalid-uuid',
        name: 'invalid-secret',
        output: outputPath,
      });

      // Errors may appear in stderr (text) or stdout (JSON logs)
      const output = (result.stderr + result.stdout).toLowerCase();
      expect(result.exitCode).not.toBe(0);
      expect(output).toMatch(/not found|invalid|error|failed/);
    });

    it('should fail with missing key for raw format', async () => {
      const outputPath = resolve(outputDir, 'missing-key.txt');

      await agent.addSecret({
        secretId: testSecret!.id,
        name: 'missing-key',
        output: outputPath,
        format: 'raw',
        key: 'nonexistent_key',
      });

      const result = await agent.syncSecrets();

      // Should either error or produce empty file
      if (result.exitCode === 0 && existsSync(outputPath)) {
        const content = readFileSync(outputPath, 'utf-8').trim();
        expect(content).toBe('');
      } else {
        expect(result.stderr.toLowerCase()).toMatch(/key|not found|error/);
      }
    });
  });
});
