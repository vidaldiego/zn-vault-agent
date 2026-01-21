// Path: src/utils/shell.ts
// Safe shell execution utilities - prevent command injection

import { execFileSync } from 'node:child_process';

/**
 * Safely change file ownership using execFileSync (no shell invocation).
 * Prevents command injection by not using string interpolation in a shell.
 *
 * @param filePath - Path to the file
 * @param owner - Owner in "user" or "user:group" format
 */
export function chownSafe(filePath: string, owner: string): void {
  const [user, group] = owner.split(':');
  const args = group ? [`${user}:${group}`, filePath] : [user, filePath];
  execFileSync('chown', args, { stdio: 'pipe' });
}

/**
 * Safely change file permissions using execFileSync (no shell invocation).
 * Prevents command injection by not using string interpolation in a shell.
 *
 * @param filePath - Path to the file
 * @param mode - Permission mode (e.g., "0640", "0600")
 */
export function chmodSafe(filePath: string, mode: string): void {
  execFileSync('chmod', [mode, filePath], { stdio: 'pipe' });
}

/**
 * Safely run useradd for system user creation.
 * Prevents command injection by not using string interpolation in a shell.
 *
 * @param username - Username to create
 * @param options - Additional options
 */
export function useraddSafe(username: string, options: {
  system?: boolean;
  noCreateHome?: boolean;
  shell?: string;
} = {}): void {
  const args: string[] = [];

  if (options.system) {
    args.push('--system');
  }
  if (options.noCreateHome) {
    args.push('--no-create-home');
  }
  if (options.shell) {
    args.push('--shell', options.shell);
  }

  args.push(username);
  execFileSync('useradd', args, { stdio: 'inherit' });
}

/**
 * Safely check if a user exists.
 * Prevents command injection by not using string interpolation in a shell.
 *
 * @param username - Username to check
 * @returns true if user exists
 */
export function userExists(username: string): boolean {
  try {
    execFileSync('id', [username], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely run systemctl commands.
 * Prevents command injection by not using string interpolation in a shell.
 *
 * @param action - Action to perform (start, stop, enable, disable, daemon-reload)
 * @param serviceName - Optional service name
 */
export function systemctlSafe(action: string, serviceName?: string): void {
  const args = serviceName ? [action, serviceName] : [action];
  execFileSync('systemctl', args, { stdio: 'inherit' });
}

/**
 * Safely run systemctl commands with suppressed output.
 * Prevents command injection by not using string interpolation in a shell.
 *
 * @param action - Action to perform (start, stop, enable, disable)
 * @param serviceName - Service name
 */
export function systemctlSafeQuiet(action: string, serviceName: string): void {
  execFileSync('systemctl', [action, serviceName], { stdio: 'pipe' });
}

/**
 * Safely remove a directory recursively.
 * Prevents command injection by not using string interpolation in a shell.
 *
 * @param dirPath - Directory path to remove
 */
export function rmDirSafe(dirPath: string): void {
  execFileSync('rm', ['-rf', dirPath], { stdio: 'inherit' });
}

/**
 * Safely find the path to a command.
 * Prevents command injection by not using string interpolation in a shell.
 *
 * @param commandName - Command name to find
 * @returns Path to command or null if not found
 */
export function whichSafe(commandName: string): string | null {
  try {
    const result = execFileSync('which', [commandName], { encoding: 'utf-8', stdio: 'pipe' });
    return result.trim();
  } catch {
    return null;
  }
}
