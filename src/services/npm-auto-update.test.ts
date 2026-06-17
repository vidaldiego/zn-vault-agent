// Path: zn-vault-agent/src/services/npm-auto-update.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NpmAutoUpdateService, loadUpdateConfig } from './npm-auto-update.js';

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn(),
  spawn: vi.fn(),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
  openSync: vi.fn(),
  writeSync: vi.fn(),
  closeSync: vi.fn(),
  constants: {
    O_WRONLY: 1,
    O_CREAT: 64,
    O_EXCL: 128,
  },
}));

// Mock logger
vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  flushLogs: vi.fn().mockResolvedValue(undefined),
}));

import { exec, spawn } from 'child_process';
import { existsSync, unlinkSync, readFileSync, statSync, openSync } from 'fs';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// Helper to create a mock child process
function createMockChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  emitter.stdout = new EventEmitter() as ChildProcess['stdout'];
  emitter.stderr = new EventEmitter() as ChildProcess['stderr'];
  emitter.kill = vi.fn().mockReturnValue(true);
  return emitter;
}

describe('NpmAutoUpdateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Default: run as root. Root takes the direct `npm install -g` path (no
    // sudo), which is what these install/verify/rollback/health-check tests
    // exercise. The install-strategy tests below override process.getuid
    // explicitly per case to cover the non-root `sudo npm install` path.
    if (typeof process.getuid !== 'function') {
      (process as { getuid?: () => number }).getuid = () => 0;
    }
    vi.spyOn(process, 'getuid').mockReturnValue(0);

    // Default mock: package.json returns current version
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes('package.json')) {
        return JSON.stringify({ version: '1.3.0' });
      }
      return '';
    });

    // Default: no lock file exists
    vi.mocked(existsSync).mockReturnValue(false);

    // Default: openSync succeeds (returns fd)
    vi.mocked(openSync).mockReturnValue(10);

    // Default: spawn returns a mock child that exits successfully
    vi.mocked(spawn).mockImplementation(() => {
      const child = createMockChildProcess();
      setTimeout(() => child.emit('close', 0), 10);
      return child;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkForUpdates', () => {
    it('should detect when update is available', async () => {
      // Mock npm view returning newer version
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: false });
      const info = await service.checkForUpdates();

      expect(info.current).toBe('1.3.0');
      expect(info.latest).toBe('1.4.0');
      expect(info.updateAvailable).toBe(true);
    });

    it('should detect when no update is available', async () => {
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.3.0\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: false });
      const info = await service.checkForUpdates();

      expect(info.current).toBe('1.3.0');
      expect(info.latest).toBe('1.3.0');
      expect(info.updateAvailable).toBe(false);
    });

    it('should handle major version updates', async () => {
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '2.0.0\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: false });
      const info = await service.checkForUpdates();

      expect(info.updateAvailable).toBe(true);
    });

    it('should handle minor version updates', async () => {
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: false });
      const info = await service.checkForUpdates();

      expect(info.updateAvailable).toBe(true);
    });

    it('should handle patch version updates', async () => {
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.3.1\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: false });
      const info = await service.checkForUpdates();

      expect(info.updateAvailable).toBe(true);
    });

    it('should use configured channel', async () => {
      let capturedCmd = '';
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        capturedCmd = String(cmd);
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        cb(null, { stdout: '1.3.0\n', stderr: '' });
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: false, channel: 'beta' });
      await service.checkForUpdates();

      expect(capturedCmd).toContain('@beta');
    });
  });

  describe('isNewer - semver comparison', () => {
    it('should detect major version updates', () => {
      const service = new NpmAutoUpdateService({ enabled: false });
      expect(service.isNewer('2.0.0', '1.0.0')).toBe(true);
      expect(service.isNewer('1.0.0', '2.0.0')).toBe(false);
    });

    it('should detect minor version updates', () => {
      const service = new NpmAutoUpdateService({ enabled: false });
      expect(service.isNewer('1.2.0', '1.1.0')).toBe(true);
      expect(service.isNewer('1.1.0', '1.2.0')).toBe(false);
    });

    it('should detect patch version updates', () => {
      const service = new NpmAutoUpdateService({ enabled: false });
      expect(service.isNewer('1.0.2', '1.0.1')).toBe(true);
      expect(service.isNewer('1.0.1', '1.0.2')).toBe(false);
    });

    it('should handle v prefix', () => {
      const service = new NpmAutoUpdateService({ enabled: false });
      expect(service.isNewer('v1.2.0', 'v1.1.0')).toBe(true);
      expect(service.isNewer('1.2.0', 'v1.1.0')).toBe(true);
    });

    it('should handle prerelease versions - release > prerelease', () => {
      const service = new NpmAutoUpdateService({ enabled: false });
      // 1.0.0 is newer than 1.0.0-beta
      expect(service.isNewer('1.0.0', '1.0.0-beta')).toBe(true);
      expect(service.isNewer('1.0.0-beta', '1.0.0')).toBe(false);
    });

    it('should compare prerelease versions numerically', () => {
      const service = new NpmAutoUpdateService({ enabled: false });
      expect(service.isNewer('1.0.0-beta.2', '1.0.0-beta.1')).toBe(true);
      expect(service.isNewer('1.0.0-beta.1', '1.0.0-beta.2')).toBe(false);
      expect(service.isNewer('1.0.0-beta.10', '1.0.0-beta.9')).toBe(true);
    });

    it('should compare prerelease versions lexicographically when not numeric', () => {
      const service = new NpmAutoUpdateService({ enabled: false });
      expect(service.isNewer('1.0.0-rc.1', '1.0.0-beta.1')).toBe(true); // 'rc' > 'beta'
      expect(service.isNewer('1.0.0-alpha.1', '1.0.0-beta.1')).toBe(false); // 'alpha' < 'beta'
    });

    it('should handle prerelease with more segments', () => {
      const service = new NpmAutoUpdateService({ enabled: false });
      expect(service.isNewer('1.0.0-beta.1.1', '1.0.0-beta.1')).toBe(true);
      expect(service.isNewer('1.0.0-beta.1', '1.0.0-beta.1.1')).toBe(false);
    });

    it('should return false for equal versions', () => {
      const service = new NpmAutoUpdateService({ enabled: false });
      expect(service.isNewer('1.0.0', '1.0.0')).toBe(false);
      expect(service.isNewer('1.0.0-beta.1', '1.0.0-beta.1')).toBe(false);
    });
  });

  describe('start/stop', () => {
    it('should not start if disabled', () => {
      const service = new NpmAutoUpdateService({ enabled: false });
      service.start();

      // Advance timers - should not trigger any checks
      vi.advanceTimersByTime(120_000);

      expect(exec).not.toHaveBeenCalled();
    });

    it('should schedule initial check after 1 minute', () => {
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        cb(null, { stdout: '1.3.0\n', stderr: '' });
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: true, stagedRolloutMaxDelayMs: 0 });
      service.start();

      // Before 1 minute - no check
      vi.advanceTimersByTime(59_000);
      expect(exec).not.toHaveBeenCalled();

      // After 1 minute - check triggered
      vi.advanceTimersByTime(2_000);
      expect(exec).toHaveBeenCalled();

      service.stop();
    });

    it('should stop timers when stopped', () => {
      const service = new NpmAutoUpdateService({ enabled: true });
      service.start();
      service.stop();

      // Advance past initial check time
      vi.advanceTimersByTime(120_000);

      expect(exec).not.toHaveBeenCalled();
    });
  });

  describe('staged rollout', () => {
    it('should calculate random delay within max bounds', () => {
      const service = new NpmAutoUpdateService({
        enabled: false,
        stagedRolloutMaxDelayMs: 60_000, // 1 minute max
      });

      // Test multiple times to verify randomness is within bounds
      for (let i = 0; i < 100; i++) {
        const delay = service.calculateStagedDelay();
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(60_000);
      }
    });

    it('should delay update when staged rollout is enabled', async () => {
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          cb(null, { stdout: 'installed\n', stderr: '' });
        } else if (String(cmd).includes('npm list')) {
          cb(null, { stdout: '@zincapp/zn-vault-agent@1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm bin')) {
          cb(null, { stdout: '/usr/local/bin\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      // Mock existsSync to return true for binary path check
      vi.mocked(existsSync).mockImplementation((path: unknown) => {
        return String(path).includes('zn-vault-agent');
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      // Use a fixed delay for testing
      const service = new NpmAutoUpdateService({
        enabled: true,
        stagedRolloutMaxDelayMs: 10_000, // 10 second max delay
      });

      // Mock calculateStagedDelay to return fixed value
      vi.spyOn(service, 'calculateStagedDelay').mockReturnValue(5_000);

      service.start();

      // Trigger initial check (1 minute)
      await vi.advanceTimersByTimeAsync(61_000);

      // At this point, npm view should be called but not npm install yet (waiting for staged delay)
      const execCalls = vi.mocked(exec).mock.calls.map(c => String(c[0]));
      expect(execCalls.some(c => c.includes('npm view'))).toBe(true);

      // Advance through the staged delay
      await vi.advanceTimersByTimeAsync(6_000);

      service.stop();
      await vi.advanceTimersByTimeAsync(2_000);

      killSpy.mockRestore();
    });

    it('should skip update if staged delay is 0', async () => {
      let installCalled = false;
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm cache clean')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          installCalled = true;
          cb(null, { stdout: 'installed\n', stderr: '' });
        } else if (String(cmd).includes('npm list')) {
          cb(null, { stdout: '@zincapp/zn-vault-agent@1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm bin')) {
          cb(null, { stdout: '/usr/local/bin\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      vi.mocked(existsSync).mockImplementation((path: unknown) => {
        return String(path).includes('zn-vault-agent');
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({
        enabled: true,
        stagedRolloutMaxDelayMs: 0, // No delay
      });

      service.start();
      await vi.advanceTimersByTimeAsync(61_000);
      service.stop();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(installCalled).toBe(true);

      killSpy.mockRestore();
    });
  });

  describe('lock file handling', () => {
    it('should acquire lock atomically using O_EXCL when no lock exists', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      let npmInstallCalled = false;
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm cache clean')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          npmInstallCalled = true;
          cb(null, { stdout: 'installed\n', stderr: '' });
        } else if (String(cmd).includes('npm list')) {
          cb(null, { stdout: '@zincapp/zn-vault-agent@1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm bin')) {
          cb(null, { stdout: '/usr/local/bin\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      // Mock process.kill to prevent actual SIGTERM
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({ enabled: true, stagedRolloutMaxDelayMs: 0 });
      service.start();

      // Trigger initial check (1 minute)
      await vi.advanceTimersByTimeAsync(61_000);

      // Stop the service to prevent interval from running
      service.stop();

      // Advance a bit more to let the restart timeout fire
      await vi.advanceTimersByTimeAsync(2_000);

      // Should have used openSync with O_EXCL flags for atomic lock
      expect(openSync).toHaveBeenCalledWith(
        '/var/run/zn-vault-agent.update.lock',
        expect.any(Number), // O_WRONLY | O_CREAT | O_EXCL
        0o644
      );
      expect(npmInstallCalled).toBe(true);

      killSpy.mockRestore();
    });

    it('should skip update if lock file exists and is fresh', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(statSync).mockReturnValue({
        mtimeMs: Date.now() - 5 * 60 * 1000, // 5 minutes old
      } as ReturnType<typeof statSync>);
      vi.mocked(readFileSync).mockImplementation((path: unknown) => {
        if (String(path).includes('package.json')) {
          return JSON.stringify({ version: '1.3.0' });
        }
        return '12345'; // PID in lock file
      });

      let npmInstallCalled = false;
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          npmInstallCalled = true;
          cb(null, { stdout: 'installed\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: true, stagedRolloutMaxDelayMs: 0 });
      service.start();

      // Trigger initial check
      await vi.advanceTimersByTimeAsync(61_000);

      // Stop immediately to prevent interval loop
      service.stop();

      // Should NOT have called npm install (lock exists)
      expect(npmInstallCalled).toBe(false);
    });

    it('should remove stale lock file (>10 minutes old)', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(statSync).mockReturnValue({
        mtimeMs: Date.now() - 15 * 60 * 1000, // 15 minutes old (stale)
      } as ReturnType<typeof statSync>);

      let npmInstallCalled = false;
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm cache clean')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          npmInstallCalled = true;
          cb(null, { stdout: 'installed\n', stderr: '' });
        } else if (String(cmd).includes('npm list')) {
          cb(null, { stdout: '@zincapp/zn-vault-agent@1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm bin')) {
          cb(null, { stdout: '/usr/local/bin\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({ enabled: true, stagedRolloutMaxDelayMs: 0 });
      service.start();

      // Trigger initial check
      await vi.advanceTimersByTimeAsync(61_000);

      // Stop to prevent interval loop
      service.stop();

      // Advance to let restart timeout fire
      await vi.advanceTimersByTimeAsync(2_000);

      // Should have removed stale lock and created new one
      expect(unlinkSync).toHaveBeenCalledWith('/var/run/zn-vault-agent.update.lock');
      expect(openSync).toHaveBeenCalled();
      expect(npmInstallCalled).toBe(true);

      killSpy.mockRestore();
    });

    it('should handle EEXIST when another process acquires lock first', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const eexistError = new Error('EEXIST') as NodeJS.ErrnoException;
      eexistError.code = 'EEXIST';
      vi.mocked(openSync).mockImplementation(() => { throw eexistError; });

      let npmInstallCalled = false;
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          npmInstallCalled = true;
          cb(null, { stdout: 'installed\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: true, stagedRolloutMaxDelayMs: 0 });
      service.start();

      await vi.advanceTimersByTimeAsync(61_000);
      service.stop();

      // Should NOT have called npm install (lock acquired by another process)
      expect(npmInstallCalled).toBe(false);
    });
  });

  describe('version verification', () => {
    it('should verify installed version matches expected', async () => {
      // Mock existsSync: true for binary check, false for lock file
      vi.mocked(existsSync).mockImplementation((path: unknown) => {
        const pathStr = String(path);
        if (pathStr.includes('.lock')) return false; // No lock file
        return pathStr.includes('zn-vault-agent'); // Binary exists
      });

      let verifyCommandCalled = false;
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm cache clean')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          cb(null, { stdout: 'installed\n', stderr: '' });
        } else if (String(cmd).includes('npm list')) {
          verifyCommandCalled = true;
          cb(null, { stdout: '@zincapp/zn-vault-agent@1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm bin')) {
          cb(null, { stdout: '/usr/local/bin\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      // Mock spawn for health check (--version and --help)
      vi.mocked(spawn).mockImplementation(() => {
        const child = createMockChildProcess();
        setTimeout(() => child.emit('close', 0), 10);
        return child;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({ enabled: true, stagedRolloutMaxDelayMs: 0 });
      service.start();

      // Trigger initial check (1 minute)
      await vi.advanceTimersByTimeAsync(61_000);

      // Wait for flushLogs and restart delay (500ms + buffer)
      await vi.advanceTimersByTimeAsync(1_000);

      service.stop();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(verifyCommandCalled).toBe(true);
      // Should proceed to restart since version matches
      expect(killSpy).toHaveBeenCalled();

      killSpy.mockRestore();
    });

    it('should rollback if verification fails with version mismatch', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const installCalls: string[] = [];
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm cache clean')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          installCalls.push(String(cmd));
          cb(null, { stdout: 'installed\n', stderr: '' });
        } else if (String(cmd).includes('npm list')) {
          // Return wrong version first time, then correct version after rollback
          if (installCalls.length === 1) {
            cb(null, { stdout: '@zincapp/zn-vault-agent@1.3.5\n', stderr: '' }); // Wrong version
          } else {
            cb(null, { stdout: '@zincapp/zn-vault-agent@1.3.0\n', stderr: '' }); // Rolled back
          }
        }
        return {} as ReturnType<typeof exec>;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({
        enabled: true,
        stagedRolloutMaxDelayMs: 0,
        rollbackOnFailure: true,
      });
      service.start();

      await vi.advanceTimersByTimeAsync(61_000);
      service.stop();
      await vi.advanceTimersByTimeAsync(2_000);

      // Should have called npm install twice (original + rollback)
      expect(installCalls.length).toBe(2);
      expect(installCalls[0]).toContain('@latest'); // Original update
      expect(installCalls[1]).toContain('@1.3.0'); // Rollback to previous version

      // Should NOT restart due to verification failure
      expect(killSpy).not.toHaveBeenCalled();

      killSpy.mockRestore();
    });
  });

  describe('npm cache clear and retry', () => {
    it('should clear npm cache before install', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      let cacheClearCalled = false;
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm cache clean')) {
          cacheClearCalled = true;
          cb(null, { stdout: '', stderr: '' });
        } else if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          cb(null, { stdout: 'installed\n', stderr: '' });
        } else if (String(cmd).includes('npm list')) {
          cb(null, { stdout: '@zincapp/zn-vault-agent@1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm bin')) {
          cb(null, { stdout: '/usr/local/bin\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      vi.mocked(spawn).mockImplementation(() => {
        const child = createMockChildProcess();
        setTimeout(() => child.emit('close', 0), 10);
        return child;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({ enabled: true, stagedRolloutMaxDelayMs: 0 });
      service.start();

      await vi.advanceTimersByTimeAsync(61_000);
      service.stop();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(cacheClearCalled).toBe(true);

      killSpy.mockRestore();
    });

    it('should retry npm install on transient failure', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      let installAttempts = 0;
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm cache clean')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          installAttempts++;
          if (installAttempts === 1) {
            // First attempt fails
            cb(new Error('ECONNRESET'), { stdout: '', stderr: 'connection reset' });
          } else {
            // Second attempt succeeds
            cb(null, { stdout: 'installed\n', stderr: '' });
          }
        } else if (String(cmd).includes('npm list')) {
          cb(null, { stdout: '@zincapp/zn-vault-agent@1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm bin')) {
          cb(null, { stdout: '/usr/local/bin\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      vi.mocked(spawn).mockImplementation(() => {
        const child = createMockChildProcess();
        setTimeout(() => child.emit('close', 0), 10);
        return child;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({ enabled: true, stagedRolloutMaxDelayMs: 0 });
      service.start();

      // Initial check after 1 min + retry delay (5s)
      await vi.advanceTimersByTimeAsync(61_000);
      await vi.advanceTimersByTimeAsync(6_000);

      service.stop();
      await vi.advanceTimersByTimeAsync(2_000);

      // Should have tried twice
      expect(installAttempts).toBe(2);

      killSpy.mockRestore();
    });

    it('should give up after max retries', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      let installAttempts = 0;
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm cache clean')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          installAttempts++;
          // All attempts fail
          cb(new Error('ECONNRESET'), { stdout: '', stderr: 'connection reset' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({ enabled: true, stagedRolloutMaxDelayMs: 0 });
      service.start();

      // Initial check + retry delays
      await vi.advanceTimersByTimeAsync(61_000);
      await vi.advanceTimersByTimeAsync(15_000); // Wait for retries

      service.stop();

      // Should have tried exactly 2 times (max retries)
      expect(installAttempts).toBe(2);

      // Should NOT restart since all attempts failed
      expect(killSpy).not.toHaveBeenCalled();

      killSpy.mockRestore();
    });
  });

  describe('real health check', () => {
    it('should run binary with --version and --help', async () => {
      vi.mocked(existsSync).mockImplementation((path: unknown) => {
        return String(path).includes('zn-vault-agent');
      });

      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm cache clean')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          cb(null, { stdout: 'installed\n', stderr: '' });
        } else if (String(cmd).includes('npm list')) {
          cb(null, { stdout: '@zincapp/zn-vault-agent@1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm bin')) {
          cb(null, { stdout: '/usr/local/bin\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const spawnArgs: string[][] = [];
      vi.mocked(spawn).mockImplementation((_cmd: unknown, args: unknown) => {
        spawnArgs.push(args as string[]);
        const child = createMockChildProcess();
        setTimeout(() => child.emit('close', 0), 10);
        return child;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({ enabled: true, stagedRolloutMaxDelayMs: 0 });
      service.start();

      await vi.advanceTimersByTimeAsync(61_000);
      service.stop();
      await vi.advanceTimersByTimeAsync(2_000);

      // Should have spawned --version and --help checks
      expect(spawnArgs).toContainEqual(['--version']);
      expect(spawnArgs).toContainEqual(['--help']);

      killSpy.mockRestore();
    });

    it('should rollback if health check fails', async () => {
      vi.mocked(existsSync).mockImplementation((path: unknown) => {
        return String(path).includes('zn-vault-agent');
      });

      const installCalls: string[] = [];
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm cache clean')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          installCalls.push(String(cmd));
          cb(null, { stdout: 'installed\n', stderr: '' });
        } else if (String(cmd).includes('npm list')) {
          if (installCalls.length === 1) {
            cb(null, { stdout: '@zincapp/zn-vault-agent@1.4.0\n', stderr: '' });
          } else {
            cb(null, { stdout: '@zincapp/zn-vault-agent@1.3.0\n', stderr: '' }); // After rollback
          }
        } else if (String(cmd).includes('npm bin')) {
          cb(null, { stdout: '/usr/local/bin\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      // Make health check fail (exit code 1)
      vi.mocked(spawn).mockImplementation(() => {
        const child = createMockChildProcess();
        setTimeout(() => child.emit('close', 1), 10); // Exit code 1 = failure
        return child;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({
        enabled: true,
        stagedRolloutMaxDelayMs: 0,
        rollbackOnFailure: true,
      });
      service.start();

      await vi.advanceTimersByTimeAsync(61_000);
      service.stop();
      await vi.advanceTimersByTimeAsync(2_000);

      // Should have called npm install twice (original + rollback)
      expect(installCalls.length).toBe(2);
      expect(installCalls[1]).toContain('@1.3.0'); // Rollback

      // Should NOT restart due to health check failure
      expect(killSpy).not.toHaveBeenCalled();

      killSpy.mockRestore();
    });

    it('should timeout health check if binary hangs', async () => {
      vi.mocked(existsSync).mockImplementation((path: unknown) => {
        return String(path).includes('zn-vault-agent');
      });

      const installCalls: string[] = [];
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm cache clean')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          installCalls.push(String(cmd));
          cb(null, { stdout: 'installed\n', stderr: '' });
        } else if (String(cmd).includes('npm list')) {
          if (installCalls.length === 1) {
            cb(null, { stdout: '@zincapp/zn-vault-agent@1.4.0\n', stderr: '' });
          } else {
            cb(null, { stdout: '@zincapp/zn-vault-agent@1.3.0\n', stderr: '' });
          }
        } else if (String(cmd).includes('npm bin')) {
          cb(null, { stdout: '/usr/local/bin\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      // Make health check hang (never emit close)
      vi.mocked(spawn).mockImplementation(() => {
        const child = createMockChildProcess();
        // Never emit close - will timeout
        return child;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({
        enabled: true,
        stagedRolloutMaxDelayMs: 0,
        healthCheckTimeoutMs: 1_000, // 1 second timeout for test
        rollbackOnFailure: true,
      });
      service.start();

      await vi.advanceTimersByTimeAsync(61_000);

      // Advance through health check timeout
      await vi.advanceTimersByTimeAsync(2_000);

      service.stop();
      await vi.advanceTimersByTimeAsync(2_000);

      // Should have attempted rollback due to timeout
      expect(installCalls.length).toBe(2);

      killSpy.mockRestore();
    });

    it('should skip rollback if rollbackOnFailure is false', async () => {
      vi.mocked(existsSync).mockImplementation((path: unknown) => {
        return String(path).includes('zn-vault-agent');
      });

      const installCalls: string[] = [];
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (String(cmd).includes('npm cache clean')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (String(cmd).includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm install')) {
          installCalls.push(String(cmd));
          cb(null, { stdout: 'installed\n', stderr: '' });
        } else if (String(cmd).includes('npm list')) {
          cb(null, { stdout: '@zincapp/zn-vault-agent@1.4.0\n', stderr: '' });
        } else if (String(cmd).includes('npm bin')) {
          cb(null, { stdout: '/usr/local/bin\n', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      // Make health check fail
      vi.mocked(spawn).mockImplementation(() => {
        const child = createMockChildProcess();
        setTimeout(() => child.emit('close', 1), 10);
        return child;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({
        enabled: true,
        stagedRolloutMaxDelayMs: 0,
        rollbackOnFailure: false, // Disable rollback
      });
      service.start();

      await vi.advanceTimersByTimeAsync(61_000);
      service.stop();
      await vi.advanceTimersByTimeAsync(2_000);

      // Should NOT have rolled back
      expect(installCalls.length).toBe(1);

      // Should NOT restart (health check failed)
      expect(killSpy).not.toHaveBeenCalled();

      killSpy.mockRestore();
    });
  });

  describe('performUpdate install strategy', () => {
    // performUpdate is private; cast to an indexable shape to invoke it
    // directly for a focused unit test of the install strategy.
    //
    // The agent user cannot `systemctl start zn-vault-agent-updater.service`
    // (polkit denies it: "interactive authentication required"), but the host
    // sudoers entry already permits `sudo npm install -g @zincapp/zn-vault-agent*`,
    // which works because sudo runs in a fresh root context OUTSIDE the unit's
    // ProtectSystem=strict sandbox. So non-root installs via `sudo npm install`,
    // NOT by starting the updater unit.
    interface PerformUpdateAccessor {
      performUpdate(targetVersion: string): Promise<void>;
    }

    let getuidSpy: ReturnType<typeof vi.spyOn> | undefined;

    function mockUid(uid: number): void {
      // process.getuid may be undefined on some platforms; define it so it
      // can be spied/stubbed deterministically.
      if (typeof process.getuid !== 'function') {
        (process as { getuid?: () => number }).getuid = () => uid;
      }
      getuidSpy = vi.spyOn(process, 'getuid').mockReturnValue(uid);
    }

    afterEach(() => {
      getuidSpy?.mockRestore();
      getuidSpy = undefined;
    });

    it('non-root: installs via sudo npm install -g (not systemctl start)', async () => {
      mockUid(1000); // non-root

      const commands: string[] = [];
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        commands.push(String(cmd));
        cb(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: false, stagedRolloutMaxDelayMs: 0 });
      await (service as unknown as PerformUpdateAccessor).performUpdate('1.4.0');

      // Non-root installs via the sudoers-permitted sudo npm install path.
      expect(commands.some((c) => c.includes('sudo npm install -g @zincapp/zn-vault-agent@latest'))).toBe(true);
      // It must NOT try to start the updater unit (agent has no permission).
      expect(commands.some((c) => c.includes('systemctl start'))).toBe(false);
      expect(commands.some((c) => c.includes('systemctl cat'))).toBe(false);
    });

    it('root: runs npm install -g directly (no sudo, no systemctl)', async () => {
      mockUid(0); // root

      const commands: string[] = [];
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        commands.push(String(cmd));
        cb(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: false, stagedRolloutMaxDelayMs: 0 });
      await (service as unknown as PerformUpdateAccessor).performUpdate('1.4.0');

      const installCmd = commands.find((c) => c.includes('npm install -g'));
      expect(installCmd).toBeDefined();
      expect(installCmd).not.toContain('sudo ');
      expect(commands.some((c) => c.includes('systemctl'))).toBe(false);
    });
  });

  describe('triggerUpdate force flag (UI force-update reinstall)', () => {
    // When the operator clicks "force update" the server sends force:true, which
    // the daemon threads into triggerUpdate({ force: true }). A forced trigger
    // must reinstall the current channel tag even when checkForUpdates reports
    // updateAvailable:false — otherwise forcing a reinstall/repair on an agent
    // already at latest silently no-ops and the UI affordance is broken.

    it('force:true reinstalls even when no update is available (root path)', async () => {
      // Root short-circuits to the in-process npm install path.
      vi.spyOn(process, 'getuid').mockReturnValue(0);
      vi.mocked(existsSync).mockReturnValue(false); // no lock file

      const installCalls: string[] = [];
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        const c = String(cmd);
        if (c.includes('npm cache clean')) {
          cb(null, { stdout: '', stderr: '' });
        } else if (c.includes('npm view')) {
          // Latest == current => updateAvailable:false
          cb(null, { stdout: '1.3.0\n', stderr: '' });
        } else if (c.includes('npm install')) {
          installCalls.push(c);
          cb(null, { stdout: 'installed\n', stderr: '' });
        } else if (c.includes('npm list')) {
          cb(null, { stdout: '@zincapp/zn-vault-agent@1.3.0\n', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({ enabled: false, stagedRolloutMaxDelayMs: 0 });
      const result = await service.triggerUpdate({ force: true });

      // Proceeded to install despite updateAvailable:false.
      expect(installCalls.length).toBe(1);
      expect(installCalls[0]).toContain('npm install -g');
      expect(result.success).toBe(true);
      expect(result.willRestart).toBe(true);
      // Message must reflect a (re)install, not "Already at latest version".
      expect(result.message).not.toBe('Already at latest version');
      expect(result.message.toLowerCase()).toContain('1.3.0');

      killSpy.mockRestore();
    });

    it('no force when no update is available still early-returns "Already at latest version" (regression guard)', async () => {
      vi.spyOn(process, 'getuid').mockReturnValue(0);
      vi.mocked(existsSync).mockReturnValue(false);

      let installCalled = false;
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        const c = String(cmd);
        if (c.includes('npm view')) {
          cb(null, { stdout: '1.3.0\n', stderr: '' }); // updateAvailable:false
        } else if (c.includes('npm install')) {
          installCalled = true;
          cb(null, { stdout: 'installed\n', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const service = new NpmAutoUpdateService({ enabled: false, stagedRolloutMaxDelayMs: 0 });
      const result = await service.triggerUpdate(); // no force

      expect(installCalled).toBe(false);
      expect(result.success).toBe(true);
      expect(result.willRestart).toBe(false);
      expect(result.message).toBe('Already at latest version');
    });

    it('force:true reinstalls via sudo npm install (non-root) and the caller verifies + restarts', async () => {
      // Non-root installs via the sudoers-permitted `sudo npm install`, which
      // does NOT restart the agent. So the caller MUST verify (npm list) and
      // self-restart (SIGTERM). Force must not change the install mechanism.
      vi.spyOn(process, 'getuid').mockReturnValue(1000); // non-root
      vi.mocked(existsSync).mockReturnValue(false); // no lock file

      const commands: string[] = [];
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        const c = String(cmd);
        commands.push(c);
        if (c.includes('npm view')) {
          cb(null, { stdout: '1.3.0\n', stderr: '' }); // updateAvailable:false
        } else if (c.includes('npm list')) {
          cb(null, { stdout: '@zincapp/zn-vault-agent@1.3.0\n', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({ enabled: false, stagedRolloutMaxDelayMs: 0 });
      const result = await service.triggerUpdate({ force: true });

      // Reinstalled via sudo npm install even though updateAvailable:false.
      expect(commands.some((c) => c.includes('sudo npm install -g @zincapp/zn-vault-agent@latest'))).toBe(true);
      // Must NOT try to start the updater unit (agent can't).
      expect(commands.some((c) => c.includes('systemctl start'))).toBe(false);
      expect(result.success).toBe(true);
      expect(result.willRestart).toBe(true);
      // The caller owns the restart on the sudo path: it verifies + restarts.
      expect(commands.some((c) => c.includes('npm list'))).toBe(true);
      // requestRestart schedules SIGTERM after flushLogs + a 500ms delay.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(killSpy).toHaveBeenCalled();

      killSpy.mockRestore();
    });
  });

  describe('triggerUpdate restart handling (non-root sudo path)', () => {
    let getuidSpy: ReturnType<typeof vi.spyOn> | undefined;

    function mockUid(uid: number): void {
      if (typeof process.getuid !== 'function') {
        (process as { getuid?: () => number }).getuid = () => uid;
      }
      getuidSpy = vi.spyOn(process, 'getuid').mockReturnValue(uid);
    }

    afterEach(() => {
      getuidSpy?.mockRestore();
      getuidSpy = undefined;
    });

    it('non-root: triggerUpdate installs via sudo npm install, then verifies + restarts', async () => {
      mockUid(1000); // non-root
      vi.mocked(existsSync).mockReturnValue(false); // no lock file

      const commands: string[] = [];
      vi.mocked(exec).mockImplementation((cmd: unknown, opts: unknown, callback?: unknown) => {
        const cb = (callback ?? opts) as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        const c = String(cmd);
        commands.push(c);
        if (c.includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (c.includes('npm list')) {
          cb(null, { stdout: '@zincapp/zn-vault-agent@1.4.0\n', stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({ enabled: false, stagedRolloutMaxDelayMs: 0 });
      const result = await service.triggerUpdate();

      expect(result.success).toBe(true);
      expect(result.willRestart).toBe(true);
      // Installed via the sudoers-permitted sudo npm install path, NOT the unit.
      expect(commands.some((c) => c.includes('sudo npm install -g @zincapp/zn-vault-agent@latest'))).toBe(true);
      expect(commands.some((c) => c.includes('systemctl start'))).toBe(false);
      // sudo npm install does NOT restart the agent, so the caller must
      // self-verify (npm list) and self-restart (SIGTERM).
      expect(commands.some((c) => c.includes('npm list'))).toBe(true);
      // requestRestart schedules SIGTERM after flushLogs + a 500ms delay.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(killSpy).toHaveBeenCalled();

      killSpy.mockRestore();
    });
  });
});

describe('loadUpdateConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return defaults when no env vars set', () => {
    delete process.env.AUTO_UPDATE;
    delete process.env.AUTO_UPDATE_INTERVAL;
    delete process.env.AUTO_UPDATE_CHANNEL;
    delete process.env.AUTO_UPDATE_STAGED_DELAY;
    delete process.env.AUTO_UPDATE_ROLLBACK;

    const config = loadUpdateConfig();

    // Auto-update is OFF by default (M1.5 of the zn-api hardening plan).
    // Operators must opt in explicitly via AUTO_UPDATE=true or the config
    // file once an upstream signing/gating process is in place.
    expect(config.enabled).toBe(false);
    expect(config.checkIntervalMs).toBe(5 * 60 * 1000);
    expect(config.channel).toBe('latest');
    expect(config.stagedRolloutMaxDelayMs).toBe(30 * 60 * 1000);
    expect(config.rollbackOnFailure).toBe(true);
  });

  it('should disable when AUTO_UPDATE=false', () => {
    process.env.AUTO_UPDATE = 'false';

    const config = loadUpdateConfig();

    expect(config.enabled).toBe(false);
  });

  it('should disable when AUTO_UPDATE=0', () => {
    process.env.AUTO_UPDATE = '0';

    const config = loadUpdateConfig();

    expect(config.enabled).toBe(false);
  });

  it('should use custom interval from env', () => {
    process.env.AUTO_UPDATE_INTERVAL = '600'; // 10 minutes in seconds

    const config = loadUpdateConfig();

    expect(config.checkIntervalMs).toBe(600 * 1000);
  });

  it('should use beta channel from env', () => {
    process.env.AUTO_UPDATE_CHANNEL = 'beta';

    const config = loadUpdateConfig();

    expect(config.channel).toBe('beta');
  });

  it('should use next channel from env', () => {
    process.env.AUTO_UPDATE_CHANNEL = 'next';

    const config = loadUpdateConfig();

    expect(config.channel).toBe('next');
  });

  it('should ignore invalid channel', () => {
    process.env.AUTO_UPDATE_CHANNEL = 'invalid';

    const config = loadUpdateConfig();

    expect(config.channel).toBe('latest');
  });

  it('should use custom staged delay from env', () => {
    process.env.AUTO_UPDATE_STAGED_DELAY = '120'; // 2 minutes in seconds

    const config = loadUpdateConfig();

    expect(config.stagedRolloutMaxDelayMs).toBe(120 * 1000);
  });

  it('should disable staged delay with 0', () => {
    process.env.AUTO_UPDATE_STAGED_DELAY = '0';

    const config = loadUpdateConfig();

    expect(config.stagedRolloutMaxDelayMs).toBe(0);
  });

  it('should disable rollback when AUTO_UPDATE_ROLLBACK=false', () => {
    process.env.AUTO_UPDATE_ROLLBACK = 'false';

    const config = loadUpdateConfig();

    expect(config.rollbackOnFailure).toBe(false);
  });

  it('should disable rollback when AUTO_UPDATE_ROLLBACK=0', () => {
    process.env.AUTO_UPDATE_ROLLBACK = '0';

    const config = loadUpdateConfig();

    expect(config.rollbackOnFailure).toBe(false);
  });
});
