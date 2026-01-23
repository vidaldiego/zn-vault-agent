// Path: zn-vault-agent/src/services/npm-auto-update.ts

/**
 * npm-based Auto-Update Service
 *
 * Periodically checks npm registry for new versions and auto-updates
 * the agent via `npm install -g`. Uses a lock file to prevent multiple
 * agents from updating simultaneously.
 *
 * Safety features:
 * - Atomic lock file acquisition (O_EXCL)
 * - Staged rollout with random delay (prevents thundering herd)
 * - Real health check (verifies new binary actually works)
 * - Automatic rollback on health check failure
 * - Version verification after update
 * - Previous version tracking for diagnostics
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import {
  existsSync,
  unlinkSync,
  readFileSync,
  statSync,
  openSync,
  writeSync,
  closeSync,
  constants,
} from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import semver from 'semver';
import { logger, flushLogs } from '../lib/logger.js';
import type { UpdateConfig, NpmVersionInfo } from '../types/update.js';
import { DEFAULT_UPDATE_CONFIG } from '../types/update.js';

const execAsync = promisify(exec);
const LOCK_FILE = '/var/run/zn-vault-agent.update.lock';
const PACKAGE_NAME = '@zincapp/zn-vault-agent';

// Lock file staleness threshold (10 minutes)
const LOCK_STALE_MS = 10 * 60 * 1000;

export class NpmAutoUpdateService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimeout: NodeJS.Timeout | null = null;
  private stagedRolloutTimeout: NodeJS.Timeout | null = null;
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
      {
        interval: this.config.checkIntervalMs / 1000,
        channel: this.config.channel,
        stagedRolloutMaxDelay: this.config.stagedRolloutMaxDelayMs / 1000,
        rollbackEnabled: this.config.rollbackOnFailure,
      },
      'Starting npm auto-update service'
    );

    // Initial check after 1 minute (let daemon stabilize)
    this.initialCheckTimeout = setTimeout(() => {
      this.checkAndUpdate().catch((err: unknown) => {
        logger.error({ err }, 'Initial auto-update check failed');
      });
    }, 60_000);

    // Then check periodically
    this.checkInterval = setInterval(() => {
      this.checkAndUpdate().catch((err: unknown) => {
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
    if (this.stagedRolloutTimeout) {
      clearTimeout(this.stagedRolloutTimeout);
      this.stagedRolloutTimeout = null;
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
   * Trigger an immediate update (bypasses staged rollout).
   * Returns update result with version info.
   */
  async triggerUpdate(): Promise<{
    success: boolean;
    previousVersion: string;
    newVersion: string;
    willRestart: boolean;
    message: string;
  }> {
    const info = await this.checkForUpdates();

    if (!info.updateAvailable) {
      return {
        success: true,
        previousVersion: info.current,
        newVersion: info.current,
        willRestart: false,
        message: 'Already at latest version',
      };
    }

    logger.info(
      { current: info.current, latest: info.latest },
      'Manual update triggered via HTTP'
    );

    try {
      // Acquire lock
      if (!this.acquireLock()) {
        return {
          success: false,
          previousVersion: info.current,
          newVersion: info.current,
          willRestart: false,
          message: 'Another update is in progress',
        };
      }

      try {
        await this.performUpdate(info.latest);

        // Verify the update was successful
        const verified = await this.verifyUpdate(info.latest);
        if (!verified) {
          throw new Error('Version verification failed after update');
        }

        // Request restart
        this.requestRestart();

        return {
          success: true,
          previousVersion: info.current,
          newVersion: info.latest,
          willRestart: true,
          message: `Updated to ${info.latest}, restarting in 2 seconds`,
        };
      } finally {
        this.releaseLock();
      }
    } catch (err) {
      logger.error({ err }, 'Manual update failed');
      return {
        success: false,
        previousVersion: info.current,
        newVersion: info.current,
        willRestart: false,
        message: err instanceof Error ? err.message : 'Update failed',
      };
    }
  }

  /**
   * Check for updates and install if available.
   * Includes staged rollout delay and health check with rollback.
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
        'Update available, preparing upgrade'
      );

      // Staged rollout: random delay to prevent thundering herd
      if (this.config.stagedRolloutMaxDelayMs > 0) {
        const delay = this.calculateStagedDelay();
        logger.info({ delaySeconds: Math.round(delay / 1000) }, 'Staged rollout delay');
        await this.sleep(delay);

        // Re-check after delay - another agent may have updated
        const recheck = await this.checkForUpdates();
        if (!recheck.updateAvailable) {
          logger.info('Update no longer needed after staged delay');
          return;
        }
      }

      // Acquire lock (prevents multiple agents updating simultaneously)
      if (!this.acquireLock()) {
        logger.info('Another agent is updating, skipping');
        return;
      }

      try {
        // Store current version for potential rollback
        const previousVersion = info.current;

        // Perform the update
        await this.performUpdate(info.latest);

        // Verify the update was successful
        const verified = await this.verifyUpdate(info.latest);
        if (!verified) {
          logger.error(
            { expected: info.latest },
            'Update verification failed - installed version does not match'
          );
          if (this.config.rollbackOnFailure) {
            await this.rollback(previousVersion);
          }
          return;
        }

        // Real health check: verify new binary actually works
        const healthy = await this.performHealthCheck();
        if (!healthy) {
          logger.error('Health check failed - new binary is not working');
          if (this.config.rollbackOnFailure) {
            await this.rollback(previousVersion);
          } else {
            logger.warn('Rollback disabled, leaving broken update in place');
          }
          // Never restart with a broken binary
          return;
        }

        logger.info(
          { previousVersion, newVersion: info.latest },
          'Update complete, requesting restart'
        );
        this.requestRestart();
      } finally {
        this.releaseLock();
      }
    } catch (err) {
      logger.error({ err }, 'Auto-update check failed');
    }
  }

  /**
   * Calculate random delay for staged rollout.
   * Uses crypto-grade randomness for better distribution.
   */
  calculateStagedDelay(): number {
    // Use Math.random() for simplicity - crypto not needed for rollout timing
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
   * Get current installed version from package.json.
   */
  getCurrentVersion(): string {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const pkgPath = join(__dirname, '..', '..', 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
      return pkg.version ?? '0.0.0';
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
   * Compare semver versions using the semver package.
   * Returns true if `latest` is newer than `current`.
   * Properly handles pre-releases (e.g., 1.0.0-beta.1 < 1.0.0)
   * and build metadata (ignored per semver spec).
   */
  isNewer(latest: string, current: string): boolean {
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
   * Acquire update lock file atomically using O_EXCL.
   * Returns false if another agent is updating.
   */
  private acquireLock(): boolean {
    try {
      // Check for existing lock file
      if (existsSync(LOCK_FILE)) {
        // Check if lock is stale (> 10 minutes old)
        const stat = statSync(LOCK_FILE);
        const age = Date.now() - stat.mtimeMs;

        if (age < LOCK_STALE_MS) {
          const pid = readFileSync(LOCK_FILE, 'utf-8').trim();
          logger.debug({ pid, age: Math.round(age / 1000) }, 'Lock file exists');
          return false;
        }

        logger.warn({ age: Math.round(age / 1000) }, 'Stale lock file detected, removing');
        try {
          unlinkSync(LOCK_FILE);
        } catch {
          // Race condition - another process may have removed it
        }
      }

      // Atomic lock acquisition using O_EXCL (fails if file exists)
      const fd = openSync(LOCK_FILE, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }

      logger.debug({ pid: process.pid }, 'Lock acquired');
      return true;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;

      // EEXIST means another process acquired the lock between our check and create
      if (error.code === 'EEXIST') {
        logger.debug('Lock acquisition failed - another process holds the lock');
        return false;
      }

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
      // Verify we still own the lock before releasing
      if (existsSync(LOCK_FILE)) {
        const pid = readFileSync(LOCK_FILE, 'utf-8').trim();
        if (pid === String(process.pid)) {
          unlinkSync(LOCK_FILE);
          logger.debug('Lock released');
        } else {
          logger.warn({ ourPid: process.pid, lockPid: pid }, 'Lock file owned by different process');
        }
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Check if running as root user.
   * If not root, we'll need sudo for npm global installs.
   */
  private isRoot(): boolean {
    return process.getuid?.() === 0;
  }

  /**
   * Get the sudo prefix if running as non-root.
   * Returns 'sudo ' for non-root users, empty string for root.
   */
  private getSudoPrefix(): string {
    return this.isRoot() ? '' : 'sudo ';
  }

  /**
   * Clear npm cache to ensure clean install.
   * This helps prevent issues from interrupted previous installs.
   */
  private async clearNpmCache(): Promise<void> {
    try {
      // npm cache clean doesn't require sudo
      await execAsync('npm cache clean --force', { timeout: 60_000 });
      logger.debug('npm cache cleared');
    } catch (err) {
      // Cache clear failure is not critical - log and continue
      logger.warn({ err }, 'Failed to clear npm cache, proceeding anyway');
    }
  }

  /**
   * Perform the npm update with retry logic.
   * Includes cache clearing and retries for transient errors.
   * Uses sudo for non-root users (requires appropriate sudoers config).
   */
  private async performUpdate(targetVersion: string): Promise<void> {
    const tag = this.config.channel;
    const maxRetries = 2;
    const sudoPrefix = this.getSudoPrefix();

    logger.info(
      { package: PACKAGE_NAME, channel: tag, targetVersion, usingSudo: !this.isRoot() },
      'Installing update via npm'
    );

    // Step 1: Clear npm cache to ensure clean install
    await this.clearNpmCache();

    // Step 2: Perform install with retries
    let lastError: Error | null = null;
    const installCmd = `${sudoPrefix}npm install -g ${PACKAGE_NAME}@${tag}`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const { stdout, stderr } = await execAsync(installCmd, {
          timeout: 5 * 60 * 1000, // 5 minute timeout
        });

        if (stdout) logger.debug({ stdout: stdout.trim() }, 'npm install stdout');
        if (stderr) logger.debug({ stderr: stderr.trim() }, 'npm install stderr');

        logger.info({ attempt, usingSudo: !this.isRoot() }, 'npm install succeeded');
        return; // Success
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries) {
          logger.warn(
            { attempt, maxRetries, err, usingSudo: !this.isRoot() },
            'npm install failed, retrying after delay'
          );
          await this.sleep(5000); // Wait 5s before retry
        }
      }
    }

    logger.error({ err: lastError, attempts: maxRetries, usingSudo: !this.isRoot() }, 'npm install failed after all retries');
    throw lastError ?? new Error('npm install failed after all retries');
  }

  /**
   * Verify the update was successful by checking the installed version.
   */
  private async verifyUpdate(expectedVersion: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`npm list -g ${PACKAGE_NAME} --depth=0 2>/dev/null || true`, {
        timeout: 30_000,
      });

      // Parse output like "@zincapp/zn-vault-agent@1.4.0"
      const match = /@zincapp\/zn-vault-agent@(\S+)/.exec(stdout);
      if (!match) {
        logger.warn({ stdout: stdout.trim() }, 'Could not parse installed version');
        return true; // Proceed anyway - version might be installed correctly
      }

      const installedVersion = match[1];
      const matches = installedVersion === expectedVersion;

      if (matches) {
        logger.info({ installedVersion }, 'Update verified - version matches');
      } else {
        logger.error(
          { installedVersion, expectedVersion },
          'Update verification failed - version mismatch'
        );
      }

      return matches;
    } catch (err) {
      logger.warn({ err }, 'Could not verify installed version');
      return true; // Proceed anyway - verification is best-effort
    }
  }

  /**
   * Perform real health check by spawning new binary and verifying it responds.
   * This catches issues like missing dependencies, corrupted installs, etc.
   */
  private async performHealthCheck(): Promise<boolean> {
    try {
      // Find the new binary path
      const binaryPath = await this.findInstalledBinaryPath();
      if (!binaryPath) {
        logger.warn('Could not find installed binary path, skipping health check');
        return true; // Fail-open if we can't find binary
      }

      logger.debug({ binaryPath }, 'Running health check on new binary');

      // Run the new binary with --version to verify it starts
      const versionOk = await this.runBinaryHealthCheck(binaryPath, ['--version']);
      if (!versionOk) {
        logger.error('New binary failed --version check');
        return false;
      }

      // Run with --help to verify CLI parsing works
      const helpOk = await this.runBinaryHealthCheck(binaryPath, ['--help']);
      if (!helpOk) {
        logger.error('New binary failed --help check');
        return false;
      }

      logger.info('Health check passed - new binary is working');
      return true;
    } catch (err) {
      logger.error({ err }, 'Health check failed with exception');
      return false;
    }
  }

  /**
   * Find the path to the globally installed binary.
   */
  private async findInstalledBinaryPath(): Promise<string | null> {
    try {
      // npm bin -g returns the global bin directory
      const { stdout } = await execAsync('npm bin -g', { timeout: 10_000 });
      const binDir = stdout.trim();
      const binaryPath = join(binDir, 'zn-vault-agent');

      if (existsSync(binaryPath)) {
        return binaryPath;
      }

      // Try common paths
      const commonPaths = [
        '/usr/local/bin/zn-vault-agent',
        '/usr/bin/zn-vault-agent',
        join(process.env.HOME ?? '', '.npm-global/bin/zn-vault-agent'),
      ];

      for (const path of commonPaths) {
        if (existsSync(path)) {
          return path;
        }
      }

      return null;
    } catch (err) {
      logger.warn({ err }, 'Could not determine binary path');
      return null;
    }
  }

  /**
   * Run a health check command on the binary.
   */
  private runBinaryHealthCheck(binaryPath: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = this.config.healthCheckTimeoutMs;
      let resolved = false;

      const child = spawn(binaryPath, args, {
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.kill('SIGKILL');
          logger.warn({ binaryPath, args, timeout }, 'Health check timed out');
          resolve(false);
        }
      }, timeout);

      child.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          const success = code === 0;
          if (!success) {
            logger.warn({ binaryPath, args, exitCode: code }, 'Health check command failed');
          }
          resolve(success);
        }
      });

      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          logger.warn({ err, binaryPath, args }, 'Health check spawn error');
          resolve(false);
        }
      });
    });
  }

  /**
   * Rollback to previous version after failed update.
   * Uses sudo for non-root users.
   */
  private async rollback(previousVersion: string): Promise<void> {
    logger.warn({ previousVersion, usingSudo: !this.isRoot() }, 'Rolling back to previous version');

    try {
      const sudoPrefix = this.getSudoPrefix();
      const { stdout, stderr } = await execAsync(
        `${sudoPrefix}npm install -g ${PACKAGE_NAME}@${previousVersion}`,
        { timeout: 5 * 60 * 1000 }
      );

      if (stdout) logger.debug({ stdout: stdout.trim() }, 'Rollback npm install stdout');
      if (stderr) logger.debug({ stderr: stderr.trim() }, 'Rollback npm install stderr');

      // Verify rollback succeeded
      const verified = await this.verifyUpdate(previousVersion);
      if (verified) {
        logger.info({ previousVersion }, 'Rollback successful');
      } else {
        logger.error({ previousVersion }, 'Rollback verification failed - system may be in inconsistent state');
      }
    } catch (err) {
      logger.error({ err, previousVersion }, 'Rollback failed - system may be in inconsistent state');
    }
  }

  /**
   * Request daemon restart via SIGTERM.
   * systemd will restart us with the new version.
   * Ensures logs are flushed before sending signal.
   */
  private requestRestart(): void {
    logger.info('Sending SIGTERM to self for restart');

    // Flush logs before restart to ensure all messages are persisted
    flushLogs()
      .catch((err: unknown) => {
        // Log flush failure shouldn't prevent restart
        logger.warn({ err }, 'Failed to flush logs before restart');
      })
      .finally(() => {
        // Small delay after flush to ensure async writes complete
        setTimeout(() => {
          process.kill(process.pid, 'SIGTERM');
        }, 500);
      });
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

  if (process.env.AUTO_UPDATE_STAGED_DELAY) {
    const delay = parseInt(process.env.AUTO_UPDATE_STAGED_DELAY, 10);
    if (!isNaN(delay) && delay >= 0) {
      config.stagedRolloutMaxDelayMs = delay * 1000; // Convert seconds to ms
    }
  }

  if (process.env.AUTO_UPDATE_ROLLBACK === 'false' || process.env.AUTO_UPDATE_ROLLBACK === '0') {
    config.rollbackOnFailure = false;
  }

  return config;
}
