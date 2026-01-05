// Path: zn-vault-agent/src/services/child-process-manager.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChildProcessManager, type ChildProcessState } from './child-process-manager.js';
import type { ExecConfig } from '../lib/config.js';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
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

// Helper to create a mock child process
function createMockChild(): EventEmitter & {
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

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
  });

  describe('crash recovery', () => {
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

      // Advance past window
      await vi.advanceTimersByTimeAsync(1500);

      // Spawn returns new child
      mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild as any);

      // Manually restart to verify counter was reset
      await manager.restart('manual');

      // Wait for child exit
      mockChild.emit('exit', 0, null);

      // Start again
      mockChild = createMockChild();
      vi.mocked(spawn).mockReturnValue(mockChild as any);
      await manager.start();

      // Now crash multiple times - should reset window
      for (let i = 0; i < baseConfig.maxRestarts; i++) {
        mockChild.exitCode = 1;
        mockChild.emit('exit', 1, null);
        await vi.advanceTimersByTimeAsync(config.restartDelayMs + 10);
        mockChild = createMockChild();
        vi.mocked(spawn).mockReturnValue(mockChild as any);
      }

      // Should still be running, not in degraded state
      expect(manager.getState().status).not.toBe('max_restarts_exceeded');
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
});
