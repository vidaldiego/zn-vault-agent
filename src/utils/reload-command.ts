// Path: src/utils/reload-command.ts
// Terminal, process-group-scoped execution for certificate/secret reload hooks.

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const GROUP_POLL_MS = 25;

export interface ReloadCommandOptions {
  timeoutMs?: number;
  terminationGraceMs?: number;
  operationLabel?: string;
}

export interface ReloadCommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  message: string;
}

const isErrno = (error: unknown, code: string): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === code;

const appendBounded = (current: Buffer, chunk: Buffer): Buffer => {
  if (current.byteLength >= MAX_OUTPUT_BYTES) return current;
  return Buffer.concat([
    current,
    chunk.subarray(0, MAX_OUTPUT_BYTES - current.byteLength),
  ]);
};

/**
 * Execute an operator-configured reload command in its own process group.
 *
 * The advertised timeout includes the TERM-to-KILL grace period. Completion is
 * reported only after the shell has closed and the entire process group is
 * gone, so a background or resistant descendant cannot outlive the shared
 * mutation lock.
 */
export async function runProcessGroupCommand(
  executable: string,
  args: string[],
  options: ReloadCommandOptions = {}
): Promise<ReloadCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs
    ?? Math.min(DEFAULT_TERMINATION_GRACE_MS, timeoutMs / 4);
  const operationLabel = options.operationLabel ?? 'Command';
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Reload command timeout must be a positive finite number');
  }
  if (
    !Number.isFinite(terminationGraceMs) ||
    terminationGraceMs < 0 ||
    terminationGraceMs >= timeoutMs
  ) {
    throw new Error('Reload command termination grace must be finite, non-negative, and less than timeout');
  }

  return new Promise<ReloadCommandResult>((resolve) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const startedAt = performance.now();
    const terminateAtMs = timeoutMs - terminationGraceMs;
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let leaderClosed = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let timedOut = false;
    let spawnError: Error | undefined;
    let settled = false;

    const groupExists = (): boolean => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return isErrno(error, 'EPERM');
      }
    };

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!isErrno(error, 'ESRCH')) {
          stderr = appendBounded(
            stderr,
            Buffer.from(`\nFailed to signal reload process group: ${String(error)}`)
          );
        }
      }
    };

    const cleanup = (): void => {
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      if (groupPoll) clearInterval(groupPoll);
    };

    const finishIfTerminal = (): void => {
      if (settled || !leaderClosed || groupExists()) return;
      settled = true;
      cleanup();
      const stdoutText = stdout.toString('utf8');
      const stderrText = stderr.toString('utf8');
      const success = !spawnError && !timedOut && exitCode === 0;
      const message = spawnError?.message
        ?? (timedOut
          ? `${operationLabel} timed out after ${timeoutMs}ms`
          : success
            ? `${operationLabel} completed successfully`
            : `${operationLabel} failed with ${exitSignal ?? `exit code ${exitCode ?? 'unknown'}`}`);
      resolve({
        success,
        stdout: stdoutText,
        stderr: stderrText,
        exitCode,
        signal: exitSignal,
        timedOut,
        message,
      });
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', (error) => {
      spawnError = error;
      leaderClosed = true;
      finishIfTerminal();
    });
    child.on('close', (code, signal) => {
      leaderClosed = true;
      exitCode = code;
      exitSignal = signal;
      if (code !== 0 && groupExists()) {
        signalGroup('SIGTERM');
      }
      finishIfTerminal();
    });

    const termTimer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
    }, terminateAtMs);
    const killTimer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGKILL');
    }, timeoutMs);
    const groupPoll = setInterval(() => {
      // Use the monotonic clock for the externally advertised budget. Timers
      // can be delayed by event-loop pressure but never extend authorization:
      // the next poll immediately delivers the appropriate terminal signal.
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        timedOut = true;
        signalGroup('SIGKILL');
      } else if (elapsedMs >= terminateAtMs) {
        timedOut = true;
        signalGroup('SIGTERM');
      }
      finishIfTerminal();
    }, GROUP_POLL_MS);
    groupPoll.unref();
  });
}

/** Execute an operator-configured shell hook through the group-safe runner. */
export function runReloadCommand(
  command: string,
  options: ReloadCommandOptions = {}
): Promise<ReloadCommandResult> {
  return runProcessGroupCommand('/bin/sh', ['-c', command], {
    operationLabel: 'Reload command',
    ...options,
  });
}
