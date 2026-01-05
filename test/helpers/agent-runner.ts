// Path: test/helpers/agent-runner.ts

/**
 * Agent CLI Runner
 *
 * Helper for executing agent CLI commands in tests.
 * Provides a programmatic interface to the agent CLI.
 */

import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { resolve } from 'path';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';

const AGENT_BIN = resolve(__dirname, '../../dist/index.js');
const TEST_CONFIG_DIR = resolve(__dirname, '../.test-config');

// Auto-assign unique ports for daemon health endpoints
// Uses process.pid as base offset to avoid conflicts between parallel test forks
// Each fork gets a unique range: PID * 100 + counter (mod 10000) + 20000
// This gives each fork 100 unique ports before potential overlap
const portBase = 20000 + ((process.pid % 100) * 100);
let portCounter = 0;
function getNextDaemonPort(): number {
  return portBase + (portCounter++ % 100);
}

export interface AgentRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DaemonHandle {
  process: ChildProcess;
  healthPort: number;
  stop: () => Promise<void>;
  waitForReady: () => Promise<void>;
}

export interface AgentConfig {
  vaultUrl: string;
  tenantId: string;
  auth: { apiKey: string } | { username: string; password: string };
  insecure?: boolean;
  targets?: unknown[];
  secretTargets?: unknown[];
}

export class AgentRunner {
  private configDir: string;
  private configPath: string;

  constructor(private testId: string = 'default') {
    this.configDir = resolve(TEST_CONFIG_DIR, testId);
    this.configPath = resolve(this.configDir, 'config.json');
  }

  /**
   * Setup clean test environment
   */
  setup(): void {
    if (existsSync(this.configDir)) {
      rmSync(this.configDir, { recursive: true });
    }
    mkdirSync(this.configDir, { recursive: true });
  }

  /**
   * Cleanup test environment
   */
  cleanup(): void {
    if (existsSync(this.configDir)) {
      rmSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Write agent configuration
   */
  writeConfig(config: AgentConfig): void {
    writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  /**
   * Read current agent configuration
   */
  readConfig(): AgentConfig | null {
    if (!existsSync(this.configPath)) {
      return null;
    }
    return JSON.parse(readFileSync(this.configPath, 'utf-8'));
  }

  /**
   * Run agent command and wait for completion
   */
  async run(args: string[], options?: {
    timeout?: number;
    env?: Record<string, string>;
    stdin?: string;
  }): Promise<AgentRunResult> {
    const timeout = options?.timeout ?? 30000;

    return new Promise((resolve, reject) => {
      const env: Record<string, string> = {
        ...process.env,
        ZNVAULT_AGENT_CONFIG_DIR: this.configDir,
        LOG_LEVEL: 'error',  // Reduce noise in tests
        ...options?.env,
      };

      const proc = spawn('node', [AGENT_BIN, ...args], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      if (options?.stdin) {
        proc.stdin?.write(options.stdin);
        proc.stdin?.end();
      }

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Command timed out after ${timeout}ms`));
      }, timeout);

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({
          exitCode: exitCode ?? -1,
          stdout,
          stderr,
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /**
   * Run login command
   */
  async login(opts: {
    url: string;
    tenantId: string;
    apiKey?: string;
    username?: string;
    password?: string;
    insecure?: boolean;
    skipTest?: boolean;
  }): Promise<AgentRunResult> {
    const args = ['login', '--url', opts.url, '--tenant', opts.tenantId, '--yes'];

    if (opts.insecure) {
      args.push('--insecure');
    }

    // Skip connection test by default in tests (API key may have limited permissions)
    // When skipTest is explicitly false, run the connection test
    const shouldSkipTest = opts.skipTest !== false;
    if (shouldSkipTest) {
      args.push('--skip-test');
    }

    if (opts.apiKey) {
      args.push('--api-key', opts.apiKey);
    } else if (opts.username && opts.password) {
      args.push('--username', opts.username, '--password', opts.password);
    }

    // Debug: log args for troubleshooting (uncomment if needed)
    // console.log('Login args:', args.join(' '), 'skipTest:', opts.skipTest, 'shouldSkipTest:', shouldSkipTest);

    return this.run(args);
  }

  /**
   * Add certificate target
   */
  async addCertificate(opts: {
    certId: string;
    name: string;
    output: string;
    format?: 'combined' | 'cert' | 'key' | 'chain' | 'fullchain';
    owner?: string;
    mode?: string;
    reloadCmd?: string;
    healthCheckCmd?: string;
  }): Promise<AgentRunResult> {
    const args = [
      'add',
      '--cert-id', opts.certId,
      '--name', opts.name,
      '--output', opts.output,
    ];

    if (opts.format) {
      args.push('--format', opts.format);
    }
    if (opts.owner) {
      args.push('--owner', opts.owner);
    }
    if (opts.mode) {
      args.push('--mode', opts.mode);
    }
    if (opts.reloadCmd) {
      args.push('--reload-cmd', opts.reloadCmd);
    }
    if (opts.healthCheckCmd) {
      args.push('--health-check-cmd', opts.healthCheckCmd);
    }

    return this.run(args);
  }

  /**
   * Remove certificate target
   */
  async removeCertificate(name: string): Promise<AgentRunResult> {
    return this.run(['remove', '--force', name]);
  }

  /**
   * List certificate targets
   */
  async listCertificates(): Promise<AgentRunResult> {
    return this.run(['list']);
  }

  /**
   * List available certificates from vault
   */
  async availableCertificates(): Promise<AgentRunResult> {
    return this.run(['available']);
  }

  /**
   * Sync certificates
   */
  async sync(opts?: {
    dryRun?: boolean;
    name?: string;
  }): Promise<AgentRunResult> {
    const args = ['sync'];
    if (opts?.dryRun) {
      args.push('--dry-run');
    }
    if (opts?.name) {
      args.push('--name', opts.name);
    }
    return this.run(args);
  }

  /**
   * Add secret target
   */
  async addSecret(opts: {
    secretId: string;
    name: string;
    output: string;
    format?: 'env' | 'json' | 'yaml' | 'raw' | 'template';
    owner?: string;
    mode?: string;
    reloadCmd?: string;
    key?: string;  // For raw format
    template?: string;  // For template format
    prefix?: string;  // For env format
  }): Promise<AgentRunResult> {
    const args = [
      'secret', 'add',
      opts.secretId,
      '--name', opts.name,
      '--output', opts.output,
    ];

    if (opts.format) {
      args.push('--format', opts.format);
    }
    if (opts.owner) {
      args.push('--owner', opts.owner);
    }
    if (opts.mode) {
      args.push('--mode', opts.mode);
    }
    if (opts.reloadCmd) {
      args.push('--reload-cmd', opts.reloadCmd);
    }
    if (opts.key) {
      args.push('--key', opts.key);
    }
    if (opts.template) {
      args.push('--template', opts.template);
    }
    if (opts.prefix) {
      args.push('--prefix', opts.prefix);
    }

    return this.run(args);
  }

  /**
   * Remove secret target
   */
  async removeSecret(name: string): Promise<AgentRunResult> {
    return this.run(['secret', 'remove', '--force', name]);
  }

  /**
   * List secret targets
   */
  async listSecrets(): Promise<AgentRunResult> {
    return this.run(['secret', 'list']);
  }

  /**
   * Sync secrets
   */
  async syncSecrets(opts?: {
    name?: string;
  }): Promise<AgentRunResult> {
    const args = ['secret', 'sync'];
    if (opts?.name) {
      args.push('--name', opts.name);
    }
    return this.run(args);
  }

  /**
   * Run exec command with secrets
   */
  async exec(opts: {
    command: string[];
    map: string[];
    envFile?: string;
  }): Promise<AgentRunResult> {
    const args = ['exec'];

    for (const mapping of opts.map) {
      args.push('--secret', mapping);  // CLI uses --secret, not --map
    }

    if (opts.envFile) {
      args.push('--output', opts.envFile);
    }

    // Only add command separator if there's a command to run
    if (opts.command.length > 0) {
      args.push('--', ...opts.command);
    }

    return this.run(args);
  }

  /**
   * Get agent status
   */
  async status(opts?: {
    json?: boolean;
  }): Promise<AgentRunResult> {
    const args = ['status'];
    if (opts?.json) {
      args.push('--json');
    }
    return this.run(args);
  }

  /**
   * Start daemon process
   */
  async startDaemon(opts?: {
    healthPort?: number;
    metricsEnabled?: boolean;
    pollInterval?: number;
    // Combined mode options
    exec?: string;
    secrets?: string[];
    restartOnChange?: boolean;
    restartDelay?: number;
    maxRestarts?: number;
    restartWindow?: number;
  }): Promise<DaemonHandle> {
    // Always assign a health port so waitForReady() works
    // Use || instead of ?? so that explicit 0 also triggers auto-assignment
    const healthPort = opts?.healthPort || getNextDaemonPort();

    const args = ['start'];
    args.push('--health-port', String(healthPort));
    if (opts?.metricsEnabled) {
      args.push('--metrics');
    }
    if (opts?.pollInterval) {
      args.push('--poll-interval', String(opts.pollInterval));
    }

    // Combined mode options
    if (opts?.exec) {
      args.push('--exec', opts.exec);
    }
    if (opts?.secrets) {
      for (const secret of opts.secrets) {
        args.push('--secret', secret);
      }
    }
    if (opts?.restartOnChange === false) {
      args.push('--no-restart-on-change');
    } else if (opts?.restartOnChange === true) {
      args.push('--restart-on-change');
    }
    if (opts?.restartDelay !== undefined) {
      args.push('--restart-delay', String(opts.restartDelay));
    }
    if (opts?.maxRestarts !== undefined) {
      args.push('--max-restarts', String(opts.maxRestarts));
    }
    if (opts?.restartWindow !== undefined) {
      args.push('--restart-window', String(opts.restartWindow));
    }

    const env: Record<string, string> = {
      ...process.env,
      ZNVAULT_AGENT_CONFIG_DIR: this.configDir,
      LOG_LEVEL: 'info',
    };

    const proc = spawn('node', [AGENT_BIN, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    // Note: We always specify a port now, so no need for dynamic detection

    const stop = async (): Promise<void> => {
      return new Promise((resolve) => {
        proc.on('close', () => resolve());
        proc.kill('SIGTERM');

        // Force kill after 5 seconds
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 5000);
      });
    };

    const waitForReady = async (): Promise<void> => {
      // Wait for health endpoint to respond
      // Poll every 200ms for up to 10 seconds (50 attempts)
      const maxAttempts = 50;
      const pollInterval = 200;
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const response = await fetch(`http://127.0.0.1:${healthPort}/health`);
          if (response.ok) {
            return;
          }
        } catch {
          // Not ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
      throw new Error(`Daemon not ready after ${(maxAttempts * pollInterval) / 1000} seconds (port ${healthPort})`);
    };

    return {
      process: proc,
      healthPort,
      stop,
      waitForReady,
    };
  }

  /**
   * Check for updates
   */
  async updateCheck(channel?: string): Promise<AgentRunResult> {
    const args = ['update', 'check'];
    if (channel) {
      args.push('--channel', channel);
    }
    return this.run(args);
  }

  /**
   * Get update status
   */
  async updateStatus(): Promise<AgentRunResult> {
    return this.run(['update', 'status']);
  }
}

/**
 * Create a temporary output directory for tests
 */
export function createTempOutputDir(testId: string): string {
  const dir = resolve(TEST_CONFIG_DIR, testId, 'output');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Clean up all test directories
 */
export function cleanupAllTests(): void {
  if (existsSync(TEST_CONFIG_DIR)) {
    rmSync(TEST_CONFIG_DIR, { recursive: true });
  }
}
