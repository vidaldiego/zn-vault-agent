// Path: src/lib/secret-env/env-file.ts
// Environment file parsing and updating functions

import fs from 'node:fs';
import path from 'node:path';
import { execLogger as log } from '../logger.js';
import type { SecretMapping } from './types.js';

/**
 * Escape a value for use in an env file
 * Format: KEY="value with escaped \"quotes\""
 */
function escapeEnvValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Parse an env file into a Map of key-value pairs
 * Handles:
 *   KEY=value
 *   KEY="quoted value"
 *   KEY="value with \"escaped\" quotes"
 *   # comments
 *   export KEY=value
 */
function parseEnvFile(content: string): Map<string, { value: string; quoted: boolean; hasExport: boolean }> {
  const result = new Map<string, { value: string; quoted: boolean; hasExport: boolean }>();
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Handle export prefix
    let hasExport = false;
    let processLine = trimmed;
    if (processLine.startsWith('export ')) {
      hasExport = true;
      processLine = processLine.substring(7).trim();
    }

    // Find the = sign
    const eqIndex = processLine.indexOf('=');
    if (eqIndex === -1) continue;

    const key = processLine.substring(0, eqIndex).trim();
    let value = processLine.substring(eqIndex + 1);

    // Check if value is quoted
    let quoted = false;
    if (value.startsWith('"') && value.endsWith('"')) {
      quoted = true;
      value = value.substring(1, value.length - 1);
      // Unescape quotes
      value = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (value.startsWith("'") && value.endsWith("'")) {
      quoted = true;
      value = value.substring(1, value.length - 1);
    }

    result.set(key, { value, quoted, hasExport });
  }

  return result;
}

/**
 * Serialize an env Map back to file content
 */
function serializeEnvFile(entries: Map<string, { value: string; quoted: boolean; hasExport: boolean }>): string {
  const lines: string[] = [];

  for (const [key, { value, quoted, hasExport }] of entries) {
    const exportPrefix = hasExport ? 'export ' : '';
    if (quoted) {
      lines.push(`${exportPrefix}${key}="${escapeEnvValue(value)}"`);
    } else {
      // Check if value needs quoting (contains spaces, special chars, etc.)
      const needsQuotes = /[\s"'$`\\]/.test(value);
      if (needsQuotes) {
        lines.push(`${exportPrefix}${key}="${escapeEnvValue(value)}"`);
      } else {
        lines.push(`${exportPrefix}${key}=${value}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Update a specific key's value in an env file
 * Uses atomic write (temp file + rename) to prevent corruption
 *
 * @param filePath - Path to the env file
 * @param envVar - Environment variable name to update
 * @param newValue - New value for the environment variable
 * @returns true if the file was updated, false if the key was added
 */
export function updateEnvFile(
  filePath: string,
  envVar: string,
  newValue: string
): { updated: boolean; added: boolean } {
  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);
  const tempPath = `${resolvedPath}.tmp.${Date.now()}.${process.pid}`;

  log.debug({ filePath: resolvedPath, envVar }, 'Updating env file');

  try {
    // Read existing file (may not exist yet)
    let content = '';
    let existingMode = 0o600;
    try {
      content = fs.readFileSync(resolvedPath, 'utf-8');
      const stats = fs.statSync(resolvedPath);
      existingMode = stats.mode & 0o777;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') throw err;
      // File doesn't exist, we'll create it
    }

    // Parse existing content
    const entries = parseEnvFile(content);

    // Check if key exists
    const existing = entries.get(envVar);
    const added = !existing;

    // Update or add the key
    entries.set(envVar, {
      value: newValue,
      quoted: true, // Always quote new values for safety
      hasExport: existing?.hasExport ?? false,
    });

    // Serialize back to content
    const newContent = serializeEnvFile(entries);

    // Ensure directory exists
    fs.mkdirSync(dir, { recursive: true });

    // Write to temp file
    fs.writeFileSync(tempPath, newContent, { mode: existingMode });

    // Atomic rename
    fs.renameSync(tempPath, resolvedPath);

    log.info({
      filePath: resolvedPath,
      envVar,
      valuePrefix: newValue.substring(0, 8),
      added,
    }, 'Env file updated successfully');

    return { updated: !added, added };
  } catch (err) {
    // Clean up temp file if it exists
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }

    log.error({ err, filePath: resolvedPath, envVar }, 'Failed to update env file');
    throw err;
  }
}

/**
 * Update multiple keys in an env file atomically
 *
 * @param filePath - Path to the env file
 * @param updates - Map of envVar -> newValue
 * @returns Summary of updates
 */
export function updateEnvFileMultiple(
  filePath: string,
  updates: Record<string, string>
): { updated: number; added: number } {
  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);
  const tempPath = `${resolvedPath}.tmp.${Date.now()}.${process.pid}`;

  log.debug({ filePath: resolvedPath, keys: Object.keys(updates) }, 'Updating env file with multiple keys');

  let updated = 0;
  let added = 0;

  try {
    // Read existing file
    let content = '';
    let existingMode = 0o600;
    try {
      content = fs.readFileSync(resolvedPath, 'utf-8');
      const stats = fs.statSync(resolvedPath);
      existingMode = stats.mode & 0o777;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') throw err;
    }

    // Parse existing content
    const entries = parseEnvFile(content);

    // Update each key
    for (const [envVar, newValue] of Object.entries(updates)) {
      const existing = entries.get(envVar);
      if (existing) {
        updated++;
      } else {
        added++;
      }

      entries.set(envVar, {
        value: newValue,
        quoted: true,
        hasExport: existing?.hasExport ?? false,
      });
    }

    // Serialize back
    const newContent = serializeEnvFile(entries);

    // Ensure directory exists
    fs.mkdirSync(dir, { recursive: true });

    // Atomic write
    fs.writeFileSync(tempPath, newContent, { mode: existingMode });
    fs.renameSync(tempPath, resolvedPath);

    log.info({
      filePath: resolvedPath,
      updated,
      added,
    }, 'Env file updated with multiple keys');

    return { updated, added };
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Ignore
    }

    log.error({ err, filePath: resolvedPath }, 'Failed to update env file');
    throw err;
  }
}

/**
 * Find which env var(s) in a file map to a specific API key name
 * This is used when handling rotation events to know which env vars to update
 *
 * @param mappings - The secret mappings from exec config
 * @param apiKeyName - The managed API key name from the rotation event
 * @returns Array of env var names that use this API key
 */
export function findEnvVarsForApiKey(
  mappings: (SecretMapping & { literal?: string })[],
  apiKeyName: string
): string[] {
  return mappings
    .filter(m => m.apiKeyName === apiKeyName)
    .map(m => m.envVar);
}
