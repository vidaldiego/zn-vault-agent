// Path: zn-vault-agent/src/services/npm-auto-update.ts

/**
 * npm-based Auto-Update Service
 *
 * Periodically checks npm registry for new versions and auto-updates
 * the agent via `npm install -g`. Uses a lock file to prevent multiple
 * agents from updating simultaneously.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, writeFileSync, unlinkSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from '../lib/logger.js';
import type { UpdateConfig, NpmVersionInfo } from '../types/update.js';
import { DEFAULT_UPDATE_CONFIG } from '../types/update.js';

const execAsync = promisify(exec);
const LOCK_FILE = '/var/run/zn-vault-agent.update.lock';
const PACKAGE_NAME = '@zincapp/zn-vault-agent';

export class NpmAutoUpdateService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimeout: NodeJS.Timeout | null = null;
  private readonly config: UpdateConfig;

  constructor(config: Partial<UpdateConfig> = {}) {
    this.config = { ...DEFAULT_UPDATE_CONFIG, ...config };
  }

  /**
   * Start the auto-update service.
   * Performs initial check after 1 minute, then checks periodically.
   */
  start(): void {
    if (!this.config.enabled) {
      logger.debug('Auto-update disabled');
      return;
    }

    logger.info(
      { interval: this.config.checkIntervalMs / 1000, channel: this.config.channel },
      'Starting npm auto-update service'
    );

    // Initial check after 1 minute (let daemon stabilize)
    this.initialCheckTimeout = setTimeout(() => {
      this.checkAndUpdate().catch((err) => {
        logger.error({ err }, 'Initial auto-update check failed');
      });
    }, 60_000);

    // Then check periodically
    this.checkInterval = setInterval(() => {
      this.checkAndUpdate().catch((err) => {
        logger.error({ err }, 'Auto-update check failed');
      });
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop the auto-update service.
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
    logger.debug('Auto-update service stopped');
  }

  /**
   * Check for updates without installing.
   */
  async checkForUpdates(): Promise<NpmVersionInfo> {
    const current = this.getCurrentVersion();
    const latest = await this.getLatestVersion();
    return {
      current,
      latest,
      updateAvailable: this.isNewer(latest, current),
    };
  }

  /**
   * Check for updates and install if available.
   */
  private async checkAndUpdate(): Promise<void> {
    try {
      const info = await this.checkForUpdates();

      if (!info.updateAvailable) {
        logger.debug({ current: info.current, latest: info.latest }, 'No update available');
        return;
      }

      logger.info(
        { current: info.current, latest: info.latest },
        'Update available, attempting upgrade'
      );

      // Acquire lock (prevents multiple agents updating simultaneously)
      if (!this.acquireLock()) {
        logger.info('Another agent is updating, skipping');
        return;
      }

      try {
        await this.performUpdate();
        logger.info({ version: info.latest }, 'Update complete, requesting restart');
        this.requestRestart();
      } finally {
        this.releaseLock();
      }
    } catch (err) {
      logger.error({ err }, 'Auto-update check failed');
    }
  }

  /**
   * Get current installed version from package.json.
   */
  private getCurrentVersion(): string {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const pkgPath = join(__dirname, '..', '..', 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      return pkg.version;
    } catch {
      // Fallback: try to read from global npm
      return '0.0.0';
    }
  }

  /**
   * Get latest version from npm registry.
   */
  private async getLatestVersion(): Promise<string> {
    const tag = this.config.channel;
    try {
      const { stdout } = await execAsync(`npm view ${PACKAGE_NAME}@${tag} version`, {
        timeout: 30_000,
      });
      return stdout.trim();
    } catch (err) {
      logger.warn({ err, channel: tag }, 'Failed to fetch latest version from npm');
      throw err;
    }
  }

  /**
   * Compare semver versions.
   * Returns true if `latest` is newer than `current`.
   */
  private isNewer(latest: string, current: string): boolean {
    const parseSemver = (v: string): number[] => {
      const parts = v.replace(/^v/, '').split('.');
      return parts.map((p) => parseInt(p, 10) || 0);
    };

    const [lMaj, lMin = 0, lPatch = 0] = parseSemver(latest);
    const [cMaj, cMin = 0, cPatch = 0] = parseSemver(current);

    if (lMaj !== cMaj) return lMaj > cMaj;
    if (lMin !== cMin) return lMin > cMin;
    return lPatch > cPatch;
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
          logger.debug({ pid, age: Math.round(age / 1000) }, 'Lock file exists');
          return false;
        }
        logger.warn({ age: Math.round(age / 1000) }, 'Stale lock file detected, removing');
      }
      writeFileSync(LOCK_FILE, String(process.pid));
      return true;
    } catch (err) {
      // Can't write to /var/run - might not be running as root
      logger.debug({ err }, 'Could not acquire lock file (non-root?)');
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
   * Perform the npm update.
   */
  private async performUpdate(): Promise<void> {
    const tag = this.config.channel;
    logger.info({ package: PACKAGE_NAME, channel: tag }, 'Installing update via npm');

    try {
      const { stdout, stderr } = await execAsync(`npm install -g ${PACKAGE_NAME}@${tag}`, {
        timeout: 5 * 60 * 1000, // 5 minute timeout
      });

      if (stdout) logger.debug({ stdout: stdout.trim() }, 'npm install stdout');
      if (stderr) logger.debug({ stderr: stderr.trim() }, 'npm install stderr');
    } catch (err) {
      logger.error({ err }, 'npm install failed');
      throw err;
    }
  }

  /**
   * Request daemon restart via SIGTERM.
   * systemd will restart us with the new version.
   */
  private requestRestart(): void {
    logger.info('Sending SIGTERM to self for restart');
    // Give logs time to flush
    setTimeout(() => {
      process.kill(process.pid, 'SIGTERM');
    }, 1000);
  }
}

/**
 * Load update config from environment or use defaults.
 */
export function loadUpdateConfig(): UpdateConfig {
  const config: UpdateConfig = { ...DEFAULT_UPDATE_CONFIG };

  // Check for environment overrides
  if (process.env.AUTO_UPDATE === 'false' || process.env.AUTO_UPDATE === '0') {
    config.enabled = false;
  }

  if (process.env.AUTO_UPDATE_INTERVAL) {
    const interval = parseInt(process.env.AUTO_UPDATE_INTERVAL, 10);
    if (!isNaN(interval) && interval > 0) {
      config.checkIntervalMs = interval * 1000; // Convert seconds to ms
    }
  }

  if (process.env.AUTO_UPDATE_CHANNEL) {
    const channel = process.env.AUTO_UPDATE_CHANNEL.toLowerCase();
    if (channel === 'latest' || channel === 'beta' || channel === 'next') {
      config.channel = channel;
    }
  }

  return config;
}
