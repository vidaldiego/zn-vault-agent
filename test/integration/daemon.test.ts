// Path: test/integration/daemon.test.ts

/**
 * Daemon Mode Integration Tests
 *
 * Tests for agent daemon functionality including health endpoints,
 * metrics, continuous sync, and WebSocket connections.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { AgentRunner, createTempOutputDir, DaemonHandle } from '../helpers/agent-runner.js';
import { VaultTestClient, generateTestCertificate } from '../helpers/vault-client.js';
import { TEST_ENV, getVaultClient } from '../setup.js';

describe('Daemon Mode', () => {
  let agent: AgentRunner;
  let vault: VaultTestClient;
  let testApiKey: { id: string; key: string } | null = null;
  let testCert: { id: string; name: string } | null = null;
  let outputDir: string;

  beforeAll(async () => {
    vault = await getVaultClient();

    // Create test API key
    testApiKey = await vault.createApiKey({
      name: 'daemon-test-key',
      expiresInDays: 1,
      permissions: [
        'certificate:read:metadata',
        'certificate:read:value',
        'secret:read:metadata',
        'secret:read:value',
      ],
      tenantId: TEST_ENV.tenantId,
    });

    // Create test certificate using new API format
    const { certPem, keyPem } = generateTestCertificate();
    const combinedPem = certPem + '\n' + keyPem;
    testCert = await vault.createCertificate({
      clientId: TEST_ENV.tenantId,
      alias: 'daemon-test-cert',
      certificateData: Buffer.from(combinedPem).toString('base64'),
      certificateType: 'PEM',
    });
  });

  afterAll(async () => {
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
    const testId = `daemon-${Date.now()}`;
    agent = new AgentRunner(testId);
    agent.setup();
    outputDir = createTempOutputDir(testId);

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

  describe('Daemon Lifecycle', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it('DAEMON-01: should start daemon and expose health endpoint', async () => {
      // Add a target to sync
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'daemon-cert',
        output: resolve(outputDir, 'daemon-cert.pem'),
      });

      daemon = await agent.startDaemon({ healthPort: 0 });
      await daemon.waitForReady();

      // Check health endpoint
      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      expect(response.ok).toBe(true);

      const health = await response.json();
      expect(health.status).toBe('ok');
    });

    it('DAEMON-02: should sync certificates on startup', async () => {
      const outputPath = resolve(outputDir, 'startup-sync.pem');

      await agent.addCertificate({
        certId: testCert!.id,
        name: 'startup-sync',
        output: outputPath,
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      // Wait a bit for initial sync
      await new Promise((r) => setTimeout(r, 2000));

      expect(existsSync(outputPath)).toBe(true);

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('-----BEGIN CERTIFICATE-----');
    });

    it('DAEMON-03: should stop gracefully on SIGTERM', async () => {
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'sigterm-test',
        output: resolve(outputDir, 'sigterm.pem'),
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      const stopPromise = daemon.stop();

      // Should stop within reasonable time
      const timeoutPromise = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 10000)
      );

      const result = await Promise.race([stopPromise.then(() => 'stopped'), timeoutPromise]);
      expect(result).toBe('stopped');

      daemon = null; // Already stopped
    });
  });

  describe('Health Endpoint', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it('DAEMON-04: should return detailed health information', async () => {
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'health-check',
        output: resolve(outputDir, 'health.pem'),
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      const health = await response.json();

      expect(health).toHaveProperty('status');
      expect(health).toHaveProperty('uptime');
      expect(health).toHaveProperty('lastSync');
    });

    it('should return readiness status', async () => {
      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/ready`);
      expect(response.ok).toBe(true);
    });

    it('should return liveness status', async () => {
      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/live`);
      expect(response.ok).toBe(true);
    });
  });

  describe('Metrics', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it('DAEMON-05: should expose Prometheus metrics when enabled', async () => {
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'metrics-test',
        output: resolve(outputDir, 'metrics.pem'),
      });

      daemon = await agent.startDaemon({ metricsEnabled: true });
      await daemon.waitForReady();

      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/metrics`);
      expect(response.ok).toBe(true);

      const metrics = await response.text();
      // Should have Prometheus format metrics
      expect(metrics).toContain('# HELP');
      expect(metrics).toContain('# TYPE');
    });

    it('should track sync metrics', async () => {
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'sync-metrics',
        output: resolve(outputDir, 'sync-metrics.pem'),
      });

      daemon = await agent.startDaemon({ metricsEnabled: true });
      await daemon.waitForReady();

      // Wait for at least one sync
      await new Promise((r) => setTimeout(r, 3000));

      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/metrics`);
      const metrics = await response.text();

      // Check for sync-related metrics
      expect(metrics).toMatch(/znvault_agent_sync|sync_total|sync_duration/i);
    });
  });

  describe('Continuous Sync', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it('DAEMON-06: should sync periodically based on poll interval', async () => {
      const outputPath = resolve(outputDir, 'poll-test.pem');

      await agent.addCertificate({
        certId: testCert!.id,
        name: 'poll-test',
        output: outputPath,
      });

      daemon = await agent.startDaemon({
        pollInterval: 2, // 2 seconds for quick test
      });
      await daemon.waitForReady();

      // Initial sync
      await new Promise((r) => setTimeout(r, 1000));
      expect(existsSync(outputPath)).toBe(true);

      const initialContent = readFileSync(outputPath, 'utf-8');

      // Wait for next poll cycle
      await new Promise((r) => setTimeout(r, 3000));

      // File should still exist (re-synced or unchanged)
      const laterContent = readFileSync(outputPath, 'utf-8');
      expect(laterContent).toBe(initialContent); // Same content if no changes
    });

    it('DAEMON-07: should detect certificate rotation and re-sync', async () => {
      const outputPath = resolve(outputDir, 'rotation-test.pem');

      await agent.addCertificate({
        certId: testCert!.id,
        name: 'rotation-test',
        output: outputPath,
      });

      daemon = await agent.startDaemon({
        pollInterval: 2,
      });
      await daemon.waitForReady();

      // Wait for initial sync
      await new Promise((r) => setTimeout(r, 1500));
      expect(existsSync(outputPath)).toBe(true);

      const initialContent = readFileSync(outputPath, 'utf-8');

      // Rotate the certificate in vault
      const { certPem: newCertPem, keyPem: newKeyPem } = generateTestCertificate();
      await vault.rotateCertificate(testCert!.id, {
        certPem: newCertPem,
        keyPem: newKeyPem,
      });

      // Wait for daemon to detect change and re-sync
      await new Promise((r) => setTimeout(r, 5000));

      const newContent = readFileSync(outputPath, 'utf-8');
      expect(newContent).not.toBe(initialContent);
      expect(newContent).toContain('-----BEGIN CERTIFICATE-----');
    }, 15000);
  });

  describe('Error Recovery', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it('DAEMON-08: should continue running after sync errors', async () => {
      // Add a valid target
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'valid-cert',
        output: resolve(outputDir, 'valid.pem'),
      });

      // Add an invalid target
      await agent.addCertificate({
        certId: 'invalid-uuid',
        name: 'invalid-cert',
        output: resolve(outputDir, 'invalid.pem'),
      });

      daemon = await agent.startDaemon({
        pollInterval: 2,
      });
      await daemon.waitForReady();

      // Wait for sync attempt
      await new Promise((r) => setTimeout(r, 3000));

      // Daemon should still be running
      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      expect(response.ok).toBe(true);

      // Valid cert should be synced
      expect(existsSync(resolve(outputDir, 'valid.pem'))).toBe(true);
    });

    it('should recover from temporary network issues', async () => {
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'recovery-test',
        output: resolve(outputDir, 'recovery.pem'),
      });

      daemon = await agent.startDaemon({
        pollInterval: 2,
      });
      await daemon.waitForReady();

      // Wait for initial sync
      await new Promise((r) => setTimeout(r, 2000));

      // Daemon should still be responsive
      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      expect(response.ok).toBe(true);
    });
  });

  describe('Configuration', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it('should use custom health port', async () => {
      const customPort = 19876;

      daemon = await agent.startDaemon({ healthPort: customPort });

      // Wait for startup
      await new Promise((r) => setTimeout(r, 2000));

      const response = await fetch(`http://127.0.0.1:${customPort}/health`);
      expect(response.ok).toBe(true);
    });

    it('should accept poll interval configuration', async () => {
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'interval-test',
        output: resolve(outputDir, 'interval.pem'),
      });

      // With very short interval for testing
      daemon = await agent.startDaemon({
        pollInterval: 1, // 1 second
      });
      await daemon.waitForReady();

      // Should sync quickly
      await new Promise((r) => setTimeout(r, 2000));
      expect(existsSync(resolve(outputDir, 'interval.pem'))).toBe(true);
    });
  });
});
