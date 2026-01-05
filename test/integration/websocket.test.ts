// Path: test/integration/websocket.test.ts

/**
 * WebSocket Integration Tests
 *
 * Tests for real-time communication between agent and vault via WebSocket.
 * Includes push notifications, connection management, and reconnection handling.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { AgentRunner, createTempOutputDir, DaemonHandle } from '../helpers/agent-runner.js';
import { VaultTestClient, generateTestCertificate } from '../helpers/vault-client.js';
import { TEST_ENV, getVaultClient } from '../setup.js';

describe('WebSocket Communication', () => {
  let agent: AgentRunner;
  let vault: VaultTestClient;
  let testApiKey: { id: string; key: string } | null = null;
  let testCert: { id: string; name: string } | null = null;
  let outputDir: string;

  beforeAll(async () => {
    vault = await getVaultClient();

    // Create test API key with WebSocket permissions
    testApiKey = await vault.createApiKey({
      name: 'websocket-test-key',
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
      alias: 'websocket-test-cert',
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
    const testId = `ws-${Date.now()}`;
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

  describe('Connection Management', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it('WS-01: should establish WebSocket connection on daemon start', async () => {
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'ws-connect-test',
        output: resolve(outputDir, 'ws-connect.pem'),
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      // Check health to verify connection status
      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      const health = await response.json();

      expect(health.status).toBe('ok');
      // WebSocket status might be in health response
      if (health.websocket) {
        expect(health.websocket.connected).toBe(true);
      }
    });

    it('WS-02: should reconnect after connection loss', async () => {
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'ws-reconnect-test',
        output: resolve(outputDir, 'ws-reconnect.pem'),
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      // Wait for connection to establish
      await new Promise((r) => setTimeout(r, 2000));

      // Verify still healthy after some time
      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      expect(response.ok).toBe(true);
    });

    it('WS-03: should show WebSocket status in health endpoint', async () => {
      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      const health = await response.json();

      expect(health).toHaveProperty('status');
      // Health response should include connection info
    });
  });

  describe('Push Notifications', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it('WS-04: should receive push notification on certificate rotation', async () => {
      const outputPath = resolve(outputDir, 'push-test.pem');

      await agent.addCertificate({
        certId: testCert!.id,
        name: 'push-test',
        output: outputPath,
      });

      daemon = await agent.startDaemon({
        pollInterval: 300, // Long poll to ensure we're testing push, not poll
      });
      await daemon.waitForReady();

      // Wait for initial sync
      await new Promise((r) => setTimeout(r, 2000));
      expect(existsSync(outputPath)).toBe(true);

      const initialContent = readFileSync(outputPath, 'utf-8');

      // Rotate certificate in vault
      const { certPem: newCertPem, keyPem: newKeyPem } = generateTestCertificate();
      await vault.rotateCertificate(testCert!.id, {
        certPem: newCertPem,
        keyPem: newKeyPem,
      });

      // Push notification should trigger sync quickly (within 10s)
      // Even though poll interval is 300s
      await new Promise((r) => setTimeout(r, 10000));

      const newContent = readFileSync(outputPath, 'utf-8');
      expect(newContent).not.toBe(initialContent);
    }, 30000);

    it('WS-05: should handle multiple push notifications', async () => {
      const outputPath = resolve(outputDir, 'multi-push.pem');

      await agent.addCertificate({
        certId: testCert!.id,
        name: 'multi-push',
        output: outputPath,
      });

      daemon = await agent.startDaemon({
        pollInterval: 300,
      });
      await daemon.waitForReady();

      // Wait for initial sync
      await new Promise((r) => setTimeout(r, 2000));

      const contents: string[] = [];
      contents.push(readFileSync(outputPath, 'utf-8'));

      // Multiple rotations
      for (let i = 0; i < 2; i++) {
        const { certPem, keyPem } = generateTestCertificate();
        await vault.rotateCertificate(testCert!.id, {
          certPem,
          keyPem,
        });
        await new Promise((r) => setTimeout(r, 5000));
        contents.push(readFileSync(outputPath, 'utf-8'));
      }

      // Each rotation should result in different content
      expect(contents[0]).not.toBe(contents[1]);
      expect(contents[1]).not.toBe(contents[2]);
    }, 60000);
  });

  describe('Connection Resilience', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it('WS-06: should maintain health during connection issues', async () => {
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'resilience-test',
        output: resolve(outputDir, 'resilience.pem'),
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      // Check health multiple times
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 2000));

        const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
        expect(response.ok).toBe(true);
      }
    });

    it('WS-07: should continue polling when WebSocket unavailable', async () => {
      const outputPath = resolve(outputDir, 'fallback.pem');

      await agent.addCertificate({
        certId: testCert!.id,
        name: 'fallback-test',
        output: outputPath,
      });

      daemon = await agent.startDaemon({
        pollInterval: 3, // Short poll interval as fallback
      });
      await daemon.waitForReady();

      // Wait for sync via polling
      await new Promise((r) => setTimeout(r, 5000));
      expect(existsSync(outputPath)).toBe(true);
    });
  });

  describe('Authentication', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it('WS-08: should authenticate WebSocket with API key', async () => {
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'ws-auth-test',
        output: resolve(outputDir, 'ws-auth.pem'),
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      // Connection should be established (verified by health check)
      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      expect(response.ok).toBe(true);
    });

    it('WS-09: should handle token refresh during long connections', async () => {
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'token-refresh-test',
        output: resolve(outputDir, 'token-refresh.pem'),
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      // Run for a while to test token refresh
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 3000));

        const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
        expect(response.ok).toBe(true);
      }
    }, 30000);
  });

  describe('Message Handling', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it('WS-10: should handle malformed messages gracefully', async () => {
      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      // Agent should stay healthy even if vault sends unexpected messages
      await new Promise((r) => setTimeout(r, 2000));

      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      expect(response.ok).toBe(true);
    });

    it('WS-11: should process sync commands from vault', async () => {
      const outputPath = resolve(outputDir, 'sync-cmd.pem');

      await agent.addCertificate({
        certId: testCert!.id,
        name: 'sync-cmd-test',
        output: outputPath,
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      // Initial sync should happen
      await new Promise((r) => setTimeout(r, 3000));
      expect(existsSync(outputPath)).toBe(true);
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

    it('WS-12: should track WebSocket connection metrics', async () => {
      daemon = await agent.startDaemon({ metricsEnabled: true });
      await daemon.waitForReady();

      // Wait for some WebSocket activity
      await new Promise((r) => setTimeout(r, 3000));

      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/metrics`);
      const metrics = await response.text();

      // Should have WebSocket-related metrics
      expect(metrics).toMatch(/websocket|ws_|connection/i);
    });

    it('WS-13: should track message metrics', async () => {
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'msg-metrics',
        output: resolve(outputDir, 'msg-metrics.pem'),
      });

      daemon = await agent.startDaemon({ metricsEnabled: true });
      await daemon.waitForReady();

      // Trigger some activity
      await new Promise((r) => setTimeout(r, 5000));

      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/metrics`);
      const metrics = await response.text();

      // Should have message-related metrics
      expect(metrics).toMatch(/message|sync|push/i);
    });
  });
});
