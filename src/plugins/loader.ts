// Path: src/plugins/loader.ts
// Plugin discovery, loading, and lifecycle management

import type { FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { createLogger } from '../lib/logger.js';
import type {
  AgentPlugin,
  PluginFactory,
  PluginConfig,
  PluginContext,
  LoadedPlugin,
  PluginEventMap,
  PluginHealthStatus,
} from './types.js';
import { PLUGIN_EVENT_HANDLERS } from './types.js';
import { createPluginContext } from './context.js';
import type { AgentConfig } from '../lib/config.js';
import type { ChildProcessManager } from '../services/child-process-manager.js';

const log = createLogger({ module: 'plugin-loader' });

/** Default timeout for plugin hooks (30 seconds) */
const PLUGIN_HOOK_TIMEOUT_MS = 30_000;

/** Cached global npm prefix */
let cachedGlobalPrefix: string | null = null;

/**
 * Get the global npm prefix path.
 * Results are cached for performance.
 */
function getGlobalNpmPrefix(): string {
  if (cachedGlobalPrefix !== null) {
    return cachedGlobalPrefix;
  }

  try {
    cachedGlobalPrefix = execSync('npm config get prefix', {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    log.debug({ prefix: cachedGlobalPrefix }, 'Resolved global npm prefix');
    return cachedGlobalPrefix;
  } catch (err) {
    // Fallback to common paths
    const fallbacks = [
      '/usr/local',
      '/usr',
      process.env.HOME ? path.join(process.env.HOME, '.npm-global') : null,
    ].filter((p): p is string => p !== null);

    for (const fallback of fallbacks) {
      const nodeModules = path.join(fallback, 'lib', 'node_modules');
      if (fs.existsSync(nodeModules)) {
        cachedGlobalPrefix = fallback;
        log.debug({ prefix: cachedGlobalPrefix }, 'Using fallback global npm prefix');
        return cachedGlobalPrefix;
      }
    }

    log.warn({ err }, 'Could not determine global npm prefix');
    cachedGlobalPrefix = '/usr/local';
    return cachedGlobalPrefix;
  }
}

/**
 * Resolve the path to a globally installed npm package directory.
 * @param packageName The npm package name (e.g., '@zincapp/my-plugin')
 * @returns The full path to the package directory in global node_modules
 */
function resolveGlobalPackageDir(packageName: string): string {
  const prefix = getGlobalNpmPrefix();
  // On macOS/Linux: {prefix}/lib/node_modules/{package}
  // On Windows: {prefix}/node_modules/{package}
  const isWindows = process.platform === 'win32';
  return isWindows
    ? path.join(prefix, 'node_modules', packageName)
    : path.join(prefix, 'lib', 'node_modules', packageName);
}

/**
 * Resolve the entry point of an npm package for ESM import.
 * Reads package.json and resolves exports or main field.
 * @param packageDir The package directory path
 * @returns The full path to the entry point file
 */
function resolvePackageEntryPoint(packageDir: string): string {
  const pkgJsonPath = path.join(packageDir, 'package.json');

  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`package.json not found in ${packageDir}`);
  }

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
    exports?: Record<string, unknown> | string;
    main?: string;
    module?: string;
  };

  // Resolve entry point from exports (ESM) or main (CJS fallback)
  let entryPoint: string | undefined;

  // Check exports field (ESM standard)
  if (pkgJson.exports) {
    if (typeof pkgJson.exports === 'string') {
      // Simple string export: "exports": "./dist/index.js"
      entryPoint = pkgJson.exports;
    } else if (typeof pkgJson.exports === 'object') {
      // Object exports - check for "." entry point
      const rootExport = pkgJson.exports['.'];
      if (typeof rootExport === 'string') {
        entryPoint = rootExport;
      } else if (rootExport && typeof rootExport === 'object') {
        // Conditional exports: { ".": { "import": "./dist/index.js", "require": "./dist/index.cjs" } }
        const conditionalExport = rootExport as Record<string, unknown>;
        entryPoint = (conditionalExport.import ?? conditionalExport.default ?? conditionalExport.require) as string | undefined;
      }
    }
  }

  // Fallback to module (ESM) or main (CJS)
  if (!entryPoint) {
    entryPoint = pkgJson.module ?? pkgJson.main ?? 'index.js';
  }

  // Resolve relative to package directory
  return path.join(packageDir, entryPoint);
}

/**
 * Execute a plugin hook with timeout protection
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  pluginName: string,
  hookName: string
): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Plugin '${pluginName}' ${hookName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Agent internals passed to plugin context
 */
export interface AgentInternals {
  /** Current agent config */
  config: AgentConfig;
  /** Child process manager (if exec mode) */
  childProcessManager: ChildProcessManager | null;
  /** Restart child process callback */
  restartChild?: (reason: string) => Promise<void>;
}

/**
 * Plugin loader options
 */
export interface PluginLoaderOptions {
  /** Plugin directory for local plugins */
  pluginDir?: string;
  /** Skip npm package discovery */
  skipNpmDiscovery?: boolean;
}

/**
 * Manages plugin discovery, loading, and lifecycle
 */
export class PluginLoader extends EventEmitter {
  private readonly plugins = new Map<string, LoadedPlugin>();
  private agentInternals: AgentInternals;
  private readonly options: PluginLoaderOptions;
  private isStarted = false;

  constructor(agentInternals: AgentInternals, options: PluginLoaderOptions = {}) {
    super();
    this.agentInternals = agentInternals;
    this.options = options;
  }

  /**
   * Load all plugins from config and auto-discovered locations
   */
  async loadPlugins(config: AgentConfig): Promise<void> {
    log.info('Loading plugins');

    // Load plugins from config
    const pluginConfigs = (config as AgentConfig & { plugins?: PluginConfig[] }).plugins ?? [];

    for (const pluginConfig of pluginConfigs) {
      // Skip disabled plugins
      if (pluginConfig.enabled === false) {
        log.debug({ package: pluginConfig.package, path: pluginConfig.path }, 'Plugin disabled, skipping');
        continue;
      }

      try {
        await this.loadPlugin(pluginConfig);
      } catch (err) {
        log.error({ err, config: pluginConfig }, 'Failed to load plugin');
        // Continue loading other plugins
      }
    }

    // Discover local plugins if plugin directory exists
    if (this.options.pluginDir) {
      await this.loadLocalPlugins(this.options.pluginDir);
    }

    log.info({ count: this.plugins.size }, 'Plugins loaded');
  }

  /**
   * Load a single plugin by config
   */
  async loadPlugin(config: PluginConfig): Promise<AgentPlugin | null> {
    const { package: packageName, path: localPath, config: pluginOptions } = config;

    if (!packageName && !localPath) {
      throw new Error('Plugin config must specify package or path');
    }

    const identifier = packageName ?? localPath ?? 'unknown';
    log.debug({ package: packageName, path: localPath }, 'Loading plugin');

    try {
      let module: { default?: AgentPlugin | PluginFactory };

      if (localPath) {
        // Resolve local path relative to config dir or as absolute
        const resolvedPath = path.isAbsolute(localPath)
          ? localPath
          : path.resolve(process.cwd(), localPath);

        if (!fs.existsSync(resolvedPath)) {
          throw new Error(`Plugin file not found: ${resolvedPath}`);
        }

        module = await import(resolvedPath) as { default?: AgentPlugin | PluginFactory };
      } else if (packageName) {
        // Import npm package from global node_modules
        // Always use global npm to ensure consistent plugin versions across the system
        const globalPackageDir = resolveGlobalPackageDir(packageName);

        if (!fs.existsSync(globalPackageDir)) {
          throw new Error(
            `Plugin package '${packageName}' not found in global npm. ` +
            `Install it with: npm install -g ${packageName}`
          );
        }

        // ESM requires importing the actual entry point file, not just the directory
        const entryPoint = resolvePackageEntryPoint(globalPackageDir);
        log.debug({ packageName, globalPackageDir, entryPoint }, 'Loading plugin from global npm');
        module = await import(entryPoint) as { default?: AgentPlugin | PluginFactory };
      } else {
        throw new Error('Plugin config must specify package or path');
      }

      // Support both direct export and factory function
      let plugin: AgentPlugin;
      if (typeof module.default === 'function') {
        // Factory function - pass plugin options
        plugin = (module.default)(pluginOptions ?? {});
      } else if (module.default !== undefined) {
        // Direct export - AgentPlugin is an object
        plugin = module.default;
      } else {
        throw new Error(`Invalid plugin export from ${identifier}`);
      }

      // Validate plugin interface
      this.validatePlugin(plugin);

      // Check for duplicate names
      if (this.plugins.has(plugin.name)) {
        log.warn({ name: plugin.name }, 'Plugin with same name already loaded, skipping');
        return null;
      }

      // Store loaded plugin
      this.plugins.set(plugin.name, {
        plugin,
        config: pluginOptions,
        status: 'loaded',
      });

      log.info({ name: plugin.name, version: plugin.version }, 'Plugin loaded');
      return plugin;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ err: error, identifier }, 'Failed to load plugin');
      throw error;
    }
  }

  /**
   * Load plugins from local directory
   */
  private async loadLocalPlugins(pluginDir: string): Promise<void> {
    if (!fs.existsSync(pluginDir)) {
      log.debug({ pluginDir }, 'Plugin directory does not exist');
      return;
    }

    const entries = fs.readdirSync(pluginDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;

      const pluginPath = path.join(pluginDir, entry.name);
      try {
        await this.loadPlugin({ path: pluginPath });
      } catch (err) {
        log.warn({ err, path: pluginPath }, 'Failed to load local plugin');
      }
    }
  }

  /**
   * Validate plugin has required fields
   */
  private validatePlugin(plugin: unknown): asserts plugin is AgentPlugin {
    if (plugin === null || plugin === undefined || typeof plugin !== 'object') {
      throw new Error('Plugin must be an object');
    }

    const p = plugin as Record<string, unknown>;

    if (typeof p.name !== 'string' || !p.name) {
      throw new Error('Plugin must have a name property');
    }

    if (typeof p.version !== 'string' || !p.version) {
      throw new Error('Plugin must have a version property');
    }

    // Validate optional lifecycle methods are functions
    const methods = ['onInit', 'onStart', 'onStop', 'routes', 'onCertificateDeployed',
                     'onSecretDeployed', 'onKeyRotated', 'onChildProcessEvent', 'healthCheck'];

    for (const method of methods) {
      if (p[method] !== undefined && typeof p[method] !== 'function') {
        throw new Error(`Plugin ${p.name}: ${method} must be a function`);
      }
    }
  }

  /**
   * Initialize all loaded plugins
   */
  async initializePlugins(): Promise<void> {
    log.debug('Initializing plugins');

    for (const [name, loaded] of this.plugins) {
      if (loaded.status !== 'loaded') continue;

      const ctx = createPluginContext(name, this.agentInternals, this);

      if (loaded.plugin.onInit) {
        try {
          await withTimeout(
            loaded.plugin.onInit(ctx),
            PLUGIN_HOOK_TIMEOUT_MS,
            name,
            'onInit'
          );
          loaded.status = 'initialized';
          log.debug({ name }, 'Plugin initialized');
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          log.error({ err: error, name }, 'Plugin initialization failed');
          loaded.status = 'error';
          loaded.error = error;
        }
      } else {
        // No init hook - mark as initialized
        loaded.status = 'initialized';
      }
    }
  }

  /**
   * Start all initialized plugins
   */
  async startPlugins(): Promise<void> {
    if (this.isStarted) {
      log.warn('Plugins already started');
      return;
    }

    log.debug('Starting plugins');

    for (const [name, loaded] of this.plugins) {
      if (loaded.status !== 'initialized') continue;

      const ctx = createPluginContext(name, this.agentInternals, this);

      if (loaded.plugin.onStart) {
        try {
          await withTimeout(
            loaded.plugin.onStart(ctx),
            PLUGIN_HOOK_TIMEOUT_MS,
            name,
            'onStart'
          );
          loaded.status = 'running';
          log.debug({ name }, 'Plugin started');
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          log.error({ err: error, name }, 'Plugin start failed');
          loaded.status = 'error';
          loaded.error = error;
        }
      } else {
        // No start hook - mark as running
        loaded.status = 'running';
      }
    }

    this.isStarted = true;
  }

  /**
   * Stop all running plugins
   */
  async stopPlugins(): Promise<void> {
    if (!this.isStarted) {
      return;
    }

    log.debug('Stopping plugins');

    // Stop in reverse order
    const plugins = Array.from(this.plugins.entries()).reverse();

    for (const [name, loaded] of plugins) {
      if (loaded.status !== 'running') continue;

      const ctx = createPluginContext(name, this.agentInternals, this);

      if (loaded.plugin.onStop) {
        try {
          await withTimeout(
            loaded.plugin.onStop(ctx),
            PLUGIN_HOOK_TIMEOUT_MS,
            name,
            'onStop'
          );
          loaded.status = 'stopped';
          log.debug({ name }, 'Plugin stopped');
        } catch (err) {
          log.warn({ err, name }, 'Plugin stop error (continuing shutdown)');
          loaded.status = 'stopped';
        }
      } else {
        loaded.status = 'stopped';
      }
    }

    this.isStarted = false;
  }

  /**
   * Register plugin routes on Fastify server
   */
  async registerRoutes(fastify: FastifyInstance): Promise<void> {
    for (const [name, loaded] of this.plugins) {
      if (!loaded.plugin.routes) continue;

      const ctx = createPluginContext(name, this.agentInternals, this);

      try {
        // Register under /plugins/<name>/ prefix
        await fastify.register(async (instance) => {
          // Use bound method call to preserve 'this' context
          await loaded.plugin.routes?.(instance, ctx);
        }, { prefix: `/plugins/${name}` });

        log.debug({ name, prefix: `/plugins/${name}` }, 'Plugin routes registered');
      } catch (err) {
        log.error({ err, name }, 'Failed to register plugin routes');
      }
    }
  }

  /**
   * Dispatch event to all plugins
   */
  async dispatchEvent<K extends keyof PluginEventMap>(
    eventType: K,
    event: PluginEventMap[K]
  ): Promise<void> {
    const handlerName = PLUGIN_EVENT_HANDLERS[eventType] as keyof AgentPlugin;

    log.debug({ eventType, plugins: this.plugins.size }, 'Dispatching event to plugins');

    for (const [name, loaded] of this.plugins) {
      if (loaded.status !== 'running') continue;

      const handler = loaded.plugin[handlerName] as
        | ((event: PluginEventMap[K], ctx: PluginContext) => Promise<void>)
        | undefined;

      if (!handler) continue;

      const ctx = createPluginContext(name, this.agentInternals, this);

      try {
        await withTimeout(
          handler.call(loaded.plugin, event, ctx),
          PLUGIN_HOOK_TIMEOUT_MS,
          name,
          handlerName
        );
      } catch (err) {
        log.error({ err, name, eventType }, 'Plugin event handler error');
        // Don't fail other plugins
      }
    }
  }

  /**
   * Collect health status from all plugins
   */
  async collectHealthStatus(): Promise<PluginHealthStatus[]> {
    const statuses: PluginHealthStatus[] = [];

    for (const [name, loaded] of this.plugins) {
      // If plugin has healthCheck, always call it (even if status is 'error')
      // This allows plugins to recover from transient startup failures
      if (loaded.plugin.healthCheck) {
        const ctx = createPluginContext(name, this.agentInternals, this);

        try {
          const status = await loaded.plugin.healthCheck(ctx);
          statuses.push(status);

          // If health check returns healthy and plugin was in error state, recover it
          if (status.status === 'healthy' && loaded.status === 'error') {
            log.info({ name }, 'Plugin recovered from error state');
            loaded.status = 'running';
            loaded.error = undefined;
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          statuses.push({
            name,
            status: 'unhealthy',
            message: `Health check failed: ${error.message}`,
          });
        }
        continue;
      }

      // No healthCheck method - report based on plugin status
      if (loaded.status === 'error') {
        statuses.push({
          name,
          status: 'unhealthy',
          message: loaded.error?.message ?? 'Plugin failed to load',
        });
      } else if (loaded.status === 'running') {
        // Running but no health check - assume healthy
        statuses.push({
          name,
          status: 'healthy',
        });
      }
      // Skip plugins that aren't running and don't have errors
    }

    return statuses;
  }

  /**
   * Get loaded plugins
   */
  getPlugins(): AgentPlugin[] {
    return Array.from(this.plugins.values()).map(l => l.plugin);
  }

  /**
   * Get plugin by name
   */
  getPlugin(name: string): AgentPlugin | undefined {
    return this.plugins.get(name)?.plugin;
  }

  /**
   * Get plugin status
   */
  getPluginStatus(name: string): LoadedPlugin['status'] | undefined {
    return this.plugins.get(name)?.status;
  }

  /**
   * Get all plugin statuses
   */
  getAllPluginStatuses(): { name: string; status: LoadedPlugin['status']; error?: string }[] {
    return Array.from(this.plugins.entries()).map(([name, loaded]) => ({
      name,
      status: loaded.status,
      error: loaded.error?.message,
    }));
  }

  /**
   * Check if any plugins are loaded
   */
  hasPlugins(): boolean {
    return this.plugins.size > 0;
  }

  /**
   * Get plugin info for registration with vault.
   * Returns basic info about loaded plugins.
   */
  getPluginInfo(): { name: string; package: string; version: string }[] {
    return Array.from(this.plugins.values())
      .filter(l => l.status !== 'error')
      .map(l => ({
        name: l.plugin.name,
        package: l.plugin.name, // For now use plugin name; in future can track npm package name
        version: l.plugin.version,
      }));
  }

  /**
   * Update agent internals (called when config changes)
   */
  updateInternals(internals: Partial<AgentInternals>): void {
    this.agentInternals = { ...this.agentInternals, ...internals };
  }
}

/**
 * Singleton plugin loader instance
 */
let pluginLoaderInstance: PluginLoader | null = null;

/**
 * Get or create the plugin loader instance
 */
export function getPluginLoader(): PluginLoader | null {
  return pluginLoaderInstance;
}

/**
 * Create and set the plugin loader instance
 */
export function createPluginLoader(
  agentInternals: AgentInternals,
  options?: PluginLoaderOptions
): PluginLoader {
  pluginLoaderInstance = new PluginLoader(agentInternals, options);
  return pluginLoaderInstance;
}

/**
 * Clear the plugin loader instance (for testing)
 */
export function clearPluginLoader(): void {
  pluginLoaderInstance = null;
}
