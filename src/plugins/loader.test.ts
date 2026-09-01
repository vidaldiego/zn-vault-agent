// Path: src/plugins/loader.test.ts
// Plugin loader unit tests

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Mock the dependencies
vi.mock('../lib/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
}));

vi.mock('../lib/api.js', () => ({
  getSecret: vi.fn(),
  decryptCertificate: vi.fn(),
}));

vi.mock('../lib/config.js', () => ({
  loadConfig: vi.fn(() => ({
    vaultUrl: 'https://vault.example.com',
    tenantId: 'test-tenant',
    auth: { apiKey: 'znv_test_key' },
    targets: [],
    secretTargets: [],
  })),
}));

import {
  PluginCompatibilityError,
  RequiredPluginLoadError,
  PluginLoader,
  createPluginLoader,
  getPluginLoader,
  clearPluginLoader,
  inspectConfiguredPayaraManifest,
  inspectInstalledPayaraRecoveryManifest,
  inspectPayaraStartupPreflight,
} from './loader.js';
import type { AgentPlugin } from './types.js';
import type { AgentConfig } from '../lib/config.js';

// Helper to create mock plugins - kept for future tests
function _createMockPlugin(overrides: Partial<AgentPlugin> = {}): AgentPlugin {
  return {
    name: 'mock-plugin',
    version: '1.0.0',
    description: 'Test plugin',
    ...overrides,
  };
}

// Create a temp directory for test plugins
function createTestPluginDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zn-vault-agent-test-'));
}

// Write a test plugin file
function writeTestPlugin(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, `${name}.js`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeTestPackage(
  nodeModulesDir: string,
  packageName: string,
  version: unknown,
  content: string
): void {
  const packageDir = path.join(nodeModulesDir, packageName);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: packageName,
    version,
    type: 'module',
    exports: './index.js',
  }));
  fs.writeFileSync(path.join(packageDir, 'index.js'), content);
}

describe('PluginLoader', () => {
  let loader: PluginLoader;
  const mockInternals = {
    config: {
      vaultUrl: 'https://vault.example.com',
      tenantId: 'test-tenant',
      auth: { apiKey: 'znv_test_key' },
      targets: [],
      secretTargets: [],
    } as AgentConfig,
    childProcessManager: null,
    restartChild: undefined,
  };

  beforeEach(() => {
    clearPluginLoader();
    loader = new PluginLoader(mockInternals);
  });

  afterEach(() => {
    clearPluginLoader();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create a new PluginLoader instance', () => {
      expect(loader).toBeInstanceOf(PluginLoader);
      expect(loader.hasPlugins()).toBe(false);
    });
  });

  describe('loadPlugin', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTestPluginDir();
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should load a plugin from a local file', async () => {
      const pluginPath = writeTestPlugin(testDir, 'test-plugin', `
        export default {
          name: 'local-plugin',
          version: '1.0.0',
          description: 'A test plugin',
        };
      `);

      const plugin = await loader.loadPlugin({ path: pluginPath });

      expect(plugin).not.toBeNull();
      expect(plugin?.name).toBe('local-plugin');
      expect(plugin?.version).toBe('1.0.0');
      expect(loader.hasPlugins()).toBe(true);
    });

    it('should load a plugin with factory function', async () => {
      const pluginPath = writeTestPlugin(testDir, 'factory-plugin', `
        export default function createPlugin(config) {
          return {
            name: 'factory-plugin',
            version: '1.0.0',
            receivedConfig: config,
          };
        }
      `);

      const plugin = await loader.loadPlugin({
        path: pluginPath,
        config: { key: 'value' },
      });

      expect(plugin).not.toBeNull();
      expect(plugin?.name).toBe('factory-plugin');
    });

    it('rejects a legacy local Payara plugin before registration', async () => {
      const pluginPath = writeTestPlugin(testDir, 'legacy-payara-plugin', `
        export default {
          name: 'payara',
          version: '2.99.9',
        };
      `);

      const error = await loader.loadPlugin({ path: pluginPath }).catch(caught => caught);

      expect(error).toBeInstanceOf(PluginCompatibilityError);
      expect(error).toMatchObject({ code: 'PLUGIN_INCOMPATIBLE_VERSION' });
      expect((error as Error).message)
        .toMatch(/requires @zincapp\/znvault-plugin-payara >=3\.0\.0 <4\.0\.0/);
      expect(loader.hasPlugins()).toBe(false);
    });

    it('rejects an unsupported future Payara major before registration', async () => {
      const pluginPath = writeTestPlugin(testDir, 'future-payara-plugin', `
        export default {
          name: 'payara',
          version: '4.0.0',
        };
      `);

      const error = await loader.loadPlugin({ path: pluginPath }).catch(caught => caught);

      expect(error).toBeInstanceOf(PluginCompatibilityError);
      expect(error).toMatchObject({ code: 'PLUGIN_INCOMPATIBLE_VERSION' });
      expect(loader.hasPlugins()).toBe(false);
    });

    it('loads a local Payara plugin at the minimum compatible version', async () => {
      const pluginPath = writeTestPlugin(testDir, 'compatible-payara-plugin', `
        export default {
          name: 'payara',
          version: '3.0.0',
        };
      `);

      const plugin = await loader.loadPlugin({ path: pluginPath });

      expect(plugin?.name).toBe('payara');
      expect(plugin?.version).toBe('3.0.0');
    });

    it('rejects a legacy npm Payara package before importing its entrypoint', async () => {
      const nodeModulesDir = path.join(testDir, 'node_modules');
      const importMarker = path.join(testDir, 'legacy-entrypoint-imported');
      writeTestPackage(
        nodeModulesDir,
        '@zincapp/znvault-plugin-payara',
        '2.7.2-lab.2',
        `
          import { writeFileSync } from 'node:fs';
          writeFileSync(${JSON.stringify(importMarker)}, 'imported');
          export default { name: 'payara', version: '2.7.2-lab.2' };
        `
      );
      const packageLoader = new PluginLoader(mockInternals, { globalNodeModulesDir: nodeModulesDir });

      await expect(packageLoader.loadPlugin({ package: '@zincapp/znvault-plugin-payara' }))
        .rejects.toThrow(/legacy or unverified lock protocol/);
      expect(fs.existsSync(importMarker)).toBe(false);
      expect(packageLoader.hasPlugins()).toBe(false);
    });

    it('fails closed when the npm Payara package version is not valid semver', async () => {
      const nodeModulesDir = path.join(testDir, 'node_modules');
      writeTestPackage(
        nodeModulesDir,
        '@zincapp/znvault-plugin-payara',
        'latest',
        `export default { name: 'payara', version: '3.0.0' };`
      );
      const packageLoader = new PluginLoader(mockInternals, { globalNodeModulesDir: nodeModulesDir });

      await expect(packageLoader.loadPlugin({ package: '@zincapp/znvault-plugin-payara' }))
        .rejects.toThrow(/version latest/);
    });

    it('loads an npm Payara package at the minimum compatible version', async () => {
      const nodeModulesDir = path.join(testDir, 'node_modules');
      writeTestPackage(
        nodeModulesDir,
        '@zincapp/znvault-plugin-payara',
        '3.0.0',
        `export default { name: 'payara', version: '3.0.0' };`
      );
      const packageLoader = new PluginLoader(mockInternals, { globalNodeModulesDir: nodeModulesDir });

      const plugin = await packageLoader.loadPlugin({ package: '@zincapp/znvault-plugin-payara' });

      expect(plugin?.version).toBe('3.0.0');
    });

    it('does not impose the Payara version contract on other npm plugins', async () => {
      const nodeModulesDir = path.join(testDir, 'node_modules');
      writeTestPackage(
        nodeModulesDir,
        '@example/legacy-plugin',
        'not-semver',
        `export default { name: 'legacy-other', version: '1.0.0' };`
      );
      const packageLoader = new PluginLoader(mockInternals, { globalNodeModulesDir: nodeModulesDir });

      const plugin = await packageLoader.loadPlugin({ package: '@example/legacy-plugin' });

      expect(plugin?.name).toBe('legacy-other');
      expect(plugin?.version).toBe('1.0.0');
    });

    it('should reject plugin with missing name', async () => {
      const pluginPath = writeTestPlugin(testDir, 'invalid-plugin', `
        export default {
          version: '1.0.0',
        };
      `);

      await expect(loader.loadPlugin({ path: pluginPath })).rejects.toThrow('name');
    });

    it('should reject plugin with missing version', async () => {
      const pluginPath = writeTestPlugin(testDir, 'invalid-plugin', `
        export default {
          name: 'test',
        };
      `);

      await expect(loader.loadPlugin({ path: pluginPath })).rejects.toThrow('version');
    });

    it('should skip duplicate plugin names', async () => {
      const pluginPath1 = writeTestPlugin(testDir, 'plugin1', `
        export default {
          name: 'duplicate',
          version: '1.0.0',
        };
      `);

      const pluginPath2 = writeTestPlugin(testDir, 'plugin2', `
        export default {
          name: 'duplicate',
          version: '2.0.0',
        };
      `);

      await loader.loadPlugin({ path: pluginPath1 });
      const plugin2 = await loader.loadPlugin({ path: pluginPath2 });

      expect(plugin2).toBeNull();
      expect(loader.getPlugins().length).toBe(1);
      expect(loader.getPlugin('duplicate')?.version).toBe('1.0.0');
    });

    it('should throw if neither package nor path provided', async () => {
      await expect(loader.loadPlugin({})).rejects.toThrow('must specify package or path');
    });

    it('should throw if file does not exist', async () => {
      await expect(
        loader.loadPlugin({ path: '/nonexistent/path/plugin.js' })
      ).rejects.toThrow('not found');
    });
  });

  describe('loadPlugins', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTestPluginDir();
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should load multiple plugins from config', async () => {
      const pluginPath1 = writeTestPlugin(testDir, 'plugin1', `
        export default { name: 'plugin-1', version: '1.0.0' };
      `);

      const pluginPath2 = writeTestPlugin(testDir, 'plugin2', `
        export default { name: 'plugin-2', version: '1.0.0' };
      `);

      const config = {
        ...mockInternals.config,
        plugins: [
          { path: pluginPath1 },
          { path: pluginPath2 },
        ],
      };

      await loader.loadPlugins(config as AgentConfig);

      expect(loader.getPlugins().length).toBe(2);
    });

    it('should skip disabled plugins', async () => {
      const pluginPath = writeTestPlugin(testDir, 'disabled-plugin', `
        export default { name: 'disabled', version: '1.0.0' };
      `);

      const config = {
        ...mockInternals.config,
        plugins: [
          { path: pluginPath, enabled: false },
        ],
      };

      await loader.loadPlugins(config as AgentConfig);

      expect(loader.hasPlugins()).toBe(false);
    });

    it('should continue loading if one plugin fails', async () => {
      const goodPluginPath = writeTestPlugin(testDir, 'good-plugin', `
        export default { name: 'good', version: '1.0.0' };
      `);

      const config = {
        ...mockInternals.config,
        plugins: [
          { path: '/nonexistent/bad-plugin.js' },
          { path: goodPluginPath },
        ],
      };

      await loader.loadPlugins(config as AgentConfig);

      expect(loader.getPlugins().length).toBe(1);
      expect(loader.getPlugin('good')).toBeDefined();
    });

    it('propagates Payara compatibility failures instead of continuing startup', async () => {
      const legacyPayaraPath = writeTestPlugin(testDir, 'legacy-payara', `
        export default { name: 'payara', version: '2.9.0' };
      `);
      const otherPluginPath = writeTestPlugin(testDir, 'other-plugin', `
        export default { name: 'other', version: '1.0.0' };
      `);
      const config = {
        ...mockInternals.config,
        plugins: [
          { path: legacyPayaraPath },
          { path: otherPluginPath },
        ],
      };

      await expect(loader.loadPlugins(config as AgentConfig))
        .rejects.toBeInstanceOf(PluginCompatibilityError);
      expect(loader.hasPlugins()).toBe(false);
    });

    it('fails startup when the configured Payara package is missing', async () => {
      const nodeModulesDir = path.join(testDir, 'empty-node-modules');
      fs.mkdirSync(nodeModulesDir, { recursive: true });
      const packageLoader = new PluginLoader(mockInternals, { globalNodeModulesDir: nodeModulesDir });
      const config = {
        ...mockInternals.config,
        plugins: [{ package: '@zincapp/znvault-plugin-payara' }],
      };

      await expect(packageLoader.loadPlugins(config as AgentConfig))
        .rejects.toMatchObject({
          code: 'REQUIRED_PLUGIN_LOAD_FAILED',
          name: 'RequiredPluginLoadError',
        } satisfies Partial<RequiredPluginLoadError>);
      expect(packageLoader.hasPlugins()).toBe(false);
    });

    it('fails startup when the configured Payara package throws during import', async () => {
      const nodeModulesDir = path.join(testDir, 'import-failure-node-modules');
      writeTestPackage(
        nodeModulesDir,
        '@zincapp/znvault-plugin-payara',
        '3.0.0',
        `throw new Error('payara import failed');`
      );
      const packageLoader = new PluginLoader(mockInternals, { globalNodeModulesDir: nodeModulesDir });
      const config = {
        ...mockInternals.config,
        plugins: [{ package: '@zincapp/znvault-plugin-payara' }],
      };

      await expect(packageLoader.loadPlugins(config as AgentConfig))
        .rejects.toThrow(/payara import failed/);
      expect(packageLoader.hasPlugins()).toBe(false);
    });

    it('fails startup when the configured Payara package factory throws', async () => {
      const nodeModulesDir = path.join(testDir, 'factory-failure-node-modules');
      writeTestPackage(
        nodeModulesDir,
        '@zincapp/znvault-plugin-payara',
        '3.0.0',
        `export default function createPayara() { throw new Error('payara factory failed'); }`
      );
      const packageLoader = new PluginLoader(mockInternals, { globalNodeModulesDir: nodeModulesDir });
      const config = {
        ...mockInternals.config,
        plugins: [{ package: '@zincapp/znvault-plugin-payara' }],
      };

      await expect(packageLoader.loadPlugins(config as AgentConfig))
        .rejects.toThrow(/payara factory failed/);
      expect(packageLoader.hasPlugins()).toBe(false);
    });
  });

  describe('initializePlugins', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTestPluginDir();
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should call onInit for all plugins', async () => {
      const pluginPath = writeTestPlugin(testDir, 'init-plugin', `
        export default {
          name: 'init-test',
          version: '1.0.0',
          async onInit(ctx) {
            // Valid onInit that doesn't throw
            ctx.logger.info('Initialized');
          }
        };
      `);

      await loader.loadPlugin({ path: pluginPath });

      expect(loader.getPluginStatus('init-test')).toBe('loaded');

      await loader.initializePlugins();

      expect(loader.getPluginStatus('init-test')).toBe('initialized');
    });

    it('should mark plugin as error if onInit throws', async () => {
      const pluginPath = writeTestPlugin(testDir, 'error-plugin', `
        export default {
          name: 'error-test',
          version: '1.0.0',
          async onInit() {
            throw new Error('Init failed');
          }
        };
      `);

      await loader.loadPlugin({ path: pluginPath });
      await loader.initializePlugins();

      expect(loader.getPluginStatus('error-test')).toBe('error');
    });
  });

  describe('startPlugins / stopPlugins', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTestPluginDir();
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should transition through lifecycle states', async () => {
      const pluginPath = writeTestPlugin(testDir, 'lifecycle-plugin', `
        export default {
          name: 'lifecycle-test',
          version: '1.0.0',
          async onInit(ctx) {},
          async onStart(ctx) {},
          async onStop(ctx) {}
        };
      `);

      await loader.loadPlugin({ path: pluginPath });
      expect(loader.getPluginStatus('lifecycle-test')).toBe('loaded');

      await loader.initializePlugins();
      expect(loader.getPluginStatus('lifecycle-test')).toBe('initialized');

      await loader.startPlugins();
      expect(loader.getPluginStatus('lifecycle-test')).toBe('running');

      await loader.stopPlugins();
      expect(loader.getPluginStatus('lifecycle-test')).toBe('stopped');
    });

    it('should not start twice', async () => {
      const pluginPath = writeTestPlugin(testDir, 'start-once-plugin', `
        let startCount = 0;
        export default {
          name: 'start-once',
          version: '1.0.0',
          async onStart(ctx) {
            startCount++;
            if (startCount > 1) {
              throw new Error('Started twice!');
            }
          }
        };
      `);

      await loader.loadPlugin({ path: pluginPath });
      await loader.initializePlugins();

      await loader.startPlugins();
      await loader.startPlugins(); // Should be no-op

      expect(loader.getPluginStatus('start-once')).toBe('running');
    });

    it('should allow a production-length startup hook to finish', async () => {
      vi.useFakeTimers();

      try {
        const pluginPath = writeTestPlugin(testDir, 'slow-start-plugin', `
          export default {
            name: 'slow-start',
            version: '1.0.0',
            async onStart() {
              await new Promise((resolve) => setTimeout(resolve, 90000));
            }
          };
        `);

        await loader.loadPlugin({ path: pluginPath });
        await loader.initializePlugins();

        const startPromise = loader.startPlugins();
        await vi.advanceTimersByTimeAsync(90_000);
        await startPromise;

        expect(loader.getPluginStatus('slow-start')).toBe('running');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('dispatchEvent', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTestPluginDir();
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should dispatch certificate events to plugins', async () => {
      const pluginPath = writeTestPlugin(testDir, 'event-plugin', `
        export let receivedEvent = null;
        export default {
          name: 'event-test',
          version: '1.0.0',
          async onCertificateDeployed(event, ctx) {
            receivedEvent = event;
          }
        };
      `);

      await loader.loadPlugin({ path: pluginPath });
      await loader.initializePlugins();
      await loader.startPlugins();

      const result = await loader.dispatchEvent('certificateDeployed', {
        certId: 'cert-123',
        name: 'test-cert',
        paths: { combined: '/etc/ssl/test.pem' },
        fingerprint: 'abc123',
        expiresAt: '2025-01-01',
        commonName: 'test.example.com',
        isUpdate: true,
      });

      expect(result).toEqual({
        handlersInvoked: 1,
        handlersSucceeded: 1,
        handlersFailed: 0,
        handlersSkipped: 0,
      });
    });

    it('should continue dispatching if one handler throws', async () => {
      const plugin1Path = writeTestPlugin(testDir, 'failing-plugin', `
        export default {
          name: 'failing',
          version: '1.0.0',
          async onCertificateDeployed() {
            throw new Error('Handler error');
          }
        };
      `);

      const plugin2Path = writeTestPlugin(testDir, 'good-plugin', `
        export let called = false;
        export default {
          name: 'good',
          version: '1.0.0',
          async onCertificateDeployed() {
            called = true;
          }
        };
      `);

      await loader.loadPlugin({ path: plugin1Path });
      await loader.loadPlugin({ path: plugin2Path });
      await loader.initializePlugins();
      await loader.startPlugins();

      const result = await loader.dispatchEvent('certificateDeployed', {
        certId: 'cert-123',
        name: 'test',
        paths: {},
        fingerprint: 'abc',
        expiresAt: '',
        commonName: '',
        isUpdate: false,
      });

      expect(result).toEqual({
        handlersInvoked: 2,
        handlersSucceeded: 1,
        handlersFailed: 1,
        handlersSkipped: 0,
      });
    });

    it('should dispatch keyRotated to a plugin left in error by onStart', async () => {
      const pluginPath = writeTestPlugin(testDir, 'errored-key-plugin', `
        export default {
          name: 'errored-key-plugin',
          version: '1.0.0',
          async onStart() {
            throw new Error('startup timed out');
          },
          async onKeyRotated() {}
        };
      `);

      await loader.loadPlugin({ path: pluginPath });
      await loader.initializePlugins();
      await loader.startPlugins();
      expect(loader.getPluginStatus('errored-key-plugin')).toBe('error');

      const result = await loader.dispatchEvent('keyRotated', {
        keyName: 'zincapi-staging',
        newPrefix: 'znv_new',
        rotationMode: 'scheduled',
      });

      expect(result).toEqual({
        handlersInvoked: 1,
        handlersSucceeded: 1,
        handlersFailed: 0,
        handlersSkipped: 0,
      });
    });

    it('should report a handler skipped for non-critical events while not running', async () => {
      const pluginPath = writeTestPlugin(testDir, 'not-started-plugin', `
        export default {
          name: 'not-started-plugin',
          version: '1.0.0',
          async onCertificateDeployed() {}
        };
      `);

      await loader.loadPlugin({ path: pluginPath });

      const result = await loader.dispatchEvent('certificateDeployed', {
        certId: 'cert-123',
        name: 'test',
        paths: {},
        fingerprint: 'abc',
        expiresAt: '',
        commonName: '',
        isUpdate: false,
      });

      expect(result).toEqual({
        handlersInvoked: 0,
        handlersSucceeded: 0,
        handlersFailed: 0,
        handlersSkipped: 1,
      });
    });
  });

  describe('collectHealthStatus', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTestPluginDir();
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should aggregate health from all plugins', async () => {
      const healthyPluginPath = writeTestPlugin(testDir, 'healthy-plugin', `
        export default {
          name: 'healthy',
          version: '1.0.0',
          async healthCheck() {
            return { name: 'healthy', status: 'healthy' };
          }
        };
      `);

      const degradedPluginPath = writeTestPlugin(testDir, 'degraded-plugin', `
        export default {
          name: 'degraded',
          version: '1.0.0',
          async healthCheck() {
            return { name: 'degraded', status: 'degraded', message: 'Slow' };
          }
        };
      `);

      await loader.loadPlugin({ path: healthyPluginPath });
      await loader.loadPlugin({ path: degradedPluginPath });
      await loader.initializePlugins();
      await loader.startPlugins();

      const statuses = await loader.collectHealthStatus();

      expect(statuses.length).toBe(2);
      expect(statuses.find(s => s.name === 'healthy')?.status).toBe('healthy');
      expect(statuses.find(s => s.name === 'degraded')?.status).toBe('degraded');
    });

    it('should report unhealthy for health check errors', async () => {
      const errorPluginPath = writeTestPlugin(testDir, 'error-health-plugin', `
        export default {
          name: 'error-health',
          version: '1.0.0',
          async healthCheck() {
            throw new Error('Health check failed');
          }
        };
      `);

      await loader.loadPlugin({ path: errorPluginPath });
      await loader.initializePlugins();
      await loader.startPlugins();

      const statuses = await loader.collectHealthStatus();

      expect(statuses.length).toBe(1);
      expect(statuses[0].status).toBe('unhealthy');
      expect(statuses[0].message).toContain('Health check failed');
    });
  });

  describe('getters', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTestPluginDir();
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should return all plugins', async () => {
      const pluginPath = writeTestPlugin(testDir, 'getter-plugin', `
        export default { name: 'getter-test', version: '1.0.0' };
      `);

      await loader.loadPlugin({ path: pluginPath });

      const plugins = loader.getPlugins();
      expect(plugins.length).toBe(1);
      expect(plugins[0].name).toBe('getter-test');
    });

    it('should return plugin by name', async () => {
      const pluginPath = writeTestPlugin(testDir, 'named-plugin', `
        export default { name: 'named', version: '2.0.0' };
      `);

      await loader.loadPlugin({ path: pluginPath });

      const plugin = loader.getPlugin('named');
      expect(plugin?.version).toBe('2.0.0');
    });

    it('should return undefined for unknown plugin', () => {
      expect(loader.getPlugin('unknown')).toBeUndefined();
    });

    it('should return all plugin statuses', async () => {
      const pluginPath = writeTestPlugin(testDir, 'status-plugin', `
        export default { name: 'status-test', version: '1.0.0' };
      `);

      await loader.loadPlugin({ path: pluginPath });

      const statuses = loader.getAllPluginStatuses();
      expect(statuses.length).toBe(1);
      expect(statuses[0]).toEqual({
        name: 'status-test',
        status: 'loaded',
        error: undefined,
      });
    });
  });
});

describe('Payara manifest-only recovery inspection', () => {
  let root: string;
  let nodeModulesDir: string;
  const config = {
    vaultUrl: 'https://vault.example.com',
    targets: [],
    secretTargets: [],
    plugins: [{ package: '@zincapp/znvault-plugin-payara', enabled: true }],
  } as unknown as AgentConfig;

  beforeEach(() => {
    root = createTestPluginDir();
    nodeModulesDir = path.join(root, 'node_modules');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('admits exact major 2 recovery without importing its factory', () => {
    const marker = path.join(root, 'factory-ran');
    writeTestPackage(
      nodeModulesDir,
      '@zincapp/znvault-plugin-payara',
      '2.9.0',
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`
    );
    expect(inspectConfiguredPayaraManifest(config, nodeModulesDir)).toEqual({
      configured: true,
      recoveryRequired: true,
      version: '2.9.0',
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('infers exact major 2 recovery for config-from-Vault without a local declaration', () => {
    const marker = path.join(root, 'inferred-factory-ran');
    writeTestPackage(
      nodeModulesDir,
      '@zincapp/znvault-plugin-payara',
      '2.7.2-lab.2',
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`
    );
    const minimalVaultConfig = {
      vaultUrl: 'https://vault.example.com',
      auth: {},
      targets: [],
      configFromVault: true,
    } as unknown as AgentConfig;

    expect(inspectInstalledPayaraRecoveryManifest(nodeModulesDir)).toEqual({
      configured: true,
      recoveryRequired: true,
      version: '2.7.2-lab.2',
    });
    expect(inspectPayaraStartupPreflight(minimalVaultConfig, nodeModulesDir)).toEqual({
      configured: true,
      recoveryRequired: true,
      version: '2.7.2-lab.2',
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([
    { label: 'missing package', version: undefined },
    { label: 'major 3 package', version: '3.0.0' },
    { label: 'future package', version: '4.0.0' },
  ])('does not infer recovery from $label', ({ version }) => {
    if (version) {
      writeTestPackage(
        nodeModulesDir,
        '@zincapp/znvault-plugin-payara',
        version,
        `export default { name: 'payara', version: ${JSON.stringify(version)} };`
      );
    }
    const minimalVaultConfig = {
      vaultUrl: 'https://vault.example.com',
      auth: {},
      targets: [],
      configFromVault: true,
    } as unknown as AgentConfig;

    expect(inspectPayaraStartupPreflight(minimalVaultConfig, nodeModulesDir)).toEqual({
      configured: false,
      recoveryRequired: false,
    });
  });

  it('does not infer recovery from a corrupt undeclared manifest', () => {
    const packageDir = path.join(nodeModulesDir, '@zincapp/znvault-plugin-payara');
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), '{');
    const minimalVaultConfig = {
      vaultUrl: 'https://vault.example.com',
      auth: {},
      targets: [],
      configFromVault: true,
    } as unknown as AgentConfig;

    expect(inspectPayaraStartupPreflight(minimalVaultConfig, nodeModulesDir)).toEqual({
      configured: false,
      recoveryRequired: false,
    });
  });

  it.each([
    { label: 'corrupt', version: undefined },
    { label: 'future major', version: '4.0.0' },
  ])('does not inspect a stale configured Payara cache before Vault for a $label manifest', ({ version }) => {
    const packageDir = path.join(nodeModulesDir, '@zincapp/znvault-plugin-payara');
    if (version) {
      writeTestPackage(
        nodeModulesDir,
        '@zincapp/znvault-plugin-payara',
        version,
        `export default { name: 'payara', version: ${JSON.stringify(version)} };`
      );
    } else {
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, 'package.json'), '{');
    }
    const staleVaultCache = {
      ...config,
      auth: { apiKey: 'test-only-api-key' },
      configFromVault: true,
      configVersion: 41,
    } as AgentConfig;

    expect(inspectPayaraStartupPreflight(staleVaultCache, nodeModulesDir)).toEqual({
      configured: false,
      recoveryRequired: false,
    });
  });

  it('accepts major 3 as the normal loader path', () => {
    writeTestPackage(
      nodeModulesDir,
      '@zincapp/znvault-plugin-payara',
      '3.0.1',
      `export default { name: 'payara', version: '3.0.1' };`
    );
    expect(inspectConfiguredPayaraManifest(config, nodeModulesDir)).toEqual({
      configured: true,
      recoveryRequired: false,
      version: '3.0.1',
    });
  });

  it.each(['latest', '4.0.0', '1.9.9'])('hard-fails invalid/future manifest %s', (version) => {
    writeTestPackage(
      nodeModulesDir,
      '@zincapp/znvault-plugin-payara',
      version,
      `export default { name: 'payara', version: ${JSON.stringify(version)} };`
    );
    expect(() => inspectConfiguredPayaraManifest(config, nodeModulesDir))
      .toThrow(PluginCompatibilityError);
  });

  it('hard-fails a missing configured package', () => {
    expect(() => inspectConfiguredPayaraManifest(config, nodeModulesDir))
      .toThrow(RequiredPluginLoadError);
  });
});

describe('Plugin Loader Singleton', () => {
  afterEach(() => {
    clearPluginLoader();
  });

  it('should create and return singleton instance', () => {
    const mockInternals = {
      config: {} as AgentConfig,
      childProcessManager: null,
    };

    const loader1 = createPluginLoader(mockInternals);
    const loader2 = getPluginLoader();

    expect(loader1).toBe(loader2);
  });

  it('should clear singleton instance', () => {
    const mockInternals = {
      config: {} as AgentConfig,
      childProcessManager: null,
    };

    createPluginLoader(mockInternals);
    expect(getPluginLoader()).not.toBeNull();

    clearPluginLoader();
    expect(getPluginLoader()).toBeNull();
  });
});
