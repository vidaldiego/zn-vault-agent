// Path: src/services/child-process-manager.ts
// Manages child process for combined daemon + exec mode

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import {
  parseSecretMappingFromConfig,
  buildSecretEnv,
  buildSecretEnvWithFiles,
  type SecretMapping,
} from '../lib/secret-env.js';
import { getSecretFileManager } from '../lib/secret-file-manager.js';
import { type ExecConfig, DEFAULT_EXEC_CONFIG } from '../lib/config.js';

const log = logger.child({ module: 'child-process-manager' });

/**
 * PID file location for tracking child process.
 * Used to detect and clean up orphaned processes on startup.
 */
const CHILD_PID_FILE = process.env.CHILD_PID_FILE ?? '/var/run/zn-vault-agent-child.pid';

/**
 * Timeout for graceful termination of orphaned processes (5 seconds).
 */
const ORPHAN_KILL_TIMEOUT_MS = 5000;

/**
 * Child process status
 */
export type ChildProcessStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'crashed'
  | 'max_restarts_exceeded';

/**
 * Child process state information for health endpoint
 */
export interface ChildProcessState {
  status: ChildProcessStatus;
  pid: number | null;
  restartCount: number;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastExitTime: string | null;
  lastStartTime: string | null;
}

/**
 * Events emitted by ChildProcessManager
 */
export interface ChildProcessManagerEvents {
  started: (pid: number) => void;
  stopped: (code: number | null, signal: string | null) => void;
  restarting: (reason: string) => void;
  maxRestartsExceeded: () => void;
  error: (error: Error) => void;
}

/**
 * Manages a child process with secrets as environment variables.
 * Handles restart on changes, crash recovery with backoff, and signal forwarding.
 */
export class ChildProcessManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private readonly config: Required<Omit<ExecConfig, 'command' | 'secrets' | 'envFile'>> & Pick<ExecConfig, 'command' | 'secrets' | 'envFile'>;
  private readonly mappings: (SecretMapping & { literal?: string; outputToFile?: boolean })[];
  private readonly useFileMode: boolean;
  private isShuttingDown = false;
  private restartCount = 0;
  private restartWindowStart = 0;
  private restartTimeout: NodeJS.Timeout | null = null;
  private status: ChildProcessStatus = 'stopped';
  private lastExitCode: number | null = null;
  private lastExitSignal: string | null = null;
  private lastExitTime: string | null = null;
  private lastStartTime: string | null = null;
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();

  constructor(execConfig: ExecConfig) {
    super();

    // Merge with defaults
    this.config = {
      ...DEFAULT_EXEC_CONFIG,
      ...execConfig,
    };

    // Parse secret mappings from config format, preserving outputToFile flag
    this.mappings = this.config.secrets.map(secret => {
      const parsed = parseSecretMappingFromConfig(secret);
      return {
        ...parsed,
        outputToFile: secret.outputToFile,
      };
    });

    // Check if any secrets should be written to files
    this.useFileMode = this.mappings.some(m => m.outputToFile);

    log.debug(
      {
        command: this.config.command,
        secretCount: this.config.secrets.length,
        restartOnChange: this.config.restartOnChange,
        useFileMode: this.useFileMode,
        fileSecrets: this.mappings.filter(m => m.outputToFile).map(m => m.envVar),
      },
      'ChildProcessManager initialized'
    );
  }

  /**
   * Kill any orphaned child process from a previous agent run.
   * This prevents zombie processes when the agent crashes and restarts.
   */
  private async killOrphanedChild(): Promise<void> {
    if (!fs.existsSync(CHILD_PID_FILE)) {
      return;
    }

    try {
      const pidStr = fs.readFileSync(CHILD_PID_FILE, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);

      if (isNaN(pid) || pid <= 0) {
        log.debug({ pidStr }, 'Invalid PID in child PID file, cleaning up');
        this.cleanupPidFile();
        return;
      }

      // Check if process exists (signal 0 = check existence)
      try {
        process.kill(pid, 0);
        log.warn({ pid }, 'Found orphaned child process, attempting graceful termination');

        // Send SIGTERM for graceful shutdown
        process.kill(pid, 'SIGTERM');

        // Wait for graceful exit (up to ORPHAN_KILL_TIMEOUT_MS)
        const terminated = await this.waitForProcessExit(pid, ORPHAN_KILL_TIMEOUT_MS);

        if (!terminated) {
          // Force kill if still running
          log.warn({ pid }, 'Orphaned process did not exit gracefully, sending SIGKILL');
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Process may have exited between check and kill
          }
        }

        log.info({ pid }, 'Orphaned child process cleaned up');
      } catch {
        // ESRCH = process doesn't exist, which is fine
        log.debug({ pid }, 'Orphaned PID file found but process not running');
      }

      this.cleanupPidFile();
    } catch (err) {
      log.warn({ err }, 'Failed to cleanup orphaned child process');
      // Still try to remove PID file
      this.cleanupPidFile();
    }
  }

  /**
   * Wait for a process to exit with timeout.
   * Returns true if process exited, false if timeout.
   */
  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 100; // Check every 100ms

    while (Date.now() - startTime < timeoutMs) {
      try {
        process.kill(pid, 0);
        // Process still running, wait
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      } catch {
        // Process exited
        return true;
      }
    }

    // Timeout - check one more time
    try {
      process.kill(pid, 0);
      return false; // Still running
    } catch {
      return true; // Exited
    }
  }

  /**
   * Write child PID to file for orphan detection.
   */
  private writePidFile(pid: number): void {
    try {
      const dir = path.dirname(CHILD_PID_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(CHILD_PID_FILE, String(pid), { mode: 0o644 });
      log.debug({ pid, file: CHILD_PID_FILE }, 'Child PID file written');
    } catch (err) {
      // Non-critical - log but don't fail
      log.warn({ err, file: CHILD_PID_FILE }, 'Failed to write child PID file');
    }
  }

  /**
   * Remove the child PID file.
   */
  private cleanupPidFile(): void {
    try {
      if (fs.existsSync(CHILD_PID_FILE)) {
        fs.unlinkSync(CHILD_PID_FILE);
        log.debug({ file: CHILD_PID_FILE }, 'Child PID file removed');
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Start the child process
   */
  async start(): Promise<void> {
    if (this.child) {
      log.warn('Child process already running, ignoring start request');
      return;
    }

    if (this.isShuttingDown) {
      log.warn('Manager is shutting down, ignoring start request');
      return;
    }

    // Kill any orphaned child process from previous run
    await this.killOrphanedChild();

    this.status = 'starting';
    log.info({ command: this.config.command.join(' '), useFileMode: this.useFileMode }, 'Starting child process');

    try {
      // Fetch secrets and build environment
      // Use file mode if any secrets are marked for file output
      let secretEnv: Record<string, string>;

      if (this.useFileMode) {
        const result = await buildSecretEnvWithFiles(this.mappings);
        secretEnv = result.env;
        log.info(
          {
            secretsDir: result.secretsDir,
            filesWritten: result.files.length,
            envVars: Object.keys(result.env).filter(k => !k.endsWith('_FILE')).length,
            fileVars: Object.keys(result.env).filter(k => k.endsWith('_FILE')).length,
          },
          'Secrets prepared (file mode enabled for sensitive values)'
        );
      } else {
        secretEnv = await buildSecretEnv(this.mappings);
      }

      const env = this.config.inheritEnv
        ? { ...process.env, ...secretEnv }
        : secretEnv;

      // Spawn the child process
      const [cmd, ...args] = this.config.command;
      this.child = spawn(cmd, args, {
        env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });

      this.lastStartTime = new Date().toISOString();
      this.status = 'running';

      this.setupSignalForwarding();
      this.setupChildEventHandlers();

      // Write PID file for orphan detection on next startup
      if (this.child.pid) {
        this.writePidFile(this.child.pid);
      }

      log.info({ pid: this.child.pid }, 'Child process started');
      this.emit('started', this.child.pid);
    } catch (err) {
      this.status = 'crashed';
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ err: error }, 'Failed to start child process');
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop the child process gracefully
   */
  async stop(): Promise<void> {
    this.isShuttingDown = true;

    // Clear any pending restart
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    // Remove signal handlers
    this.cleanupSignalHandlers();

    // Clean up secret files if we were using file mode
    if (this.useFileMode) {
      try {
        const manager = getSecretFileManager();
        manager.cleanup();
        log.debug('Cleaned up secret files');
      } catch (err) {
        log.warn({ err }, 'Failed to cleanup secret files');
      }
    }

    // Clean up PID file
    this.cleanupPidFile();

    if (!this.child) {
      this.status = 'stopped';
      return;
    }

    const childToStop = this.child;
    log.info({ pid: childToStop.pid }, 'Stopping child process');

    await new Promise<void>((resolve) => {
      const child = childToStop;

      // Set up exit handler
      const onExit = (): void => {
        this.child = null;
        this.status = 'stopped';
        resolve();
      };

      // If already dead
      if (child.exitCode !== null || child.signalCode !== null) {
        onExit();
        return;
      }

      child.once('exit', onExit);

      // Send SIGTERM first
      child.kill('SIGTERM');

      // Force kill after 10 seconds
      setTimeout(() => {
        if (this.child) {
          log.warn({ pid: this.child.pid }, 'Child did not exit, sending SIGKILL');
          this.child.kill('SIGKILL');
        }
      }, 10000);
    });
  }

  /**
   * Restart the child process (e.g., after cert/secret change)
   */
  async restart(reason: string): Promise<void> {
    if (this.isShuttingDown) {
      log.warn('Manager is shutting down, ignoring restart request');
      return;
    }

    if (!this.config.restartOnChange) {
      log.debug({ reason }, 'Restart requested but restartOnChange is disabled');
      return;
    }

    log.info({ reason }, 'Restarting child process');
    this.status = 'restarting';
    this.emit('restarting', reason);

    // Stop current process
    if (this.child) {
      this.isShuttingDown = false; // Don't prevent restart
      await this.stopChild();
    }

    // Start with fresh secrets
    await this.start();
  }

  /**
   * Get current process state for health endpoint
   */
  getState(): ChildProcessState {
    return {
      status: this.status,
      pid: this.child?.pid ?? null,
      restartCount: this.restartCount,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      lastExitTime: this.lastExitTime,
      lastStartTime: this.lastStartTime,
    };
  }

  /**
   * Check if process is in a healthy state
   */
  isHealthy(): boolean {
    return this.status === 'running';
  }

  /**
   * Check if process is in a degraded state (restarting or max restarts exceeded)
   */
  isDegraded(): boolean {
    return this.status === 'restarting' || this.status === 'max_restarts_exceeded';
  }

  /**
   * Stop child without setting shutdown flag
   */
  private async stopChild(): Promise<void> {
    const childToStop = this.child;
    if (!childToStop) return;

    await new Promise<void>((resolve) => {
      const child = childToStop;

      // Remove signal handlers during restart
      this.cleanupSignalHandlers();

      const onExit = (): void => {
        this.child = null;
        resolve();
      };

      if (child.exitCode !== null || child.signalCode !== null) {
        onExit();
        return;
      }

      child.once('exit', onExit);
      child.kill('SIGTERM');

      setTimeout(() => {
        if (this.child === child) {
          child.kill('SIGKILL');
        }
      }, 5000);
    });
  }

  /**
   * Set up signal forwarding from parent to child
   */
  private setupSignalForwarding(): void {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

    for (const signal of signals) {
      const handler = (): void => {
        if (this.child) {
          log.debug({ signal, pid: this.child.pid }, 'Forwarding signal to child');
          this.child.kill(signal);
        }
      };
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  /**
   * Clean up signal handlers
   */
  private cleanupSignalHandlers(): void {
    for (const [signal, handler] of this.signalHandlers) {
      process.off(signal, handler);
    }
    this.signalHandlers.clear();
  }

  /**
   * Set up event handlers for child process
   */
  private setupChildEventHandlers(): void {
    if (!this.child) return;

    this.child.on('exit', (code, signal) => {
      this.lastExitCode = code;
      this.lastExitSignal = signal?.toString() ?? null;
      this.lastExitTime = new Date().toISOString();

      log.info({ code, signal, pid: this.child?.pid }, 'Child process exited');
      this.emit('stopped', code, signal?.toString() ?? null);

      this.child = null;
      this.cleanupSignalHandlers();

      // Handle crash recovery if not shutting down
      if (!this.isShuttingDown) {
        this.handleCrash(code, signal?.toString() ?? null);
      } else {
        this.status = 'stopped';
      }
    });

    this.child.on('error', (err) => {
      log.error({ err }, 'Child process error');
      this.emit('error', err);
    });
  }

  /**
   * Handle child process crash with rate limiting
   */
  private handleCrash(code: number | null, signal: string | null): void {
    const now = Date.now();

    // Reset counter if outside restart window
    if (now - this.restartWindowStart > this.config.restartWindowMs) {
      this.restartCount = 0;
      this.restartWindowStart = now;
    }

    this.restartCount++;

    // Check if max restarts exceeded
    if (this.restartCount > this.config.maxRestarts) {
      log.error(
        {
          restartCount: this.restartCount,
          maxRestarts: this.config.maxRestarts,
          windowMs: this.config.restartWindowMs,
        },
        'Max restarts exceeded, entering degraded state'
      );
      this.status = 'max_restarts_exceeded';
      this.emit('maxRestartsExceeded');
      return;
    }

    // Schedule restart with delay
    this.status = 'crashed';
    log.info(
      {
        code,
        signal,
        restartCount: this.restartCount,
        delayMs: this.config.restartDelayMs,
      },
      'Child crashed, scheduling restart'
    );

    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = null;
      this.start().catch((err: unknown) => {
        log.error({ err }, 'Failed to restart child process');
      });
    }, this.config.restartDelayMs);
  }

  /**
   * Reset restart counter (call after successful manual restart)
   */
  resetRestartCount(): void {
    this.restartCount = 0;
    this.restartWindowStart = Date.now();
    if (this.status === 'max_restarts_exceeded') {
      this.status = 'stopped';
    }
  }
}
