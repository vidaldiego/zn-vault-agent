// Path: test/integration/combined-mode.test.ts

/**
 * Combined Mode Integration Tests
 *
 * Tests for running daemon + exec in a single agent instance.
 * Combined mode syncs certificates/secrets AND manages a child process
 * with injected environment variables.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { AgentRunner, createTempOutputDir, DaemonHandle } from '../helpers/agent-runner.js';
import { VaultTestClient } from '../helpers/vault-client.js';
import { TEST_ENV, getVaultClient } from '../setup.js';

// Use fixed ports for testing (avoid random port detection issues)
let nextPort = 19100;
function getNextPort(): number {
  return nextPort++;
}

// Helper to wait for child process to reach 'running' status
// Child starts as 'starting' and transitions to 'running' once confirmed running
async function waitForChildRunning(port: number, maxAttempts = 20, interval = 250): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        const health = await res.json();
        if (health.childProcess?.status === 'running') {
          return;
        }
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Child process did not reach 'running' status after ${(maxAttempts * interval) / 1000}s`);
}

describe('Combined Mode', () => {
  let agent: AgentRunner;
  let vault: VaultTestClient;
  let testApiKey: { id: string; key: string } | null = null;
  let testSecret: { id: string; alias: string } | null = null;
  let testCert: { id: string; alias: string } | null = null;
  let outputDir: string;
  let daemon: DaemonHandle | null = null;

  // Helper to create a simple script that outputs env vars
  function createTestScript(scriptPath: string): void {
    const script = `#!/bin/sh
echo "STARTED"
echo "API_KEY=$API_KEY"
echo "DB_HOST=$DB_HOST"
# Keep running until signaled
trap 'echo "SIGTERM received"; exit 0' TERM
trap 'echo "SIGINT received"; exit 0' INT
while true; do
  sleep 1
done
`;
    writeFileSync(scriptPath, script, { mode: 0o755 });
  }

  // Helper to create a crashing script
  function createCrashingScript(scriptPath: string, exitCode: number = 1): void {
    const script = `#!/bin/sh
echo "CRASH_TEST started"
exit ${exitCode}
`;
    writeFileSync(scriptPath, script, { mode: 0o755 });
  }

  beforeAll(async () => {
    vault = await getVaultClient();

    // Create test API key with required permissions
    testApiKey = await vault.createApiKey({
      name: 'combined-mode-test-key',
      expiresInDays: 1,
      permissions: [
        'certificate:read:metadata',
        'certificate:read:value',
        'secret:read:metadata',
        'secret:read:value',
      ],
      tenantId: TEST_ENV.tenantId,
    });

    // Create test secret for exec
    testSecret = await vault.createSecret({
      alias: `combined/test-secret-${Date.now()}`,
      tenant: TEST_ENV.tenantId,
      type: 'credential',
      data: {
        apiKey: 'sk-combined-test-12345',
        dbHost: 'localhost',
        dbPort: 5432,
      },
    });

    // Create or get test certificate
    try {
      testCert = await vault.createCertificate({
        alias: `combined/test-cert-${Date.now()}`,
        tenant: TEST_ENV.tenantId,
        commonName: 'combined-test.example.com',
        validityDays: 30,
      });
    } catch {
      // Certificate creation may fail if not supported in test env
      testCert = null;
    }
  });

  afterAll(async () => {
    // Clean up test resources
    if (testSecret) {
      try {
        await vault.deleteSecret(testSecret.id);
      } catch { /* ignore */ }
    }
    if (testCert) {
      try {
        await vault.deleteCertificate(testCert.id);
      } catch { /* ignore */ }
    }
    if (testApiKey) {
      try {
        await vault.deleteApiKey(testApiKey.id);
      } catch { /* ignore */ }
    }
  });

  beforeEach(async () => {
    const testId = `combined-${Date.now()}`;
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

  afterEach(async () => {
    // Stop daemon if running
    if (daemon) {
      try {
        await daemon.stop();
      } catch { /* ignore */ }
      daemon = null;
    }
    agent?.cleanup();
  });

  describe('Basic Combined Mode', () => {
    it('COMBINED-01: should start daemon with exec and inject secrets', async () => {
      const scriptPath = resolve(outputDir, 'test-app.sh');
      createTestScript(scriptPath);
      const port = getNextPort();

      // Start daemon in combined mode
      daemon = await agent.startDaemon({
        healthPort: port,
        exec: scriptPath,
        secrets: [
          `API_KEY=alias:${testSecret!.alias}.apiKey`,
          `DB_HOST=alias:${testSecret!.alias}.dbHost`,
        ],
        restartOnChange: false,  // Disable for this test
      });

      // Wait for daemon to be ready
      await daemon.waitForReady();

      // Wait for child process to reach 'running' status
      await waitForChildRunning(port);

      // Check health endpoint shows child process
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.ok).toBe(true);

      const health = await healthRes.json();
      expect(health.childProcess).toBeDefined();
      expect(health.childProcess.status).toBe('running');
      expect(health.childProcess.pid).toBeGreaterThan(0);
    });

    it('COMBINED-02: should include child process in health status', async () => {
      const scriptPath = resolve(outputDir, 'health-test.sh');
      createTestScript(scriptPath);
      const port = getNextPort();

      daemon = await agent.startDaemon({
        healthPort: port,
        exec: scriptPath,
        secrets: [`VAR=alias:${testSecret!.alias}.apiKey`],
      });

      await daemon.waitForReady();
      await waitForChildRunning(port);

      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      const health = await healthRes.json();

      // Verify health structure includes childProcess
      expect(health).toHaveProperty('status');
      expect(health).toHaveProperty('childProcess');
      expect(health.childProcess).toHaveProperty('status');
      expect(health.childProcess).toHaveProperty('pid');
      expect(health.childProcess).toHaveProperty('restartCount');
      expect(health.childProcess).toHaveProperty('lastStartTime');

      // Status should be healthy when child is running
      expect(health.status).toBe('healthy');
      expect(health.childProcess.status).toBe('running');
    });

    it('COMBINED-03: should forward SIGTERM to child and shutdown cleanly', async () => {
      const scriptPath = resolve(outputDir, 'signal-test.sh');
      createTestScript(scriptPath);
      const port = getNextPort();

      daemon = await agent.startDaemon({
        healthPort: port,
        exec: scriptPath,
        secrets: [`VAR=alias:${testSecret!.alias}.apiKey`],
      });

      await daemon.waitForReady();
      await waitForChildRunning(port);

      // Verify child is running
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      const health = await healthRes.json();
      expect(health.childProcess.status).toBe('running');

      // Stop the daemon (sends SIGTERM)
      await daemon.stop();
      daemon = null;  // Mark as stopped

      // Daemon should have exited cleanly
      // (stop() resolves after process exits)
    });
  });

  describe('Crash Recovery', () => {
    it('COMBINED-04: should auto-restart child on crash', async () => {
      // Create a script that crashes immediately
      const scriptPath = resolve(outputDir, 'crash-test.sh');
      createCrashingScript(scriptPath, 1);
      const port = getNextPort();

      daemon = await agent.startDaemon({
        healthPort: port,
        exec: scriptPath,
        secrets: [`VAR=alias:${testSecret!.alias}.apiKey`],
        restartDelay: 100,  // Fast restart for testing
        maxRestarts: 5,
        restartWindow: 60000,
      });

      // Wait a bit for crash and restart cycle
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Check health - should show crashed/restarting or restart count > 0
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      const health = await healthRes.json();

      expect(health.childProcess).toBeDefined();
      expect(health.childProcess.restartCount).toBeGreaterThan(0);
    });

    it('COMBINED-05: should enter degraded state after max restarts', async () => {
      const scriptPath = resolve(outputDir, 'max-restart-test.sh');
      createCrashingScript(scriptPath, 1);
      const port = getNextPort();

      daemon = await agent.startDaemon({
        healthPort: port,
        exec: scriptPath,
        secrets: [`VAR=alias:${testSecret!.alias}.apiKey`],
        restartDelay: 50,  // Very fast for testing
        maxRestarts: 2,
        restartWindow: 60000,
      });

      // Wait for max restarts to be exceeded
      await new Promise(resolve => setTimeout(resolve, 2000));

      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      const health = await healthRes.json();

      expect(health.childProcess.status).toBe('max_restarts_exceeded');
      expect(health.status).toBe('degraded');
    });
  });

  describe('Literal Values', () => {
    it('COMBINED-06: should support literal values in exec secrets', async () => {
      const scriptPath = resolve(outputDir, 'literal-test.sh');
      const script = `#!/bin/sh
echo "USE_VAULT=$USE_VAULT"
echo "ENV=$ENV"
trap 'exit 0' TERM INT
while true; do sleep 1; done
`;
      writeFileSync(scriptPath, script, { mode: 0o755 });
      const port = getNextPort();

      daemon = await agent.startDaemon({
        healthPort: port,
        exec: scriptPath,
        secrets: [
          'USE_VAULT=literal:true',
          'ENV=literal:production',
          `API_KEY=alias:${testSecret!.alias}.apiKey`,
        ],
      });

      await daemon.waitForReady();
      await waitForChildRunning(port);

      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      const health = await healthRes.json();

      expect(health.childProcess.status).toBe('running');
    });
  });

  describe('No Restart Mode', () => {
    it('COMBINED-07: should not restart child when restartOnChange is false', async () => {
      const scriptPath = resolve(outputDir, 'no-restart-test.sh');
      createTestScript(scriptPath);
      const port = getNextPort();

      daemon = await agent.startDaemon({
        healthPort: port,
        exec: scriptPath,
        secrets: [`VAR=alias:${testSecret!.alias}.apiKey`],
        restartOnChange: false,
      });

      await daemon.waitForReady();
      await waitForChildRunning(port);

      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      const health = await healthRes.json();

      expect(health.childProcess.status).toBe('running');
      expect(health.childProcess.restartCount).toBe(0);
    });
  });

  describe('With Certificate Sync', () => {
    it('COMBINED-08: should sync certificates AND run exec', async () => {
      // Skip if no test certificate available
      if (!testCert) {
        console.log('Skipping COMBINED-08: no test certificate available');
        return;
      }

      const scriptPath = resolve(outputDir, 'cert-sync-test.sh');
      createTestScript(scriptPath);
      const port = getNextPort();

      const certOutputPath = resolve(outputDir, 'cert.pem');

      // Add certificate target
      await agent.addCertificate({
        certId: testCert.id,
        name: 'test-cert',
        output: certOutputPath,
        format: 'combined',
      });

      daemon = await agent.startDaemon({
        healthPort: port,
        exec: scriptPath,
        secrets: [`API_KEY=alias:${testSecret!.alias}.apiKey`],
      });

      await daemon.waitForReady();
      await waitForChildRunning(port);

      // Wait a bit for cert sync
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify health shows both cert sync and child process
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      const health = await healthRes.json();

      expect(health.childProcess.status).toBe('running');
      expect(health.certificates.total).toBeGreaterThanOrEqual(1);

      // Certificate should have been synced
      expect(existsSync(certOutputPath)).toBe(true);
    });
  });
});
