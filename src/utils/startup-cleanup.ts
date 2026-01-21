// Path: src/utils/startup-cleanup.ts
// Startup cleanup utilities for orphaned files

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'startup-cleanup' });

/**
 * Pattern to match orphaned temp files from crashed deployments.
 * Format: .{filename}.{pid}.tmp
 * Examples: .server.crt.12345.tmp, .api-key.54321.tmp
 */
const TEMP_FILE_PATTERN = /^\..+\.\d+\.tmp$/;

/**
 * Maximum age for backup files before cleanup (24 hours in milliseconds).
 */
const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Statistics from cleanup operation.
 */
export interface CleanupStats {
  tempFilesRemoved: number;
  backupFilesRemoved: number;
  errors: number;
}

/**
 * Clean up orphaned temporary and old backup files from specified directories.
 *
 * This should be called on agent startup to clean up files left behind by
 * crashed deployments. It removes:
 * - Temp files matching pattern .{name}.{pid}.tmp
 * - Backup files (*.bak) older than 24 hours
 *
 * @param directories - List of directories to scan for orphaned files
 * @returns Statistics about the cleanup operation
 */
export function cleanupOrphanedFiles(directories: string[]): CleanupStats {
  const stats: CleanupStats = {
    tempFilesRemoved: 0,
    backupFilesRemoved: 0,
    errors: 0,
  };

  // Deduplicate directories
  const uniqueDirs = [...new Set(directories)];

  for (const dir of uniqueDirs) {
    if (!dir) continue;

    // Check if directory exists
    if (!fs.existsSync(dir)) {
      log.debug({ dir }, 'Directory does not exist, skipping cleanup');
      continue;
    }

    try {
      const files = fs.readdirSync(dir);

      for (const file of files) {
        const filePath = path.join(dir, file);

        // Clean temp files from crashed processes
        if (TEMP_FILE_PATTERN.test(file)) {
          try {
            // Verify it's a file (not directory)
            const fileStat = fs.statSync(filePath);
            if (!fileStat.isFile()) continue;

            fs.unlinkSync(filePath);
            stats.tempFilesRemoved++;
            log.info({ path: filePath }, 'Cleaned up orphaned temp file');
          } catch (err) {
            stats.errors++;
            log.warn({ path: filePath, err }, 'Failed to clean orphaned temp file');
          }
        }

        // Clean old backup files (>24h)
        if (file.endsWith('.bak')) {
          try {
            const fileStat = fs.statSync(filePath);
            if (!fileStat.isFile()) continue;

            const ageMs = Date.now() - fileStat.mtimeMs;
            if (ageMs > MAX_BACKUP_AGE_MS) {
              fs.unlinkSync(filePath);
              stats.backupFilesRemoved++;
              log.info(
                { path: filePath, ageHours: Math.round(ageMs / (60 * 60 * 1000)) },
                'Cleaned up old backup file'
              );
            }
          } catch (err) {
            stats.errors++;
            log.warn({ path: filePath, err }, 'Failed to clean old backup file');
          }
        }
      }
    } catch (err) {
      stats.errors++;
      log.warn({ err, dir }, 'Failed to scan directory for orphaned files');
    }
  }

  if (stats.tempFilesRemoved > 0 || stats.backupFilesRemoved > 0) {
    log.info(
      {
        tempFilesRemoved: stats.tempFilesRemoved,
        backupFilesRemoved: stats.backupFilesRemoved,
        errors: stats.errors,
      },
      'Startup cleanup completed'
    );
  }

  return stats;
}

/**
 * Extract unique directories from certificate and secret target configurations.
 *
 * @param certTargets - Array of certificate targets with output paths
 * @param secretTargets - Array of secret targets with file paths
 * @returns Array of unique directory paths
 */
export function extractTargetDirectories(
  certTargets?: { outputs?: Record<string, string | undefined> }[],
  secretTargets?: { output?: string; filePath?: string }[]
): string[] {
  const directories = new Set<string>();

  // Extract directories from certificate targets
  if (certTargets) {
    for (const target of certTargets) {
      if (target.outputs) {
        for (const outputPath of Object.values(target.outputs)) {
          if (outputPath) {
            directories.add(path.dirname(outputPath));
          }
        }
      }
    }
  }

  // Extract directories from secret targets
  if (secretTargets) {
    for (const target of secretTargets) {
      const targetPath = target.output ?? target.filePath;
      if (targetPath) {
        directories.add(path.dirname(targetPath));
      }
    }
  }

  return [...directories];
}
