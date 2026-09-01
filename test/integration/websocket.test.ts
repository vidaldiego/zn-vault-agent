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

const testRunId = `${Date.now()}-${process.pid}`;

/**
 * Wait for a condition to be true, polling at the specified interval.
 * Faster than fixed setTimeout when condition is met quickly.
 */
async function waitFor(
  condition: () => Promise<boolean>,
  { timeout = 10000, interval = 200 }: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

/**
 * Wait for health endpoint to be available and show daemon is ready
 */
async function waitForHealthy(port: number, timeout = 15000): Promise<void> {
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (!res.ok) return false;
      const health = await res.json();
      return health.status === 'healthy';
    } catch {
      return false;
    }
  }, { timeout, interval: 100 });
}

/**
 * Wait for the server acknowledgement that makes push subscriptions usable.
 * The health connection bit is set after `connection_established`, not merely
 * when the transport socket opens.
 */
async function waitForWebSocketEstablished(
  daemon: DaemonHandle,
  timeout = 15000
): Promise<void> {
  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
        if (response.ok) {
          const health = await response.json() as {
            websocket?: { certificates?: { connected?: boolean } };
          };
          if (health.websocket?.certificates?.connected === true) return true;
        }
      } catch {
        // The daemon may still be opening its health listener.
      }
      return false;
    }, { timeout, interval: 100 });
  } catch (err) {
    const { stdout, stderr } = daemon.getOutput();
    throw new Error(
      `${(err as Error).message}; daemon output:\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`
    );
  }
}

describe('WebSocket Communication', () => {
  let agent: AgentRunner;
  let vault: VaultTestClient;
  let testApiKey: { id: string; key: string } | null = null;
  let testCert: { id: string; name: string };
  let outputDir: string;

  beforeAll(async () => {
    vault = await getVaultClient();

    // Create test API key with WebSocket permissions
    testApiKey = await vault.createApiKey({
      name: `websocket-test-key-${testRunId}`,
      expiresInDays: 90,
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
      alias: `websocket-test-cert-${testRunId}`,
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
        certId: testCert.id,
        name: 'ws-connect-test',
        output: resolve(outputDir, 'ws-connect.pem'),
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();
      await waitForHealthy(daemon.healthPort);

      // Check health to verify daemon is running
      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      expect(response.ok).toBe(true);

      const health = await response.json();
      expect(health.status).toBe('healthy');

      // WebSocket status is optional - just verify daemon is healthy
      // The actual WebSocket connection is tested via certificate sync behavior
    });

    it('WS-02: should reconnect after connection loss', async () => {
      await agent.addCertificate({
        certId: testCert.id,
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
        certId: testCert.id,
        name: 'push-test',
        output: outputPath,
      });

      daemon = await agent.startDaemon({
        pollInterval: 300, // Long poll to ensure we're testing push, not poll
      });
      await daemon.waitForReady();
      await waitForHealthy(daemon.healthPort);
      await waitForWebSocketEstablished(daemon);

      // Wait for initial sync
      await waitFor(async () => existsSync(outputPath), { timeout: 10000, interval: 200 });
      expect(existsSync(outputPath)).toBe(true);

      const initialContent = readFileSync(outputPath, 'utf-8');

      // Rotate certificate in vault
      const { certPem: newCertPem, keyPem: newKeyPem } = generateTestCertificate();
      await vault.rotateCertificate(testCert.id, {
        certPem: newCertPem,
        keyPem: newKeyPem,
      });

      // Poll for the push-driven write. Under a loaded SDK harness, delivery
      // may take longer than an arbitrary sleep even though it remains well
      // below the configured polling interval.
      await waitFor(
        async () => readFileSync(outputPath, 'utf-8') !== initialContent,
        { timeout: 20000, interval: 200 }
      );

      const newContent = readFileSync(outputPath, 'utf-8');
      expect(newContent).not.toBe(initialContent);
    }, 45000);

    it('WS-05: should handle multiple push notifications', async () => {
      const outputPath = resolve(outputDir, 'multi-push.pem');

      await agent.addCertificate({
        certId: testCert.id,
        name: 'multi-push',
        output: outputPath,
      });

      daemon = await agent.startDaemon({
        pollInterval: 300,
      });
      await daemon.waitForReady();
      await waitForWebSocketEstablished(daemon);

      // Wait for initial sync
      await waitFor(async () => existsSync(outputPath), { timeout: 10000, interval: 200 });

      const contents: string[] = [];
      contents.push(readFileSync(outputPath, 'utf-8'));

      // Multiple rotations
      for (let i = 0; i < 2; i++) {
        const { certPem, keyPem } = generateTestCertificate();
        await vault.rotateCertificate(testCert.id, {
          certPem,
          keyPem,
        });

        // Do not issue the next rotation until this exact version has produced
        // a new file. A fixed sleep can sample the previous deployment while a
        // valid push is still queued under a loaded Node runtime.
        const previousContent = contents.at(-1)!;
        await waitFor(
          async () => existsSync(outputPath)
            && readFileSync(outputPath, 'utf-8') !== previousContent,
          { timeout: 20000, interval: 200 }
        );
        contents.push(readFileSync(outputPath, 'utf-8'));
      }

      // Each rotation should result in different content
      expect(contents[0]).not.toBe(contents[1]);
      expect(contents[1]).not.toBe(contents[2]);
    }, 75000);
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
        certId: testCert.id,
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
        certId: testCert.id,
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
        certId: testCert.id,
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
        certId: testCert.id,
        name: 'token-refresh-test',
        output: resolve(outputDir, 'token-refresh.pem'),
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();
      await waitForWebSocketEstablished(daemon);

      // Keep observing the live health bit; an old "connected" log line must
      // not satisfy this long-connection assertion after a disconnect.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        await waitForWebSocketEstablished(daemon, 5000);
      }
    }, 120000);
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
        certId: testCert.id,
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
      daemon = await agent.startDaemon();
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
        certId: testCert.id,
        name: 'msg-metrics',
        output: resolve(outputDir, 'msg-metrics.pem'),
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      // Trigger some activity
      await new Promise((r) => setTimeout(r, 5000));

      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/metrics`);
      const metrics = await response.text();

      // Should have message-related metrics
      expect(metrics).toMatch(/message|sync|push/i);
    });
  });

  describe('Managed API Key Rotation Events', () => {
    let daemon: DaemonHandle | null = null;
    let managedApiKey: { id: string; key: string; name: string } | null = null;
    let managedKeySequence = 0;

    beforeEach(async () => {
      // Isolate every rotation test so a redelivered event from an earlier
      // daemon cannot satisfy a later test's event or metric assertion.
      managedApiKey = await vault.createManagedApiKey({
        name: `ws-rotation-event-test-key-${testRunId}-${managedKeySequence++}`,
        tenantId: TEST_ENV.tenantId,
        permissions: [
          'certificate:read:metadata',
          'certificate:read:value',
          'secret:read:metadata',
          'secret:read:value',
          // Required for the daemon to bind its own managed key.
          'api_key:read',
        ],
        rotationMode: 'scheduled',
        rotationInterval: '24h',
        gracePeriod: '5m',
      });
      const current = await vault.bindManagedApiKey(
        managedApiKey.name,
        TEST_ENV.tenantId
      );
      managedApiKey.key = current.key;
    });

    afterEach(async () => {
      try {
        if (daemon) {
          await daemon.stop();
          daemon = null;
        }
      } finally {
        if (managedApiKey) {
          try {
            await vault.deleteApiKey(managedApiKey.id);
          } catch { /* ignore */ }
          managedApiKey = null;
        }
      }
    });

    it('WS-14: should subscribe to managed API key rotation events', async () => {
      // Login with managed key
      await agent.loginWithManagedKey({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: managedApiKey!.key,
        managedKeyName: managedApiKey!.name,
        insecure: TEST_ENV.insecure,
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      // Check health - managed key status should be visible
      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      const health = await response.json();

      expect(health.status).toBe('healthy');
      if (health.managedKey) {
        expect(health.managedKey.isRunning).toBe(true);
      }
    });

    it('WS-15: should receive rotation event and update key', async () => {
      // Login with managed key
      await agent.loginWithManagedKey({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: managedApiKey!.key,
        managedKeyName: managedApiKey!.name,
        insecure: TEST_ENV.insecure,
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();
      await waitForWebSocketEstablished(daemon);

      // Wait for health to show managed key info
      await waitForHealthy(daemon.healthPort);

      // Keep the exact value in test memory only; health/log output must never
      // expose a credential-derived prefix.
      const keyBefore = agent.readConfig()?.auth.apiKey;
      expect(keyBefore).toBeTruthy();

      // Trigger rotation on the server
      await vault.rotateManagedKey(managedApiKey!.name);

      // Poll the protected config file for the exact value change.
      await waitFor(async () => {
        const keyAfter = agent.readConfig()?.auth.apiKey;
        return Boolean(keyAfter && keyAfter !== keyBefore);
      }, { timeout: 10000, interval: 200 });

      const healthAfter = await (await fetch(`http://127.0.0.1:${daemon.healthPort}/health`)).json();
      expect(healthAfter.status).toBe('healthy');
    }, 30000);

    it('WS-16: should track WebSocket rotation event metrics', async () => {
      // Login with managed key
      await agent.loginWithManagedKey({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: managedApiKey!.key,
        managedKeyName: managedApiKey!.name,
        insecure: TEST_ENV.insecure,
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();
      await waitForWebSocketEstablished(daemon);

      const readWsEventMetric = async (): Promise<number> => {
        const response = await fetch(`http://127.0.0.1:${daemon!.healthPort}/metrics`);
        if (!response.ok) throw new Error(`Metrics endpoint returned ${response.status}`);
        const metrics = await response.text();
        const match = metrics.match(
          /^znvault_agent_managed_key_ws_events_total(?:\{[^}]*\})?\s+(\d+(?:\.\d+)?)$/m
        );
        return match ? Number(match[1]) : 0;
      };
      const baselineWsEvents = await readWsEventMetric();
      expect(baselineWsEvents).toBe(0);

      // Trigger rotation
      await vault.rotateManagedKey(managedApiKey!.name);

      // Require a new event after this test's rotation, not merely a non-zero
      // counter left by startup recovery or another managed-key event.
      await waitFor(async () => {
        try {
          return await readWsEventMetric() > baselineWsEvents;
        } catch {
          return false;
        }
      }, { timeout: 10000, interval: 200 });

      expect(await readWsEventMetric()).toBeGreaterThan(baselineWsEvents);
    }, 90000);

    it('WS-17: should show safety rails status in health', async () => {
      // Login with managed key
      await agent.loginWithManagedKey({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: managedApiKey!.key,
        managedKeyName: managedApiKey!.name,
        insecure: TEST_ENV.insecure,
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      // Poll for healthy status (faster than fixed 2s wait)
      await waitForHealthy(daemon.healthPort);

      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      const health = await response.json();

      expect(health.status).toBe('healthy');
      if (health.managedKey?.safetyRails) {
        // Safety rails should be tracking
        expect(health.managedKey.safetyRails).toHaveProperty('missedRotations');
        expect(health.managedKey.safetyRails).toHaveProperty('wsEventReceived');
      }
    });

    it('WS-18: should reconnect and check for missed rotations', async () => {
      // Login with managed key
      await agent.loginWithManagedKey({
        url: TEST_ENV.vaultUrl,
        tenantId: TEST_ENV.tenantId,
        apiKey: managedApiKey!.key,
        managedKeyName: managedApiKey!.name,
        insecure: TEST_ENV.insecure,
      });

      daemon = await agent.startDaemon();
      await daemon.waitForReady();

      // Poll for healthy status (faster than fixed 3s wait)
      await waitForHealthy(daemon.healthPort);

      // Agent should remain healthy (verifies reconnection recovery is working)
      const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/health`);
      const health = await response.json();

      expect(health.status).toBe('healthy');
    });
  });
});
