// Path: src/plugins/storage.ts
// Persistent key-value storage for plugins

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../lib/logger.js';
import type { PluginStorage } from './types.js';

const log = createLogger({ module: 'plugin-storage' });

/**
 * Get storage directory for plugins
 * Uses /etc/zn-vault-agent/plugins/ for system config or ~/.zn-vault-agent/plugins/ for user
 */
function getStorageDir(): string {
  const customDir = process.env.ZNVAULT_AGENT_CONFIG_DIR;
  if (customDir) {
    return path.join(customDir, 'plugin-data');
  }

  // System config dir
  const systemDir = '/etc/zn-vault-agent/plugin-data';
  if (process.getuid?.() === 0 || fs.existsSync('/etc/zn-vault-agent')) {
    return systemDir;
  }

  // User config dir
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(homeDir, '.zn-vault-agent', 'plugin-data');
}

/**
 * Storage file cache to avoid repeated disk reads
 */
const storageCache = new Map<string, Record<string, unknown>>();

/**
 * Get storage file path for a plugin
 */
function getStoragePath(pluginName: string): string {
  const storageDir = getStorageDir();
  // Sanitize plugin name for filename
  const safeName = pluginName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(storageDir, `${safeName}.json`);
}

/**
 * Ensure storage directory exists
 */
function ensureStorageDir(): void {
  const storageDir = getStorageDir();
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    log.debug({ storageDir }, 'Created plugin storage directory');
  }
}

/**
 * Load storage data from disk
 */
function loadStorageData(pluginName: string): Record<string, unknown> {
  // Check cache first
  if (storageCache.has(pluginName)) {
    return storageCache.get(pluginName)!;
  }

  const storagePath = getStoragePath(pluginName);

  if (!fs.existsSync(storagePath)) {
    const empty: Record<string, unknown> = {};
    storageCache.set(pluginName, empty);
    return empty;
  }

  try {
    const content = fs.readFileSync(storagePath, 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;
    storageCache.set(pluginName, data);
    return data;
  } catch (err) {
    log.warn({ err, pluginName, path: storagePath }, 'Failed to load plugin storage');
    const empty: Record<string, unknown> = {};
    storageCache.set(pluginName, empty);
    return empty;
  }
}

/**
 * Save storage data to disk
 */
function saveStorageData(pluginName: string, data: Record<string, unknown>): void {
  ensureStorageDir();
  const storagePath = getStoragePath(pluginName);

  try {
    // Atomic write with temp file
    const tempPath = `${storagePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, storagePath);
    storageCache.set(pluginName, data);
    log.debug({ pluginName, path: storagePath }, 'Plugin storage saved');
  } catch (err) {
    log.error({ err, pluginName, path: storagePath }, 'Failed to save plugin storage');
    throw err;
  }
}

/**
 * Create a PluginStorage instance for a specific plugin
 */
export function getPluginStorage(pluginName: string): PluginStorage {
  return {
    get<T>(key: string): T | undefined {
      const data = loadStorageData(pluginName);
      return data[key] as T | undefined;
    },

    set<T>(key: string, value: T): void {
      const data = loadStorageData(pluginName);
      data[key] = value as unknown;
      saveStorageData(pluginName, data);
    },

    delete(key: string): void {
      const data = loadStorageData(pluginName);
      delete data[key];
      saveStorageData(pluginName, data);
    },

    clear(): void {
      saveStorageData(pluginName, {});
    },

    has(key: string): boolean {
      const data = loadStorageData(pluginName);
      return key in data;
    },

    keys(): string[] {
      const data = loadStorageData(pluginName);
      return Object.keys(data);
    },
  };
}

/**
 * Delete all storage for a plugin (for uninstall/cleanup)
 */
export function deletePluginStorage(pluginName: string): void {
  const storagePath = getStoragePath(pluginName);
  storageCache.delete(pluginName);

  if (fs.existsSync(storagePath)) {
    try {
      fs.unlinkSync(storagePath);
      log.debug({ pluginName, path: storagePath }, 'Plugin storage deleted');
    } catch (err) {
      log.warn({ err, pluginName, path: storagePath }, 'Failed to delete plugin storage');
    }
  }
}

/**
 * List all plugins with storage
 */
export function listPluginsWithStorage(): string[] {
  const storageDir = getStorageDir();

  if (!fs.existsSync(storageDir)) {
    return [];
  }

  try {
    const files = fs.readdirSync(storageDir);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/**
 * Clear storage cache (for testing)
 */
export function clearStorageCache(): void {
  storageCache.clear();
}
