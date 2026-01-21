// Path: src/utils/file.ts
// Atomic file write utilities - prevent partial writes and ensure data integrity

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chownSafe } from './shell.js';
import { validateOutputPath } from './path.js';

export interface AtomicWriteOptions {
  /**
   * File permissions (octal number, e.g., 0o640).
   * Defaults to 0o640.
   */
  mode?: number;

  /**
   * File owner in "user" or "user:group" format.
   * Only applied when running as root.
   */
  owner?: string;

  /**
   * Force sync to disk before rename (fsync).
   * Recommended for critical data.
   * Defaults to false.
   */
  fsync?: boolean;

  /**
   * Create parent directories if they don't exist.
   * Defaults to true.
   */
  createDirs?: boolean;

  /**
   * Mode for created parent directories.
   * Defaults to 0o750.
   */
  dirMode?: number;

  /**
   * Create backup of existing file before write.
   * Backup will be at filePath + '.backup'.
   * Defaults to false.
   */
  backup?: boolean;

  /**
   * Verify written content by re-reading and comparing hash.
   * Defaults to false.
   */
  verify?: boolean;
}

const DEFAULT_OPTIONS: Required<Omit<AtomicWriteOptions, 'owner'>> & { owner?: string } = {
  mode: 0o640,
  owner: undefined,
  fsync: false,
  createDirs: true,
  dirMode: 0o750,
  backup: false,
  verify: false,
};

/**
 * Write content to a file atomically.
 *
 * Uses temp file + rename pattern to ensure the file is either
 * fully written or not modified at all.
 *
 * @param filePath - Absolute path to target file
 * @param content - Content to write (string or Buffer)
 * @param options - Write options
 * @returns Hash of written content (SHA-256)
 */
export function writeAtomic(
  filePath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {}
): string {
  // Validate path
  validateOutputPath(filePath);

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const dir = path.dirname(filePath);
  const tempPath = `${filePath}.tmp.${process.pid}`;
  const backupPath = `${filePath}.backup`;

  // Create directory if needed
  if (opts.createDirs && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: opts.dirMode });
  }

  // Create backup if requested and file exists
  if (opts.backup && fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch {
      // Non-fatal, continue without backup
    }
  }

  try {
    // Write to temp file
    if (opts.fsync) {
      // Use low-level API for fsync control
      const fd = fs.openSync(tempPath, 'w', opts.mode);
      try {
        // Handle both string and Buffer content
        if (typeof content === 'string') {
          fs.writeSync(fd, content);
        } else {
          fs.writeSync(fd, content, 0, content.length);
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      fs.writeFileSync(tempPath, content, { mode: opts.mode });
    }

    // Verify if requested
    if (opts.verify) {
      const written = fs.readFileSync(tempPath);
      const expectedHash = hashContent(content);
      const actualHash = hashContent(written);
      if (expectedHash !== actualHash) {
        throw new Error('Write verification failed: content mismatch');
      }
    }

    // Apply ownership if specified and running as root
    if (opts.owner && process.getuid?.() === 0) {
      try {
        chownSafe(tempPath, opts.owner);
      } catch {
        // Non-fatal, ownership may fail but file write succeeded
      }
    }

    // Atomic rename
    fs.renameSync(tempPath, filePath);

    return hashContent(content);
  } catch (err) {
    // Clean up temp file on error
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Write content atomically with full durability guarantees.
 * This is the paranoid version with fsync, verification, and backup.
 *
 * @param filePath - Absolute path to target file
 * @param content - Content to write
 * @param options - Additional options
 * @returns Hash of written content
 */
export function writeAtomicDurable(
  filePath: string,
  content: string | Buffer,
  options: Omit<AtomicWriteOptions, 'fsync' | 'verify' | 'backup'> = {}
): string {
  return writeAtomic(filePath, content, {
    ...options,
    fsync: true,
    verify: true,
    backup: true,
  });
}

/**
 * Calculate SHA-256 hash of content.
 *
 * @param content - Content to hash
 * @returns Hex-encoded hash
 */
export function hashContent(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Verify a file matches expected hash.
 *
 * @param filePath - Path to file
 * @param expectedHash - Expected SHA-256 hash
 * @returns true if file matches hash
 */
export function verifyFile(filePath: string, expectedHash: string): boolean {
  try {
    const content = fs.readFileSync(filePath);
    return hashContent(content) === expectedHash;
  } catch {
    return false;
  }
}

/**
 * Recover file from backup if main file is corrupted or missing.
 *
 * @param filePath - Path to main file
 * @param validator - Optional function to validate content
 * @returns Recovered content or null
 */
export function recoverFromBackup(
  filePath: string,
  validator?: (content: string) => boolean
): string | null {
  const backupPath = `${filePath}.backup`;

  if (!fs.existsSync(backupPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(backupPath, 'utf-8');

    // Validate content if validator provided
    if (validator && !validator(content)) {
      return null;
    }

    return content;
  } catch {
    return null;
  }
}

/**
 * Clean up temp and backup files for a given path.
 *
 * @param filePath - Main file path
 */
export function cleanupTempFiles(filePath: string): void {
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);

  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith(`${basename}.tmp.`) || file === `${basename}.backup`) {
        try {
          fs.unlinkSync(path.join(dir, file));
        } catch {
          // Ignore individual cleanup errors
        }
      }
    }
  } catch {
    // Ignore directory read errors
  }
}

/**
 * Ensure a directory exists with proper permissions.
 *
 * @param dirPath - Directory path
 * @param mode - Directory mode (default: 0o750)
 * @param owner - Optional owner in "user:group" format
 */
export function ensureDir(
  dirPath: string,
  mode: number = 0o750,
  owner?: string
): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode });
  }

  if (owner && process.getuid?.() === 0) {
    try {
      chownSafe(dirPath, owner);
    } catch {
      // Non-fatal
    }
  }
}
