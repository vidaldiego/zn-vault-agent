// Path: test/integration/resilience.test.ts
// Integration tests for agent resilience features

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanupOrphanedFiles, extractTargetDirectories } from '../../src/utils/startup-cleanup.js';

// Skip these tests if not running in integration mode
const isIntegration = process.env.VITEST_INTEGRATION === 'true';

describe.skipIf(!isIntegration)('Agent Resilience', () => {
  let testDir: string;

  beforeAll(() => {
    // Create a temporary test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-vault-agent-resilience-'));
  });

  afterAll(() => {
    // Clean up test directory
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Startup Recovery', () => {
    it('should clean orphaned temp files on startup', () => {
      // Create orphaned temp files
      const tempFile1 = path.join(testDir, '.server.crt.12345.tmp');
      const tempFile2 = path.join(testDir, '.api-key.54321.tmp');
      fs.writeFileSync(tempFile1, 'temp content 1');
      fs.writeFileSync(tempFile2, 'temp content 2');

      // Run cleanup
      const stats = cleanupOrphanedFiles([testDir]);

      // Verify temp files are removed
      expect(stats.tempFilesRemoved).toBe(2);
      expect(fs.existsSync(tempFile1)).toBe(false);
      expect(fs.existsSync(tempFile2)).toBe(false);
    });

    it('should clean old backup files but keep recent ones', () => {
      // Create old backup file (>24h)
      const oldBackup = path.join(testDir, 'server.crt.bak');
      fs.writeFileSync(oldBackup, 'old backup');
      const oldTime = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
      fs.utimesSync(oldBackup, new Date(oldTime), new Date(oldTime));

      // Create recent backup file (<24h)
      const recentBackup = path.join(testDir, 'api-key.bak');
      fs.writeFileSync(recentBackup, 'recent backup');
      // Recent file keeps current mtime

      // Run cleanup
      const stats = cleanupOrphanedFiles([testDir]);

      // Verify old backup is removed, recent is kept
      expect(stats.backupFilesRemoved).toBe(1);
      expect(fs.existsSync(oldBackup)).toBe(false);
      expect(fs.existsSync(recentBackup)).toBe(true);

      // Clean up
      fs.unlinkSync(recentBackup);
    });

    it('should handle non-existent directories gracefully', () => {
      const stats = cleanupOrphanedFiles(['/non/existent/directory/12345']);

      expect(stats.errors).toBe(0);
      expect(stats.tempFilesRemoved).toBe(0);
      expect(stats.backupFilesRemoved).toBe(0);
    });

    it('should not remove regular files', () => {
      // Create regular files that should NOT be removed
      const normalFile = path.join(testDir, 'server.crt');
      const configFile = path.join(testDir, 'config.json');
      fs.writeFileSync(normalFile, 'certificate content');
      fs.writeFileSync(configFile, '{"key": "value"}');

      // Run cleanup
      const stats = cleanupOrphanedFiles([testDir]);

      // Verify regular files are kept
      expect(fs.existsSync(normalFile)).toBe(true);
      expect(fs.existsSync(configFile)).toBe(true);

      // Clean up
      fs.unlinkSync(normalFile);
      fs.unlinkSync(configFile);
    });
  });

  describe('Directory Extraction', () => {
    it('should extract unique directories from cert targets', () => {
      const certTargets = [
        {
          outputs: {
            cert: '/etc/ssl/certs/server.crt',
            key: '/etc/ssl/private/server.key',
            chain: '/etc/ssl/certs/chain.pem',
          },
        },
        {
          outputs: {
            combined: '/opt/app/certs/combined.pem',
          },
        },
      ];

      const dirs = extractTargetDirectories(certTargets, undefined);

      expect(dirs).toContain('/etc/ssl/certs');
      expect(dirs).toContain('/etc/ssl/private');
      expect(dirs).toContain('/opt/app/certs');
      // Should be unique
      expect(dirs.filter(d => d === '/etc/ssl/certs').length).toBe(1);
    });

    it('should extract directories from secret targets', () => {
      const secretTargets = [
        { output: '/app/secrets/db-password.txt' },
        { filePath: '/app/config/api-key.json' },
      ];

      const dirs = extractTargetDirectories(undefined, secretTargets);

      expect(dirs).toContain('/app/secrets');
      expect(dirs).toContain('/app/config');
    });
  });

  describe('Resource Management', () => {
    it('should deduplicate directory list for cleanup', () => {
      // Create temp file
      const tempFile = path.join(testDir, '.test.99999.tmp');
      fs.writeFileSync(tempFile, 'temp');

      // Pass same directory multiple times
      const stats = cleanupOrphanedFiles([testDir, testDir, testDir]);

      // Should only clean once
      expect(stats.tempFilesRemoved).toBe(1);
      expect(fs.existsSync(tempFile)).toBe(false);
    });
  });
});

// Unit tests that don't require vault
describe('Startup Cleanup Unit Tests', () => {
  it('should match temp file pattern correctly', () => {
    const pattern = /^\..+\.\d+\.tmp$/;

    // Should match
    expect(pattern.test('.server.crt.12345.tmp')).toBe(true);
    expect(pattern.test('.api-key.99999.tmp')).toBe(true);
    expect(pattern.test('.a.1.tmp')).toBe(true);

    // Should not match
    expect(pattern.test('server.crt.12345.tmp')).toBe(false); // No leading dot
    expect(pattern.test('.server.crt.tmp')).toBe(false); // No PID
    expect(pattern.test('.server.crt.abc.tmp')).toBe(false); // Non-numeric
    expect(pattern.test('.server.crt.12345')).toBe(false); // No .tmp suffix
    expect(pattern.test('.12345.tmp')).toBe(false); // No filename
  });

  it('should match backup file pattern correctly', () => {
    const pattern = /\.bak$/;

    // Should match
    expect(pattern.test('server.crt.bak')).toBe(true);
    expect(pattern.test('file.bak')).toBe(true);
    expect(pattern.test('.hidden.bak')).toBe(true);

    // Should not match
    expect(pattern.test('backup')).toBe(false);
    expect(pattern.test('file.backup')).toBe(false);
    expect(pattern.test('bak')).toBe(false);
  });
});
