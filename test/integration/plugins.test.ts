// Path: test/integration/plugins.test.ts

/**
 * Plugin System Integration Tests
 *
 * Tests for agent plugin loading, lifecycle, routes, and event handling.
 *
 * Note: These tests use a mock plugin for testing the plugin infrastructure.
 * The actual Payara plugin tests are in the znvault-plugin-payara package.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { AgentRunner, createTempOutputDir, DaemonHandle } from '../helpers/agent-runner.js';
import { VaultTestClient } from '../helpers/vault-client.js';
import { TEST_ENV, getVaultClient } from '../setup.js';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mock plugin for testing
const MOCK_PLUGIN_CODE = `
// Mock plugin for integration testing
export default function createMockPlugin(config) {
  let initialized = false;
  let started = false;

  return {
    name: 'mock-plugin',
    version: '1.0.0',
    description: 'Mock plugin for testing',

    async onInit(ctx) {
      ctx.logger.info({ config }, 'Mock plugin initializing');
      if (config.failOnInit) {
        throw new Error('Simulated init failure');
      }
      initialized = true;
    },

    async onStart(ctx) {
      ctx.logger.info('Mock plugin started');
      if (config.failOnStart) {
        throw new Error('Simulated start failure');
      }
      started = true;
    },

    async onStop(ctx) {
      ctx.logger.info('Mock plugin stopping');
      started = false;
    },

    async routes(fastify, ctx) {
      fastify.get('/status', async () => ({
        initialized,
        started,
        config,
      }));

      fastify.post('/echo', async (request) => ({
        received: request.body,
      }));

      fastify.get('/context', async () => ({
        vaultUrl: ctx.vaultUrl,
        tenantId: ctx.tenantId,
      }));
    },

    async onCertificateDeployed(event, ctx) {
      ctx.logger.info({ event }, 'Certificate deployed');
      // Store event for verification
      ctx.emit('mock:cert-deployed', event);
    },

    async healthCheck(ctx) {
      return {
        name: 'mock-plugin',
        status: initialized && started ? 'healthy' : 'unhealthy',
        details: {
          initialized,
          started,
          testValue: config.testValue || 'default',
        },
      };
    },
  };
};
`;

describe('Plugin System', () => {
  let agent: AgentRunner;
  let vault: VaultTestClient;
  let testApiKey: { id: string; key: string } | null = null;
  let outputDir: string;
  let mockPluginPath: string;

  beforeAll(async () => {
    vault = await getVaultClient();

    // Create test API key
    testApiKey = await vault.createApiKey({
      name: 'plugin-test-key',
      expiresInDays: 1,
      permissions: [
        'certificate:read:metadata',
        'certificate:read:value',
        'secret:read:metadata',
        'secret:read:value',
      ],
      tenantId: TEST_ENV.tenantId,
    });

    // Create mock plugin file
    mockPluginPath = resolve(__dirname, '../fixtures/mock-plugin.mjs');
    mkdirSync(dirname(mockPluginPath), { recursive: true });
    writeFileSync(mockPluginPath, MOCK_PLUGIN_CODE);
  });

  afterAll(async () => {
    // Cleanup mock plugin
    try {
      rmSync(mockPluginPath, { force: true });
      rmSync(dirname(mockPluginPath), { recursive: true, force: true });
    } catch { /* ignore */ }

    if (testApiKey) {
      try {
        await vault.deleteApiKey(testApiKey.id);
      } catch { /* ignore */ }
    }
  });

  beforeEach(async () => {
    const testId = `plugin-${Date.now()}`;
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

  describe('Plugin Loading', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it('PLUGIN-01: should load plugin from local path', async () => {
      // Configure plugin in agent
      agent.setConfig({
        plugins: [{
          path: mockPluginPath,
          config: { testValue: 'from-config' },
        }],
      });

      daemon = await agent.startDaemon({ healthPort: 0 });
      const healthPort = daemon.healthPort!;

      // Check plugin routes are registered
      const response = await fetch(`http://localhost:${healthPort}/plugins/mock-plugin/status`);
      expect(response.status).toBe(200);

      const data = await response.json() as { initialized: boolean; started: boolean; config: { testValue: string } };
      expect(data.initialized).toBe(true);
      expect(data.started).toBe(true);
      expect(data.config.testValue).toBe('from-config');
    });

    it('PLUGIN-02: should include plugin health in /health response', async () => {
      agent.setConfig({
        plugins: [{
          path: mockPluginPath,
          config: { testValue: 'health-test' },
        }],
      });

      daemon = await agent.startDaemon({ healthPort: 0 });
      const healthPort = daemon.healthPort!;

      const response = await fetch(`http://localhost:${healthPort}/health`);
      expect(response.status).toBe(200);

      const health = await response.json() as { plugins?: Array<{ name: string; status: string; details?: { testValue?: string } }> };

      // Find mock plugin in health response
      const pluginHealth = health.plugins?.find(p => p.name === 'mock-plugin');
      expect(pluginHealth).toBeDefined();
      expect(pluginHealth?.status).toBe('healthy');
      expect(pluginHealth?.details?.testValue).toBe('health-test');
    });

    it('PLUGIN-03: should handle plugin init failure gracefully', async () => {
      agent.setConfig({
        plugins: [{
          path: mockPluginPath,
          config: { failOnInit: true },
        }],
      });

      // Agent should still start, but plugin should be in error state
      daemon = await agent.startDaemon({ healthPort: 0 });
      const healthPort = daemon.healthPort!;

      // Health endpoint should still work
      const response = await fetch(`http://localhost:${healthPort}/health`);
      expect(response.status).toBe(200);

      // Plugin routes may not be registered due to init failure
      const pluginResponse = await fetch(`http://localhost:${healthPort}/plugins/mock-plugin/status`);
      // Could be 404 or error depending on implementation
      expect([200, 404, 500]).toContain(pluginResponse.status);
    });

    it.skip('PLUGIN-04: should load plugin from npm package', async () => {
      // This test requires @zincapp/znvault-plugin-payara to be installed
      // Skipped by default - enable when testing npm package loading

      agent.setConfig({
        plugins: [{
          package: '@zincapp/znvault-plugin-payara',
          config: {
            payaraHome: '/opt/payara',
            domain: 'domain1',
            user: 'test',
            warPath: '/tmp/test.war',
            appName: 'TestApp',
          },
        }],
      });

      daemon = await agent.startDaemon({ healthPort: 0 });
      const healthPort = daemon.healthPort!;

      const response = await fetch(`http://localhost:${healthPort}/plugins/payara/status`);
      expect(response.status).toBe(200);
    });
  });

  describe('Plugin Routes', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it('PLUGIN-05: should register GET routes under /plugins/<name>/', async () => {
      agent.setConfig({
        plugins: [{ path: mockPluginPath, config: {} }],
      });

      daemon = await agent.startDaemon({ healthPort: 0 });
      const healthPort = daemon.healthPort!;

      const response = await fetch(`http://localhost:${healthPort}/plugins/mock-plugin/status`);
      expect(response.status).toBe(200);
    });

    it('PLUGIN-06: should register POST routes under /plugins/<name>/', async () => {
      agent.setConfig({
        plugins: [{ path: mockPluginPath, config: {} }],
      });

      daemon = await agent.startDaemon({ healthPort: 0 });
      const healthPort = daemon.healthPort!;

      const response = await fetch(`http://localhost:${healthPort}/plugins/mock-plugin/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      });

      expect(response.status).toBe(200);
      const data = await response.json() as { received: { message: string } };
      expect(data.received.message).toBe('hello');
    });

    it('PLUGIN-07: should provide plugin context with vault info', async () => {
      agent.setConfig({
        plugins: [{ path: mockPluginPath, config: {} }],
      });

      daemon = await agent.startDaemon({ healthPort: 0 });
      const healthPort = daemon.healthPort!;

      const response = await fetch(`http://localhost:${healthPort}/plugins/mock-plugin/context`);
      expect(response.status).toBe(200);

      const data = await response.json() as { vaultUrl: string; tenantId: string };
      expect(data.vaultUrl).toBe(TEST_ENV.vaultUrl);
      expect(data.tenantId).toBe(TEST_ENV.tenantId);
    });
  });

  describe('Plugin Events', () => {
    // These tests require event infrastructure to be fully implemented
    // Skipped until event dispatching is integrated

    it.skip('PLUGIN-08: should dispatch certificate events to plugins', async () => {
      // TODO: Test certificate deployment event dispatching
    });

    it.skip('PLUGIN-09: should dispatch secret events to plugins', async () => {
      // TODO: Test secret deployment event dispatching
    });

    it.skip('PLUGIN-10: should dispatch key rotation events to plugins', async () => {
      // TODO: Test key rotation event dispatching
    });
  });

  describe('Multiple Plugins', () => {
    let daemon: DaemonHandle | null = null;

    afterEach(async () => {
      if (daemon) {
        await daemon.stop();
        daemon = null;
      }
    });

    it.skip('PLUGIN-11: should load multiple plugins', async () => {
      // TODO: Create second mock plugin and test loading multiple
    });

    it.skip('PLUGIN-12: should aggregate health from multiple plugins', async () => {
      // TODO: Test health aggregation with multiple plugins
    });
  });
});
