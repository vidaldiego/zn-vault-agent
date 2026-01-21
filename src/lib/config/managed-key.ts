// Path: src/lib/config/managed-key.ts
// Managed API key operations

import fs from 'node:fs';
import path from 'node:path';
import { configLogger as log } from '../logger.js';
import { chownSafe } from '../../utils/shell.js';
import { validateOutputPath } from '../../utils/path.js';
import { loadConfig } from './loader.js';
import { saveConfig } from './saver.js';

/**
 * Write managed key to file using paranoid-level durability guarantees.
 * This is a CRITICAL operation - failures must be logged and thrown.
 *
 * Durability pattern:
 * 1. Create backup of existing file (if present)
 * 2. Write to temp file using open/write/fsync/close (ensures data on disk)
 * 3. Verify temp file contents
 * 4. Apply permissions/ownership to temp file
 * 5. Atomic rename temp to target (POSIX guarantees atomicity)
 *
 * Recovery guarantees:
 * - Power failure during write: original file intact, temp may exist
 * - Power failure after fsync but before rename: original intact, temp valid
 * - Corruption of main file: backup available at .backup
 */
function writeManagedKeyToFile(
  filePath: string,
  key: string,
  options?: { owner?: string; mode?: string }
): void {
  // Validate path to prevent traversal attacks
  validateOutputPath(filePath);

  const dir = path.dirname(filePath);
  const tempPath = `${filePath}.tmp.${process.pid}`;
  const backupPath = `${filePath}.backup`;

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    log.debug({ dir }, 'Created directory for managed key file');
  }

  try {
    // Step 1: Create backup of existing file (if present and valid)
    if (fs.existsSync(filePath)) {
      try {
        const currentKey = fs.readFileSync(filePath, 'utf-8');
        // Only backup if current file has valid content (not empty/corrupted)
        if (currentKey.startsWith('znv_')) {
          fs.copyFileSync(filePath, backupPath);
          // Apply same permissions to backup
          if (options?.mode) {
            fs.chmodSync(backupPath, parseInt(options.mode, 8));
          }
          log.debug({ backupPath }, 'Created backup of existing key file');
        }
      } catch (backupErr) {
        // Non-fatal - continue without backup
        log.warn({ backupPath, err: backupErr }, 'Failed to create backup (continuing)');
      }
    }

    // Step 2: Write to temp file with fsync for durability
    // Using open/write/fsync/close instead of writeFileSync ensures data is on disk
    const fd = fs.openSync(tempPath, 'w', 0o640);
    try {
      fs.writeSync(fd, key);
      fs.fsyncSync(fd); // Force data to disk - critical for durability
    } finally {
      fs.closeSync(fd);
    }

    // Step 3: Verify temp file contents before rename
    const written = fs.readFileSync(tempPath, 'utf-8');
    if (written !== key) {
      throw new Error('Temp file verification failed: written content doesn\'t match');
    }

    // Step 4: Apply custom mode if specified
    if (options?.mode) {
      const mode = parseInt(options.mode, 8);
      fs.chmodSync(tempPath, mode);
    }

    // Step 5: Apply ownership if specified and running as root (using safe chown)
    if (options?.owner && process.getuid?.() === 0) {
      try {
        chownSafe(tempPath, options.owner);
        log.debug({ path: tempPath, owner: options.owner }, 'Applied ownership to managed key file');
      } catch (err) {
        log.warn({ path: tempPath, owner: options.owner, err }, 'Failed to set temp file ownership');
        // Continue - ownership will be inherited or can be fixed manually
      }
    }

    // Step 6: Atomic rename (POSIX guarantees this is atomic)
    fs.renameSync(tempPath, filePath);

    log.info({ path: filePath }, 'Managed key written with fsync and verified');
  } catch (err) {
    // Clean up temp file on failure
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }

    log.error({ path: filePath, err }, 'CRITICAL: Managed key file write FAILED');
    throw err;
  }
}

/**
 * Attempt to recover key from backup file if main file is missing/corrupted.
 * Returns the recovered key or null if recovery not possible.
 */
function recoverKeyFromBackup(filePath: string): string | null {
  const backupPath = `${filePath}.backup`;

  if (!fs.existsSync(backupPath)) {
    return null;
  }

  try {
    const backupKey = fs.readFileSync(backupPath, 'utf-8');
    if (backupKey.startsWith('znv_')) {
      log.warn({ backupPath }, 'Recovered key from backup file');
      return backupKey;
    }
  } catch (err) {
    log.error({ backupPath, err }, 'Failed to read backup file');
  }

  return null;
}

/**
 * Update managed key configuration after bind
 * Stores the new key value and rotation metadata
 *
 * IMPORTANT: Also updates process.env.ZNVAULT_API_KEY to ensure that
 * subsequent calls to loadConfig() return the new key, even if the
 * agent was started with the env var set (which would otherwise override
 * the config file value).
 */
export function updateManagedKey(
  newKey: string,
  metadata: {
    nextRotationAt?: string;
    graceExpiresAt?: string;
    rotationMode?: 'scheduled' | 'on-use' | 'on-bind';
  }
): void {
  const config = loadConfig();

  if (!config.managedKey?.name) {
    log.warn('updateManagedKey called but no managed key configured');
    return;
  }

  // Update the API key value
  config.auth.apiKey = newKey;

  // Update managed key metadata
  config.managedKey.nextRotationAt = metadata.nextRotationAt;
  config.managedKey.graceExpiresAt = metadata.graceExpiresAt;
  config.managedKey.rotationMode = metadata.rotationMode;
  config.managedKey.lastBind = new Date().toISOString();

  saveConfig(config);

  // CRITICAL: Also update the environment variable so that subsequent
  // loadConfig() calls return the new key. Without this, if the agent
  // was started with ZNVAULT_API_KEY env var, loadConfig() would continue
  // returning the old key even after saveConfig() writes the new one.
  process.env.ZNVAULT_API_KEY = newKey;

  // CRITICAL: Write key to file if filePath is configured
  // This ensures apps that read from file always have the current key
  if (config.managedKey.filePath) {
    try {
      writeManagedKeyToFile(config.managedKey.filePath, newKey, {
        owner: config.managedKey.fileOwner,
        mode: config.managedKey.fileMode,
      });
    } catch (err) {
      // Log but don't throw - config.json is already updated
      // Plugin will auto-fix on next health check or startup
      log.error({
        err,
        filePath: config.managedKey.filePath,
      }, 'CRITICAL: Failed to write managed key to file');
    }
  }

  log.info({
    managedKeyName: config.managedKey.name,
    nextRotationAt: metadata.nextRotationAt,
    filePath: config.managedKey.filePath,
  }, 'Managed key config updated');
}

/**
 * Check if using managed key mode
 */
export function isManagedKeyMode(): boolean {
  const config = loadConfig();
  return !!config.managedKey?.name;
}

/**
 * Verify and sync managed key file on startup.
 * Includes backup recovery if main file is corrupted/missing.
 * Returns true if file was in sync or successfully synced, false if sync failed.
 */
export function syncManagedKeyFile(): { synced: boolean; wasOutOfSync: boolean; recoveredFromBackup?: boolean; error?: string } {
  const config = loadConfig();

  if (!config.managedKey?.filePath) {
    return { synced: true, wasOutOfSync: false };
  }

  if (!config.auth.apiKey) {
    return { synced: false, wasOutOfSync: true, error: 'No API key in config' };
  }

  const filePath = config.managedKey.filePath;
  const expectedKey = config.auth.apiKey;

  // Check if file exists and matches
  let currentKey: string | null = null;
  try {
    if (fs.existsSync(filePath)) {
      currentKey = fs.readFileSync(filePath, 'utf-8');
    }
  } catch (err) {
    log.warn({ path: filePath, err }, 'Failed to read managed key file');
  }

  if (currentKey === expectedKey) {
    log.info({ path: filePath }, 'Managed key file verified - in sync');
    return { synced: true, wasOutOfSync: false };
  }

  // File is out of sync - try backup recovery first
  if (!currentKey?.startsWith('znv_')) {
    const backupKey = recoverKeyFromBackup(filePath);
    if (backupKey === expectedKey) {
      // Backup matches expected key - restore from backup
      log.info({ path: filePath }, 'Backup matches expected key - restoring');
      try {
        writeManagedKeyToFile(filePath, backupKey, {
          owner: config.managedKey.fileOwner,
          mode: config.managedKey.fileMode,
        });
        return { synced: true, wasOutOfSync: true, recoveredFromBackup: true };
      } catch (err) {
        log.error({ path: filePath, err }, 'Failed to restore from backup');
        // Fall through to write expected key
      }
    } else if (backupKey) {
      log.warn({
        backupPrefix: backupKey.substring(0, 20),
        expectedPrefix: expectedKey.substring(0, 20),
      }, 'Backup exists but does not match expected key - using expected key');
    }
  }

  // File is out of sync - fix it with expected key
  log.warn({
    path: filePath,
    expectedPrefix: expectedKey.substring(0, 20),
    currentPrefix: currentKey?.substring(0, 20) ?? '(missing)',
  }, 'Managed key file OUT OF SYNC - auto-fixing');

  try {
    writeManagedKeyToFile(filePath, expectedKey, {
      owner: config.managedKey.fileOwner,
      mode: config.managedKey.fileMode,
    });
    log.info({ path: filePath }, 'Managed key file auto-fixed');
    return { synced: true, wasOutOfSync: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ path: filePath, err }, 'CRITICAL: Failed to auto-fix managed key file');
    return { synced: false, wasOutOfSync: true, error };
  }
}
