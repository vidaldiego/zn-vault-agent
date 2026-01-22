// Path: zn-vault-agent/src/services/plugin-auto-update.ts

/**
 * Plugin Auto-Update Service
 *
 * Periodically checks npm registry for new versions of installed plugins
 * and auto-updates them via `npm install`. After updates, the daemon
 * restarts to load the new plugin versions.
 */

import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { existsSync, writeFileSync, unlinkSync, readFileSync, statSync } from 'fs';
import semver from 'semver';
import { logger } from '../lib/logger.js';
import type { PluginConfig, PluginVersionInfo } from '../plugins/types.js';
import type { UpdateChannel } from '../types/update.js';

const execAsync = promisify(exec);
const LOCK_FILE = '/var/run/zn-vault-agent.plugin-update.lock';

/**
 * Package.json structure for type-safe parsing
 */
interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
}

/**
 * npm list --json output structure
 */
interface NpmListOutput {
  dependencies?: Record<string, { version?: string }>;
}

/**
 * Plugin update result
 */
export interface PluginUpdateResult {
  package: string;
  previousVersion: string;
  newVersion: string;
  success: boolean;
  error?: string;
}

/**
 * Plugin auto-update service configuration
 */
export interface PluginAutoUpdateServiceConfig {
  /** Global enable/disable (default: true) */
  enabled: boolean;
  /** Check interval in milliseconds (default: 5 minutes) */
  checkIntervalMs: number;
  /** Default channel for plugins without specific channel (default: 'latest') */
  defaultChannel: UpdateChannel;
  /** Maximum random delay before applying update for staged rollout (ms). 0 = no delay */
  stagedRolloutMaxDelayMs: number;
}

export const DEFAULT_PLUGIN_UPDATE_CONFIG: PluginAutoUpdateServiceConfig = {
  enabled: true,
  checkIntervalMs: 5 * 60 * 1000, // 5 minutes
  defaultChannel: 'latest',
  stagedRolloutMaxDelayMs: 30 * 60 * 1000, // 30 minutes max delay for staged rollout
};

export class PluginAutoUpdateService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimeout: NodeJS.Timeout | null = null;
  private stagedRolloutTimeout: NodeJS.Timeout | null = null;
  private readonly config: PluginAutoUpdateServiceConfig;
  private readonly plugins: PluginConfig[];
  private readonly installedVersions = new Map<string, string>();

  constructor(plugins: PluginConfig[], config: Partial<PluginAutoUpdateServiceConfig> = {}) {
    this.config = { ...DEFAULT_PLUGIN_UPDATE_CONFIG, ...config };
    this.plugins = plugins.filter((p) => p.package !== undefined && p.enabled !== false);
  }

  /**
   * Start the plugin auto-update service.
   * Performs initial check after 2 minutes, then checks periodically.
   */
  start(): void {
    if (!this.config.enabled || this.plugins.length === 0) {
      logger.debug(
        { enabled: this.config.enabled, pluginCount: this.plugins.length },
        'Plugin auto-update disabled or no plugins to update'
      );
      return;
    }

    logger.info(
      {
        interval: this.config.checkIntervalMs / 1000,
        plugins: this.plugins.map((p) => p.package),
      },
      'Starting plugin auto-update service'
    );

    // Detect currently installed versions
    this.detectInstalledVersions();

    // Initial check after 2 minutes (let daemon stabilize, after agent self-update check)
    this.initialCheckTimeout = setTimeout(() => {
      this.checkAndUpdateAll().catch((err: unknown) => {
        logger.error({ err }, 'Initial plugin auto-update check failed');
      });
    }, 2 * 60_000);

    // Then check periodically
    this.checkInterval = setInterval(() => {
      this.checkAndUpdateAll().catch((err: unknown) => {
        logger.error({ err }, 'Plugin auto-update check failed');
      });
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop the plugin auto-update service.
   */
  stop(): void {
    if (this.initialCheckTimeout) {
      clearTimeout(this.initialCheckTimeout);
      this.initialCheckTimeout = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.stagedRolloutTimeout) {
      clearTimeout(this.stagedRolloutTimeout);
      this.stagedRolloutTimeout = null;
    }
    logger.debug('Plugin auto-update service stopped');
  }

  /**
   * Check for updates for all plugins without installing.
   */
  async checkForUpdates(): Promise<PluginVersionInfo[]> {
    const results: PluginVersionInfo[] = [];

    for (const plugin of this.plugins) {
      if (!plugin.package) continue;

      // Skip if plugin has auto-update disabled
      if (plugin.autoUpdate?.enabled === false) {
        logger.debug({ package: plugin.package }, 'Plugin auto-update disabled');
        continue;
      }

      try {
        const channel = plugin.autoUpdate?.channel ?? this.config.defaultChannel;
        const current = this.installedVersions.get(plugin.package) ?? '0.0.0';
        const latest = await this.getLatestVersion(plugin.package, channel);

        results.push({
          package: plugin.package,
          current,
          latest,
          updateAvailable: this.isNewer(latest, current),
        });
      } catch (err) {
        logger.warn({ err, package: plugin.package }, 'Failed to check plugin version');
      }
    }

    return results;
  }

  /**
   * Trigger immediate update check and installation.
   * Used by HTTP endpoint to update plugins on-demand.
   * Returns results of update attempts.
   */
  async triggerUpdates(): Promise<PluginUpdateResult[]> {
    const updates = await this.checkForUpdates();
    const availableUpdates = updates.filter((u) => u.updateAvailable);

    if (availableUpdates.length === 0) {
      logger.debug({ checked: updates.length }, 'No plugin updates available');
      return [];
    }

    logger.info(
      { updates: availableUpdates.map((u) => `${u.package}@${u.current} → ${u.latest}`) },
      'Plugin updates available, triggering update'
    );

    // Acquire lock (prevents multiple agents updating simultaneously)
    if (!this.acquireLock()) {
      throw new Error('Another agent is updating plugins, try again later');
    }

    const results: PluginUpdateResult[] = [];

    try {
      for (const update of availableUpdates) {
        const plugin = this.plugins.find((p) => p.package === update.package);
        if (!plugin) continue;

        const channel = plugin.autoUpdate?.channel ?? this.config.defaultChannel;
        const result = await this.updatePlugin(update.package, channel);
        results.push({
          package: update.package,
          previousVersion: update.current,
          newVersion: update.latest,
          ...result,
        });
      }

      const successful = results.filter((r) => r.success);
      if (successful.length > 0) {
        logger.info(
          { updated: successful.map((r) => `${r.package}@${r.newVersion}`) },
          'Plugin updates complete, requesting restart'
        );
        // Schedule restart after response is sent
        setTimeout(() => { this.requestRestart(); }, 2000);
      }
    } finally {
      this.releaseLock();
    }

    return results;
  }

  /**
   * Check for updates and install if available (internal periodic check).
   * Includes staged rollout delay to prevent thundering herd.
   */
  private async checkAndUpdateAll(): Promise<void> {
    const updates = await this.checkForUpdates();
    const availableUpdates = updates.filter((u) => u.updateAvailable);

    if (availableUpdates.length === 0) {
      logger.debug({ checked: updates.length }, 'No plugin updates available');
      return;
    }

    logger.info(
      { updates: availableUpdates.map((u) => `${u.package}@${u.current} → ${u.latest}`) },
      'Plugin updates available, preparing upgrade'
    );

    // Staged rollout: random delay to prevent thundering herd
    if (this.config.stagedRolloutMaxDelayMs > 0) {
      const delay = this.calculateStagedDelay();
      logger.info({ delaySeconds: Math.round(delay / 1000) }, 'Plugin staged rollout delay');
      await this.sleep(delay);

      // Re-check after delay - another agent may have updated
      const recheck = await this.checkForUpdates();
      const stillNeedUpdate = recheck.filter((u) => u.updateAvailable);
      if (stillNeedUpdate.length === 0) {
        logger.info('Plugin updates no longer needed after staged delay');
        return;
      }
    }

    // Acquire lock (prevents multiple agents updating simultaneously)
    if (!this.acquireLock()) {
      logger.info('Another agent is updating plugins, skipping');
      return;
    }

    const results: PluginUpdateResult[] = [];

    try {
      for (const update of availableUpdates) {
        const plugin = this.plugins.find((p) => p.package === update.package);
        if (!plugin) continue;

        const channel = plugin.autoUpdate?.channel ?? this.config.defaultChannel;
        const result = await this.updatePlugin(update.package, channel);
        results.push({
          package: update.package,
          previousVersion: update.current,
          newVersion: update.latest,
          ...result,
        });
      }

      const successful = results.filter((r) => r.success);
      if (successful.length > 0) {
        logger.info(
          { updated: successful.map((r) => `${r.package}@${r.newVersion}`) },
          'Plugin updates complete, requesting restart'
        );
        this.requestRestart();
      }
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Calculate random delay for staged rollout.
   */
  private calculateStagedDelay(): number {
    return Math.floor(Math.random() * this.config.stagedRolloutMaxDelayMs);
  }

  /**
   * Sleep for specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.stagedRolloutTimeout = setTimeout(resolve, ms);
    });
  }

  /**
   * Update a single plugin via npm install -g.
   * Installs globally to ensure consistent plugin versions across the system.
   * The plugin loader always loads from global npm.
   */
  private async updatePlugin(
    packageName: string,
    channel: UpdateChannel
  ): Promise<{ success: boolean; error?: string }> {
    logger.info({ package: packageName, channel }, 'Installing plugin update globally');

    try {
      // Install globally so the plugin loader can find it
      const { stdout, stderr } = await execAsync(
        `npm install -g ${packageName}@${channel}`,
        { timeout: 5 * 60 * 1000 } // 5 minute timeout
      );

      if (stdout) logger.debug({ stdout: stdout.trim() }, 'npm install -g stdout');
      if (stderr) logger.debug({ stderr: stderr.trim() }, 'npm install -g stderr');

      return { success: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error({ err, package: packageName }, 'Plugin global update failed');
      return { success: false, error: errorMessage };
    }
  }

  /** Cached global npm prefix */
  private cachedGlobalPrefix: string | null = null;

  /**
   * Get the global npm prefix path.
   * Results are cached for performance.
   */
  private getGlobalNpmPrefix(): string {
    if (this.cachedGlobalPrefix !== null) {
      return this.cachedGlobalPrefix;
    }

    try {
      this.cachedGlobalPrefix = execSync('npm config get prefix', {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      logger.debug({ prefix: this.cachedGlobalPrefix }, 'Resolved global npm prefix');
      return this.cachedGlobalPrefix;
    } catch (err) {
      // Fallback to common paths
      const fallbacks = ['/usr/local', '/usr'];
      const home = process.env.HOME;
      if (home) {
        fallbacks.push(`${home}/.npm-global`);
      }

      for (const fallback of fallbacks) {
        const isWindows = process.platform === 'win32';
        const nodeModules = isWindows
          ? `${fallback}/node_modules`
          : `${fallback}/lib/node_modules`;
        if (existsSync(nodeModules)) {
          this.cachedGlobalPrefix = fallback;
          logger.debug({ prefix: this.cachedGlobalPrefix }, 'Using fallback global npm prefix');
          return this.cachedGlobalPrefix;
        }
      }

      logger.warn({ err }, 'Could not determine global npm prefix');
      this.cachedGlobalPrefix = '/usr/local';
      return this.cachedGlobalPrefix;
    }
  }

  /**
   * Detect currently installed versions by checking global npm packages.
   * Plugins are always installed and loaded from global npm.
   */
  private detectInstalledVersions(): void {
    logger.debug({ plugins: this.plugins.map(p => p.package) }, 'Detecting installed plugin versions from global npm');

    // First try npm list -g (checks global node_modules)
    try {
      const output = execSync('npm list -g --json --depth=0', {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const npmList = JSON.parse(output) as NpmListOutput;
      const dependencies = npmList.dependencies ?? {};

      for (const plugin of this.plugins) {
        if (!plugin.package) continue;

        const pkgInfo = dependencies[plugin.package];
        if (pkgInfo?.version) {
          this.installedVersions.set(plugin.package, pkgInfo.version);
          logger.info({ package: plugin.package, version: pkgInfo.version, location: 'global' }, 'Detected installed plugin version');
        } else {
          this.installedVersions.set(plugin.package, '0.0.0');
          logger.warn({ package: plugin.package }, 'Plugin not found in global npm packages');
        }
      }
      return;
    } catch (err) {
      logger.warn({ err }, 'Failed to get versions via npm list -g, falling back to direct package.json check');
    }

    // Fallback: check package.json directly in global node_modules
    const globalPrefix = this.getGlobalNpmPrefix();
    const isWindows = process.platform === 'win32';
    const globalNodeModules = isWindows
      ? `${globalPrefix}/node_modules`
      : `${globalPrefix}/lib/node_modules`;

    for (const plugin of this.plugins) {
      if (!plugin.package) continue;

      try {
        const globalPkgPath = `${globalNodeModules}/${plugin.package}/package.json`;
        if (existsSync(globalPkgPath)) {
          const pkg = JSON.parse(readFileSync(globalPkgPath, 'utf-8')) as PackageJson;
          this.installedVersions.set(plugin.package, pkg.version ?? '0.0.0');
          logger.info({ package: plugin.package, version: pkg.version, location: 'global' }, 'Detected installed plugin version via package.json');
        } else {
          this.installedVersions.set(plugin.package, '0.0.0');
          logger.debug({ package: plugin.package, globalPkgPath }, 'Plugin not installed globally');
        }
      } catch {
        this.installedVersions.set(plugin.package, '0.0.0');
        logger.debug({ package: plugin.package }, 'Plugin not installed or version unknown');
      }
    }
  }

  /**
   * Get latest version from npm registry.
   */
  private async getLatestVersion(packageName: string, channel: UpdateChannel): Promise<string> {
    try {
      const { stdout } = await execAsync(`npm view ${packageName}@${channel} version`, {
        timeout: 30_000,
      });
      return stdout.trim();
    } catch (err) {
      logger.warn({ err, package: packageName, channel }, 'Failed to fetch latest version from npm');
      throw err;
    }
  }

  /**
   * Compare semver versions using the semver package.
   * Returns true if `latest` is newer than `current`.
   * Properly handles pre-releases (e.g., 1.0.0-beta.1 < 1.0.0)
   * and build metadata (ignored per semver spec).
   */
  private isNewer(latest: string, current: string): boolean {
    try {
      // semver.gt handles all edge cases including pre-releases
      return semver.gt(latest, current);
    } catch {
      // Fallback to simple comparison if semver parsing fails
      logger.warn({ latest, current }, 'Failed to parse semver, falling back to string comparison');
      return latest > current;
    }
  }

  /**
   * Acquire update lock file.
   * Returns false if another agent is updating.
   */
  private acquireLock(): boolean {
    try {
      if (existsSync(LOCK_FILE)) {
        // Check if lock is stale (> 10 minutes old)
        const stat = statSync(LOCK_FILE);
        const age = Date.now() - stat.mtimeMs;
        if (age < 10 * 60 * 1000) {
          const pid = readFileSync(LOCK_FILE, 'utf-8').trim();
          logger.debug({ pid, age: Math.round(age / 1000) }, 'Plugin update lock file exists');
          return false;
        }
        logger.warn({ age: Math.round(age / 1000) }, 'Stale plugin update lock file detected, removing');
      }
      writeFileSync(LOCK_FILE, String(process.pid));
      return true;
    } catch (err) {
      // Can't write to /var/run - might not be running as root
      logger.debug({ err }, 'Could not acquire plugin update lock file (non-root?)');
      return true; // Allow update anyway
    }
  }

  /**
   * Release update lock file.
   */
  private releaseLock(): void {
    try {
      unlinkSync(LOCK_FILE);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Request daemon restart via SIGTERM.
   * systemd will restart us with the new plugin versions.
   */
  private requestRestart(): void {
    logger.info('Sending SIGTERM to self for restart (plugin update)');
    // Give logs time to flush
    setTimeout(() => {
      process.kill(process.pid, 'SIGTERM');
    }, 1000);
  }
}

/**
 * Load plugin auto-update config from environment or use defaults.
 */
export function loadPluginUpdateConfig(): PluginAutoUpdateServiceConfig {
  const config: PluginAutoUpdateServiceConfig = { ...DEFAULT_PLUGIN_UPDATE_CONFIG };

  // Check for environment overrides
  if (process.env.PLUGIN_AUTO_UPDATE === 'false' || process.env.PLUGIN_AUTO_UPDATE === '0') {
    config.enabled = false;
  }

  if (process.env.PLUGIN_AUTO_UPDATE_INTERVAL) {
    const interval = parseInt(process.env.PLUGIN_AUTO_UPDATE_INTERVAL, 10);
    if (!isNaN(interval) && interval > 0) {
      config.checkIntervalMs = interval * 1000; // Convert seconds to ms
    }
  }

  if (process.env.PLUGIN_AUTO_UPDATE_CHANNEL) {
    const channel = process.env.PLUGIN_AUTO_UPDATE_CHANNEL.toLowerCase();
    if (channel === 'latest' || channel === 'beta' || channel === 'next') {
      config.defaultChannel = channel;
    }
  }

  if (process.env.PLUGIN_AUTO_UPDATE_STAGED_DELAY) {
    const delay = parseInt(process.env.PLUGIN_AUTO_UPDATE_STAGED_DELAY, 10);
    if (!isNaN(delay) && delay >= 0) {
      config.stagedRolloutMaxDelayMs = delay * 1000; // Convert seconds to ms
    }
  }

  return config;
}
