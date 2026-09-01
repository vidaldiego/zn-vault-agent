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
import { existsSync, readFileSync, readlinkSync, writeFileSync } from 'fs';
import { AgentRunner, createTempOutputDir, DaemonHandle } from '../helpers/agent-runner.js';
import { VaultTestClient, generateTestCertificate } from '../helpers/vault-client.js';
import { TEST_ENV, getVaultClient } from '../setup.js';

// Use fixed ports for testing (avoid random port detection issues)
let nextPort = 19100;
const testRunId = `${process.pid}-${Date.now()}`;
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

async function waitForChildRestartEvidence(
  daemon: DaemonHandle,
  maxAttempts = 40,
  interval = 250
): Promise<Record<string, any>> {
  let lastHealth: Record<string, any> | undefined;
  for (let i = 0; i < maxAttempts; i++) {
    if (daemon.process.exitCode !== null || daemon.process.signalCode !== null) {
      const output = daemon.getOutput();
      throw new Error(
        `Daemon exited before child restart evidence; ` +
        `stdout=${JSON.stringify(output.stdout.slice(-1000))} ` +
        `stderr=${JSON.stringify(output.stderr.slice(-1000))}`
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      lastHealth = await res.json() as Record<string, any>;
      if ((lastHealth.childProcess?.restartCount ?? 0) > 0) {
        return lastHealth;
      }
    } catch {
      // The listener or child may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(
    `Child restart evidence did not appear after ${(maxAttempts * interval) / 1000}s; ` +
    `last health: ${JSON.stringify(lastHealth ?? {})}`
  );
}

async function waitForChildStatus(
  daemon: DaemonHandle,
  expectedStatus: string,
  maxAttempts = 40,
  interval = 250
): Promise<Record<string, any>> {
  let lastHealth: Record<string, any> | undefined;
  for (let i = 0; i < maxAttempts; i++) {
    if (daemon.process.exitCode !== null || daemon.process.signalCode !== null) {
      const output = daemon.getOutput();
      throw new Error(
        `Daemon exited before child reached ${expectedStatus}; ` +
        `stdout=${JSON.stringify(output.stdout.slice(-1000))} ` +
        `stderr=${JSON.stringify(output.stderr.slice(-1000))}`
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      lastHealth = await res.json() as Record<string, any>;
      if (lastHealth.childProcess?.status === expectedStatus) {
        return lastHealth;
      }
    } catch {
      // The listener or child may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(
    `Child did not reach ${expectedStatus} after ${(maxAttempts * interval) / 1000}s; ` +
    `last health: ${JSON.stringify(lastHealth ?? {})}`
  );
}

interface ChildPidEvidence {
  version: number;
  pid: number;
  identity: {
    kind: string;
    startTimeTicks?: unknown;
    executablePath?: unknown;
  };
}

function readLinuxProcessIdentity(pid: number): {
  state: string;
  startTimeTicks: string;
  executablePath: string;
} {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) throw new Error(`Malformed /proc/${pid}/stat`);
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  const state = fields[0];
  const startTimeTicks = fields[19];
  if (!state || !startTimeTicks) throw new Error(`Incomplete /proc/${pid}/stat`);
  return {
    state,
    startTimeTicks,
    executablePath: readlinkSync(`/proc/${pid}/exe`),
  };
}

async function waitForExactChildTermination(evidence: ChildPidEvidence): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (process.platform === 'linux' && evidence.identity?.kind === 'linux-procfs') {
      try {
        const observed = readLinuxProcessIdentity(evidence.pid);
        if (
          observed.startTimeTicks !== evidence.identity.startTimeTicks
          || observed.executablePath !== evidence.identity.executablePath
          || observed.state === 'Z'
        ) {
          return;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
    } else {
      try {
        process.kill(evidence.pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
        throw err;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Exact child process ${evidence.pid} remained live after daemon shutdown`);
}

async function stopDaemonAndAssertChildTermination(
  agent: AgentRunner,
  daemon: DaemonHandle,
  expectedChildPid?: number
): Promise<void> {
  const evidencePath = agent.getChildPidFilePath();
  const evidence = existsSync(evidencePath)
    ? JSON.parse(readFileSync(evidencePath, 'utf-8')) as ChildPidEvidence
    : null;

  if (expectedChildPid !== undefined) {
    expect(evidence, 'running child must have durable exact-identity evidence').not.toBeNull();
    expect(evidence?.version).toBe(1);
    expect(evidence?.pid).toBe(expectedChildPid);
    expect(evidence?.identity).toBeDefined();

    if (process.platform === 'linux') {
      expect(evidence?.identity.kind).toBe('linux-procfs');
      expect(typeof evidence?.identity.startTimeTicks).toBe('string');
      expect(evidence?.identity.startTimeTicks).not.toBe('');
      expect(typeof evidence?.identity.executablePath).toBe('string');
      expect(evidence?.identity.executablePath).not.toBe('');

      const observedBeforeStop = readLinuxProcessIdentity(expectedChildPid);
      expect(observedBeforeStop.state).not.toBe('Z');
      expect(observedBeforeStop.startTimeTicks).toBe(evidence?.identity.startTimeTicks);
      expect(observedBeforeStop.executablePath).toBe(evidence?.identity.executablePath);
    }
  }

  await daemon.stop();
  expect(daemon.process.exitCode).toBe(0);
  expect(daemon.process.signalCode).toBeNull();
  if (evidence) await waitForExactChildTermination(evidence);
  expect(existsSync(evidencePath), 'daemon shutdown must remove child.pid evidence').toBe(false);
}

describe('Combined Mode', () => {
  let agent: AgentRunner;
  let vault: VaultTestClient;
  let testApiKey: { id: string; key: string } | null = null;
  let testSecret: { id: string; alias: string } | null = null;
  let testCert: { id: string; name: string };
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
      name: `combined-mode-test-key-${testRunId}`,
      expiresInDays: 90,
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
        apiKey: ['combined', 'test', 'credential'].join('-'),
        dbHost: 'localhost',
        dbPort: 5432,
      },
    });

    // Create a unique certificate using the current vault API contract.
    const { certPem, keyPem } = generateTestCertificate();
    testCert = await vault.createCertificate({
      clientId: TEST_ENV.tenantId,
      alias: `combined/test-cert-${Date.now()}`,
      certificateData: Buffer.from(`${certPem}\n${keyPem}`).toString('base64'),
      certificateType: 'PEM',
    });
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
    if (daemon) {
      await stopDaemonAndAssertChildTermination(agent, daemon);
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
      await stopDaemonAndAssertChildTermination(
        agent,
        daemon,
        health.childProcess.pid as number
      );
      daemon = null;  // Mark as stopped
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
        secrets: ['VAR=literal:crash-recovery'],
        restartDelay: 100,  // Fast restart for testing
        maxRestarts: 5,
        restartWindow: 60000,
      });

      // Poll the externally observable restart receipt instead of assuming
      // secret fetch + spawn + crash always completes within a fixed delay.
      const health = await waitForChildRestartEvidence(daemon);

      expect(health.childProcess).toBeDefined();
      expect(health.childProcess.restartCount).toBeGreaterThan(0);
    });

    it('COMBINED-05: should become unhealthy and not ready after max restarts', async () => {
      const scriptPath = resolve(outputDir, 'max-restart-test.sh');
      createCrashingScript(scriptPath, 1);
      const port = getNextPort();

      daemon = await agent.startDaemon({
        healthPort: port,
        exec: scriptPath,
        secrets: ['VAR=literal:max-restarts'],
        restartDelay: 50,  // Very fast for testing
        maxRestarts: 2,
        restartWindow: 60000,
      });

      await waitForChildStatus(daemon, 'max_restarts_exceeded');

      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      const health = await healthRes.json();

      expect(healthRes.status).toBe(503);
      expect(health.childProcess.status).toBe('max_restarts_exceeded');
      expect(health.status).toBe('unhealthy');

      const readyRes = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(readyRes.status).toBe(503);
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
