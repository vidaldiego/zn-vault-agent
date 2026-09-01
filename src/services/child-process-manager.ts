// Path: src/services/child-process-manager.ts
// Manages child process for combined daemon + exec mode

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import {
  parseSecretMappingFromConfig,
  buildSecretEnv,
  buildSecretEnvWithFiles,
  type SecretMapping,
} from '../lib/secret-env.js';
import { getSecretFileManager } from '../lib/secret-file-manager.js';
import { type ExecConfig, DEFAULT_EXEC_CONFIG } from '../lib/config.js';

const log = logger.child({ module: 'child-process-manager' });

/**
 * PID file location for tracking child process.
 * Used to detect and clean up orphaned processes on startup.
 */
const CHILD_PID_FILE = process.env.CHILD_PID_FILE ?? '/run/zn-vault-agent/child.pid';
const CHILD_RESERVATION_FILE = process.env.CHILD_RESERVATION_FILE
  ?? path.join(path.dirname(CHILD_PID_FILE), 'child.owner');
const CHILD_RESERVATION_CLAIM_FILE = `${CHILD_RESERVATION_FILE}.claim`;

/**
 * Timeout for graceful termination of orphaned processes (5 seconds).
 */
const ORPHAN_KILL_TIMEOUT_MS = 5000;
const RESTART_GRACEFUL_STOP_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACEFUL_STOP_TIMEOUT_MS = 10_000;
const FORCE_KILL_CONFIRMATION_TIMEOUT_MS = 5_000;
const CHILD_PID_EVIDENCE_VERSION = 1;

interface LinuxProcessIdentity {
  kind: 'linux-procfs';
  startTimeTicks: string;
  executablePath: string;
}

interface UnsupportedProcessIdentity {
  kind: 'unsupported-platform';
  platform: NodeJS.Platform;
}

type ProcessIdentity = LinuxProcessIdentity | UnsupportedProcessIdentity;

interface ChildPidEvidence {
  version: typeof CHILD_PID_EVIDENCE_VERSION;
  ownerToken: string;
  pid: number;
  configuredExecutable: string;
  capturedAt: string;
  identity: ProcessIdentity;
}

interface ChildReservationEvidence {
  version: typeof CHILD_PID_EVIDENCE_VERSION;
  ownerToken: string;
  managerPid: number;
  capturedAt: string;
  identity: ProcessIdentity;
}

interface LegacyPidEvidence {
  pid: number;
  legacy: true;
}

type ParsedPidEvidence = ChildPidEvidence | LegacyPidEvidence;

/**
 * Child process status
 */
export type ChildProcessStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'crashed'
  | 'max_restarts_exceeded';

/**
 * Child process state information for health endpoint
 */
export interface ChildProcessState {
  status: ChildProcessStatus;
  pid: number | null;
  restartCount: number;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastExitTime: string | null;
  lastStartTime: string | null;
}

/**
 * Events emitted by ChildProcessManager
 */
export interface ChildProcessManagerEvents {
  started: (pid: number) => void;
  stopped: (code: number | null, signal: string | null) => void;
  restarting: (reason: string) => void;
  maxRestartsExceeded: () => void;
  error: (error: Error) => void;
}

export interface ChildProcessManagerOptions {
  /** Daemon mode owns SIGINT/SIGTERM and stops the child after its drain. */
  forwardTerminationSignals?: boolean;
}

/**
 * Manages a child process with secrets as environment variables.
 * Handles restart on changes, crash recovery with backoff, and signal forwarding.
 */
export class ChildProcessManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private readonly config: Required<Omit<ExecConfig, 'command' | 'secrets' | 'envFile'>> & Pick<ExecConfig, 'command' | 'secrets' | 'envFile'>;
  private readonly mappings: (SecretMapping & { literal?: string; outputToFile?: boolean })[];
  private readonly useFileMode: boolean;
  private readonly forwardTerminationSignals: boolean;
  private isShuttingDown = false;
  private restartCount = 0;
  private restartWindowStart = 0;
  private restartTimeout: NodeJS.Timeout | null = null;
  private lifecycleChain: Promise<void> | null = null;
  private intentionalRestartChild: ChildProcess | null = null;
  private readonly spawnedChildren = new WeakSet<ChildProcess>();
  private readonly terminatedChildren = new WeakSet<ChildProcess>();
  private status: ChildProcessStatus = 'stopped';
  private lastExitCode: number | null = null;
  private lastExitSignal: string | null = null;
  private lastExitTime: string | null = null;
  private lastStartTime: string | null = null;
  /** Exact durable evidence written by this manager instance, if any. */
  private ownedPidEvidence: string | null = null;
  private readonly pidEvidenceOwnerToken = randomUUID();
  /** Cross-process reservation retained until terminal stop. */
  private ownedReservationEvidence: string | null = null;
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();

  constructor(
    execConfig: ExecConfig,
    options: ChildProcessManagerOptions = {}
  ) {
    super();
    this.forwardTerminationSignals = options.forwardTerminationSignals ?? true;

    // Merge with defaults
    this.config = {
      ...DEFAULT_EXEC_CONFIG,
      ...execConfig,
    };

    // Parse secret mappings from config format, preserving outputToFile flag
    this.mappings = this.config.secrets.map(secret => {
      const parsed = parseSecretMappingFromConfig(secret);
      return {
        ...parsed,
        outputToFile: secret.outputToFile,
      };
    });

    // Check if any secrets should be written to files
    this.useFileMode = this.mappings.some(m => m.outputToFile);

    log.debug(
      {
        command: this.config.command,
        secretCount: this.config.secrets.length,
        restartOnChange: this.config.restartOnChange,
        useFileMode: this.useFileMode,
        fileSecrets: this.mappings.filter(m => m.outputToFile).map(m => m.envVar),
      },
      'ChildProcessManager initialized'
    );
  }

  /**
   * Kill any orphaned child process from a previous agent run.
   * This prevents zombie processes when the agent crashes and restarts.
   */
  private async killOrphanedChild(): Promise<void> {
    if (!fs.existsSync(CHILD_PID_FILE)) {
      return;
    }

    const storedEvidence = fs.readFileSync(CHILD_PID_FILE, 'utf-8');
    const evidence = this.parsePidEvidence(storedEvidence.trim());
    if (!evidence) {
      log.error({ file: CHILD_PID_FILE }, 'Ambiguous child PID evidence; refusing orphan cleanup');
      throw new Error('Invalid child PID evidence; refusing to signal any process');
    }
    const { pid } = evidence;

    try {
      process.kill(pid, 0);
    } catch (err) {
      if (!this.isNoSuchProcessError(err)) {
        log.error({ err, pid }, 'Unable to verify orphaned child process');
        throw new Error(`Unable to verify orphaned child process ${pid}`);
      }
      log.debug({ pid }, 'Orphaned PID file found but process not running');
      this.cleanupPidFile(storedEvidence);
      return;
    }

    this.assertOrphanIdentity(evidence, 'SIGTERM');
    log.warn({ pid }, 'Found orphaned child process, attempting graceful termination');
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      if (this.isNoSuchProcessError(err)) {
        this.cleanupPidFile(storedEvidence);
        return;
      }
      log.error({ err, pid }, 'Failed to send SIGTERM to orphaned child process');
      throw new Error(`Unable to terminate orphaned child process ${pid}`);
    }

    let terminated = await this.waitForProcessExit(pid, ORPHAN_KILL_TIMEOUT_MS);
    if (!terminated) {
      this.assertOrphanIdentity(evidence, 'SIGKILL');
      log.warn({ pid }, 'Orphaned process did not exit gracefully, sending SIGKILL');
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        if (this.isNoSuchProcessError(err)) {
          terminated = true;
        } else {
          log.error({ err, pid }, 'Failed to send SIGKILL to orphaned child process');
          throw new Error(`Unable to kill orphaned child process ${pid}`);
        }
      }
      if (!terminated) {
        terminated = await this.waitForProcessExit(
          pid,
          FORCE_KILL_CONFIRMATION_TIMEOUT_MS
        );
      }
    }

    if (!terminated) {
      log.error({ pid }, 'Orphaned child process did not confirm exit');
      throw new Error(`Orphaned child process ${pid} did not confirm exit`);
    }

    log.info({ pid }, 'Orphaned child process cleaned up');
    this.cleanupPidFile(storedEvidence);
  }

  private parsePidEvidence(rawEvidence: string): ParsedPidEvidence | null {
    if (/^[1-9]\d*$/.test(rawEvidence)) {
      const pid = Number(rawEvidence);
      return Number.isSafeInteger(pid) ? { pid, legacy: true } : null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawEvidence);
    } catch {
      return null;
    }

    if (!this.isObjectRecord(parsed)
      || parsed.version !== CHILD_PID_EVIDENCE_VERSION
      || typeof parsed.ownerToken !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.ownerToken)
      || !Number.isSafeInteger(parsed.pid)
      || typeof parsed.pid !== 'number'
      || parsed.pid <= 0
      || typeof parsed.configuredExecutable !== 'string'
      || parsed.configuredExecutable.length === 0
      || typeof parsed.capturedAt !== 'string'
      || !this.isObjectRecord(parsed.identity)
    ) {
      return null;
    }

    const identity = parsed.identity;
    if (identity.kind === 'linux-procfs') {
      if (typeof identity.startTimeTicks !== 'string'
        || !/^\d+$/.test(identity.startTimeTicks)
        || typeof identity.executablePath !== 'string'
        || identity.executablePath.length === 0
      ) {
        return null;
      }
      return parsed as unknown as ChildPidEvidence;
    }

    if (identity.kind === 'unsupported-platform'
      && typeof identity.platform === 'string'
      && identity.platform.length > 0
    ) {
      return parsed as unknown as ChildPidEvidence;
    }

    return null;
  }

  private isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private parseReservationEvidence(rawEvidence: string): ChildReservationEvidence | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawEvidence);
    } catch {
      return null;
    }

    if (!this.isObjectRecord(parsed)
      || parsed.version !== CHILD_PID_EVIDENCE_VERSION
      || typeof parsed.ownerToken !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.ownerToken)
      || !Number.isSafeInteger(parsed.managerPid)
      || typeof parsed.managerPid !== 'number'
      || parsed.managerPid <= 0
      || typeof parsed.capturedAt !== 'string'
      || !this.isObjectRecord(parsed.identity)
    ) {
      return null;
    }

    const identity = parsed.identity;
    if (identity.kind === 'linux-procfs') {
      if (typeof identity.startTimeTicks !== 'string'
        || !/^\d+$/.test(identity.startTimeTicks)
        || typeof identity.executablePath !== 'string'
        || identity.executablePath.length === 0
      ) {
        return null;
      }
      return parsed as unknown as ChildReservationEvidence;
    }

    if (identity.kind === 'unsupported-platform'
      && typeof identity.platform === 'string'
      && identity.platform.length > 0
    ) {
      return parsed as unknown as ChildReservationEvidence;
    }

    return null;
  }

  /**
   * Confirm that a live PID still names the exact process captured at spawn.
   * A legacy PID-only file or a platform without a stable kernel birth marker
   * is deliberately non-actionable: preserving evidence is safer than killing
   * an unrelated process after PID reuse.
   */
  private assertOrphanIdentity(
    evidence: ParsedPidEvidence,
    signal: 'SIGTERM' | 'SIGKILL'
  ): void {
    const { pid } = evidence;
    if ('legacy' in evidence) {
      log.error({ pid, signal }, 'Legacy PID evidence cannot prove orphan identity');
      throw new Error(
        `Cannot verify identity of orphaned child process ${pid}; refusing ${signal}`
      );
    }

    if (evidence.identity.kind !== 'linux-procfs') {
      log.error(
        { pid, signal, platform: evidence.identity.platform },
        'Stable orphan identity is unavailable on this platform'
      );
      throw new Error(
        `Cannot verify identity of orphaned child process ${pid}; refusing ${signal}`
      );
    }

    let observed: LinuxProcessIdentity;
    try {
      observed = this.readLinuxProcessIdentity(pid);
    } catch (err) {
      log.error({ err, pid, signal }, 'Unable to read orphan process identity');
      throw new Error(
        `Unable to verify identity of orphaned child process ${pid}; refusing ${signal}`,
        { cause: err }
      );
    }

    if (observed.startTimeTicks !== evidence.identity.startTimeTicks
      || observed.executablePath !== evidence.identity.executablePath
    ) {
      log.error(
        {
          pid,
          signal,
          expectedStartTimeTicks: evidence.identity.startTimeTicks,
          observedStartTimeTicks: observed.startTimeTicks,
          expectedExecutablePath: evidence.identity.executablePath,
          observedExecutablePath: observed.executablePath,
        },
        'Orphan process identity mismatch; refusing signal'
      );
      throw new Error(
        `Orphaned child process ${pid} identity mismatch; refusing ${signal}`
      );
    }
  }

  private readLinuxProcessIdentity(pid: number): LinuxProcessIdentity {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) {
      throw new Error(`Malformed /proc/${pid}/stat`);
    }

    // Fields after the command begin at field 3 (state). starttime is field 22.
    const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const startTimeTicks = fieldsAfterCommand[19];
    if (!startTimeTicks || !/^\d+$/.test(startTimeTicks)) {
      throw new Error(`Missing start time in /proc/${pid}/stat`);
    }

    const executablePath = fs.readlinkSync(`/proc/${pid}/exe`);
    if (!executablePath) {
      throw new Error(`Missing executable identity for process ${pid}`);
    }

    return {
      kind: 'linux-procfs',
      startTimeTicks,
      executablePath,
    };
  }

  private isNoSuchProcessError(error: unknown): boolean {
    return typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ESRCH';
  }

  private isAlreadyExistsError(error: unknown): boolean {
    return typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'EEXIST';
  }

  private isNoSuchFileError(error: unknown): boolean {
    return typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT';
  }

  /**
   * Reserve combined-mode ownership before orphan inspection, secret fetches,
   * or spawn. The claim file serializes every ownership transition, including
   * stale-owner recovery. Claims are deliberately never auto-reaped: an
   * abandoned claim is ambiguous and requires explicit operator intervention.
   */
  private acquireChildReservation(): void {
    if (this.ownedReservationEvidence) {
      this.assertChildReservationOwnership('reservation reuse');
      return;
    }

    const dir = path.dirname(CHILD_RESERVATION_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const identity: ProcessIdentity = process.platform === 'linux'
      ? this.readLinuxProcessIdentity(process.pid)
      : { kind: 'unsupported-platform', platform: process.platform };
    const evidence: ChildReservationEvidence = {
      version: CHILD_PID_EVIDENCE_VERSION,
      ownerToken: this.pidEvidenceOwnerToken,
      managerPid: process.pid,
      capturedAt: new Date().toISOString(),
      identity,
    };
    const serializedEvidence = `${JSON.stringify(evidence)}\n`;

    try {
      fs.writeFileSync(CHILD_RESERVATION_CLAIM_FILE, serializedEvidence, {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
        flush: true,
      });
    } catch (err) {
      if (this.isAlreadyExistsError(err)) {
        log.error(
          { file: CHILD_RESERVATION_CLAIM_FILE },
          'Child reservation claim already exists; explicit operator intervention required'
        );
        throw new Error(
          'Child process reservation recovery is already claimed; refusing to spawn'
        );
      }
      throw new Error('Failed to claim child process reservation transition', { cause: err });
    }

    let acquisitionFailed = false;
    let acquisitionError: unknown;
    try {
      if (fs.existsSync(CHILD_RESERVATION_FILE)) {
        let storedEvidence: string;
        try {
          storedEvidence = fs.readFileSync(CHILD_RESERVATION_FILE, 'utf-8');
        } catch (readError) {
          throw new Error('Unable to read existing child process reservation', {
            cause: readError,
          });
        }
        const existing = this.parseReservationEvidence(storedEvidence.trim());
        if (!existing) {
          throw new Error('Invalid child process reservation; refusing to spawn');
        }

        let ownerIsStale = false;
        try {
          process.kill(existing.managerPid, 0);
        } catch (probeError) {
          if (this.isNoSuchProcessError(probeError)) {
            ownerIsStale = true;
          } else {
            throw new Error('Unable to verify existing child process reservation owner', {
              cause: probeError,
            });
          }
        }

        if (!ownerIsStale && existing.identity.kind === 'linux-procfs') {
          let observedIdentity: LinuxProcessIdentity;
          try {
            observedIdentity = this.readLinuxProcessIdentity(existing.managerPid);
          } catch (identityError) {
            throw new Error('Unable to verify existing child process reservation owner', {
              cause: identityError,
            });
          }
          ownerIsStale = observedIdentity.startTimeTicks !== existing.identity.startTimeTicks
            || observedIdentity.executablePath !== existing.identity.executablePath;
        }

        if (!ownerIsStale) {
          throw new Error(
            `Child process ownership is already reserved by manager ${existing.managerPid}`
          );
        }

        // The O_EXCL claim is the mutation lock. Re-read exact evidence while
        // holding it, then remove the stale owner. No other compliant manager
        // can replace the owner until this claim is released.
        const currentEvidence = fs.readFileSync(CHILD_RESERVATION_FILE, 'utf-8');
        if (currentEvidence !== storedEvidence) {
          throw new Error('Child process reservation changed during stale-owner recovery');
        }
        fs.unlinkSync(CHILD_RESERVATION_FILE);
      }

      try {
        fs.writeFileSync(CHILD_RESERVATION_FILE, serializedEvidence, {
          encoding: 'utf-8',
          mode: 0o600,
          flag: 'wx',
          flush: true,
        });
      } catch (err) {
        throw new Error('Failed to acquire child process reservation', { cause: err });
      }
      this.ownedReservationEvidence = serializedEvidence;

      const persistedEvidence = fs.readFileSync(CHILD_RESERVATION_FILE, 'utf-8');
      if (persistedEvidence !== serializedEvidence) {
        this.ownedReservationEvidence = null;
        throw new Error('Child process reservation changed while it was being acquired');
      }
    } catch (err) {
      acquisitionFailed = true;
      acquisitionError = err;
    }

    if (!this.removeExactEvidence(
      CHILD_RESERVATION_CLAIM_FILE,
      serializedEvidence,
      false
    )) {
      log.error(
        { file: CHILD_RESERVATION_CLAIM_FILE },
        'Child reservation claim changed; refusing non-owned cleanup'
      );
      throw new Error(
        'Child process reservation claim could not be released; refusing to spawn',
        acquisitionFailed ? { cause: acquisitionError } : undefined
      );
    }
    if (acquisitionFailed) throw acquisitionError;

    this.assertChildReservationOwnership('reservation acquisition');
    log.debug({ file: CHILD_RESERVATION_FILE }, 'Child process reservation acquired');
  }

  /** Revalidate exact ownership at every boundary before external effects. */
  private assertChildReservationOwnership(stage: string): void {
    const ownedEvidence = this.ownedReservationEvidence;
    if (!ownedEvidence) {
      throw new Error(`Child process reservation is not owned before ${stage}`);
    }

    // A late claimant may hold the transition claim briefly while it verifies
    // this exact live owner. It cannot replace live byte-exact ownership, so
    // the persisted owner evidence remains authoritative here.
    let currentEvidence: string;
    try {
      currentEvidence = fs.readFileSync(CHILD_RESERVATION_FILE, 'utf-8');
    } catch (err) {
      throw new Error(`Unable to verify child process reservation before ${stage}`, {
        cause: err,
      });
    }
    if (currentEvidence !== ownedEvidence) {
      throw new Error(`Child process reservation ownership changed before ${stage}`);
    }
  }

  /**
   * Wait for a process to exit with timeout.
   * Returns true if process exited, false if timeout.
   */
  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 100; // Check every 100ms

    while (Date.now() - startTime < timeoutMs) {
      try {
        process.kill(pid, 0);
        // Process still running, wait
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      } catch (err) {
        if (this.isNoSuchProcessError(err)) return true;
        throw err;
      }
    }

    // Timeout - check one more time
    try {
      process.kill(pid, 0);
      return false; // Still running
    } catch (err) {
      if (this.isNoSuchProcessError(err)) return true;
      throw err;
    }
  }

  /** Persist process birth evidence without replacing any rival owner. */
  private writePidFile(pid: number): void {
    const dir = path.dirname(CHILD_PID_FILE);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      const identity: ProcessIdentity = process.platform === 'linux'
        ? this.readLinuxProcessIdentity(pid)
        : { kind: 'unsupported-platform', platform: process.platform };
      const evidence: ChildPidEvidence = {
        version: CHILD_PID_EVIDENCE_VERSION,
        ownerToken: this.pidEvidenceOwnerToken,
        pid,
        configuredExecutable: this.config.command[0] ?? 'unknown',
        capturedAt: new Date().toISOString(),
        identity,
      };

      const serializedEvidence = `${JSON.stringify(evidence)}\n`;
      fs.writeFileSync(CHILD_PID_FILE, serializedEvidence, {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
        flush: true,
      });
      this.ownedPidEvidence = serializedEvidence;
      log.debug(
        { pid, file: CHILD_PID_FILE, identityKind: identity.kind },
        'Child PID evidence written'
      );
    } catch (err) {
      log.error({ err, file: CHILD_PID_FILE }, 'Failed to write child PID evidence');
      throw new Error('Failed to persist child process identity evidence', { cause: err });
    }
  }

  /**
   * Remove the child PID file.
   */
  private cleanupPidFile(expectedEvidence: string): void {
    if (!this.removeExactEvidence(CHILD_PID_FILE, expectedEvidence)) {
      throw new Error('Child PID evidence changed during orphan cleanup; refusing to spawn');
    }
    this.ownedPidEvidence = null;
    log.debug({ file: CHILD_PID_FILE }, 'Child PID file removed');
  }

  private removeExactEvidence(
    file: string,
    expectedEvidence: string,
    missingIsSuccess = true
  ): boolean {
    try {
      if (!fs.existsSync(file)) return missingIsSuccess;
      const currentEvidence = fs.readFileSync(file, 'utf-8');
      if (currentEvidence !== expectedEvidence) return false;
      fs.unlinkSync(file);
      return true;
    } catch (err) {
      log.warn({ err, file }, 'Failed to remove exact process ownership evidence');
      return false;
    }
  }

  /**
   * Remove only evidence written by this manager instance. Evidence found at
   * startup belongs to a prior process and must remain until orphan cleanup
   * confirms ESRCH or the exact captured process exits.
   */
  private cleanupOwnedPidFile(): void {
    const ownedEvidence = this.ownedPidEvidence;
    if (!ownedEvidence) return;

    try {
      if (!fs.existsSync(CHILD_PID_FILE)) {
        this.ownedPidEvidence = null;
        return;
      }

      const currentEvidence = fs.readFileSync(CHILD_PID_FILE, 'utf-8');
      if (currentEvidence !== ownedEvidence) {
        log.warn(
          { file: CHILD_PID_FILE },
          'Child PID evidence was replaced; refusing non-owned cleanup'
        );
        this.ownedPidEvidence = null;
        return;
      }

      fs.unlinkSync(CHILD_PID_FILE);
      this.ownedPidEvidence = null;
      log.debug({ file: CHILD_PID_FILE }, 'Owned child PID evidence removed');
    } catch (err) {
      log.warn({ err, file: CHILD_PID_FILE }, 'Failed to remove owned child PID evidence');
    }
  }

  private cleanupOwnedReservationFile(): void {
    const ownedEvidence = this.ownedReservationEvidence;
    if (!ownedEvidence) return;

    if (this.removeExactEvidence(CHILD_RESERVATION_FILE, ownedEvidence)) {
      this.ownedReservationEvidence = null;
      log.debug({ file: CHILD_RESERVATION_FILE }, 'Child process reservation released');
      return;
    }

    log.warn(
      { file: CHILD_RESERVATION_FILE },
      'Child process reservation was replaced; refusing non-owned cleanup'
    );
    this.ownedReservationEvidence = null;
  }

  /**
   * Serialize every operation that may create, replace, or stop the child.
   *
   * The first operation begins immediately, preserving the existing lifecycle
   * event timing, while the published barrier makes re-entrant operations wait.
   * A rejected operation does not poison later crash recovery or restart work.
   */
  private enqueueLifecycleOperation(operation: () => Promise<void>): Promise<void> {
    if (!this.lifecycleChain) {
      let releaseBarrier!: () => void;
      const firstBarrier = new Promise<void>(resolve => {
        releaseBarrier = resolve;
      });
      this.lifecycleChain = firstBarrier;

      let scheduledOperation: Promise<void>;
      try {
        scheduledOperation = operation();
      } catch (err) {
        scheduledOperation = Promise.reject(err);
      }
      const releaseFirstOperation = (): void => {
        releaseBarrier();
        if (this.lifecycleChain === firstBarrier) {
          this.lifecycleChain = null;
        }
      };
      void scheduledOperation.then(releaseFirstOperation, releaseFirstOperation);
      return scheduledOperation;
    }

    const scheduledOperation = this.lifecycleChain.then(operation);
    const settledOperation = scheduledOperation.catch(() => undefined);
    this.lifecycleChain = settledOperation;
    const clearSettledOperation = (): void => {
      if (this.lifecycleChain === settledOperation) {
        this.lifecycleChain = null;
      }
    };
    void scheduledOperation.then(clearSettledOperation, clearSettledOperation);
    return scheduledOperation;
  }

  /**
   * Start the child process
   */
  start(): Promise<void> {
    return this.enqueueLifecycleOperation(async () => this.performStart(false));
  }

  private async performStart(rejectOnShutdown: boolean): Promise<void> {
    if (this.child) {
      log.warn('Child process already running, ignoring start request');
      return;
    }

    if (this.isShuttingDown) {
      log.warn('Manager is shutting down, ignoring start request');
      if (rejectOnShutdown) {
        throw new Error('Child process manager is shutting down');
      }
      return;
    }

    // Cross-process reservation precedes orphan inspection, secret retrieval,
    // and spawn. Therefore two managers cannot both observe absence and admit
    // a child, even when their in-process lifecycle queues are independent.
    try {
      this.acquireChildReservation();
      await this.killOrphanedChild();
    } catch (err) {
      this.status = 'crashed';
      throw err;
    }

    // stop() closes admission synchronously. Revalidate after every awaited
    // preparation phase so a start cannot spawn after shutdown observed no
    // child and moved on.
    if (this.isShuttingDown) {
      if (rejectOnShutdown) {
        throw new Error('Child process manager is shutting down');
      }
      return;
    }

    this.status = 'starting';
    log.info({ command: this.config.command.join(' '), useFileMode: this.useFileMode }, 'Starting child process');

    let spawnedChild: ChildProcess | null = null;
    try {
      // Fetch secrets and build environment
      // Use file mode if any secrets are marked for file output
      let secretEnv: Record<string, string>;

      this.assertChildReservationOwnership('secret retrieval');
      if (this.useFileMode) {
        const result = await buildSecretEnvWithFiles(this.mappings);
        secretEnv = result.env;
        log.info(
          {
            secretsDir: result.secretsDir,
            filesWritten: result.files.length,
            envVars: Object.keys(result.env).filter(k => !k.endsWith('_FILE')).length,
            fileVars: Object.keys(result.env).filter(k => k.endsWith('_FILE')).length,
          },
          'Secrets prepared (file mode enabled for sensitive values)'
        );
      } else {
        secretEnv = await buildSecretEnv(this.mappings);
      }

      if (this.isShuttingDown) {
        if (rejectOnShutdown) {
          throw new Error('Child process manager is shutting down');
        }
        this.status = 'stopped';
        return;
      }

      const env = this.config.inheritEnv
        ? { ...process.env, ...secretEnv }
        : secretEnv;

      // Spawn the child process
      const [cmd, ...args] = this.config.command;
      this.assertChildReservationOwnership('child spawn');
      spawnedChild = spawn(cmd, args, {
        env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      this.child = spawnedChild;
      const spawnConfirmed = this.waitForSpawn(spawnedChild);
      this.setupSignalForwarding();
      this.setupChildEventHandlers();

      // spawn() returning only means an attempt was admitted by Node. Do not
      // acknowledge a mutation restart until the child emits `spawn`; an
      // asynchronous `error` before that point rejects this lifecycle step.
      await spawnConfirmed;

      if (this.child !== spawnedChild) {
        throw new Error('Child process failed before startup completed');
      }
      if (this.isShuttingDown) {
        if (rejectOnShutdown) {
          throw new Error('Child process manager is shutting down');
        }
        return;
      }

      // Never acknowledge or leave a child running without durable identity
      // evidence. The ChildProcess handle is safe to signal here even if PID
      // evidence could not be captured, because it is the object just spawned.
      try {
        if (!spawnedChild.pid) {
          throw new Error('Spawned child has no PID');
        }
        this.writePidFile(spawnedChild.pid);
      } catch (evidenceError) {
        const childExitedBeforeIdentityCapture = evidenceError instanceof Error
          && (
            this.isNoSuchFileError(evidenceError.cause)
            || this.isNoSuchProcessError(evidenceError.cause)
          );
        const terminationWasAlreadyHandled = this.terminatedChildren.has(spawnedChild);
        this.intentionalRestartChild = spawnedChild;
        let terminationError: unknown;
        try {
          await this.terminateChild(spawnedChild, RESTART_GRACEFUL_STOP_TIMEOUT_MS);
          if (this.child === spawnedChild) this.child = null;
        } catch (err) {
          terminationError = err;
        } finally {
          this.intentionalRestartChild = null;
          this.cleanupSignalHandlers();
        }

        if (terminationError) {
          throw new AggregateError(
            [evidenceError, terminationError],
            'Failed to persist child identity and confirm child termination'
          );
        }
        if (
          childExitedBeforeIdentityCapture
          && !terminationWasAlreadyHandled
          && !this.isShuttingDown
        ) {
          // A short-lived Linux child can disappear between the `spawn` event
          // and the /proc identity read. The termination handler was
          // deliberately suppressed while we confirmed the child was gone, so
          // account for this as a real crash and retain bounded recovery.
          this.handleCrash(
            spawnedChild.exitCode,
            spawnedChild.signalCode?.toString() ?? null
          );
        }
        throw evidenceError;
      }

      this.lastStartTime = new Date().toISOString();
      this.status = 'running';
      log.info({ pid: spawnedChild.pid }, 'Child process started');
      this.emit('started', spawnedChild.pid);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!this.isShuttingDown) {
        if (this.getState().status !== 'max_restarts_exceeded') {
          this.status = 'crashed';
        }
      } else if (!this.child) {
        this.status = 'stopped';
      }
      log.error({ err: error }, 'Failed to start child process');
      // Child event handlers own errors emitted by an admitted process. Errors
      // from secret preparation or a synchronous spawn failure have no such
      // handler, so publish them here.
      if (!spawnedChild) {
        this.emit('error', error);
      }
      throw error;
    }
  }

  private waitForSpawn(child: ChildProcess): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError);
        this.spawnedChildren.add(child);
        resolve();
      };
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn);
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  /**
   * Close lifecycle admission before daemon drain or process shutdown.
   * The child remains running until stop() so already-admitted mutations can
   * unwind, but crash recovery and new starts/restarts are disabled now.
   */
  beginShutdown(): void {
    this.isShuttingDown = true;

    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }
  }

  /**
   * Stop the child process gracefully
   */
  stop(): Promise<void> {
    this.beginShutdown();

    return this.enqueueLifecycleOperation(async () => this.performStop());
  }

  private async performStop(): Promise<void> {
    // Remove signal handlers
    this.cleanupSignalHandlers();

    if (!this.child) {
      this.status = 'stopped';
      this.cleanupChildArtifacts();
      this.cleanupOwnedReservationFile();
      return;
    }

    const childToStop = this.child;
    log.info({ pid: childToStop.pid }, 'Stopping child process');

    await this.terminateChild(childToStop, SHUTDOWN_GRACEFUL_STOP_TIMEOUT_MS);
    if (this.child === childToStop) {
      this.child = null;
    }
    this.status = 'stopped';
    this.cleanupChildArtifacts();
    this.cleanupOwnedReservationFile();
  }

  /** Remove child-owned material only after termination is confirmed. */
  private cleanupChildArtifacts(): void {
    if (this.useFileMode) {
      try {
        const manager = getSecretFileManager();
        manager.cleanup();
        log.debug('Cleaned up secret files');
      } catch (err) {
        log.warn({ err }, 'Failed to cleanup secret files');
      }
    }

    this.cleanupOwnedPidFile();
  }

  /**
   * Restart the child process (e.g., after cert/secret change)
   */
  restart(reason: string): Promise<void> {
    if (this.isShuttingDown) {
      return Promise.reject(new Error('Child process manager is shutting down'));
    }

    if (!this.config.restartOnChange) {
      log.debug({ reason }, 'Restart requested but restartOnChange is disabled');
      return Promise.resolve();
    }

    // Certificate, secret, exec, plugin/key, crash recovery, initial start and
    // shutdown all share the same child lifecycle coordinator.
    return this.enqueueLifecycleOperation(async () => this.performRestart(reason));
  }

  private async performRestart(reason: string): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error('Child process manager is shutting down');
    }

    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    log.info({ reason }, 'Restarting child process');
    this.status = 'restarting';
    this.emit('restarting', reason);

    // Stop current process
    if (this.child) {
      this.intentionalRestartChild = this.child;
      try {
        await this.stopChild();
      } finally {
        this.intentionalRestartChild = null;
      }
    }

    // Start with fresh secrets
    await this.performStart(true);
  }

  /**
   * Get current process state for health endpoint
   */
  getState(): ChildProcessState {
    return {
      status: this.status,
      pid: this.child?.pid ?? null,
      restartCount: this.restartCount,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      lastExitTime: this.lastExitTime,
      lastStartTime: this.lastStartTime,
    };
  }

  /**
   * Check if process is in a healthy state
   */
  isHealthy(): boolean {
    return this.status === 'running';
  }

  /** Check if process is transitioning or awaiting crash recovery. */
  isDegraded(): boolean {
    return this.status === 'starting'
      || this.status === 'restarting'
      || this.status === 'crashed'
      || this.status === 'max_restarts_exceeded';
  }

  /**
   * Stop child without setting shutdown flag
   */
  private async stopChild(): Promise<void> {
    const childToStop = this.child;
    if (!childToStop) return;

    // Remove signal handlers during restart
    this.cleanupSignalHandlers();
    await this.terminateChild(childToStop, RESTART_GRACEFUL_STOP_TIMEOUT_MS);
    if (this.child === childToStop) {
      this.child = null;
    }
  }

  /**
   * Stop one captured child and require exit/close confirmation before success.
   * An `error` event is deliberately ignored as termination evidence because
   * Node also emits it for failed kill/send operations while the process lives.
   */
  private async terminateChild(
    child: ChildProcess,
    gracefulTimeoutMs: number
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | null = null;
      let confirmationTimer: NodeJS.Timeout | null = null;

      const cleanup = (): void => {
        child.off('exit', onTerminated);
        child.off('close', onTerminated);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (confirmationTimer) clearTimeout(confirmationTimer);
      };
      const onTerminated = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const rejectUnconfirmed = (): void => {
        if (settled) return;
        settled = true;
        if (this.child === child) {
          this.status = 'crashed';
        }
        cleanup();
        reject(new Error(
          `Child process ${child.pid ?? 'unknown'} did not confirm exit after SIGKILL`
        ));
      };
      const forceKill = (): void => {
        if (settled) return;
        if (child.exitCode !== null || child.signalCode !== null) {
          onTerminated();
          return;
        }
        log.warn({ pid: child.pid }, 'Child did not exit, sending SIGKILL');
        try {
          child.kill('SIGKILL');
        } catch (err) {
          log.error({ err, pid: child.pid }, 'Failed to send SIGKILL to child');
        }
        confirmationTimer = setTimeout(
          rejectUnconfirmed,
          FORCE_KILL_CONFIRMATION_TIMEOUT_MS
        );
      };

      child.once('exit', onTerminated);
      child.once('close', onTerminated);
      try {
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(forceKill, gracefulTimeoutMs);
      } catch (err) {
        log.error({ err, pid: child.pid }, 'Failed to send SIGTERM to child');
        forceKill();
      }
    });
  }

  /**
   * Set up signal forwarding from parent to child
   */
  private setupSignalForwarding(): void {
    const signals: NodeJS.Signals[] = this.forwardTerminationSignals
      ? ['SIGINT', 'SIGTERM', 'SIGHUP']
      : ['SIGHUP'];

    for (const signal of signals) {
      const handler = (): void => {
        if (this.child) {
          log.debug({ signal, pid: this.child.pid }, 'Forwarding signal to child');
          this.child.kill(signal);
        }
      };
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  /**
   * Clean up signal handlers
   */
  private cleanupSignalHandlers(): void {
    for (const [signal, handler] of this.signalHandlers) {
      process.off(signal, handler);
    }
    this.signalHandlers.clear();
  }

  /**
   * Set up event handlers for child process
   */
  private setupChildEventHandlers(): void {
    const child = this.child;
    if (!child) return;

    child.on('exit', (code, signal) => {
      this.handleChildTermination(child, code, signal?.toString() ?? null);
    });

    // `close` is also terminal and may be the only terminal event after some
    // spawn failures. The termination guard prevents double handling after
    // the usual exit -> close sequence.
    child.on('close', (code, signal) => {
      this.handleChildTermination(child, code, signal?.toString() ?? null);
    });

    child.on('error', (err) => {
      if (this.child === child) {
        this.status = 'crashed';
        if (!this.spawnedChildren.has(child)) {
          // An error before `spawn` proves that no process was created. Errors
          // after `spawn` can also mean failed kill/send and are not proof of
          // death, so retain the child and wait for exit/close in that case.
          this.child = null;
          this.cleanupSignalHandlers();
          if (!this.isShuttingDown && this.intentionalRestartChild !== child) {
            this.handleCrash(null, null);
          } else if (this.intentionalRestartChild !== child) {
            this.status = 'stopped';
          }
        }
      }
      log.error({ err }, 'Child process error');
      this.emit('error', err);
    });
  }

  private handleChildTermination(
    child: ChildProcess,
    code: number | null,
    signal: string | null
  ): void {
    if (this.terminatedChildren.has(child)) return;
    this.terminatedChildren.add(child);

    const isCurrentChild = this.child === child;
    const isIntentionalRestart = this.intentionalRestartChild === child;
    if (!isCurrentChild && !isIntentionalRestart) {
      log.debug({ pid: child.pid }, 'Ignoring stale termination from a replaced child process');
      return;
    }

    this.lastExitCode = code;
    this.lastExitSignal = signal;
    this.lastExitTime = new Date().toISOString();

    log.info({ code, signal, pid: child.pid }, 'Child process exited');
    this.emit('stopped', code, signal);

    if (this.child === child) {
      this.child = null;
    }
    this.cleanupSignalHandlers();

    if (isIntentionalRestart) {
      // performRestart() owns the following start. Scheduling crash recovery
      // here would create a second child after the intentional SIGTERM.
      this.status = 'restarting';
    } else if (!this.isShuttingDown) {
      this.handleCrash(code, signal);
    } else {
      this.status = 'stopped';
    }
  }

  /**
   * Handle child process crash with rate limiting
   */
  private handleCrash(code: number | null, signal: string | null): void {
    const now = Date.now();

    // Reset counter if outside restart window
    if (now - this.restartWindowStart > this.config.restartWindowMs) {
      this.restartCount = 0;
      this.restartWindowStart = now;
    }

    this.restartCount++;

    // Check if max restarts exceeded
    if (this.restartCount > this.config.maxRestarts) {
      log.error(
        {
          restartCount: this.restartCount,
          maxRestarts: this.config.maxRestarts,
          windowMs: this.config.restartWindowMs,
        },
        'Max restarts exceeded, entering degraded state'
      );
      this.status = 'max_restarts_exceeded';
      this.emit('maxRestartsExceeded');
      return;
    }

    // Schedule restart with delay
    this.status = 'crashed';
    log.info(
      {
        code,
        signal,
        restartCount: this.restartCount,
        delayMs: this.config.restartDelayMs,
      },
      'Child crashed, scheduling restart'
    );

    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = null;
      this.start().catch((err: unknown) => {
        log.error({ err }, 'Failed to restart child process');
      });
    }, this.config.restartDelayMs);
  }

  /**
   * Reset restart counter (call after successful manual restart)
   */
  resetRestartCount(): void {
    this.restartCount = 0;
    this.restartWindowStart = Date.now();
    if (this.status === 'max_restarts_exceeded') {
      this.status = 'stopped';
    }
  }
}
