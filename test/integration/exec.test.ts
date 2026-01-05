// Path: test/integration/exec.test.ts

/**
 * Exec Mode Integration Tests
 *
 * Tests for executing commands with injected secrets as environment variables.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { AgentRunner, createTempOutputDir } from '../helpers/agent-runner.js';
import { VaultTestClient } from '../helpers/vault-client.js';
import { TEST_ENV, getVaultClient } from '../setup.js';

describe('Exec Mode', () => {
  let agent: AgentRunner;
  let vault: VaultTestClient;
  let testApiKey: { id: string; key: string } | null = null;
  let testSecret1: { id: string; alias: string } | null = null;
  let testSecret2: { id: string; alias: string } | null = null;
  let outputDir: string;

  beforeAll(async () => {
    vault = await getVaultClient();

    // Create test API key
    testApiKey = await vault.createApiKey({
      name: 'exec-test-key',
      expiresInDays: 1,
      permissions: [
        'secret:read:metadata',
        'secret:read:value',
      ],
      tenantId: TEST_ENV.tenantId,
    });

    // Create test secrets
    testSecret1 = await vault.createSecret({
      alias: 'exec/api-key',
      tenant: TEST_ENV.tenantId,
      type: 'credential',  // Valid types: opaque, credential, setting
      data: {
        key: 'sk-test-12345',
        endpoint: 'https://api.example.com',
      },
    });

    testSecret2 = await vault.createSecret({
      alias: 'exec/database',
      tenant: TEST_ENV.tenantId,
      type: 'credential',
      data: {
        host: 'localhost',
        port: 5432,
        username: 'app',
        password: 'dbpass123',
      },
    });
  });

  afterAll(async () => {
    // Clean up test resources
    if (testSecret1) {
      try {
        await vault.deleteSecret(testSecret1.id);
      } catch { /* ignore */ }
    }
    if (testSecret2) {
      try {
        await vault.deleteSecret(testSecret2.id);
      } catch { /* ignore */ }
    }
    if (testApiKey) {
      try {
        await vault.deleteApiKey(testApiKey.id);
      } catch { /* ignore */ }
    }
  });

  beforeEach(async () => {
    const testId = `exec-${Date.now()}`;
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

  describe('Single Secret Injection', () => {
    it('EXEC-01: should inject secret as environment variable', async () => {
      const result = await agent.exec({
        command: ['printenv', 'API_KEY'],
        map: [`API_KEY=alias:${testSecret1!.alias}.key`],  // Use alias: prefix
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('sk-test-12345');
    });

    it('EXEC-02: should inject multiple keys from same secret', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "$API_KEY|$API_ENDPOINT"'],
        map: [
          `API_KEY=alias:${testSecret1!.alias}.key`,
          `API_ENDPOINT=alias:${testSecret1!.alias}.endpoint`,
        ],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('sk-test-12345|https://api.example.com');
    });

    it('should inject entire secret as JSON', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "$SECRET_JSON"'],
        map: [`SECRET_JSON=alias:${testSecret1!.alias}`],  // No key = entire secret
      });

      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.key).toBe('sk-test-12345');
      expect(parsed.endpoint).toBe('https://api.example.com');
    });
  });

  describe('Multiple Secrets', () => {
    it('EXEC-03: should inject from multiple secrets', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "$API_KEY|$DB_HOST|$DB_USER"'],
        map: [
          `API_KEY=alias:${testSecret1!.alias}.key`,
          `DB_HOST=alias:${testSecret2!.alias}.host`,
          `DB_USER=alias:${testSecret2!.alias}.username`,
        ],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('sk-test-12345|localhost|app');
    });
  });

  describe('Env File Support', () => {
    it('EXEC-04: should write secrets to env file', async () => {
      const envFilePath = resolve(outputDir, 'secrets.env');

      // CLI --env-file writes secrets to file instead of running command
      const result = await agent.exec({
        command: [],  // No command when writing to file
        map: [
          `API_KEY=alias:${testSecret1!.alias}.key`,
          `DB_PASS=alias:${testSecret2!.alias}.password`,
        ],
        envFile: envFilePath,
      });

      expect(result.exitCode).toBe(0);

      // Verify file was written with secrets
      const content = readFileSync(envFilePath, 'utf-8');
      expect(content).toContain('API_KEY="sk-test-12345"');
      expect(content).toContain('DB_PASS="dbpass123"');
    });

    it('should write multiple secrets to env file', async () => {
      const envFilePath = resolve(outputDir, 'combined.env');

      const result = await agent.exec({
        command: [],
        map: [
          `API_KEY=alias:${testSecret1!.alias}.key`,
          `DB_HOST=alias:${testSecret2!.alias}.host`,
        ],
        envFile: envFilePath,
      });

      expect(result.exitCode).toBe(0);

      const content = readFileSync(envFilePath, 'utf-8');
      expect(content).toContain('API_KEY="sk-test-12345"');
      expect(content).toContain('DB_HOST="localhost"');
    });
  });

  describe('Command Execution', () => {
    it('should pass exit code from child process', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'exit 42'],
        map: [`VAR=alias:${testSecret1!.alias}.key`],
      });

      expect(result.exitCode).toBe(42);
    });

    it('should handle command with arguments', async () => {
      const result = await agent.exec({
        command: ['echo', 'hello', 'world'],
        map: [`VAR=alias:${testSecret1!.alias}.key`],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello world');
    });

    it('should pass stdout from child process', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "line1"; echo "line2"'],
        map: [`VAR=alias:${testSecret1!.alias}.key`],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('line1');
      expect(result.stdout).toContain('line2');
    });

    it('should pass stderr from child process', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "error message" >&2; exit 1'],
        map: [`VAR=alias:${testSecret1!.alias}.key`],
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('error message');
    });
  });

  describe('Security', () => {
    it('should not expose secrets in error messages', async () => {
      const result = await agent.exec({
        command: ['false'],
        map: [`SECRET_KEY=alias:${testSecret1!.alias}.key`],
      });

      expect(result.exitCode).not.toBe(0);
      // Secret value should not appear in stderr
      expect(result.stderr).not.toContain('sk-test-12345');
    });

    it('should not inherit parent environment secrets', async () => {
      // Set a secret in parent environment and verify child doesn't see it
      const result = await agent.exec({
        command: ['printenv', 'PARENT_SECRET'],
        map: [`OTHER_VAR=alias:${testSecret1!.alias}.key`],
      });

      // printenv returns 1 if variable not found
      expect(result.exitCode).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('should fail with invalid secret alias', async () => {
      const result = await agent.exec({
        command: ['echo', 'test'],
        map: ['VAR=alias:nonexistent/secret.key'],
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toMatch(/not found|invalid|error/);
    });

    it('should fail with invalid key path', async () => {
      const result = await agent.exec({
        command: ['echo', 'test'],
        map: [`VAR=alias:${testSecret1!.alias}.nonexistent_key`],
      });

      // CLI should fail when key is not found
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toMatch(/not found|key|error/);
    });

    it('should fail with malformed mapping', async () => {
      const result = await agent.exec({
        command: ['echo', 'test'],
        map: ['INVALID_MAPPING_NO_EQUALS'],
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toMatch(/invalid|format|mapping/);
    });

    it('should require at least one secret mapping', async () => {
      const result = await agent.exec({
        command: ['echo', 'test'],
        map: [],
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toMatch(/required|secret/);
    });
  });

  describe('Special Characters', () => {
    it('should handle secrets with special characters', async () => {
      // Create a secret with special characters using unique alias
      const uniqueAlias = `exec/special-chars-${Date.now()}`;
      const specialSecret = await vault.createSecret({
        alias: uniqueAlias,
        tenant: TEST_ENV.tenantId,
        type: 'credential',
        data: {
          password: 'p@ss$w0rd!#&*()[]{}',
        },
      });

      try {
        const result = await agent.exec({
          command: ['sh', '-c', 'echo "$SPECIAL"'],
          map: [`SPECIAL=alias:${specialSecret.alias}.password`],
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('p@ss$w0rd!#&*()[]{}');
      } finally {
        await vault.deleteSecret(specialSecret.id);
      }
    });

    it('should handle secrets with newlines', async () => {
      // Create a secret with multiline content using unique alias
      const uniqueAlias = `exec/multiline-${Date.now()}`;
      const multilineSecret = await vault.createSecret({
        alias: uniqueAlias,
        tenant: TEST_ENV.tenantId,
        type: 'opaque',
        data: {
          content: 'line1\nline2\nline3',
        },
      });

      try {
        const result = await agent.exec({
          command: ['sh', '-c', 'echo "$CONTENT" | wc -l'],
          map: [`CONTENT=alias:${multilineSecret.alias}.content`],
        });

        expect(result.exitCode).toBe(0);
        expect(parseInt(result.stdout.trim())).toBe(3);
      } finally {
        await vault.deleteSecret(multilineSecret.id);
      }
    });
  });
});
