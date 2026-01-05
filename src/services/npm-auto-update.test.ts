// Path: zn-vault-agent/src/services/npm-auto-update.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NpmAutoUpdateService, loadUpdateConfig } from './npm-auto-update.js';

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

// Mock logger
vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { exec } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, readFileSync, statSync } from 'fs';
import { promisify } from 'util';

describe('NpmAutoUpdateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Default mock: package.json returns current version
    vi.mocked(readFileSync).mockImplementation((path: any) => {
      if (path.toString().includes('package.json')) {
        return JSON.stringify({ version: '1.3.0' });
      }
      return '';
    });

    // Default: no lock file exists
    vi.mocked(existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkForUpdates', () => {
    it('should detect when update is available', async () => {
      // Mock npm view returning newer version
      vi.mocked(exec).mockImplementation((cmd: any, opts: any, callback?: any) => {
        const cb = callback || opts;
        if (cmd.includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        }
        return {} as any;
      });

      const service = new NpmAutoUpdateService({ enabled: false });
      const info = await service.checkForUpdates();

      expect(info.current).toBe('1.3.0');
      expect(info.latest).toBe('1.4.0');
      expect(info.updateAvailable).toBe(true);
    });

    it('should detect when no update is available', async () => {
      vi.mocked(exec).mockImplementation((cmd: any, opts: any, callback?: any) => {
        const cb = callback || opts;
        if (cmd.includes('npm view')) {
          cb(null, { stdout: '1.3.0\n', stderr: '' });
        }
        return {} as any;
      });

      const service = new NpmAutoUpdateService({ enabled: false });
      const info = await service.checkForUpdates();

      expect(info.current).toBe('1.3.0');
      expect(info.latest).toBe('1.3.0');
      expect(info.updateAvailable).toBe(false);
    });

    it('should handle major version updates', async () => {
      vi.mocked(exec).mockImplementation((cmd: any, opts: any, callback?: any) => {
        const cb = callback || opts;
        if (cmd.includes('npm view')) {
          cb(null, { stdout: '2.0.0\n', stderr: '' });
        }
        return {} as any;
      });

      const service = new NpmAutoUpdateService({ enabled: false });
      const info = await service.checkForUpdates();

      expect(info.updateAvailable).toBe(true);
    });

    it('should handle minor version updates', async () => {
      vi.mocked(exec).mockImplementation((cmd: any, opts: any, callback?: any) => {
        const cb = callback || opts;
        if (cmd.includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        }
        return {} as any;
      });

      const service = new NpmAutoUpdateService({ enabled: false });
      const info = await service.checkForUpdates();

      expect(info.updateAvailable).toBe(true);
    });

    it('should handle patch version updates', async () => {
      vi.mocked(exec).mockImplementation((cmd: any, opts: any, callback?: any) => {
        const cb = callback || opts;
        if (cmd.includes('npm view')) {
          cb(null, { stdout: '1.3.1\n', stderr: '' });
        }
        return {} as any;
      });

      const service = new NpmAutoUpdateService({ enabled: false });
      const info = await service.checkForUpdates();

      expect(info.updateAvailable).toBe(true);
    });

    it('should use configured channel', async () => {
      let capturedCmd = '';
      vi.mocked(exec).mockImplementation((cmd: any, opts: any, callback?: any) => {
        capturedCmd = cmd;
        const cb = callback || opts;
        cb(null, { stdout: '1.3.0\n', stderr: '' });
        return {} as any;
      });

      const service = new NpmAutoUpdateService({ enabled: false, channel: 'beta' });
      await service.checkForUpdates();

      expect(capturedCmd).toContain('@beta');
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
      vi.mocked(exec).mockImplementation((cmd: any, opts: any, callback?: any) => {
        const cb = callback || opts;
        cb(null, { stdout: '1.3.0\n', stderr: '' });
        return {} as any;
      });

      const service = new NpmAutoUpdateService({ enabled: true });
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

  describe('lock file handling', () => {
    it('should acquire lock when no lock exists', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      let npmInstallCalled = false;
      vi.mocked(exec).mockImplementation((cmd: any, opts: any, callback?: any) => {
        const cb = callback || opts;
        if (cmd.includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (cmd.includes('npm install')) {
          npmInstallCalled = true;
          cb(null, { stdout: 'installed\n', stderr: '' });
        }
        return {} as any;
      });

      // Mock process.kill to prevent actual SIGTERM
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({ enabled: true });
      service.start();

      // Trigger initial check (1 minute)
      await vi.advanceTimersByTimeAsync(61_000);

      // Stop the service to prevent interval from running
      service.stop();

      // Advance a bit more to let the restart timeout fire
      await vi.advanceTimersByTimeAsync(2_000);

      expect(writeFileSync).toHaveBeenCalledWith(
        '/var/run/zn-vault-agent.update.lock',
        expect.any(String)
      );
      expect(npmInstallCalled).toBe(true);

      killSpy.mockRestore();
    });

    it('should skip update if lock file exists and is fresh', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(statSync).mockReturnValue({
        mtimeMs: Date.now() - 5 * 60 * 1000, // 5 minutes old
      } as any);
      vi.mocked(readFileSync).mockImplementation((path: any) => {
        if (path.toString().includes('package.json')) {
          return JSON.stringify({ version: '1.3.0' });
        }
        return '12345'; // PID in lock file
      });

      let npmInstallCalled = false;
      vi.mocked(exec).mockImplementation((cmd: any, opts: any, callback?: any) => {
        const cb = callback || opts;
        if (cmd.includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (cmd.includes('npm install')) {
          npmInstallCalled = true;
          cb(null, { stdout: 'installed\n', stderr: '' });
        }
        return {} as any;
      });

      const service = new NpmAutoUpdateService({ enabled: true });
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
      } as any);

      let npmInstallCalled = false;
      vi.mocked(exec).mockImplementation((cmd: any, opts: any, callback?: any) => {
        const cb = callback || opts;
        if (cmd.includes('npm view')) {
          cb(null, { stdout: '1.4.0\n', stderr: '' });
        } else if (cmd.includes('npm install')) {
          npmInstallCalled = true;
          cb(null, { stdout: 'installed\n', stderr: '' });
        }
        return {} as any;
      });

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const service = new NpmAutoUpdateService({ enabled: true });
      service.start();

      // Trigger initial check
      await vi.advanceTimersByTimeAsync(61_000);

      // Stop to prevent interval loop
      service.stop();

      // Advance to let restart timeout fire
      await vi.advanceTimersByTimeAsync(2_000);

      // Should have overwritten the stale lock
      expect(writeFileSync).toHaveBeenCalledWith(
        '/var/run/zn-vault-agent.update.lock',
        expect.any(String)
      );
      expect(npmInstallCalled).toBe(true);

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

    const config = loadUpdateConfig();

    expect(config.enabled).toBe(true);
    expect(config.checkIntervalMs).toBe(5 * 60 * 1000);
    expect(config.channel).toBe('latest');
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
});
