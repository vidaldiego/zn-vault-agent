// Path: test/integration/rotation-propagation.test.ts

/**
 * Managed key rotation propagation integration tests.
 *
 * Regression coverage for the 2026-07-05 production incident: a scheduled
 * managed-key rotation was not propagated to a plugin-deployed API key file
 * while the agent was running. The WebSocket rotation event was lost, and the
 * renewal service's polling rails — which did detect the rotation and refresh
 * the agent's own credentials — never dispatched the plugin `keyRotated`
 * event. The file stayed stale until the grace period expired (consumer 401s)
 * and only an agent restart re-rendered it.
 *
 * ROTATION-01 covers the normal push path (WebSocket event → plugin file
 * rewrite, no restart). ROTATION-02 reproduces the incident: WebSocket
 * 'apikeys' events are suppressed via ZNVAULT_TEST_SUPPRESS_WS_TOPICS, so the
 * file refresh must come from the polling-rail → propagation path within one
 * refresh cycle (~60s).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import { AgentRunner, type DaemonHandle } from '../helpers/agent-runner.js';
import { VaultTestClient, type ManagedApiKey } from '../helpers/vault-client.js';
import { TEST_ENV, getVaultClient } from '../setup.js';

const KEY_FILE_PLUGIN = resolve(__dirname, '../fixtures/key-file-plugin.mjs');

// Helper to wait for a condition
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs: number = 1000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
}

function readKeyFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

describe('Managed Key Rotation Propagation', () => {
  let vault: VaultTestClient;

  beforeAll(async () => {
    vault = await getVaultClient();
  }, 30000);

  /**
   * Provision one managed key + agent daemon with the key-file plugin.
   * Returns everything a test needs, plus a cleanup function.
   */
  async function setupAgentWithKeyFilePlugin(testId: string, opts?: {
    daemonEnv?: Record<string, string>;
    /** Extra plugin config merged in (e.g. secrets with api-key: mappings). */
    pluginExtraConfig?: Record<string, unknown>;
  }): Promise<{
    agent: AgentRunner;
    daemon: DaemonHandle;
    managedKey: ManagedApiKey;
    initialKey: string;
    keyFilePath: string;
    rotationLogPath: string;
    outputDir: string;
    cleanup: () => Promise<void>;
  }> {
    const managedKey = await vault.createManagedApiKey({
      name: `rotation-prop-${testId}-${Date.now()}`,
      permissions: [
        'certificate:read:metadata',
        'certificate:read:value',
        'secret:read:metadata',
        'secret:read:value',
        // Required for the agent to bind its own managed key at runtime
        'api_key:read',
      ],
      tenantId: TEST_ENV.tenantId,
      rotationMode: 'scheduled',
      // 60s is the minimum; keeps the renewal service's scheduled-refresh rail
      // cycle short (refresh at nextRotationAt-30s, clamped to a 60s minimum).
      rotationInterval: '60s',
      // Long grace so the pre-rotation key stays valid for binds all test long.
      gracePeriod: '10m',
    });
    const initialKey = managedKey.key;

    const agent = new AgentRunner(`rotation-prop-${testId}-${Date.now()}`);
    agent.setup();

    const outputDir = resolve(process.cwd(), 'test/.test-config', `rotation-prop-out-${testId}-${Date.now()}`);
    mkdirSync(outputDir, { recursive: true });
    const keyFilePath = resolve(outputDir, 'ZINC_CONFIG_VAULT_API_KEY');
    const rotationLogPath = resolve(outputDir, 'rotation.log');

    agent.writeConfig({
      vaultUrl: TEST_ENV.vaultUrl,
      tenantId: TEST_ENV.tenantId,
      insecure: true,
      auth: { apiKey: initialKey },
      managedKey: { name: managedKey.name, rotationMode: 'scheduled' },
      targets: [],
      secretTargets: [],
      plugins: [
        {
          package: 'key-file-plugin',
          path: KEY_FILE_PLUGIN,
          config: { filePath: keyFilePath, rotationLogPath, ...opts?.pluginExtraConfig },
        },
      ],
    });

    const daemon = await agent.startDaemon({ env: opts?.daemonEnv });
    await daemon.waitForReady();

    // /health may be 200 before the unified WebSocket has received its server
    // acknowledgement when no certificate/secret targets are configured.
    // Wait for the real readiness contract so a rotation cannot race ahead of
    // the managed-key subscription this test is meant to exercise.
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${daemon.healthPort}/ready`);
        return response.ok;
      } catch {
        return false;
      }
    }, 30000, 250);

    // Plugin writes the file during onInit/onStart
    await waitFor(() => readKeyFile(keyFilePath) === initialKey, 15000, 500);

    const cleanup = async (): Promise<void> => {
      await daemon.stop();
      agent.cleanup();
      rmSync(outputDir, { recursive: true, force: true });
      try {
        await vault.deleteManagedApiKey(managedKey.id);
      } catch {
        // Ignore cleanup errors
      }
    };

    return { agent, daemon, managedKey, initialKey, keyFilePath, rotationLogPath, outputDir, cleanup };
  }

  it('ROTATION-01: plugin key file is rewritten after rotation via the WebSocket event (no restart)', async () => {
    const env = await setupAgentWithKeyFilePlugin('ws');
    try {
      await vault.rotateManagedKey(env.managedKey.name, TEST_ENV.tenantId);

      // The live WebSocket apikey.rotated event should drive bind + plugin
      // keyRotated within seconds.
      await waitFor(() => {
        const content = readKeyFile(env.keyFilePath);
        return content !== null && content !== env.initialKey && content.startsWith('znv_');
      }, 30000, 1000);

      const finalKey = readKeyFile(env.keyFilePath);
      expect(finalKey).not.toBe(env.initialKey);
      expect(finalKey?.startsWith('znv_')).toBe(true);
    } catch (err) {
      console.error('ROTATION-01 daemon output:', env.daemon.getOutput());
      throw err;
    } finally {
      await env.cleanup();
    }
  }, 120000);

  it('ROTATION-02: plugin key file is rewritten even when the WebSocket rotation event is LOST (2026-07-05 incident)', async () => {
    // Suppress all 'apikeys' WebSocket events in the daemon — the exact
    // production failure (the live event never processed, redelivery lost).
    // The polling-rail → propagation path must refresh the file on its own.
    const env = await setupAgentWithKeyFilePlugin('rail', {
      daemonEnv: { ZNVAULT_TEST_SUPPRESS_WS_TOPICS: 'apikeys' },
    });
    try {
      await vault.rotateManagedKey(env.managedKey.name, TEST_ENV.tenantId);

      // File must still hold the OLD key briefly (event suppressed, rail not
      // yet fired) — this is what proved the bug pre-fix.
      const rightAfterRotate = readKeyFile(env.keyFilePath);
      expect(rightAfterRotate).toBe(env.initialKey);

      // The renewal service's scheduled-refresh rail binds within ~60s
      // (MIN_REFRESH_INTERVAL_MS) of daemon start, detects the rotation and —
      // with the fix — propagates it to the plugin, which rewrites the file.
      // Pre-fix this times out: the rail only reconnected the WebSocket.
      // Note: with a 60s rotation interval the server's scheduled job may
      // rotate again mid-wait, so assert "not the initial key" rather than a
      // specific prefix.
      await waitFor(() => {
        const content = readKeyFile(env.keyFilePath);
        return content !== null && content !== env.initialKey && content.startsWith('znv_');
      }, 150000, 2000);

      const finalKey = readKeyFile(env.keyFilePath);
      expect(finalKey).not.toBe(env.initialKey);
    } catch (err) {
      console.error('ROTATION-02 daemon output:', env.daemon.getOutput());
      throw err;
    } finally {
      await env.cleanup();
    }
  }, 240000);

  it('ROTATION-03: a tracked key that is NOT the agent`s own is refreshed via the polling rail when its WebSocket event is LOST', async () => {
    // A second managed key consumed by the plugin (api-key: mapping) but not
    // used for agent auth. The renewal service never binds it; only the
    // TrackedKeyPoller can pick up its rotations when WS events are lost.
    const otherKey = await vault.createManagedApiKey({
      name: `rotation-prop-other-${Date.now()}`,
      permissions: ['secret:read:metadata'],
      tenantId: TEST_ENV.tenantId,
      rotationMode: 'scheduled',
      rotationInterval: '60s',
      gracePeriod: '10m',
    });
    const env = await setupAgentWithKeyFilePlugin('other-key', {
      daemonEnv: { ZNVAULT_TEST_SUPPRESS_WS_TOPICS: 'apikeys' },
      pluginExtraConfig: {
        // Mirrors the payara plugin config shape; the agent extracts
        // api-key: entries from plugin secrets to track those keys.
        secrets: { OTHER_VAULT_KEY: `api-key:${otherKey.name}` },
      },
    });
    try {
      // The poller's first poll dispatches a baseline keyRotated for the
      // tracked key shortly after plugins start.
      await waitFor(() => {
        const log = readKeyFile(env.rotationLogPath);
        return log !== null && log.split('\n').includes(otherKey.name);
      }, 30000, 1000);

      const dispatchCountBeforeRotation = (readKeyFile(env.rotationLogPath) ?? '')
        .split('\n')
        .filter((line) => line === otherKey.name).length;
      await vault.rotateManagedKey(otherKey.name, TEST_ENV.tenantId);

      // WS events are suppressed; the poller's next bind (≤60s away) must
      // detect the rotation and dispatch keyRotated again. Count dispatches
      // without persisting any credential-derived fragment in the fixture.
      await waitFor(() => {
        const log = readKeyFile(env.rotationLogPath) ?? '';
        return log.split('\n').filter((line) => line === otherKey.name).length
          > dispatchCountBeforeRotation;
      }, 150000, 2000);

      // The agent's own key file must be untouched by the other key's
      // rotation (no credential clobber).
      expect(readKeyFile(env.keyFilePath)).toBe(env.initialKey);
    } finally {
      await env.cleanup();
      try {
        await vault.deleteManagedApiKey(otherKey.id);
      } catch {
        // Ignore cleanup errors
      }
    }
  }, 300000);
});
