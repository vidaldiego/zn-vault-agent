// Path: src/lib/secret-file-manager.ts
// Manages secure secret files on tmpfs for passing secrets without env var logging

import fs from 'node:fs';
import path from 'node:path';
import { execLogger as log } from './logger.js';

/**
 * Default secrets directory (on tmpfs for security)
 */
const DEFAULT_SECRETS_DIR = '/run/zn-vault-agent/secrets';

/**
 * Manages secret files in a secure directory
 *
 * Security features:
 * - Files stored on tmpfs (never touch disk)
 * - Directory has 0700 permissions (root only)
 * - Files have 0600 permissions (root only)
 * - Files are cleaned up on process exit
 */
export class SecretFileManager {
  private readonly secretsDir: string;
  private readonly writtenFiles: Set<string> = new Set();
  private cleanupRegistered = false;

  constructor(secretsDir?: string) {
    this.secretsDir = secretsDir || process.env.ZNVAULT_SECRETS_DIR || DEFAULT_SECRETS_DIR;
  }

  /**
   * Initialize the secrets directory with secure permissions
   */
  async initialize(): Promise<void> {
    try {
      // Create parent directory if needed (/run/zn-vault-agent)
      const parentDir = path.dirname(this.secretsDir);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true, mode: 0o755 });
        log.debug({ path: parentDir }, 'Created parent directory');
      }

      // Create secrets directory with restricted permissions
      if (!fs.existsSync(this.secretsDir)) {
        fs.mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
        log.info({ path: this.secretsDir }, 'Created secrets directory');
      } else {
        // Ensure correct permissions on existing directory
        fs.chmodSync(this.secretsDir, 0o700);
      }

      // Verify we're on tmpfs (best effort check)
      this.verifyTmpfs();

      // Register cleanup handler
      this.registerCleanup();
    } catch (err) {
      log.error({ err, path: this.secretsDir }, 'Failed to initialize secrets directory');
      throw err;
    }
  }

  /**
   * Write a secret to a file
   * Returns the path to the file
   */
  async writeSecret(name: string, value: string): Promise<string> {
    const filePath = path.join(this.secretsDir, name);

    try {
      // Write with restricted permissions (0600 = owner read/write only)
      fs.writeFileSync(filePath, value, { mode: 0o600 });
      this.writtenFiles.add(filePath);

      log.debug({ name, path: filePath }, 'Wrote secret file');
      return filePath;
    } catch (err) {
      log.error({ err, name, path: filePath }, 'Failed to write secret file');
      throw err;
    }
  }

  /**
   * Read a secret from a file
   */
  async readSecret(name: string): Promise<string> {
    const filePath = path.join(this.secretsDir, name);

    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      log.error({ err, name, path: filePath }, 'Failed to read secret file');
      throw err;
    }
  }

  /**
   * Delete a specific secret file
   */
  async deleteSecret(name: string): Promise<void> {
    const filePath = path.join(this.secretsDir, name);

    try {
      if (fs.existsSync(filePath)) {
        // Overwrite with zeros before deletion (defense in depth)
        const stats = fs.statSync(filePath);
        fs.writeFileSync(filePath, Buffer.alloc(stats.size, 0));
        fs.unlinkSync(filePath);
        this.writtenFiles.delete(filePath);
        log.debug({ name, path: filePath }, 'Deleted secret file');
      }
    } catch (err) {
      log.warn({ err, name, path: filePath }, 'Failed to delete secret file');
    }
  }

  /**
   * Clean up all written secret files
   */
  async cleanup(): Promise<void> {
    log.debug({ count: this.writtenFiles.size }, 'Cleaning up secret files');

    for (const filePath of this.writtenFiles) {
      try {
        if (fs.existsSync(filePath)) {
          // Overwrite with zeros before deletion
          const stats = fs.statSync(filePath);
          fs.writeFileSync(filePath, Buffer.alloc(stats.size, 0));
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        log.warn({ err, path: filePath }, 'Failed to cleanup secret file');
      }
    }

    this.writtenFiles.clear();
  }

  /**
   * Get the secrets directory path
   */
  getSecretsDir(): string {
    return this.secretsDir;
  }

  /**
   * List all secret files
   */
  listSecrets(): string[] {
    try {
      return fs.readdirSync(this.secretsDir);
    } catch {
      return [];
    }
  }

  /**
   * Verify the secrets directory is on tmpfs (best effort)
   */
  private verifyTmpfs(): void {
    // On Linux, /run is typically tmpfs
    if (process.platform === 'linux') {
      if (!this.secretsDir.startsWith('/run/') &&
          !this.secretsDir.startsWith('/dev/shm/') &&
          !this.secretsDir.startsWith('/tmp/')) {
        log.warn(
          { path: this.secretsDir },
          'Secrets directory may not be on tmpfs - secrets could be written to disk'
        );
      }
    }
  }

  /**
   * Register cleanup handler for process exit
   */
  private registerCleanup(): void {
    if (this.cleanupRegistered) return;

    const cleanup = (): void => {
      this.cleanup().catch(() => {
        // Ignore errors during shutdown
      });
    };

    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });

    this.cleanupRegistered = true;
  }
}

// Singleton instance for shared use
let defaultManager: SecretFileManager | null = null;

/**
 * Get the default SecretFileManager instance
 */
export function getSecretFileManager(): SecretFileManager {
  if (!defaultManager) {
    defaultManager = new SecretFileManager();
  }
  return defaultManager;
}

/**
 * Initialize the default SecretFileManager
 */
export async function initializeSecretFiles(): Promise<SecretFileManager> {
  const manager = getSecretFileManager();
  await manager.initialize();
  return manager;
}
