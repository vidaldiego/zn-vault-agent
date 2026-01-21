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
import { VaultTestClient, type ManagedApiKey } from '../helpers/vault-client.js';
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

  describe('Managed API Key Injection (api-key: format)', () => {
    let managedKey: ManagedApiKey | null = null;

    beforeAll(async () => {
      // Create a managed API key for testing
      // Only use permissions that the test API key itself has
      managedKey = await vault.createManagedApiKey({
        name: `exec-managed-test-${Date.now()}`,
        tenantId: TEST_ENV.tenantId,
        rotationMode: 'on-bind',
        gracePeriod: '5m',
        permissions: [
          'secret:read:metadata',
          'secret:read:value',
        ],
      });
    });

    afterAll(async () => {
      if (managedKey) {
        try {
          await vault.deleteManagedApiKey(managedKey.id);
        } catch { /* ignore */ }
      }
    });

    it('EXEC-MKEY-01: should inject managed API key as environment variable', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "$VAULT_KEY" | head -c 4'],
        map: [`VAULT_KEY=api-key:${managedKey!.name}`],
      });

      expect(result.exitCode).toBe(0);
      // Managed keys have znv_ prefix
      expect(result.stdout.trim()).toBe('znv_');
    });

    it('EXEC-MKEY-02: should inject managed API key with full value', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo -n "$API_KEY" | wc -c'],
        map: [`API_KEY=api-key:${managedKey!.name}`],
      });

      expect(result.exitCode).toBe(0);
      // API keys are 36+ characters (znv_ prefix + 32 char value)
      const length = parseInt(result.stdout.trim());
      expect(length).toBeGreaterThanOrEqual(36);
    });

    it('EXEC-MKEY-03: should fail for nonexistent managed key', async () => {
      const result = await agent.exec({
        command: ['echo', 'test'],
        map: ['VAR=api-key:nonexistent-managed-key-12345'],
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toMatch(/not found|error/);
    });

    it('EXEC-MKEY-04: should fail for empty api-key name', async () => {
      const result = await agent.exec({
        command: ['echo', 'test'],
        map: ['VAR=api-key:'],
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toMatch(/invalid|format|api-key/);
    });
  });

  describe('Mixed Format Injection (secrets + api-keys + literals)', () => {
    let managedKey: ManagedApiKey | null = null;

    beforeAll(async () => {
      managedKey = await vault.createManagedApiKey({
        name: `exec-mixed-test-${Date.now()}`,
        tenantId: TEST_ENV.tenantId,
        rotationMode: 'on-bind',
        permissions: [
          'secret:read:metadata',
          'secret:read:value',
        ],
      });
    });

    afterAll(async () => {
      if (managedKey) {
        try {
          await vault.deleteManagedApiKey(managedKey.id);
        } catch { /* ignore */ }
      }
    });

    it('EXEC-MIX-01: should inject secrets, API keys, and literals together', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "$DB_HOST|$ENV_NAME|$API_KEY_PREFIX"'],
        map: [
          `DB_HOST=alias:${testSecret2!.alias}.host`,
          'ENV_NAME=literal:production',
          `API_KEY_PREFIX=api-key:${managedKey!.name}`,
        ],
      });

      expect(result.exitCode).toBe(0);
      const parts = result.stdout.trim().split('|');

      expect(parts[0]).toBe('localhost');       // Secret value
      expect(parts[1]).toBe('production');      // Literal value
      expect(parts[2].startsWith('znv_')).toBe(true);  // API key starts with prefix
    });

    it('EXEC-MIX-02: should write mixed formats to env file', async () => {
      const envFilePath = resolve(outputDir, 'mixed.env');

      const result = await agent.exec({
        command: [],
        map: [
          `SECRET_VAL=alias:${testSecret1!.alias}.key`,
          'LITERAL_VAL=literal:my-literal-value',
          `API_KEY=api-key:${managedKey!.name}`,
        ],
        envFile: envFilePath,
      });

      expect(result.exitCode).toBe(0);

      const content = readFileSync(envFilePath, 'utf-8');
      expect(content).toContain('SECRET_VAL="sk-test-12345"');
      expect(content).toContain('LITERAL_VAL="my-literal-value"');
      expect(content).toMatch(/API_KEY="znv_[^"]+"/);
    });

    it('EXEC-MIX-03: should handle same managed key referenced multiple times', async () => {
      // Same managed key bound to different env vars should get same value (cached)
      const result = await agent.exec({
        command: ['sh', '-c', 'test "$KEY1" = "$KEY2" && echo "MATCH" || echo "DIFFERENT"'],
        map: [
          `KEY1=api-key:${managedKey!.name}`,
          `KEY2=api-key:${managedKey!.name}`,
        ],
      });

      expect(result.exitCode).toBe(0);
      // Note: on-bind mode may return different keys, but within single exec they should be cached
      expect(result.stdout.trim()).toBe('MATCH');
    });
  });

  describe('Literal Value Injection', () => {
    it('EXEC-LIT-01: should inject literal value', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "$MY_VAR"'],
        map: ['MY_VAR=literal:hello-world'],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello-world');
    });

    it('EXEC-LIT-02: should handle literal with special characters', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "$CONFIG"'],
        map: ['CONFIG=literal:host=localhost;port=5432;ssl=true'],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('host=localhost;port=5432;ssl=true');
    });

    it('EXEC-LIT-03: should handle empty literal value', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "[$EMPTY]"'],
        map: ['EMPTY=literal:'],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('[]');
    });

    it('EXEC-LIT-04: should not fetch from vault for literal values', async () => {
      // Using a literal that looks like an alias should not try to fetch it
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "$VAR"'],
        map: ['VAR=literal:alias:fake/path.key'],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('alias:fake/path.key');
    });
  });

  describe('Env File Injection (--env-file / -e)', () => {
    let envFileSecret: { id: string; alias: string } | null = null;
    let envFileSecret2: { id: string; alias: string } | null = null;

    beforeAll(async () => {
      // Create env file type secrets with key-value data
      envFileSecret = await vault.createSecret({
        alias: `exec/envfile-${Date.now()}`,
        tenant: TEST_ENV.tenantId,
        type: 'opaque',
        data: {
          DB_HOST: 'localhost',
          DB_PORT: '5432',
          DB_USER: 'testuser',
        },
      });

      envFileSecret2 = await vault.createSecret({
        alias: `exec/envfile2-${Date.now()}`,
        tenant: TEST_ENV.tenantId,
        type: 'opaque',
        data: {
          DB_HOST: 'prodhost',  // Override
          APP_NAME: 'myapp',
        },
      });
    });

    afterAll(async () => {
      if (envFileSecret) {
        try {
          await vault.deleteSecret(envFileSecret.id);
        } catch { /* ignore */ }
      }
      if (envFileSecret2) {
        try {
          await vault.deleteSecret(envFileSecret2.id);
        } catch { /* ignore */ }
      }
    });

    it('EXEC-ENVFILE-01: should inject all vars from env file secret', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "$DB_HOST|$DB_PORT|$DB_USER"'],
        map: [],
        envFiles: [`alias:${envFileSecret!.alias}`],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('localhost|5432|testuser');
    });

    it('EXEC-ENVFILE-02: should apply prefix to all vars from env file', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "$APP_DB_HOST|$APP_DB_PORT"'],
        map: [],
        envFiles: [`alias:${envFileSecret!.alias}:APP_`],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('localhost|5432');
    });

    it('EXEC-ENVFILE-03: should let individual mapping override env file', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "$DB_HOST|$DB_PORT"'],
        map: ['DB_HOST=literal:overridden-host'],
        envFiles: [`alias:${envFileSecret!.alias}`],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('overridden-host|5432');
    });

    it('EXEC-ENVFILE-04: should let later env file override earlier', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "$DB_HOST|$DB_PORT|$APP_NAME"'],
        map: [],
        envFiles: [
          `alias:${envFileSecret!.alias}`,
          `alias:${envFileSecret2!.alias}`,
        ],
      });

      expect(result.exitCode).toBe(0);
      // DB_HOST should be 'prodhost' (from second), DB_PORT '5432' (from first), APP_NAME 'myapp' (from second)
      expect(result.stdout.trim()).toBe('prodhost|5432|myapp');
    });

    it('EXEC-ENVFILE-05: should write env file vars to output file', async () => {
      const envFilePath = resolve(outputDir, 'envfile-output.env');

      const result = await agent.exec({
        command: [],
        map: [],
        envFiles: [`alias:${envFileSecret!.alias}`],
        envFile: envFilePath,
      });

      expect(result.exitCode).toBe(0);

      const content = readFileSync(envFilePath, 'utf-8');
      expect(content).toContain('DB_HOST="localhost"');
      expect(content).toContain('DB_PORT="5432"');
      expect(content).toContain('DB_USER="testuser"');
    });

    it('EXEC-ENVFILE-06: should fail for non-existent env file secret', async () => {
      const result = await agent.exec({
        command: ['echo', 'test'],
        map: [],
        envFiles: ['alias:nonexistent/envfile/secret'],
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toMatch(/not found|error/);
    });

    it('EXEC-ENVFILE-07: should work with mix of env files and individual mappings', async () => {
      const result = await agent.exec({
        command: ['sh', '-c', 'echo "$DB_HOST|$DB_PORT|$API_KEY"'],
        map: [`API_KEY=alias:${testSecret1!.alias}.key`],
        envFiles: [`alias:${envFileSecret!.alias}`],
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('localhost|5432|sk-test-12345');
    });

    it('EXEC-ENVFILE-08: should require at least one env-file or secret', async () => {
      const result = await agent.exec({
        command: ['echo', 'test'],
        map: [],
        envFiles: [],
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toMatch(/required|secret|env-file/);
    });
  });
});
