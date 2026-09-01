// Path: zn-vault-agent/src/services/child-process-manager.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChildProcessManager } from './child-process-manager.js';
import type { ExecConfig } from '../lib/config.js';
import { RestartRequiredMutationQueue } from '../lib/coalescing-retry-queue.js';
import fs from 'node:fs';

const { mockSecretFileCleanup } = vi.hoisted(() => ({
  mockSecretFileCleanup: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock fs module
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readlinkSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

// Mock secret-env module
vi.mock('../lib/secret-env.js', () => ({
  parseSecretMappingFromConfig: vi.fn((config) => ({
    envVar: config.env,
    secretId: config.secret || '',
    literal: config.literal,
  })),
  buildSecretEnv: vi.fn(),
}));

vi.mock('../lib/secret-file-manager.js', () => ({
  getSecretFileManager: () => ({ cleanup: mockSecretFileCleanup }),
}));

// Mock logger
vi.mock('../lib/logger.js', () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import { spawn } from 'child_process';
import { buildSecretEnv } from '../lib/secret-env.js';
import { EventEmitter } from 'events';

const ORPHAN_KILL_TEST_TIMEOUT_MS = 5_001;

function linuxPidEvidence(
  pid: number,
  startTimeTicks = '424242',
  executablePath = '/usr/local/bin/node'
): string {
  return JSON.stringify({
    version: 1,
    ownerToken: '00000000-0000-4000-8000-000000000001',
    pid,
    configuredExecutable: 'node',
    capturedAt: '2026-09-01T00:00:00.000Z',
    identity: {
      kind: 'linux-procfs',
      startTimeTicks,
      executablePath,
    },
  });
}

function linuxReservationEvidence(
  managerPid: number,
  startTimeTicks = '424242',
  executablePath = '/usr/local/bin/node'
): string {
  return `${JSON.stringify({
    version: 1,
    ownerToken: '00000000-0000-4000-8000-000000000002',
    managerPid,
    capturedAt: '2026-09-01T00:00:00.000Z',
    identity: {
      kind: 'linux-procfs',
      startTimeTicks,
      executablePath,
    },
  })}\n`;
}

function linuxProcStat(pid: number, startTimeTicks = '424242'): string {
  const fieldsAfterCommand = [
    'S',
    ...Array.from({ length: 18 }, () => '0'),
    startTimeTicks,
  ];
  return `${pid} (node test child) ${fieldsAfterCommand.join(' ')}`;
}

let defaultReservationEvidence: string | null = null;
let defaultReservationClaimEvidence: string | null = null;

function isReservationPath(file: unknown): boolean {
  return String(file).endsWith('/child.owner');
}

function isReservationClaimPath(file: unknown): boolean {
  return String(file).endsWith('/child.owner.claim');
}

function defaultReservationExists(file: unknown): boolean {
  if (isReservationClaimPath(file)) return defaultReservationClaimEvidence !== null;
  if (isReservationPath(file)) return defaultReservationEvidence !== null;
  return false;
}

function reservationOrPidEvidenceExists(file: unknown): boolean {
  if (isReservationClaimPath(file) || isReservationPath(file)) {
    return defaultReservationExists(file);
  }
  return String(file).includes('child.pid');
}

function writeDefaultReservationEvidence(file: unknown, data: unknown): void {
  if (isReservationClaimPath(file)) {
    if (defaultReservationClaimEvidence !== null) {
      throw Object.assign(new Error('reservation claim exists'), { code: 'EEXIST' });
    }
    defaultReservationClaimEvidence = String(data);
    return;
  }
  if (isReservationPath(file)) {
    if (defaultReservationEvidence !== null) {
      throw Object.assign(new Error('reservation exists'), { code: 'EEXIST' });
    }
    defaultReservationEvidence = String(data);
  }
}

function unlinkDefaultReservationEvidence(file: unknown): void {
  if (isReservationClaimPath(file)) {
    defaultReservationClaimEvidence = null;
  } else if (isReservationPath(file)) {
    defaultReservationEvidence = null;
  }
}

function mockPidEvidenceRead(contents: string): void {
  vi.mocked(fs.readFileSync).mockImplementation((file) => {
    const filePath = String(file);
    const procMatch = /^\/proc\/(\d+)\/stat$/.exec(filePath);
    if (procMatch) return linuxProcStat(Number(procMatch[1]));
    if (isReservationClaimPath(filePath)) return defaultReservationClaimEvidence ?? '';
    if (isReservationPath(filePath)) return defaultReservationEvidence ?? '';
    return contents;
  });
}

interface LinuxIdentityReader {
  readLinuxProcessIdentity: (pid: number) => {
    kind: 'linux-procfs';
    startTimeTicks: string;
    executablePath: string;
  };
}

function spyOnLinuxIdentity(
  manager: ChildProcessManager,
  implementation: LinuxIdentityReader['readLinuxProcessIdentity']
) {
  return vi.spyOn(
    manager as unknown as LinuxIdentityReader,
    'readLinuxProcessIdentity'
  ).mockImplementation((pid) => {
    // Linux start() captures the manager reservation before inspecting an
    // orphan. Keep that self-read independent from orphan-specific sequences
    // so the same test exercises the intended signal boundary on every OS.
    if (pid === process.pid) {
      return {
        kind: 'linux-procfs',
        startTimeTicks: '101010',
        executablePath: process.execPath,
      };
    }
    return implementation(pid);
  });
}

// Helper to create a mock child process
function createMockChild(autoSpawn = true): EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  if (autoSpawn) {
    let spawnScheduled = false;
    child.on('newListener', (event) => {
      if (event === 'spawn' && !spawnScheduled) {
        spawnScheduled = true;
        void Promise.resolve().then(() => child.emit('spawn'));
      }
    });
  }
  return child;
}

describe('ChildProcessManager', () => {
  let mockChild: ReturnType<typeof createMockChild>;

  // Use Required to ensure all optional fields have values in tests
  const baseConfig: Required<ExecConfig> = {
    command: ['node', 'app.js'],
    secrets: [
      { env: 'DB_PASSWORD', secret: 'alias:db/prod.password' },
      { env: 'API_KEY', literal: 'test-key' },
    ],
    inheritEnv: true,
    restartOnChange: true,
    restartDelayMs: 100,
    maxRestarts: 3,
    restartWindowMs: 60000,
    envFile: '/tmp/secrets.env',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    defaultReservationEvidence = null;
    defaultReservationClaimEvidence = null;
    vi.mocked(fs.existsSync).mockImplementation(defaultReservationExists);
    mockPidEvidenceRead('');
    vi.mocked(fs.readlinkSync).mockReset();
    vi.mocked(fs.readlinkSync).mockReturnValue('/usr/local/bin/node');
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.writeFileSync).mockImplementation(writeDefaultReservationEvidence);
    vi.mocked(fs.renameSync).mockReset();
    vi.mocked(fs.unlinkSync).mockReset();
    vi.mocked(fs.unlinkSync).mockImplementation(unlinkDefaultReservationEvidence);
    vi.mocked(fs.mkdirSync).mockReset();

    // Increase max listeners to avoid warning during tests
    process.setMaxListeners(50);

    mockChild = createMockChild();
    vi.mocked(spawn).mockReturnValue(mockChild as any);
    vi.mocked(buildSecretEnv).mockResolvedValue({
      DB_PASSWORD: 'secret123',
      API_KEY: 'test-key',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    // Reset max listeners
    process.setMaxListeners(10);
  });

  describe('start', () => {
    it('should spawn child with correct env vars', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      expect(buildSecretEnv).toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledWith(
        'node',
        ['app.js'],
        expect.objectContaining({
          stdio: 'inherit',
        })
      );

      // Env should include secrets
      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const env = spawnCall[2]?.env as Record<string, string>;
      expect(env.DB_PASSWORD).toBe('secret123');
      expect(env.API_KEY).toBe('test-key');
    });

    it('should emit started event with pid', async () => {
      const manager = new ChildProcessManager(baseConfig);
      const startedHandler = vi.fn();
      manager.on('started', startedHandler);

      await manager.start();

      expect(startedHandler).toHaveBeenCalledWith(12345);
    });

    it('should set status to running after start', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      const state = manager.getState();
      expect(state.status).toBe('running');
      expect(state.pid).toBe(12345);
    });

    it('should not inherit env when inheritEnv is false', async () => {
      const config = { ...baseConfig, inheritEnv: false };
      const manager = new ChildProcessManager(config);
      await manager.start();

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      const env = spawnCall[2]?.env as Record<string, string>;
      // Should only have secrets, not process.env
      expect(env.DB_PASSWORD).toBe('secret123');
      expect(env.PATH).toBeUndefined();
    });

    it('should ignore duplicate start requests', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();
      await manager.start();

      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('does not spawn after stop closes admission during secret preparation', async () => {
      let releaseSecrets!: (env: Record<string, string>) => void;
      vi.mocked(buildSecretEnv).mockImplementationOnce(async () => new Promise(resolve => {
        releaseSecrets = resolve;
      }));
      const manager = new ChildProcessManager(baseConfig);

      const startPromise = manager.start();
      for (let attempt = 0; attempt < 20 && !releaseSecrets; attempt++) {
        await Promise.resolve();
      }
      expect(releaseSecrets).toBeTypeOf('function');

      const stopPromise = manager.stop();
      releaseSecrets({ DB_PASSWORD: 'secret123', API_KEY: 'test-key' });
      await expect(startPromise).resolves.toBeUndefined();
      await expect(stopPromise).resolves.toBeUndefined();

      expect(spawn).not.toHaveBeenCalled();
      expect(manager.getState().status).toBe('stopped');
    });

    it('terminates an admitted child when identity evidence cannot be persisted', async () => {
      vi.mocked(fs.writeFileSync).mockImplementation((file, data) => {
        writeDefaultReservationEvidence(file, data);
        if (String(file).endsWith('/child.pid')) {
          throw Object.assign(new Error('rival evidence already exists'), { code: 'EEXIST' });
        }
      });
      mockChild.kill.mockImplementation((signal: NodeJS.Signals) => {
        if (signal === 'SIGTERM') {
          void Promise.resolve().then(() => mockChild.emit('exit', 0, 'SIGTERM'));
        }
        return true;
      });
      const manager = new ChildProcessManager(baseConfig);
      const startedHandler = vi.fn();
      manager.on('started', startedHandler);

      await expect(manager.start()).rejects.toThrow(
        'Failed to persist child process identity evidence'
      );

      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(startedHandler).not.toHaveBeenCalled();
      expect(fs.renameSync).not.toHaveBeenCalled();
      expect(manager.getState()).toMatchObject({
        status: 'crashed',
        pid: null,
        restartCount: 0,
      });
      await vi.advanceTimersByTimeAsync(baseConfig.restartDelayMs + 10);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('retains bounded crash recovery when the child vanishes before identity persistence', async () => {
      let pidWriteAttempts = 0;
      vi.mocked(fs.writeFileSync).mockImplementation((file, data) => {
        writeDefaultReservationEvidence(file, data);
        if (String(file).endsWith('/child.pid') && pidWriteAttempts++ === 0) {
          throw Object.assign(new Error('process identity disappeared'), { code: 'ENOENT' });
        }
      });
      mockChild.kill.mockImplementation(() => {
        void Promise.resolve().then(() => {
          mockChild.exitCode = 1;
          mockChild.emit('exit', 1, null);
        });
        return true;
      });
      const manager = new ChildProcessManager(baseConfig);

      await expect(manager.start()).rejects.toThrow(
        'Failed to persist child process identity evidence'
      );
      expect(manager.getState()).toMatchObject({
        status: 'crashed',
        pid: null,
        restartCount: 1,
        lastExitCode: 1,
      });

      const recoveredChild = createMockChild();
      recoveredChild.pid = 23456;
      vi.mocked(spawn).mockReturnValue(
        recoveredChild as unknown as ReturnType<typeof spawn>
      );
      await vi.advanceTimersByTimeAsync(baseConfig.restartDelayMs + 10);

      expect(spawn).toHaveBeenCalledTimes(2);
      expect(manager.getState()).toMatchObject({
        status: 'running',
        pid: 23456,
        restartCount: 1,
      });
    });

    it('stops retrying vanished pre-evidence children after the configured maximum', async () => {
      vi.mocked(fs.writeFileSync).mockImplementation((file, data) => {
        writeDefaultReservationEvidence(file, data);
        if (String(file).endsWith('/child.pid')) {
          throw Object.assign(new Error('process identity disappeared'), { code: 'ENOENT' });
        }
      });
      let nextPid = 30000;
      vi.mocked(spawn).mockImplementation(() => {
        const child = createMockChild();
        child.pid = nextPid++;
        child.kill.mockImplementation(() => {
          void Promise.resolve().then(() => {
            child.exitCode = 1;
            child.emit('exit', 1, null);
          });
          return true;
        });
        return child as unknown as ReturnType<typeof spawn>;
      });
      const manager = new ChildProcessManager({
        ...baseConfig,
        restartDelayMs: 10,
        maxRestarts: 2,
      });
      const maxRestartsHandler = vi.fn();
      manager.on('maxRestartsExceeded', maxRestartsHandler);

      await expect(manager.start()).rejects.toThrow(
        'Failed to persist child process identity evidence'
      );
      await vi.advanceTimersByTimeAsync(11);
      await vi.advanceTimersByTimeAsync(11);

      expect(spawn).toHaveBeenCalledTimes(3);
      expect(manager.getState()).toMatchObject({
        status: 'max_restarts_exceeded',
        pid: null,
        restartCount: 3,
        lastExitCode: 1,
      });
      expect(maxRestartsHandler).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(spawn).toHaveBeenCalledTimes(3);
    });

    it('reserves ownership before secret fetch so two managers cannot both spawn', async () => {
      let reservationEvidence: string | null = null;
      let reservationClaimEvidence: string | null = null;
      let releaseSecrets!: (env: Record<string, string>) => void;

      vi.mocked(fs.existsSync).mockImplementation((file) => {
        if (String(file).endsWith('/child.owner.claim')) {
          return reservationClaimEvidence !== null;
        }
        if (String(file).endsWith('/child.owner')) return reservationEvidence !== null;
        return false;
      });
      vi.mocked(fs.writeFileSync).mockImplementation((file, data) => {
        if (String(file).endsWith('/child.owner.claim')) {
          if (reservationClaimEvidence !== null) {
            throw Object.assign(new Error('reservation claim exists'), { code: 'EEXIST' });
          }
          reservationClaimEvidence = String(data);
          return;
        }
        if (!String(file).endsWith('/child.owner')) return;
        if (reservationEvidence !== null) {
          throw Object.assign(new Error('reservation exists'), { code: 'EEXIST' });
        }
        reservationEvidence = String(data);
      });
      vi.mocked(fs.readFileSync).mockImplementation((file) => {
        const filePath = String(file);
        const procMatch = /^\/proc\/(\d+)\/stat$/.exec(filePath);
        if (procMatch) return linuxProcStat(Number(procMatch[1]));
        if (filePath.endsWith('/child.owner.claim') && reservationClaimEvidence !== null) {
          return reservationClaimEvidence;
        }
        if (filePath.endsWith('/child.owner') && reservationEvidence !== null) {
          return reservationEvidence;
        }
        return '';
      });
      vi.mocked(fs.unlinkSync).mockImplementation((file) => {
        if (String(file).endsWith('/child.owner.claim')) {
          reservationClaimEvidence = null;
        } else if (String(file).endsWith('/child.owner')) {
          reservationEvidence = null;
        }
      });
      vi.mocked(buildSecretEnv).mockImplementationOnce(async () => new Promise(resolve => {
        releaseSecrets = resolve;
      }));

      const firstManager = new ChildProcessManager(baseConfig);
      const firstStart = firstManager.start();
      for (let attempt = 0; attempt < 20 && !releaseSecrets; attempt++) {
        await Promise.resolve();
      }
      expect(releaseSecrets).toBeTypeOf('function');
      expect(reservationEvidence).not.toBeNull();
      expect(spawn).not.toHaveBeenCalled();

      const secondManager = new ChildProcessManager(baseConfig);
      await expect(secondManager.start()).rejects.toThrow(
        `Child process ownership is already reserved by manager ${process.pid}`
      );
      expect(spawn).not.toHaveBeenCalled();

      releaseSecrets({ DB_PASSWORD: 'secret123', API_KEY: 'test-key' });
      await firstStart;
      expect(spawn).toHaveBeenCalledTimes(1);

      const stopPromise = firstManager.stop();
      mockChild.emit('exit', 0, null);
      await stopPromise;
    });

    it('does not let a late contender claim revoke the exact live owner', async () => {
      let releaseSecrets!: (env: Record<string, string>) => void;
      vi.mocked(buildSecretEnv).mockImplementationOnce(async () => new Promise(resolve => {
        releaseSecrets = resolve;
      }));

      const manager = new ChildProcessManager(baseConfig);
      const startPromise = manager.start();
      for (let attempt = 0; attempt < 20 && !releaseSecrets; attempt++) {
        await Promise.resolve();
      }
      expect(releaseSecrets).toBeTypeOf('function');
      expect(defaultReservationEvidence).not.toBeNull();

      // Model the interval after another compliant manager acquires its
      // transition claim but before it observes and rejects this live owner.
      defaultReservationClaimEvidence = linuxReservationEvidence(88888);
      releaseSecrets({ DB_PASSWORD: 'secret123', API_KEY: 'test-key' });

      await expect(startPromise).resolves.toBeUndefined();
      expect(spawn).toHaveBeenCalledTimes(1);

      defaultReservationClaimEvidence = null;
      const stopPromise = manager.stop();
      mockChild.emit('exit', 0, null);
      await stopPromise;
    });

    it('reclaims a dead manager reservation before orphan cleanup and spawn', async () => {
      const staleManagerPid = 99999;
      let reservationEvidence: string | null = linuxReservationEvidence(staleManagerPid);
      let reservationClaimEvidence: string | null = null;

      vi.mocked(fs.existsSync).mockImplementation((file) => {
        if (String(file).endsWith('/child.owner.claim')) {
          return reservationClaimEvidence !== null;
        }
        if (String(file).endsWith('/child.owner')) return reservationEvidence !== null;
        return false;
      });
      vi.mocked(fs.writeFileSync).mockImplementation((file, data) => {
        if (String(file).endsWith('/child.owner.claim')) {
          if (reservationClaimEvidence !== null) {
            throw Object.assign(new Error('reservation claim exists'), { code: 'EEXIST' });
          }
          reservationClaimEvidence = String(data);
          return;
        }
        if (!String(file).endsWith('/child.owner')) return;
        if (reservationEvidence !== null) {
          throw Object.assign(new Error('reservation exists'), { code: 'EEXIST' });
        }
        reservationEvidence = String(data);
      });
      vi.mocked(fs.readFileSync).mockImplementation((file) => {
        const filePath = String(file);
        const procMatch = /^\/proc\/(\d+)\/stat$/.exec(filePath);
        if (procMatch) return linuxProcStat(Number(procMatch[1]));
        if (filePath.endsWith('/child.owner.claim') && reservationClaimEvidence !== null) {
          return reservationClaimEvidence;
        }
        if (filePath.endsWith('/child.owner') && reservationEvidence !== null) {
          return reservationEvidence;
        }
        return '';
      });
      vi.mocked(fs.unlinkSync).mockImplementation((file) => {
        if (String(file).endsWith('/child.owner.claim')) {
          reservationClaimEvidence = null;
        } else if (String(file).endsWith('/child.owner')) {
          reservationEvidence = null;
        }
      });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
        if (pid === staleManagerPid) {
          throw Object.assign(new Error('manager exited'), { code: 'ESRCH' });
        }
        return true;
      });

      const manager = new ChildProcessManager(baseConfig);
      try {
        await manager.start();
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(reservationEvidence).toContain(`"managerPid":${process.pid}`);

        const stopPromise = manager.stop();
        mockChild.emit('exit', 0, null);
        await stopPromise;
      } finally {
        killSpy.mockRestore();
      }
    });

    it('fails closed on an abandoned transition claim without deleting it', async () => {
      const abandonedClaim = linuxReservationEvidence(99999);
      defaultReservationClaimEvidence = abandonedClaim;

      const manager = new ChildProcessManager(baseConfig);
      await expect(manager.start()).rejects.toThrow(
        'Child process reservation recovery is already claimed; refusing to spawn'
      );

      expect(defaultReservationClaimEvidence).toBe(abandonedClaim);
      expect(fs.unlinkSync).not.toHaveBeenCalledWith(
        expect.stringContaining('/child.owner.claim')
      );
      expect(buildSecretEnv).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('revalidates exact reservation ownership immediately before secret retrieval', async () => {
      const rivalEvidence = linuxReservationEvidence(88888);
      let ownerReads = 0;
      vi.mocked(fs.readFileSync).mockImplementation((file) => {
        const filePath = String(file);
        const procMatch = /^\/proc\/(\d+)\/stat$/.exec(filePath);
        if (procMatch) return linuxProcStat(Number(procMatch[1]));
        if (isReservationClaimPath(filePath)) {
          return defaultReservationClaimEvidence ?? '';
        }
        if (isReservationPath(filePath)) {
          ownerReads++;
          if (ownerReads >= 3) return rivalEvidence;
          return defaultReservationEvidence ?? '';
        }
        return '';
      });

      const manager = new ChildProcessManager(baseConfig);
      await expect(manager.start()).rejects.toThrow(
        'Child process reservation ownership changed before secret retrieval'
      );

      expect(buildSecretEnv).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('revalidates exact reservation ownership immediately before child spawn', async () => {
      let releaseSecrets!: (env: Record<string, string>) => void;
      vi.mocked(buildSecretEnv).mockImplementationOnce(async () => new Promise(resolve => {
        releaseSecrets = resolve;
      }));
      const manager = new ChildProcessManager(baseConfig);

      const startPromise = manager.start();
      for (let attempt = 0; attempt < 20 && !releaseSecrets; attempt++) {
        await Promise.resolve();
      }
      expect(releaseSecrets).toBeTypeOf('function');
      defaultReservationEvidence = linuxReservationEvidence(88888);
      releaseSecrets({ DB_PASSWORD: 'secret123', API_KEY: 'test-key' });

      await expect(startPromise).rejects.toThrow(
        'Child process reservation ownership changed before child spawn'
      );
      expect(buildSecretEnv).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should send SIGTERM to child', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      const stopPromise = manager.stop();

      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

      // Simulate child exit
      mockChild.emit('exit', 0, null);
      await stopPromise;

      expect(manager.getState().status).toBe('stopped');
    });

    it('should send SIGKILL if child does not exit', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      const stopPromise = manager.stop();

      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

      // Advance past SIGKILL timeout (10 seconds)
      await vi.advanceTimersByTimeAsync(11000);

      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

      // Clean up
      mockChild.emit('exit', null, 'SIGKILL');
      await stopPromise;
    });

    it('keeps child, PID and secret files when exit cannot be confirmed', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();
      const writtenEvidence = String(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1]);
      (manager as unknown as { useFileMode: boolean }).useFileMode = true;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockPidEvidenceRead(writtenEvidence);
      vi.mocked(fs.unlinkSync).mockClear();
      mockSecretFileCleanup.mockClear();

      const stopPromise = manager.stop();
      const rejection = expect(stopPromise).rejects.toThrow(
        'did not confirm exit after SIGKILL'
      );
      await vi.advanceTimersByTimeAsync(15_001);
      await rejection;

      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
      expect(manager.getState()).toMatchObject({
        status: 'crashed',
        pid: 12345,
      });
      expect(manager.isHealthy()).toBe(false);
      expect(fs.unlinkSync).not.toHaveBeenCalledWith(
        expect.stringContaining('/child.pid')
      );
      expect(mockSecretFileCleanup).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('cleans PID and secret files only after confirmed child exit', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();
      const writtenEvidence = String(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1]);
      (manager as unknown as { useFileMode: boolean }).useFileMode = true;
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockPidEvidenceRead(writtenEvidence);
      vi.mocked(fs.unlinkSync).mockClear();
      mockSecretFileCleanup.mockClear();

      const stopPromise = manager.stop();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
      expect(mockSecretFileCleanup).not.toHaveBeenCalled();

      mockChild.emit('exit', 0, null);
      await stopPromise;
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('/run/zn-vault-agent/child.pid')
      );
      expect(mockSecretFileCleanup).toHaveBeenCalledTimes(1);
    });

    it('should resolve immediately if no child running', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.stop();

      expect(manager.getState().status).toBe('stopped');
    });
  });

  describe('restart', () => {
    it('should stop and start child with reason', async () => {
      const manager = new ChildProcessManager(baseConfig);
      const restartingHandler = vi.fn();
      manager.on('restarting', restartingHandler);

      await manager.start();

      // Create new mock for restart
      const newChild = createMockChild();
      newChild.pid = 54321;

      const restartPromise = manager.restart('certificate rotated');

      // First child exits
      mockChild.emit('exit', 0, null);

      // New child spawns
      vi.mocked(spawn).mockReturnValue(newChild as any);
      await restartPromise;

      expect(restartingHandler).toHaveBeenCalledWith('certificate rotated');
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('should not restart when restartOnChange is false', async () => {
      const config = { ...baseConfig, restartOnChange: false };
      const manager = new ChildProcessManager(config);

      await manager.start();
      await manager.restart('test');

      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('serializes concurrent certificate, secret, exec and key restarts globally', async () => {
      const manager = new ChildProcessManager(baseConfig);
      const reasons: string[] = [];
      manager.on('restarting', reason => reasons.push(reason));
      await manager.start();

      const requests = [
        manager.restart('certificate rotated'),
        manager.restart('secret file updated'),
        manager.restart('exec secret updated'),
        manager.restart('managed API key rotated'),
      ];
      const children = Array.from({ length: 4 }, (_, index) => {
        const child = createMockChild();
        child.pid = 20000 + index;
        return child;
      });

      const flushUntil = async (condition: () => boolean): Promise<void> => {
        for (let attempt = 0; attempt < 50 && !condition(); attempt++) {
          await Promise.resolve();
        }
        expect(condition()).toBe(true);
      };

      for (let index = 0; index < children.length; index++) {
        const child = children[index];
        await flushUntil(() => mockChild.kill.mock.calls.some(
          ([signal]) => signal === 'SIGTERM'
        ));
        vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
        mockChild.emit('exit', 0, null);
        await flushUntil(() => vi.mocked(spawn).mock.calls.length === index + 2);
        mockChild = child;
      }

      await Promise.all(requests);

      expect(reasons).toEqual([
        'certificate rotated',
        'secret file updated',
        'exec secret updated',
        'managed API key rotated',
      ]);
      expect(spawn).toHaveBeenCalledTimes(5);
      expect(manager.getState().status).toBe('running');
      expect(manager.getState().restartCount).toBe(0);

      await vi.advanceTimersByTimeAsync(baseConfig.restartDelayMs + 10);
      expect(spawn).toHaveBeenCalledTimes(5);
    });

    it('cancels crash recovery when a mutation restart takes ownership', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      mockChild.emit('exit', 1, null);
      expect(manager.getState().status).toBe('crashed');

      const replacement = createMockChild();
      vi.mocked(spawn).mockReturnValue(replacement as unknown as ReturnType<typeof spawn>);
      await manager.restart('secret file updated');

      await vi.advanceTimersByTimeAsync(baseConfig.restartDelayMs + 10);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(manager.getState().status).toBe('running');
    });

    it('continues the global restart chain after a replacement start fails', async () => {
      const manager = new ChildProcessManager(baseConfig);
      manager.on('error', vi.fn());
      await manager.start();

      vi.mocked(buildSecretEnv).mockRejectedValueOnce(new Error('replacement failed'));
      const failedRestart = manager.restart('certificate rotated');
      mockChild.emit('exit', 0, null);
      await expect(failedRestart).rejects.toThrow('replacement failed');

      const recoveredChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(recoveredChild as unknown as ReturnType<typeof spawn>);
      vi.mocked(buildSecretEnv).mockResolvedValue({
        DB_PASSWORD: 'secret123',
        API_KEY: 'test-key',
      });

      await expect(manager.restart('secret file updated')).resolves.toBeUndefined();
      expect(manager.getState().status).toBe('running');
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('keeps real mutation wiring pending until a replacement emits spawn', async () => {
      const manager = new ChildProcessManager(baseConfig);
      manager.on('error', vi.fn());
      await manager.start();

      const prepare = vi.fn().mockResolvedValue({
        decision: 'resolved',
        evidence: { version: 21 },
      });
      const queue = new RestartRequiredMutationQueue<string, { version: number }>({
        prepare,
        restart: async () => manager.restart('exec secret updated'),
        retryDelayMs: 60_000,
      });
      queue.enqueue('exec-secret', 21, 'v21');

      const failedReplacement = createMockChild(false);
      vi.mocked(spawn).mockReturnValue(failedReplacement as unknown as ReturnType<typeof spawn>);
      const failedAttempt = queue.retryNow('exec-secret');
      mockChild.emit('exit', 0, null);
      for (let attempt = 0; attempt < 20 && vi.mocked(spawn).mock.calls.length < 2; attempt++) {
        await Promise.resolve();
      }
      expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);

      failedReplacement.emit('error', new Error('replacement did not spawn'));
      await expect(failedAttempt).resolves.toBe(false);
      expect(queue.isPending('exec-secret')).toBe(true);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(manager.getState().status).toBe('crashed');

      const recoveredChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(recoveredChild as unknown as ReturnType<typeof spawn>);
      await expect(queue.retryNow('exec-secret')).resolves.toBe(true);

      expect(queue.isPending('exec-secret')).toBe(false);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(manager.getState().status).toBe('running');
      expect(spawn).toHaveBeenCalledTimes(3);
    });
  });

  describe('crash recovery', () => {
    it('fails closed and recovers when a running child emits an asynchronous error', async () => {
      const manager = new ChildProcessManager(baseConfig);
      const errorHandler = vi.fn();
      manager.on('error', errorHandler);
      await manager.start();

      const childError = new Error('spawn transport failed');
      mockChild.emit('error', childError);

      expect(errorHandler).toHaveBeenCalledWith(childError);
      expect(manager.getState().status).toBe('crashed');
      expect(manager.getState().pid).toBe(12345);
      expect(manager.isDegraded()).toBe(true);

      const recoveredChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(recoveredChild as unknown as ReturnType<typeof spawn>);
      await vi.advanceTimersByTimeAsync(baseConfig.restartDelayMs + 10);

      // `error` is not proof that the spawned OS process died.
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(manager.getState().status).toBe('crashed');
      expect(manager.getState().pid).toBe(12345);

      mockChild.exitCode = 1;
      mockChild.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(baseConfig.restartDelayMs + 10);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(manager.getState().status).toBe('running');
    });

    it('should auto-restart on crash with delay', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      // Simulate crash
      mockChild.exitCode = 1;
      mockChild.emit('exit', 1, null);

      expect(manager.getState().status).toBe('crashed');
      expect(manager.getState().lastExitCode).toBe(1);

      // Advance past restart delay
      vi.mocked(spawn).mockReturnValue(createMockChild() as any);
      await vi.advanceTimersByTimeAsync(baseConfig.restartDelayMs + 10);

      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('should enter degraded state after max restarts', async () => {
      const manager = new ChildProcessManager(baseConfig);
      const maxRestartsHandler = vi.fn();
      manager.on('maxRestartsExceeded', maxRestartsHandler);

      await manager.start();

      // Simulate crashes - each crash triggers restart timer
      // maxRestarts is 3, so we need 4 crashes to exceed it
      for (let i = 0; i <= baseConfig.maxRestarts; i++) {
        // Current child crashes
        mockChild.exitCode = 1;
        mockChild.emit('exit', 1, null);

        if (i < baseConfig.maxRestarts) {
          // Set up new mock before restart timer fires
          mockChild = createMockChild();
          vi.mocked(spawn).mockReturnValue(mockChild as any);

          // Advance past restart delay to trigger auto-restart
          await vi.advanceTimersByTimeAsync(baseConfig.restartDelayMs + 10);
        }
      }

      expect(manager.getState().status).toBe('max_restarts_exceeded');
      expect(maxRestartsHandler).toHaveBeenCalled();
    });

    it('should reset restart count after window expires', async () => {
      const config = { ...baseConfig, restartWindowMs: 1000 };
      const manager = new ChildProcessManager(config);

      await manager.start();

      // First crash
      mockChild.exitCode = 1;
      mockChild.emit('exit', 1, null);

      const recoveredChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(recoveredChild as any);

      // Crash recovery starts after 100ms; advance beyond the accounting
      // window while leaving the recovered child running.
      await vi.advanceTimersByTimeAsync(1500);
      expect(manager.getState().status).toBe('running');

      recoveredChild.exitCode = 1;
      recoveredChild.emit('exit', 1, null);

      // The second crash is outside the window, so it starts a fresh count.
      expect(manager.getState().restartCount).toBe(1);
      expect(manager.getState().status).toBe('crashed');
    });

    it('does not let crash recovery spawn after shutdown begins', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      let releaseSecrets!: (env: Record<string, string>) => void;
      vi.mocked(buildSecretEnv).mockImplementationOnce(async () => new Promise(resolve => {
        releaseSecrets = resolve;
      }));
      mockChild.emit('exit', 1, null);

      vi.advanceTimersByTime(baseConfig.restartDelayMs + 1);
      for (let attempt = 0; attempt < 20 && !releaseSecrets; attempt++) {
        await Promise.resolve();
      }
      expect(releaseSecrets).toBeTypeOf('function');

      const stopPromise = manager.stop();
      releaseSecrets({ DB_PASSWORD: 'secret123', API_KEY: 'test-key' });
      await expect(stopPromise).resolves.toBeUndefined();

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(manager.getState().status).toBe('stopped');
    });
  });

  describe('signal forwarding', () => {
    it('should forward SIGTERM to child', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      // Simulate SIGTERM to parent process
      process.emit('SIGTERM' as any);

      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

      // Clean up - start stop and then emit exit to resolve promise
      const stopPromise = manager.stop();
      mockChild.emit('exit', 0, null);
      await stopPromise;
    });

    it('should forward SIGINT to child', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      process.emit('SIGINT' as any);

      expect(mockChild.kill).toHaveBeenCalledWith('SIGINT');

      // Clean up
      const stopPromise = manager.stop();
      mockChild.emit('exit', 0, null);
      await stopPromise;
    });

    it('does not forward daemon-owned termination signals but still forwards SIGHUP', async () => {
      const manager = new ChildProcessManager(baseConfig, {
        forwardTerminationSignals: false,
      });
      await manager.start();
      mockChild.kill.mockClear();

      process.emit('SIGTERM' as NodeJS.Signals);
      process.emit('SIGINT' as NodeJS.Signals);
      expect(mockChild.kill).not.toHaveBeenCalled();

      process.emit('SIGHUP' as NodeJS.Signals);
      expect(mockChild.kill).toHaveBeenCalledTimes(1);
      expect(mockChild.kill).toHaveBeenCalledWith('SIGHUP');

      const stopPromise = manager.stop();
      mockChild.emit('exit', 0, null);
      await stopPromise;
    });
  });

  describe('getState', () => {
    it('should return correct initial state', () => {
      const manager = new ChildProcessManager(baseConfig);
      const state = manager.getState();

      expect(state.status).toBe('stopped');
      expect(state.pid).toBeNull();
      expect(state.restartCount).toBe(0);
      expect(state.lastExitCode).toBeNull();
    });

    it('should return correct state after start', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      const state = manager.getState();
      expect(state.status).toBe('running');
      expect(state.pid).toBe(12345);
      expect(state.lastStartTime).toBeTruthy();
    });

    it('should return correct state after exit', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      // Stop to prevent auto-restart
      const stopPromise = manager.stop();
      mockChild.emit('exit', 42, null);
      await stopPromise;

      const state = manager.getState();
      expect(state.status).toBe('stopped');
      expect(state.lastExitCode).toBe(42);
      expect(state.lastExitTime).toBeTruthy();
    });
  });

  describe('health checks', () => {
    it('isHealthy returns true when running', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      expect(manager.isHealthy()).toBe(true);
      expect(manager.isDegraded()).toBe(false);
    });

    it('isDegraded returns true when max restarts exceeded', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      // Exceed max restarts
      for (let i = 0; i <= baseConfig.maxRestarts; i++) {
        // Current child crashes
        mockChild.exitCode = 1;
        mockChild.emit('exit', 1, null);

        if (i < baseConfig.maxRestarts) {
          mockChild = createMockChild();
          vi.mocked(spawn).mockReturnValue(mockChild as any);
          await vi.advanceTimersByTimeAsync(baseConfig.restartDelayMs + 10);
        }
      }

      expect(manager.isHealthy()).toBe(false);
      expect(manager.isDegraded()).toBe(true);
    });

    it('isDegraded returns true when restarting', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      // Start restart (don't await)
      const restartPromise = manager.restart('test');

      // Before child exits, should be restarting
      expect(manager.isDegraded()).toBe(true);

      // Clean up
      mockChild.emit('exit', 0, null);
      vi.mocked(spawn).mockReturnValue(createMockChild() as any);
      await restartPromise;
    });
  });

  describe('resetRestartCount', () => {
    it('should reset counter and exit degraded state', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      // Exceed max restarts
      for (let i = 0; i <= baseConfig.maxRestarts; i++) {
        // Current child crashes
        mockChild.exitCode = 1;
        mockChild.emit('exit', 1, null);

        if (i < baseConfig.maxRestarts) {
          mockChild = createMockChild();
          vi.mocked(spawn).mockReturnValue(mockChild as any);
          await vi.advanceTimersByTimeAsync(baseConfig.restartDelayMs + 10);
        }
      }

      expect(manager.getState().status).toBe('max_restarts_exceeded');

      manager.resetRestartCount();

      expect(manager.getState().status).toBe('stopped');
      expect(manager.getState().restartCount).toBe(0);
    });
  });

  describe('orphan process handling', () => {
    it('writes exclusive, private child identity evidence without replacing a rival', async () => {
      const manager = new ChildProcessManager(baseConfig);
      await manager.start();

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls.at(-1);
      expect(writeCall).toBeDefined();
      const evidence = JSON.parse(String(writeCall?.[1])) as Record<string, unknown>;
      expect(evidence).toMatchObject({
        version: 1,
        ownerToken: expect.stringMatching(/^[0-9a-f-]{36}$/i),
        pid: 12345,
        configuredExecutable: 'node',
      });
      expect(evidence.identity).toMatchObject(process.platform === 'linux'
        ? {
            kind: 'linux-procfs',
            startTimeTicks: '424242',
            executablePath: '/usr/local/bin/node',
          }
        : {
            kind: 'unsupported-platform',
            platform: process.platform,
          });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('/run/zn-vault-agent/child.pid'),
        expect.any(String),
        expect.objectContaining({ mode: 0o600, flag: 'wx', flush: true })
      );
      expect(fs.renameSync).not.toHaveBeenCalled();
    });

    it('reads Linux start ticks and executable identity from procfs', () => {
      const pid = 43210;
      const fieldsAfterCommand = [
        'S',
        ...Array.from({ length: 18 }, () => '0'),
        '987654321',
      ];
      vi.mocked(fs.readFileSync).mockReturnValue(
        `${pid} (node ) worker) ${fieldsAfterCommand.join(' ')}`
      );
      vi.mocked(fs.readlinkSync).mockReturnValue('/opt/node/bin/node');
      const manager = new ChildProcessManager(baseConfig);

      expect(
        (manager as unknown as LinuxIdentityReader).readLinuxProcessIdentity(pid)
      ).toEqual({
        kind: 'linux-procfs',
        startTimeTicks: '987654321',
        executablePath: '/opt/node/bin/node',
      });
    });

    it('should remove PID file on stop', async () => {
      let pidEvidenceWritten = false;
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (isReservationClaimPath(path) || isReservationPath(path)) {
          return defaultReservationExists(path);
        }
        if (String(path).endsWith('/child.pid')) return pidEvidenceWritten;
        return false;
      });
      vi.mocked(fs.writeFileSync).mockImplementation((file, data) => {
        writeDefaultReservationEvidence(file, data);
        if (String(file).endsWith('/child.pid')) pidEvidenceWritten = true;
      });
      vi.mocked(fs.unlinkSync).mockImplementation((file) => {
        unlinkDefaultReservationEvidence(file);
        if (String(file).endsWith('/child.pid')) pidEvidenceWritten = false;
      });

      const manager = new ChildProcessManager(baseConfig);
      await manager.start();
      const writtenEvidence = String(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1]);
      mockPidEvidenceRead(writtenEvidence);

      const stopPromise = manager.stop();
      mockChild.emit('exit', 0, null);
      await stopPromise;

      expect(fs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('/run/zn-vault-agent/child.pid')
      );
    });

    it('kills an orphan only when the durable Linux identity still matches', async () => {
      const orphanPid = 99999;

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (isReservationClaimPath(path) || isReservationPath(path)) {
          return defaultReservationExists(path);
        }
        if (String(path).includes('child.pid')) return true;
        return false;
      });
      mockPidEvidenceRead(linuxPidEvidence(orphanPid));

      // Track kill calls
      const killCalls: Array<{ pid: number; signal: string | number }> = [];
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
        killCalls.push({ pid, signal: signal ?? 0 });
        if (signal === 0) {
          // Process exists check - on first check return true, then throw (process exited)
          if (killCalls.filter(k => k.signal === 0).length === 1) {
            return true;
          }
          throw Object.assign(new Error('process not found'), { code: 'ESRCH' });
        }
        return true;
      });

      const manager = new ChildProcessManager(baseConfig);
      const identitySpy = spyOnLinuxIdentity(manager, () => ({
        kind: 'linux-procfs',
        startTimeTicks: '424242',
        executablePath: '/usr/local/bin/node',
      }));

      try {
        await manager.start();

        expect(killCalls).toContainEqual({ pid: orphanPid, signal: 'SIGTERM' });
        expect(identitySpy).toHaveBeenCalledWith(orphanPid);
      } finally {
        identitySpy.mockRestore();
        killSpy.mockRestore();
      }
    });

    it('blocks PID reuse without sending any termination signal', async () => {
      const orphanPid = 99999;
      vi.mocked(fs.existsSync).mockImplementation(reservationOrPidEvidenceExists);
      mockPidEvidenceRead(
        linuxPidEvidence(orphanPid, '111111', '/usr/local/bin/node')
      );
      vi.mocked(fs.unlinkSync).mockClear();
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
      const manager = new ChildProcessManager(baseConfig);
      const identitySpy = spyOnLinuxIdentity(manager, () => ({
        kind: 'linux-procfs',
        startTimeTicks: '222222',
        executablePath: '/usr/local/bin/node',
      }));

      try {
        await expect(manager.start()).rejects.toThrow(
          `Orphaned child process ${orphanPid} identity mismatch; refusing SIGTERM`
        );

        expect(killSpy).toHaveBeenCalledWith(orphanPid, 0);
        expect(killSpy).not.toHaveBeenCalledWith(orphanPid, 'SIGTERM');
        expect(killSpy).not.toHaveBeenCalledWith(orphanPid, 'SIGKILL');
        expect(fs.unlinkSync).not.toHaveBeenCalledWith(
          expect.stringContaining('/child.pid')
        );
        expect(spawn).not.toHaveBeenCalled();
        expect(manager.getState().status).toBe('crashed');
      } finally {
        identitySpy.mockRestore();
        killSpy.mockRestore();
      }
    });

    it('revalidates identity before SIGKILL and preserves evidence on mismatch', async () => {
      const orphanPid = 99999;
      vi.mocked(fs.existsSync).mockImplementation(reservationOrPidEvidenceExists);
      mockPidEvidenceRead(linuxPidEvidence(orphanPid));
      vi.mocked(fs.unlinkSync).mockClear();
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
      const manager = new ChildProcessManager(baseConfig);
      const identitySpy = spyOnLinuxIdentity(manager, vi.fn()
        .mockReturnValueOnce({
          kind: 'linux-procfs',
          startTimeTicks: '424242',
          executablePath: '/usr/local/bin/node',
        })
        .mockReturnValueOnce({
          kind: 'linux-procfs',
          startTimeTicks: '999999',
          executablePath: '/usr/local/bin/node',
        }));

      try {
        const startPromise = manager.start();
        const rejection = expect(startPromise).rejects.toThrow(
          `Orphaned child process ${orphanPid} identity mismatch; refusing SIGKILL`
        );
        await vi.advanceTimersByTimeAsync(ORPHAN_KILL_TEST_TIMEOUT_MS);
        await rejection;

        expect(killSpy).toHaveBeenCalledWith(orphanPid, 'SIGTERM');
        expect(killSpy).not.toHaveBeenCalledWith(orphanPid, 'SIGKILL');
        expect(fs.unlinkSync).not.toHaveBeenCalledWith(
          expect.stringContaining('/child.pid')
        );
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        identitySpy.mockRestore();
        killSpy.mockRestore();
      }
    });

    it('fails closed on ambiguous identity reads without signaling the PID', async () => {
      const orphanPid = 99999;
      vi.mocked(fs.existsSync).mockImplementation(reservationOrPidEvidenceExists);
      mockPidEvidenceRead(linuxPidEvidence(orphanPid));
      vi.mocked(fs.unlinkSync).mockClear();
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
      const manager = new ChildProcessManager(baseConfig);
      const identitySpy = spyOnLinuxIdentity(manager, () => {
        throw Object.assign(new Error('procfs denied'), { code: 'EACCES' });
      });

      try {
        await expect(manager.start()).rejects.toThrow(
          `Unable to verify identity of orphaned child process ${orphanPid}; refusing SIGTERM`
        );

        expect(killSpy).not.toHaveBeenCalledWith(orphanPid, 'SIGTERM');
        expect(killSpy).not.toHaveBeenCalledWith(orphanPid, 'SIGKILL');
        expect(fs.unlinkSync).not.toHaveBeenCalledWith(
          expect.stringContaining('/child.pid')
        );
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        identitySpy.mockRestore();
        killSpy.mockRestore();
      }
    });

    it('fails closed on a live legacy PID-only file without signaling the PID', async () => {
      const orphanPid = 99999;
      vi.mocked(fs.existsSync).mockImplementation(reservationOrPidEvidenceExists);
      mockPidEvidenceRead(String(orphanPid));
      vi.mocked(fs.unlinkSync).mockClear();
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
      const manager = new ChildProcessManager(baseConfig);

      try {
        await expect(manager.start()).rejects.toThrow(
          `Cannot verify identity of orphaned child process ${orphanPid}; refusing SIGTERM`
        );

        expect(killSpy).not.toHaveBeenCalledWith(orphanPid, 'SIGTERM');
        expect(killSpy).not.toHaveBeenCalledWith(orphanPid, 'SIGKILL');
        expect(fs.unlinkSync).not.toHaveBeenCalledWith(
          expect.stringContaining('/child.pid')
        );
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('preserves non-owned live evidence across stop and blocks the next manager', async () => {
      const orphanPid = 99999;
      const persistedEvidence = linuxPidEvidence(
        orphanPid,
        '111111',
        '/usr/local/bin/node'
      );
      vi.mocked(fs.existsSync).mockImplementation(reservationOrPidEvidenceExists);
      mockPidEvidenceRead(persistedEvidence);
      vi.mocked(fs.unlinkSync).mockClear();
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

      const firstManager = new ChildProcessManager(baseConfig);
      const firstIdentitySpy = spyOnLinuxIdentity(firstManager, () => ({
        kind: 'linux-procfs',
        startTimeTicks: '222222',
        executablePath: '/usr/local/bin/node',
      }));

      try {
        await expect(firstManager.start()).rejects.toThrow(
          `Orphaned child process ${orphanPid} identity mismatch; refusing SIGTERM`
        );
        await firstManager.stop();

        expect(fs.unlinkSync).not.toHaveBeenCalledWith(
          expect.stringContaining('/child.pid')
        );

        const secondManager = new ChildProcessManager(baseConfig);
        const secondIdentitySpy = spyOnLinuxIdentity(secondManager, () => ({
          kind: 'linux-procfs',
          startTimeTicks: '222222',
          executablePath: '/usr/local/bin/node',
        }));
        try {
          await expect(secondManager.start()).rejects.toThrow(
            `Orphaned child process ${orphanPid} identity mismatch; refusing SIGTERM`
          );
        } finally {
          secondIdentitySpy.mockRestore();
        }

        expect(fs.unlinkSync).not.toHaveBeenCalledWith(
          expect.stringContaining('/child.pid')
        );
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        firstIdentitySpy.mockRestore();
        killSpy.mockRestore();
      }
    });

    it('should handle missing orphan process gracefully', async () => {
      const orphanPid = 99999;

      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (isReservationClaimPath(path) || isReservationPath(path)) {
          return defaultReservationExists(path);
        }
        if (String(path).includes('child.pid')) return true;
        return false;
      });
      mockPidEvidenceRead(String(orphanPid));

      // Process doesn't exist
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
        if (signal === 0) {
          throw Object.assign(new Error('process not found'), { code: 'ESRCH' });
        }
        return true;
      });

      const manager = new ChildProcessManager(baseConfig);

      try {
        await expect(manager.start()).resolves.not.toThrow();
        expect(fs.unlinkSync).toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('blocks startup and preserves PID evidence when orphan SIGKILL is denied', async () => {
      const orphanPid = 99999;
      vi.mocked(fs.existsSync).mockImplementation(reservationOrPidEvidenceExists);
      mockPidEvidenceRead(linuxPidEvidence(orphanPid));
      vi.mocked(fs.unlinkSync).mockClear();
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(
        (_pid: number, signal?: string | number) => {
          if (signal === 'SIGKILL') {
            throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
          }
          return true;
        }
      );

      try {
        const manager = new ChildProcessManager(baseConfig);
        const identitySpy = spyOnLinuxIdentity(manager, () => ({
          kind: 'linux-procfs',
          startTimeTicks: '424242',
          executablePath: '/usr/local/bin/node',
        }));
        const startPromise = manager.start();
        const rejection = expect(startPromise).rejects.toThrow(
          `Unable to kill orphaned child process ${orphanPid}`
        );
        await vi.advanceTimersByTimeAsync(ORPHAN_KILL_TEST_TIMEOUT_MS);
        await rejection;

        expect(killSpy).toHaveBeenCalledWith(orphanPid, 'SIGTERM');
        expect(killSpy).toHaveBeenCalledWith(orphanPid, 'SIGKILL');
        expect(spawn).not.toHaveBeenCalled();
        expect(fs.unlinkSync).not.toHaveBeenCalledWith(
          expect.stringContaining('/child.pid')
        );
        expect(manager.getState().status).toBe('crashed');
        identitySpy.mockRestore();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('blocks startup until orphan exit is confirmed after SIGKILL', async () => {
      const orphanPid = 99999;
      vi.mocked(fs.existsSync).mockImplementation(reservationOrPidEvidenceExists);
      mockPidEvidenceRead(linuxPidEvidence(orphanPid));
      vi.mocked(fs.unlinkSync).mockClear();
      const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

      try {
        const manager = new ChildProcessManager(baseConfig);
        const identitySpy = spyOnLinuxIdentity(manager, () => ({
          kind: 'linux-procfs',
          startTimeTicks: '424242',
          executablePath: '/usr/local/bin/node',
        }));
        const startPromise = manager.start();
        const rejection = expect(startPromise).rejects.toThrow(
          `Orphaned child process ${orphanPid} did not confirm exit`
        );
        await vi.advanceTimersByTimeAsync(ORPHAN_KILL_TEST_TIMEOUT_MS * 2);
        await rejection;

        expect(killSpy).toHaveBeenCalledWith(orphanPid, 'SIGKILL');
        expect(spawn).not.toHaveBeenCalled();
        expect(fs.unlinkSync).not.toHaveBeenCalledWith(
          expect.stringContaining('/child.pid')
        );
        expect(manager.getState().status).toBe('crashed');
        identitySpy.mockRestore();
      } finally {
        killSpy.mockRestore();
      }
    });

    it('preserves malformed PID evidence and blocks startup', async () => {
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (isReservationClaimPath(path) || isReservationPath(path)) {
          return defaultReservationExists(path);
        }
        if (String(path).includes('child.pid')) return true;
        return false;
      });
      mockPidEvidenceRead('invalid-not-a-number');

      const manager = new ChildProcessManager(baseConfig);

      await expect(manager.start()).rejects.toThrow(
        'Invalid child PID evidence; refusing to signal any process'
      );
      expect(fs.unlinkSync).not.toHaveBeenCalledWith(
        expect.stringContaining('/child.pid')
      );
      expect(spawn).not.toHaveBeenCalled();
    });
  });
});
