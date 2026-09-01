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
import { createHash, randomBytes } from 'node:crypto';

const AGENT_BIN = resolve(__dirname, '../../dist/index.js');
const TEST_CONFIG_DIR = resolve(__dirname, '../.test-config');
const DAEMON_GRACEFUL_STOP_TIMEOUT_MS = 20_000;
const DAEMON_CLOSE_CONFIRMATION_TIMEOUT_MS = 5_000;

// Auto-assign unique ports for daemon health endpoints
// Uses process.pid as base offset to avoid conflicts between parallel test forks
// Each fork gets a unique range: PID * 100 + counter (mod 10000) + 20000
// This gives each fork 100 unique ports before potential overlap
const portBase = 20000 + ((process.pid % 100) * 100);
let portCounter = 0;
function getNextDaemonPort(): number {
  return portBase + (portCounter++ % 100);
}

/**
 * Build an agent environment without inheriting config overrides from the SDK
 * test harness itself. Every runner has a private config.json; a parent
 * ZNVAULT_API_KEY (the suite admin key) would otherwise shadow it and can make
 * authentication tests exercise a different credential than the one saved by
 * the runner.
 */
export function createIsolatedAgentEnv(
  configDir: string,
  logLevel: string,
  overrides?: Record<string, string>
): NodeJS.ProcessEnv {
  const mutationLockPath = resolve(configDir, 'znvault-deploy.lock');
  const isolatedHostname = `znvault-test-${createHash('sha256')
    .update(`${process.pid}\0${configDir}`)
    .digest('hex')
    .slice(0, 16)}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ZNVAULT_AGENT_CONFIG_DIR: configDir,
    LOG_LEVEL: logLevel,
    // The SDK Vault intentionally keeps its production WebSocket rate limits.
    // Give each runner a stable identity so independent daemon tests do not
    // consume one shared agentId quota merely because their parent shell has a
    // common HOSTNAME. Commands and reconnects for the same runner retain the
    // same identity. A new Vitest process gets a fresh namespace so a rerun
    // against the same live SDK Vault cannot inherit the prior run's quota.
    HOSTNAME: isolatedHostname,
  };

  for (const name of [
    'ZNVAULT_URL',
    'ZNVAULT_TENANT_ID',
    'ZNVAULT_API_KEY',
    'ZNVAULT_USERNAME',
    'ZNVAULT_PASSWORD',
    'ZNVAULT_INSECURE',
    'ZNVAULT_CA_CERT_PATH',
    'ZNVAULT_TEST_DEPLOY_LOCK_PATH',
    'CHILD_PID_FILE',
  ]) {
    delete env[name];
  }

  return {
    ...env,
    ...overrides,
    // Identity isolation is an invariant of the live integration harness, just
    // like its lock and child ownership paths; callers cannot collapse it via
    // inherited or per-command overrides.
    HOSTNAME: isolatedHostname,
    // All commands and daemons created by one runner must contend on the same
    // private lock, while independent suites retain separate lock domains.
    ZNVAULT_TEST_DEPLOY_LOCK_PATH: mutationLockPath,
    ZNVAULT_CONTROL_TOKEN_FILE: resolve(configDir, 'control-plane-token'),
    // Combined-mode tests run in parallel Vitest workers. Keep child ownership
    // evidence private to the runner so independent daemons do not contend on
    // the production default under /run.
    CHILD_PID_FILE: resolve(configDir, 'child.pid'),
  };
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
  getOutput: () => { stdout: string; stderr: string };
}

export interface AgentConfig {
  vaultUrl: string;
  tenantId?: string;
  auth: { apiKey?: string; username?: string; password?: string };
  insecure?: boolean;
  targets: unknown[];
  secretTargets?: unknown[];
  managedKey?: { name: string; rotationMode?: 'scheduled' | 'on-use' | 'on-bind' };
  plugins?: { package?: string; path?: string; config?: Record<string, unknown> }[];
}

export type AgentConfigUpdate = Omit<Partial<AgentConfig>, 'auth'> & {
  auth?: Partial<AgentConfig['auth']>;
};

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
    this.ensureControlPlaneToken();
  }

  private ensureControlPlaneToken(): string {
    const tokenPath = resolve(this.configDir, 'control-plane-token');
    if (!existsSync(tokenPath)) {
      writeFileSync(tokenPath, `${randomBytes(32).toString('base64url')}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });
    }
    return tokenPath;
  }

  /** Authorization header for this runner's isolated local control plane. */
  getControlPlaneHeaders(): { Authorization: string } {
    const token = readFileSync(this.ensureControlPlaneToken(), 'utf-8').trim();
    return { Authorization: `Bearer ${token}` };
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
    mkdirSync(this.configDir, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  /**
   * Read current agent configuration
   */
  readConfig(): AgentConfig | null {
    if (!existsSync(this.configPath)) {
      return null;
    }
    return JSON.parse(readFileSync(this.configPath, 'utf-8')) as AgentConfig;
  }

  /**
   * Return the private config file used by this runner's child processes.
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * Return the private cross-process mutation lock shared by this runner.
   */
  getMutationLockPath(): string {
    return resolve(this.configDir, 'znvault-deploy.lock');
  }

  /** Return the private exact-identity evidence for a combined-mode child. */
  getChildPidFilePath(): string {
    return resolve(this.configDir, 'child.pid');
  }

  /**
   * Merge test-specific values into the current agent configuration.
   */
  setConfig(update: AgentConfigUpdate): void {
    const current = this.readConfig();
    if (!current) {
      throw new Error('Agent config does not exist; call login() or writeConfig() before setConfig()');
    }

    this.writeConfig({
      ...current,
      ...update,
      auth: update.auth ? { ...current.auth, ...update.auth } : current.auth,
    });
  }

  /**
   * Run agent command and wait for completion
   */
  async run(args: string[], options?: {
    timeout?: number;
    env?: Record<string, string>;
    stdin?: string;
  }): Promise<AgentRunResult> {
    // The production API client has a 30s per-attempt inactivity timeout and
    // retries transient transport failures. Leave enough room for the first
    // timeout plus backoff and one healthy retry, while remaining below the
    // integration suite's 60s default test budget.
    const timeout = options?.timeout ?? 45_000;

    return new Promise((resolve, reject) => {
      const env = createIsolatedAgentEnv(this.configDir, 'error', options?.env);

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
    tenantId?: string; // Deprecated: tenant is auto-detected from API key
    apiKey?: string;
    username?: string;
    password?: string;
    insecure?: boolean;
    skipTest?: boolean;
  }): Promise<AgentRunResult> {
    const shouldSkipTest = opts.skipTest !== false;

    // Username/password are intentionally not accepted as CLI flags anymore.
    // Store them in the runner's private 0600 config and use an authenticated
    // command for the optional connection check, keeping the password out of
    // argv and the process environment.
    if (!opts.apiKey && (opts.username !== undefined || opts.password !== undefined)) {
      if (!opts.username || !opts.password) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Username and password must both be provided\n',
        };
      }

      const current = this.readConfig() ?? {
        vaultUrl: '',
        auth: {},
        targets: [],
        secretTargets: [],
      };
      this.writeConfig({
        ...current,
        vaultUrl: opts.url,
        tenantId: opts.tenantId ?? current.tenantId,
        auth: { username: opts.username, password: opts.password },
        insecure: opts.insecure ?? false,
        managedKey: undefined,
      });

      if (shouldSkipTest) {
        return {
          exitCode: 0,
          stdout: `Configuration saved to: ${this.configPath}\nConnection test skipped\n`,
          stderr: '',
        };
      }

      return this.availableCertificates();
    }

    const args = ['login', '--url', opts.url, '--yes'];

    if (opts.insecure) {
      args.push('--insecure');
    }

    // Skip connection test by default in tests (API key may have limited permissions)
    // When skipTest is explicitly false, run the connection test
    if (shouldSkipTest) {
      args.push('--skip-test');
    }

    if (opts.apiKey) {
      args.push('--api-key', opts.apiKey);
    }

    const result = await this.run(args);

    // The CLI intentionally ignores tenantId for API-key login because it can
    // discover the tenant itself. Tests already know the isolated SDK tenant;
    // retain it when --skip-test deliberately bypasses that discovery request.
    if (result.exitCode === 0 && opts.tenantId) {
      const config = this.readConfig();
      if (config && !config.tenantId) {
        this.writeConfig({ ...config, tenantId: opts.tenantId });
      }
    }

    return result;
  }

  /**
   * Login with a managed API key (stores managed key metadata in config)
   */
  async loginWithManagedKey(opts: {
    url: string;
    tenantId: string;
    apiKey: string;
    managedKeyName: string;
    insecure?: boolean;
    skipTest?: boolean;
  }): Promise<AgentRunResult> {
    // First do a regular login with the API key
    const result = await this.login({
      url: opts.url,
      tenantId: opts.tenantId,
      apiKey: opts.apiKey,
      insecure: opts.insecure,
      skipTest: opts.skipTest,
    });

    if (result.exitCode !== 0) {
      return result;
    }

    // Now update the config to add managed key metadata
    const config = this.readConfig();
    if (config) {
      (config as AgentConfig & { managedKey?: { name: string; rotationMode?: string } }).managedKey = {
        name: opts.managedKeyName,
        rotationMode: 'scheduled',  // Default
      };
      this.writeConfig(config);
    }

    return result;
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
      '--cert', opts.certId,
      '--name', opts.name,
      '--yes',  // Non-interactive mode
    ];

    // Use format-specific output options (default to combined)
    const format = opts.format || 'combined';
    switch (format) {
      case 'combined':
        args.push('--combined', opts.output);
        break;
      case 'cert':
        args.push('--cert-file', opts.output);
        break;
      case 'key':
        args.push('--key-file', opts.output);
        break;
      case 'chain':
        args.push('--chain-file', opts.output);
        break;
      case 'fullchain':
        args.push('--fullchain-file', opts.output);
        break;
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
      args.push('--health-cmd', opts.healthCheckCmd);
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
      args.push('--target', opts.name);
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
    envFiles?: string[];  // -e/--env-secret refs (alias:path[:PREFIX_])
    envFile?: string;     // --output path for writing env file
    envSecretFlag?: '-e' | '--env-secret';
  }): Promise<AgentRunResult> {
    const args = ['exec'];

    // Add env secret references (-e/--env-secret)
    for (const ref of opts.envFiles ?? []) {
      args.push(opts.envSecretFlag ?? '--env-secret', ref);
    }

    // Add individual secret mappings (-s/--secret)
    for (const mapping of opts.map) {
      args.push('--secret', mapping);
    }

    // Add output file path (--output)
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
    /** Extra environment variables for the daemon process (e.g. fault injection) */
    env?: Record<string, string>;
    // Combined mode options
    exec?: string;
    secrets?: string[];
    restartOnChange?: boolean;
    restartDelay?: number;
    maxRestarts?: number;
    restartWindow?: number;
  }): Promise<DaemonHandle> {
    this.ensureControlPlaneToken();
    // Always assign a health port so waitForReady() works
    // Use || instead of ?? so that explicit 0 also triggers auto-assignment
    const healthPort = opts?.healthPort || getNextDaemonPort();

    const args = ['start'];
    args.push('--health-port', String(healthPort));
    // Note: --metrics and --poll-interval flags don't exist in the CLI
    // Metrics are enabled by default when --health-port is set
    // Poll interval is configured via config file, not CLI flag

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

    const env = createIsolatedAgentEnv(this.configDir, 'info', opts?.env);

    const proc = spawn('node', [AGENT_BIN, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    // Capture stdout/stderr for debugging on failure
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    // Track if process has exited
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let closeObserved = false;
    proc.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal as string | null;
    });
    proc.on('close', () => {
      closeObserved = true;
    });

    const stop = async (): Promise<void> => {
      if (closeObserved) return;

      return new Promise((resolve, reject) => {
        let forceTimer: NodeJS.Timeout | undefined;
        let settleTimer: NodeJS.Timeout | undefined;
        let settled = false;
        let forced = false;

        const finish = (): void => {
          if (settled) return;
          settled = true;
          if (forceTimer) clearTimeout(forceTimer);
          if (settleTimer) clearTimeout(settleTimer);
          proc.off('close', finish);
          if (forced) {
            reject(new Error(
              `Daemon required SIGKILL after ${DAEMON_GRACEFUL_STOP_TIMEOUT_MS}ms; ` +
              `exitCode=${String(exitCode ?? proc.exitCode)} ` +
              `signal=${String(exitSignal ?? proc.signalCode)}`
            ));
          } else {
            resolve();
          }
        };

        proc.once('close', finish);

        // The close event may have fired between the initial check and listener
        // registration. Exit alone is insufficient: a leaked descendant can
        // keep inherited stdio open after the daemon process is already gone.
        if (closeObserved) {
          finish();
          return;
        }

        const daemonAlreadyExited = exitCode !== null
          || proc.exitCode !== null
          || proc.signalCode !== null;
        if (!daemonAlreadyExited) proc.kill('SIGTERM');

        // ChildProcess.killed only means a signal was sent; it does not mean
        // the process has exited. Check exit state before escalating.
        if (!daemonAlreadyExited) {
          forceTimer = setTimeout(() => {
            if (exitCode === null && proc.exitCode === null && proc.signalCode === null) {
              forced = true;
              proc.kill('SIGKILL');
            }
          }, DAEMON_GRACEFUL_STOP_TIMEOUT_MS);
        }

        // Keep test cleanup bounded, but never turn an unconfirmed close into a
        // passing teardown. A leaked descendant can keep the inherited stdio
        // pipes open after the daemon itself exits, which is release-blocking
        // evidence rather than a reason to resolve blindly.
        settleTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (forceTimer) clearTimeout(forceTimer);
          proc.off('close', finish);
          reject(new Error(
            `Daemon did not confirm close after ` +
            `${DAEMON_GRACEFUL_STOP_TIMEOUT_MS + DAEMON_CLOSE_CONFIRMATION_TIMEOUT_MS}ms; ` +
            `exitCode=${String(exitCode ?? proc.exitCode)} ` +
            `signal=${String(exitSignal ?? proc.signalCode)}`
          ));
        }, DAEMON_GRACEFUL_STOP_TIMEOUT_MS + DAEMON_CLOSE_CONFIRMATION_TIMEOUT_MS);
      });
    };

    const waitForReady = async (): Promise<void> => {
      // Wait for health endpoint to respond
      // Poll every 250ms for up to 30 seconds (120 attempts)
      const maxAttempts = 120;
      const pollInterval = 250;
      for (let i = 0; i < maxAttempts; i++) {
        // Check if process has exited early
        if (exitCode !== null) {
          const lastStderr = stderr.slice(-1000);
          const lastStdout = stdout.slice(-1000);
          throw new Error(
            `Daemon process exited with code ${exitCode} (signal: ${exitSignal}) before becoming ready.\n` +
            `Last stderr: ${lastStderr}\n` +
            `Last stdout: ${lastStdout}`
          );
        }

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

      // On timeout, include daemon output for debugging
      const lastStderr = stderr.slice(-500);
      const lastStdout = stdout.slice(-1000);
      throw new Error(
        `Daemon not ready after ${(maxAttempts * pollInterval) / 1000} seconds (port ${healthPort}).\n` +
        `Process alive: ${exitCode === null}\n` +
        `Last stderr: ${lastStderr}\n` +
        `Last stdout: ${lastStdout}`
      );
    };

    return {
      process: proc,
      healthPort,
      stop,
      waitForReady,
      getOutput: () => ({ stdout, stderr }),
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
