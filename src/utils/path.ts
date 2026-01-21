// Path: src/utils/path.ts
// Path traversal protection utilities

import path from 'node:path';

/**
 * Check if a path is safe (no traversal attempts).
 * Detects:
 * - Directory traversal (../)
 * - Null bytes (\0)
 *
 * @param userPath - Path to validate
 * @returns true if path is safe
 */
export function isPathSafe(userPath: string): boolean {
  // Check for null bytes (can be used to truncate paths in some systems)
  if (userPath.includes('\0')) {
    return false;
  }

  // Normalize and check for directory traversal
  const normalized = path.normalize(userPath);

  // Check if normalized path contains ..
  // This catches cases like "../", "/../", "..\", etc.
  if (normalized.includes('..')) {
    return false;
  }

  return true;
}

/**
 * Validate an output path for file operations.
 * Throws if the path is invalid or contains traversal attempts.
 *
 * @param filePath - Path to validate
 * @throws Error if path is invalid
 */
export function validateOutputPath(filePath: string): void {
  if (!filePath) {
    throw new Error('Path cannot be empty');
  }

  if (!path.isAbsolute(filePath)) {
    throw new Error(`Path must be absolute: ${filePath}`);
  }

  if (!isPathSafe(filePath)) {
    throw new Error(`Invalid path (potential traversal): ${filePath}`);
  }
}

/**
 * Safely join paths with traversal protection.
 * The resulting path is validated to not escape the base directory.
 *
 * @param basePath - Base directory (must be absolute)
 * @param userPath - User-provided path component
 * @returns Joined and validated path
 * @throws Error if the result would escape basePath
 */
export function safeJoinPath(basePath: string, userPath: string): string {
  if (!path.isAbsolute(basePath)) {
    throw new Error(`Base path must be absolute: ${basePath}`);
  }

  // Resolve the user path relative to base
  const resolved = path.resolve(basePath, userPath);

  // Ensure the resolved path is still under basePath
  const normalizedBase = path.normalize(basePath);
  const normalizedResolved = path.normalize(resolved);

  if (!normalizedResolved.startsWith(normalizedBase + path.sep) &&
      normalizedResolved !== normalizedBase) {
    throw new Error(`Path escapes base directory: ${userPath}`);
  }

  return resolved;
}

/**
 * Validate that a path doesn't contain any dangerous characters.
 * This is an additional layer of protection for paths that will be used
 * in contexts where special characters could cause issues.
 *
 * @param filePath - Path to validate
 * @returns true if path contains only safe characters
 */
export function hasSafeCharacters(filePath: string): boolean {
  // Allow alphanumeric, -, _, ., /, and space
  // Disallow shell metacharacters and other potentially dangerous chars
  const dangerousPattern = /[`$|;&<>(){}[\]\\'"!#%^*?~]/;
  return !dangerousPattern.test(filePath);
}

/**
 * Sanitize a filename by removing or replacing dangerous characters.
 * Use this for user-provided filenames that need to be safe.
 *
 * @param filename - Filename to sanitize
 * @returns Sanitized filename
 */
export function sanitizeFilename(filename: string): string {
  // Remove null bytes
  let safe = filename.replace(/\0/g, '');

  // Replace dangerous characters with underscore
  safe = safe.replace(/[`$|;&<>(){}[\]\\'"!#%^*?~]/g, '_');

  // Remove any directory separators
  safe = safe.replace(/[/\\]/g, '_');

  // Collapse multiple underscores
  safe = safe.replace(/_+/g, '_');

  // Remove leading/trailing underscores and dots
  safe = safe.replace(/^[._]+|[._]+$/g, '');

  return safe || 'unnamed';
}
