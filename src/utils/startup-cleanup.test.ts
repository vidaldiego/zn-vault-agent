// Path: src/utils/startup-cleanup.test.ts
// Tests for startup cleanup utility

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { cleanupOrphanedFiles, extractTargetDirectories } from './startup-cleanup.js';

// Mock fs module
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

// Mock logger
vi.mock('../lib/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Helper to mock readdirSync return value
function mockReaddirSync(files: string[]): void {
  (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(files);
}

describe('cleanupOrphanedFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should remove orphaned temp files matching .name.pid.tmp pattern', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync([
      '.server.crt.12345.tmp',
      '.api-key.54321.tmp',
      'normal-file.txt',
    ]);
    vi.mocked(fs.statSync).mockReturnValue({
      isFile: () => true,
      mtimeMs: Date.now(),
    } as fs.Stats);
    vi.mocked(fs.unlinkSync).mockImplementation(() => undefined);

    const stats = cleanupOrphanedFiles(['/etc/certs']);

    expect(stats.tempFilesRemoved).toBe(2);
    expect(stats.errors).toBe(0);
    expect(fs.unlinkSync).toHaveBeenCalledWith('/etc/certs/.server.crt.12345.tmp');
    expect(fs.unlinkSync).toHaveBeenCalledWith('/etc/certs/.api-key.54321.tmp');
  });

  it('should remove backup files older than 24 hours', () => {
    const oldTime = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago

    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync([
      'server.crt.bak',
      'api-key.bak',
    ]);
    vi.mocked(fs.statSync).mockReturnValue({
      isFile: () => true,
      mtimeMs: oldTime,
    } as fs.Stats);
    vi.mocked(fs.unlinkSync).mockImplementation(() => undefined);

    const stats = cleanupOrphanedFiles(['/etc/certs']);

    expect(stats.backupFilesRemoved).toBe(2);
    expect(stats.errors).toBe(0);
  });

  it('should keep recent backup files (less than 24 hours old)', () => {
    const recentTime = Date.now() - (12 * 60 * 60 * 1000); // 12 hours ago

    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync([
      'server.crt.bak',
    ]);
    vi.mocked(fs.statSync).mockReturnValue({
      isFile: () => true,
      mtimeMs: recentTime,
    } as fs.Stats);

    const stats = cleanupOrphanedFiles(['/etc/certs']);

    expect(stats.backupFilesRemoved).toBe(0);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('should handle non-existent directories gracefully', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const stats = cleanupOrphanedFiles(['/non/existent/path']);

    expect(stats.tempFilesRemoved).toBe(0);
    expect(stats.backupFilesRemoved).toBe(0);
    expect(stats.errors).toBe(0);
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });

  it('should handle permission errors gracefully', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    (fs.readdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const stats = cleanupOrphanedFiles(['/etc/certs']);

    expect(stats.errors).toBe(1);
    expect(stats.tempFilesRemoved).toBe(0);
  });

  it('should handle unlink errors gracefully', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync([
      '.server.crt.12345.tmp',
    ]);
    vi.mocked(fs.statSync).mockReturnValue({
      isFile: () => true,
      mtimeMs: Date.now(),
    } as fs.Stats);
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw new Error('EBUSY: resource busy');
    });

    const stats = cleanupOrphanedFiles(['/etc/certs']);

    expect(stats.errors).toBe(1);
    expect(stats.tempFilesRemoved).toBe(0);
  });

  it('should deduplicate directories', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync([]);

    cleanupOrphanedFiles(['/etc/certs', '/etc/certs', '/etc/certs']);

    // Should only scan once
    expect(fs.readdirSync).toHaveBeenCalledTimes(1);
  });

  it('should skip directories (not files) matching patterns', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync([
      '.config.12345.tmp', // This is actually a directory
    ]);
    vi.mocked(fs.statSync).mockReturnValue({
      isFile: () => false, // It's a directory
      mtimeMs: Date.now(),
    } as fs.Stats);

    const stats = cleanupOrphanedFiles(['/etc/certs']);

    expect(stats.tempFilesRemoved).toBe(0);
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('should skip empty or null directories', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    mockReaddirSync([]);

    const stats = cleanupOrphanedFiles(['', null as unknown as string, '/etc/certs']);

    // existsSync should only be called for /etc/certs
    expect(fs.existsSync).toHaveBeenCalledTimes(1);
    expect(fs.existsSync).toHaveBeenCalledWith('/etc/certs');
  });
});

describe('extractTargetDirectories', () => {
  it('should extract directories from certificate targets', () => {
    const certTargets = [
      {
        outputs: {
          cert: '/etc/ssl/certs/server.crt',
          key: '/etc/ssl/private/server.key',
          chain: '/etc/ssl/certs/chain.pem',
        },
      },
    ];

    const dirs = extractTargetDirectories(certTargets, undefined);

    expect(dirs).toContain('/etc/ssl/certs');
    expect(dirs).toContain('/etc/ssl/private');
  });

  it('should extract directories from secret targets with output field', () => {
    const secretTargets = [
      { output: '/app/secrets/db-password.txt' },
      { output: '/app/config/api-key.json' },
    ];

    const dirs = extractTargetDirectories(undefined, secretTargets);

    expect(dirs).toContain('/app/secrets');
    expect(dirs).toContain('/app/config');
  });

  it('should extract directories from secret targets with filePath field', () => {
    const secretTargets = [
      { filePath: '/app/secrets/db-password.txt' },
    ];

    const dirs = extractTargetDirectories(undefined, secretTargets);

    expect(dirs).toContain('/app/secrets');
  });

  it('should return unique directories', () => {
    const certTargets = [
      {
        outputs: {
          cert: '/etc/ssl/certs/a.crt',
          chain: '/etc/ssl/certs/b.crt',
        },
      },
    ];

    const dirs = extractTargetDirectories(certTargets, undefined);

    expect(dirs.filter(d => d === '/etc/ssl/certs').length).toBe(1);
  });

  it('should handle undefined targets gracefully', () => {
    const dirs = extractTargetDirectories(undefined, undefined);

    expect(dirs).toEqual([]);
  });

  it('should handle empty targets gracefully', () => {
    const dirs = extractTargetDirectories([], []);

    expect(dirs).toEqual([]);
  });

  it('should handle targets with undefined output paths', () => {
    const certTargets = [
      {
        outputs: {
          cert: '/etc/ssl/certs/server.crt',
          key: undefined,
        },
      },
    ];

    const dirs = extractTargetDirectories(certTargets, undefined);

    expect(dirs).toContain('/etc/ssl/certs');
    expect(dirs.length).toBe(1);
  });
});
