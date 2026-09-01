// Path: zn-vault-agent/src/services/npm-auto-update.ts

/**
 * npm-based Auto-Update Service
 *
 * Periodically checks npm registry for new versions and auto-updates
 * the agent via `npm install -g`. Uses a lock file to prevent multiple
 * agents from updating simultaneously.
 *
 * Safety features:
 * - Atomic lock file acquisition (O_EXCL)
 * - Staged rollout with random delay (prevents thundering herd)
 * - Real health check (verifies new binary actually works)
 * - Automatic rollback on health check failure
 * - Version verification after update
 * - Previous version tracking for diagnostics
 */

import { exec, execFile, spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'util';
import {
  fchmodSync,
  existsSync,
  unlinkSync,
  readFileSync,
  openSync,
  writeFileSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  fstatSync,
  constants,
} from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import semver from 'semver';
import { logger, flushLogs } from '../lib/logger.js';
import type { UpdateConfig, NpmVersionInfo } from '../types/update.js';
import { DEFAULT_UPDATE_CONFIG } from '../types/update.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const LOCK_FILE = '/run/zn-vault-agent/.self-update.lock';
const PACKAGE_NAME = '@zincapp/zn-vault-agent';

// Root-owned helper unit whose validated wrapper performs the exact global npm
// install and argv-safe restart OUTSIDE the agent's mount namespace. The agent unit
// runs as a non-root service user under ProtectSystem=strict, which makes /usr
// read-only IN THE AGENT'S MOUNT NAMESPACE. An in-process `sudo npm install`
// CANNOT escape that namespace (sudo changes uid, not the namespace), so it
// fails EROFS when writing /usr/bin (the real INC-2026-06-12-01 mechanism). The
// updater unit runs in its own clean namespace where /usr/bin is writable.
const UPDATER_UNIT = 'zn-vault-agent-updater.service';

// Absolute systemctl path used to start the updater unit. It MUST match the
// provisioned sudoers rule byte-for-byte:
//   zn-vault-agent ALL=(root) NOPASSWD: /usr/bin/systemctl start zn-vault-agent-updater.service
const SYSTEMCTL_BIN = '/usr/bin/systemctl';

// Root-owned systemd .path unit that watches for the trigger file.  When the
// trigger appears, the companion .service (oneshot) installs the target version
// and restarts the agent.  This is the PREFERRED non-root strategy because it
// requires no sudo at all — the agent only needs to create a file.
const UPDATER_PATH_UNIT = 'zn-vault-agent-updater.path';

// The trigger lives in the agent-owned state directory. Publication uses a
// unique O_EXCL temporary inode followed by a hard-link no-replace operation;
// the root wrapper is the only component allowed to consume the live trigger.
const TRIGGER_FILE = '/var/lib/zn-vault-agent/.update-trigger';
const SELF_UPDATE_STATE_DIR = '/var/lib/zn-vault-agent-updater';

const SELF_UPDATE_CHANNELS = new Set(['latest', 'beta', 'next', 'dr-m4']);
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXACT_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface SelfUpdateRailOptions {
  triggerFile?: string;
  stateDir?: string;
  agentUid?: number;
  rootUid?: number;
}

export interface SelfUpdateRequest {
  requestId: string;
  expectedCurrentVersion: string;
  targetVersion: string;
  force?: boolean;
}

export interface SelfUpdatePendingStatus {
  status: 'pending';
  requestId: string;
  package: typeof PACKAGE_NAME;
  channel: string;
  previousVersion: string;
  targetVersion: string;
  requestedAt: string;
  pollPath: string;
  success?: undefined;
  willRestart?: undefined;
  newVersion?: undefined;
  message?: undefined;
}

export interface SelfUpdateTerminalStatus {
  status: 'succeeded' | 'failed';
  requestId: string;
  package: typeof PACKAGE_NAME;
  channel: string;
  previousVersion: string;
  targetVersion: string;
  installedVersion: string | null;
  requestedAt: string;
  startedAt: string;
  finishedAt: string;
  reason: string;
}

export type SelfUpdateStatus = SelfUpdatePendingStatus | SelfUpdateTerminalStatus;

interface SelfUpdateRequestEvidence {
  requestId: string;
  currentVersion: string;
  targetVersion: string;
  channel: string;
  requestedAt: string;
}

interface SelfUpdateReceiptEvidence {
  terminal: SelfUpdateTerminalStatus;
  committing: boolean;
}

export class SelfUpdateRailError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number = 502
  ) {
    super(message);
    this.name = 'SelfUpdateRailError';
  }
}

function isExactIsoTimestamp(value: string): boolean {
  return EXACT_ISO_RE.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function pendingStatus(
  requestId: string
): Pick<SelfUpdatePendingStatus, 'status' | 'requestId' | 'package' | 'pollPath'> {
  return {
    status: 'pending',
    requestId,
    package: PACKAGE_NAME,
    pollPath: `/agent/update/${requestId}`,
  };
}

function pendingFromEvidence(evidence: SelfUpdateRequestEvidence): SelfUpdatePendingStatus {
  return {
    ...pendingStatus(evidence.requestId),
    channel: evidence.channel,
    previousVersion: evidence.currentVersion,
    targetVersion: evidence.targetVersion,
    requestedAt: evidence.requestedAt,
  };
}

function sameRequestIdentity(
  left: SelfUpdateRequestEvidence,
  right: SelfUpdateRequestEvidence
): boolean {
  return left.requestId === right.requestId
    && left.currentVersion === right.currentVersion
    && left.targetVersion === right.targetVersion
    && left.channel === right.channel
    && left.requestedAt === right.requestedAt;
}

function fsyncDirectory(directory: string): void {
  const directoryFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0);
  const fd = openSync(directory, directoryFlags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Publish a complete self-update request without replacing an existing one.
 *
 * The hard-link is the commit point: two callers can create independent temp
 * files, but only one can link its inode to `triggerFile`. The losing caller
 * receives EEXIST and cannot overwrite the admitted request.
 */
export function publishSelfUpdateTriggerAtomically(
  triggerFile: string,
  content: string,
  nonce: string = randomUUID(),
  fault?: (point: 'after-link' | 'after-first-dir-fsync' | 'after-temp-unlink' | 'after-second-dir-fsync') => void
): void {
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number' || noFollow === 0) {
    throw new Error('Secure self-update publication requires O_NOFOLLOW support');
  }
  if (!UUID_V4_RE.test(nonce)) {
    throw new Error('Self-update temp nonce must be a lowercase UUID v4');
  }

  const directory = dirname(triggerFile);
  const tempFile = `${triggerFile}.tmp.${process.pid}.${nonce}`;
  let fd: number | undefined;
  let linkCommitted = false;
  let tempIdentity: { dev: number; ino: number; uid: number } | undefined;
  try {
    fd = openSync(
      tempFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600
    );
    writeFileSync(fd, content, { encoding: 'utf8' });
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const tempOpened = fstatSync(fd);
    if (!tempOpened.isFile() || (tempOpened.mode & 0o777) !== 0o600
      || tempOpened.nlink !== 1) {
      throw new Error('Self-update temp inode changed before publication');
    }
    tempIdentity = { dev: tempOpened.dev, ino: tempOpened.ino, uid: tempOpened.uid };
    closeSync(fd);
    fd = undefined;
    // link(2) is an atomic no-replace publication primitive. Unlike rename,
    // it fails with EEXIST when another request is already pending.
    linkSync(tempFile, triggerFile);
    linkCommitted = true;
    fault?.('after-link');
    fsyncDirectory(directory);
    fault?.('after-first-dir-fsync');
    unlinkSync(tempFile);
    fault?.('after-temp-unlink');
    fsyncDirectory(directory);
    fault?.('after-second-dir-fsync');
  } catch (err) {
    let committed = false;
    if (linkCommitted && tempIdentity) {
      try {
        const before = lstatSync(triggerFile);
        if (before.isFile() && !before.isSymbolicLink()
          && before.dev === tempIdentity.dev && before.ino === tempIdentity.ino
          && before.uid === tempIdentity.uid
          && (before.mode & 0o777) === 0o600 && before.nlink >= 1 && before.nlink <= 2
          && before.size === Buffer.byteLength(content) && constants.O_NOFOLLOW) {
          const committedFd = openSync(triggerFile, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const opened = fstatSync(committedFd);
            committed = opened.isFile() && opened.dev === before.dev && opened.ino === before.ino
              && (opened.mode & 0o777) === 0o600 && opened.nlink === before.nlink
              && opened.size === before.size && readFileSync(committedFd, 'utf8') === content;
          } finally {
            closeSync(committedFd);
          }
        }
      } catch {
        committed = false;
      }
    }
    if (!committed) throw err;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original publication error.
      }
    }
    try {
      unlinkSync(tempFile);
    } catch {
      // The normal success path already removed it; failed O_EXCL creates no
      // inode. Never unlink the committed trigger here.
    }
    // If a post-link fsync or temp unlink failed, exact inode+byte readback
    // above proves admission. Best-effort directory sync narrows the remaining
    // crash window without turning an already committed UUID into an error.
    try {
      fsyncDirectory(directory);
    } catch {
      // The exact live trigger remains observable and root-reconcilable.
    }
  }
}

export class NpmAutoUpdateService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimeout: NodeJS.Timeout | null = null;
  private stagedRolloutTimeout: NodeJS.Timeout | null = null;
  private readonly config: UpdateConfig;
  private readonly triggerFile: string;
  private readonly stateDir: string;
  private readonly activeFile: string;
  private readonly agentUid: number;
  private readonly rootUid: number;

  constructor(config: Partial<UpdateConfig> = {}, rail: SelfUpdateRailOptions = {}) {
    this.config = { ...DEFAULT_UPDATE_CONFIG, ...config };
    this.triggerFile = rail.triggerFile ?? TRIGGER_FILE;
    this.stateDir = rail.stateDir ?? SELF_UPDATE_STATE_DIR;
    this.activeFile = `${this.stateDir}/active.state`;
    this.agentUid = rail.agentUid ?? process.getuid?.() ?? 0;
    this.rootUid = rail.rootUid ?? 0;
  }

  /**
   * Start the auto-update service.
   * Performs initial check after 1 minute, then checks periodically.
   */
  start(): void {
    if (!this.config.enabled) {
      logger.debug('Auto-update disabled');
      return;
    }

    logger.info(
      {
        interval: this.config.checkIntervalMs / 1000,
        channel: this.config.channel,
        stagedRolloutMaxDelay: this.config.stagedRolloutMaxDelayMs / 1000,
        rollbackEnabled: this.config.rollbackOnFailure,
      },
      'Starting npm auto-update service'
    );

    // Initial check after 1 minute (let daemon stabilize)
    this.initialCheckTimeout = setTimeout(() => {
      this.checkAndUpdate().catch((err: unknown) => {
        logger.error({ err }, 'Initial auto-update check failed');
      });
    }, 60_000);

    // Then check periodically
    this.checkInterval = setInterval(() => {
      this.checkAndUpdate().catch((err: unknown) => {
        logger.error({ err }, 'Auto-update check failed');
      });
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop the auto-update service.
   */
  stop(): void {
    if (this.initialCheckTimeout) {
      clearTimeout(this.initialCheckTimeout);
      this.initialCheckTimeout = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.stagedRolloutTimeout) {
      clearTimeout(this.stagedRolloutTimeout);
      this.stagedRolloutTimeout = null;
    }
    logger.debug('Auto-update service stopped');
  }

  /**
   * Check for updates without installing.
   */
  async checkForUpdates(): Promise<NpmVersionInfo> {
    const current = this.getCurrentVersion();
    const latest = await this.getLatestVersion();
    return {
      current,
      latest,
      updateAvailable: this.isNewer(latest, current),
    };
  }

  /**
   * Admit one manual self-update onto the durable root-owned rail.
   *
   * Admission is deliberately separate from the legacy synchronous
   * `triggerUpdate()` result: publishing a trigger proves only that systemd
   * accepted durable work, never that npm installed or that restart completed.
   */
  async requestUpdate(request: SelfUpdateRequest): Promise<SelfUpdateStatus> {
    if (!UUID_V4_RE.test(request.requestId)) {
      throw new SelfUpdateRailError('INVALID_REQUEST_ID', 'Invalid Agent update requestId', 400);
    }
    if (semver.valid(request.expectedCurrentVersion) !== request.expectedCurrentVersion
      || semver.valid(request.targetVersion) !== request.targetVersion) {
      throw new SelfUpdateRailError('INVALID_UPDATE_VERSION', 'Invalid exact Agent update version', 400);
    }

    const existing = this.exactReplayOrConflict(
      request.requestId,
      request.expectedCurrentVersion,
      request.targetVersion
    );
    if (existing) return existing;

    const force = request.force ?? false;
    const info = await this.checkForUpdates();
    if (info.current !== request.expectedCurrentVersion) {
      throw new SelfUpdateRailError(
        'SELF_UPDATE_CURRENT_VERSION_CONFLICT',
        'Installed Agent version does not match expectedCurrentVersion',
        409
      );
    }
    if (info.latest !== request.targetVersion) {
      throw new SelfUpdateRailError(
        'SELF_UPDATE_TARGET_VERSION_CONFLICT',
        'Configured Agent channel does not resolve to targetVersion',
        409
      );
    }
    if (!this.isNewer(request.targetVersion, request.expectedCurrentVersion) && !(
      force && request.targetVersion === request.expectedCurrentVersion
    )) {
      throw new SelfUpdateRailError(
        'NO_UPDATE_AVAILABLE',
        'Exact target is not newer; equality requires force=true',
        409
      );
    }
    return await this.admitResolvedUpdate(
      request.requestId,
      request.expectedCurrentVersion,
      request.targetVersion
    );
  }

  private async admitResolvedUpdate(
    requestId: string,
    currentVersion: string,
    targetVersion: string
  ): Promise<SelfUpdateStatus> {
    if (!this.acquireLock()) {
      throw new SelfUpdateRailError('SELF_UPDATE_BUSY', 'Another Agent update is in progress', 409);
    }

    try {
      const replay = this.exactReplayOrConflict(requestId, currentVersion, targetVersion);
      if (replay) return replay;

      // A merely installed .path unit is not an execution guarantee. Disabled,
      // failed, and rate-limited units all fail this argv-safe active check, so
      // no trigger is published when systemd cannot consume it.
      if (!(await this.isUpdaterPathUnitActive())) {
        throw new SelfUpdateRailError(
          'SELF_UPDATE_RAIL_INACTIVE',
          `Root-owned updater path is not active: ${UPDATER_PATH_UNIT}`,
          503
        );
      }

      try {
        const request = await this.installViaTriggerFile(requestId, targetVersion, currentVersion);
        return {
          status: 'pending',
          requestId: request.requestId,
          package: PACKAGE_NAME,
          channel: request.channel,
          previousVersion: request.currentVersion,
          targetVersion: request.targetVersion,
          requestedAt: request.requestedAt,
          pollPath: `/agent/update/${request.requestId}`,
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          const replayAfterRace = this.exactReplayOrConflict(
            requestId,
            currentVersion,
            targetVersion
          );
          if (replayAfterRace) return replayAfterRace;
          throw new SelfUpdateRailError(
            'SELF_UPDATE_BUSY',
            'A durable Agent update request is already pending',
            409
          );
        }
        throw err;
      }
    } finally {
      this.releaseLock();
    }
  }

  private exactReplayOrConflict(
    requestId: string,
    expectedCurrentVersion: string,
    targetVersion: string
  ): SelfUpdateStatus | null {
    const existing = this.getUpdateStatus(requestId);
    if (!existing) return null;
    if (existing.previousVersion !== expectedCurrentVersion
      || existing.targetVersion !== targetVersion
      || existing.channel !== this.config.channel) {
      throw new SelfUpdateRailError(
        'SELF_UPDATE_REQUEST_ID_CONFLICT',
        'requestId is already bound to a different Agent update identity',
        409
      );
    }
    return existing;
  }

  /**
   * Observe a durable self-update operation. A receipt is terminal only after
   * the root helper has also removed both active and trigger evidence. This
   * keeps the active->receipt->restart->cleanup race externally pending.
   */
  getUpdateStatus(requestId: string): SelfUpdateStatus | null {
    if (!UUID_V4_RE.test(requestId)) {
      throw new SelfUpdateRailError('INVALID_REQUEST_ID', 'Invalid Agent update requestId', 400);
    }

    const trigger = this.readTrustedRequestEvidence(
      this.triggerFile,
      this.agentUid,
      0o600,
      'trigger'
    );
    const active = this.readTrustedRequestEvidence(
      this.activeFile,
      this.rootUid,
      0o644,
      'active state'
    );
    const receiptPath = `${this.stateDir}/${requestId}.receipt`;
    const receipt = this.readTrustedReceipt(receiptPath, requestId);
    const matchingTrigger = trigger?.requestId === requestId ? trigger : null;
    const matchingActive = active?.requestId === requestId ? active : null;
    const requestEvidence = matchingTrigger ?? matchingActive;

    if (matchingTrigger && matchingActive && !sameRequestIdentity(matchingTrigger, matchingActive)) {
      throw new SelfUpdateRailError(
        'SELF_UPDATE_EVIDENCE_CONFLICT',
        'Agent update trigger and active state identities conflict'
      );
    }
    if (receipt && requestEvidence) {
      const receiptRequest: SelfUpdateRequestEvidence = {
        requestId: receipt.terminal.requestId,
        currentVersion: receipt.terminal.previousVersion,
        targetVersion: receipt.terminal.targetVersion,
        channel: receipt.terminal.channel,
        requestedAt: receipt.terminal.requestedAt,
      };
      if (!sameRequestIdentity(requestEvidence, receiptRequest)) {
        throw new SelfUpdateRailError(
          'SELF_UPDATE_EVIDENCE_CONFLICT',
          'Agent update request and receipt identities conflict'
        );
      }
    }

    if (receipt?.committing) {
      return pendingFromEvidence({
        requestId: receipt.terminal.requestId,
        currentVersion: receipt.terminal.previousVersion,
        targetVersion: receipt.terminal.targetVersion,
        channel: receipt.terminal.channel,
        requestedAt: receipt.terminal.requestedAt,
      });
    }
    if (requestEvidence) return pendingFromEvidence(requestEvidence);
    return receipt?.terminal ?? null;
  }

  /**
   * Trigger an immediate update (bypasses staged rollout).
   * Returns update result with version info.
   *
   * @param opts.force - When true (operator clicked "force update"), proceed
   *   to (re)install the channel tag even if `checkForUpdates` reports
   *   `updateAvailable:false`. This repairs/reinstalls an agent already at
   *   latest. `force` only changes the "proceed despite updateAvailable:false"
   *   decision — the install mechanism (in-process `npm install -g` when root,
   *   or the root-owned updater unit via `sudo systemctl start` when non-root)
   *   is unchanged.
   */
  async triggerUpdate(opts?: { force?: boolean }): Promise<{
    success: boolean;
    previousVersion: string;
    newVersion: string;
    willRestart: boolean;
    message: string;
  } | SelfUpdatePendingStatus> {
    // Every unprivileged/root-helper entry point uses the same durable rail.
    // WebSocket callers receive admission/poll metadata, never a false install
    // success before the helper receipt and cleanup exist.
    const force = opts?.force ?? false;
    if (!this.isRoot()) {
      throw new SelfUpdateRailError(
        'EXACT_SELF_UPDATE_REQUEST_REQUIRED',
        'Non-root Agent updates require caller-supplied requestId/current/target via requestUpdate()',
        400
      );
    }
    const info = await this.checkForUpdates();

    // Without an available update we normally no-op. A forced trigger skips this
    // early-return and reinstalls the channel tag (forced reinstall/repair).
    if (!info.updateAvailable && !force) {
      return {
        success: true,
        previousVersion: info.current,
        newVersion: info.current,
        willRestart: false,
        message: 'Already at latest version',
      };
    }

    // When forced and already at latest, there is no newer version to move to —
    // we reinstall the current channel tag, which resolves to info.current.
    const targetVersion = info.updateAvailable ? info.latest : info.current;
    const isReinstall = force && !info.updateAvailable;

    logger.info(
      { current: info.current, latest: info.latest, force, reinstall: isReinstall },
      isReinstall
        ? 'Forced reinstall triggered (already at latest)'
        : 'Manual update triggered'
    );

    try {
      // Acquire lock
      if (!this.acquireLock()) {
        return {
          success: false,
          previousVersion: info.current,
          newVersion: info.current,
          willRestart: false,
          message: 'Another update is in progress',
        };
      }

      try {
        const restartHandledExternally = await this.performUpdate(targetVersion, info.current);

        // When the install was delegated to the root-owned updater unit, the
        // validated wrapper installs AND restarts the agent. We
        // must NOT also verify (the agent is about to be restarted from under
        // us, so verify can't confirm) or self-restart (avoid a double restart).
        // Report willRestart and return.
        if (restartHandledExternally) {
          return {
            success: true,
            previousVersion: info.current,
            newVersion: targetVersion,
            willRestart: true,
            message: isReinstall
              ? `Reinstall delegated to ${UPDATER_UNIT}; agent will restart on ${targetVersion}`
              : `Update delegated to ${UPDATER_UNIT}; agent will restart on ${targetVersion}`,
          };
        }

        // The in-process npm install just ran (directly as root, or the
        // best-effort sudo fallback). It does NOT restart the agent, so we own
        // verify + restart. The installed version must match the target
        // (== current on a forced reinstall).
        const verified = await this.verifyUpdate(targetVersion);
        if (!verified) {
          throw new Error('Version verification failed after update');
        }

        // Request restart
        this.requestRestart();

        return {
          success: true,
          previousVersion: info.current,
          newVersion: targetVersion,
          willRestart: true,
          message: isReinstall
            ? `Reinstalling ${targetVersion}, restarting in 2 seconds`
            : `Updated to ${targetVersion}, restarting in 2 seconds`,
        };
      } finally {
        this.releaseLock();
      }
    } catch (err) {
      logger.error({ err }, 'Manual update failed');
      return {
        success: false,
        previousVersion: info.current,
        newVersion: info.current,
        willRestart: false,
        message: err instanceof Error ? err.message : 'Update failed',
      };
    }
  }

  /**
   * Check for updates and install if available.
   * Includes staged rollout delay and health check with rollback.
   */
  private async checkAndUpdate(): Promise<void> {
    try {
      const info = await this.checkForUpdates();

      if (!info.updateAvailable) {
        logger.debug({ current: info.current, latest: info.latest }, 'No update available');
        return;
      }

      logger.info(
        { current: info.current, latest: info.latest },
        'Update available, preparing upgrade'
      );

      // Staged rollout: random delay to prevent thundering herd
      if (this.config.stagedRolloutMaxDelayMs > 0) {
        const delay = this.calculateStagedDelay();
        logger.info({ delaySeconds: Math.round(delay / 1000) }, 'Staged rollout delay');
        await this.sleep(delay);

        // Re-check after delay - another agent may have updated
        const recheck = await this.checkForUpdates();
        if (!recheck.updateAvailable) {
          logger.info('Update no longer needed after staged delay');
          return;
        }
      }

      if (!this.isRoot()) {
        const accepted = await this.admitResolvedUpdate(randomUUID(), info.current, info.latest);
        if (accepted.status !== 'pending') {
          logger.info(
            {
              status: accepted.status,
              requestId: accepted.requestId,
              previousVersion: accepted.previousVersion,
              targetVersion: accepted.targetVersion,
              finishedAt: accepted.finishedAt,
            },
            'Periodic Agent update replayed a durable terminal receipt'
          );
          return;
        }
        logger.info(
          {
            requestId: accepted.requestId,
            previousVersion: accepted.previousVersion,
            targetVersion: accepted.targetVersion,
            pollPath: accepted.pollPath,
          },
          'Periodic Agent update accepted by durable root-owned rail'
        );
        return;
      }

      // Acquire lock (prevents multiple agents updating simultaneously)
      if (!this.acquireLock()) {
        logger.info('Another agent is updating, skipping');
        return;
      }

      try {
        // Store current version for potential rollback
        const previousVersion = info.current;

        // Perform the update. Returns true when delegated to the root-owned
        // updater unit (non-root + unit present), false for the in-process
        // install paths (root, or the sudo-npm fallback).
        const restartHandledExternally = await this.performUpdate(info.latest, previousVersion);

        // Delegated to the root-owned updater unit: its wrapper installs AND restarts
        // the agent outside the sandbox. Skip our own verify/health-check/
        // rollback/restart — they would race the unit's restart, and a rollback
        // can't run as the unprivileged agent anyway.
        if (restartHandledExternally) {
          logger.info(
            { previousVersion, newVersion: info.latest, unit: UPDATER_UNIT },
            'Update delegated to updater unit; it will restart the agent'
          );
          return;
        }

        // Verify the update was successful
        const verified = await this.verifyUpdate(info.latest);
        if (!verified) {
          logger.error(
            { expected: info.latest },
            'Update verification failed - installed version does not match'
          );
          if (this.config.rollbackOnFailure) {
            await this.rollback(previousVersion);
          }
          return;
        }

        // Real health check: verify new binary actually works
        const healthy = await this.performHealthCheck();
        if (!healthy) {
          logger.error('Health check failed - new binary is not working');
          if (this.config.rollbackOnFailure) {
            await this.rollback(previousVersion);
          } else {
            logger.warn('Rollback disabled, leaving broken update in place');
          }
          // Never restart with a broken binary
          return;
        }

        logger.info(
          { previousVersion, newVersion: info.latest },
          'Update complete, requesting restart'
        );
        this.requestRestart();
      } finally {
        this.releaseLock();
      }
    } catch (err) {
      logger.error({ err }, 'Auto-update check failed');
    }
  }

  /**
   * Calculate random delay for staged rollout.
   * Uses crypto-grade randomness for better distribution.
   */
  calculateStagedDelay(): number {
    // Use Math.random() for simplicity - crypto not needed for rollout timing
    return Math.floor(Math.random() * this.config.stagedRolloutMaxDelayMs);
  }

  /**
   * Sleep for specified milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.stagedRolloutTimeout = setTimeout(resolve, ms);
    });
  }

  /**
   * Get current installed version from package.json.
   */
  getCurrentVersion(): string {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const pkgPath = join(__dirname, '..', '..', 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
      return pkg.version ?? '0.0.0';
    } catch {
      // Fallback: try to read from global npm
      return '0.0.0';
    }
  }

  /**
   * Get latest version from npm registry.
   */
  private async getLatestVersion(): Promise<string> {
    const tag = this.config.channel;
    try {
      const { stdout } = await execAsync(`npm view ${PACKAGE_NAME}@${tag} version`, {
        timeout: 30_000,
      });
      return stdout.trim();
    } catch (err) {
      logger.warn({ err, channel: tag }, 'Failed to fetch latest version from npm');
      throw err;
    }
  }

  /**
   * Compare semver versions using the semver package.
   * Returns true if `latest` is newer than `current`.
   * Properly handles pre-releases (e.g., 1.0.0-beta.1 < 1.0.0)
   * and build metadata (ignored per semver spec).
   */
  isNewer(latest: string, current: string): boolean {
    try {
      // semver.gt handles all edge cases including pre-releases
      return semver.gt(latest, current);
    } catch {
      // Fallback to simple comparison if semver parsing fails
      logger.warn({ latest, current }, 'Failed to parse semver, falling back to string comparison');
      return latest > current;
    }
  }

  /**
   * Acquire update lock file atomically using O_EXCL.
   * Returns false if another agent is updating.
   */
  private acquireLock(): boolean {
    try {
      // Check for existing lock file
      if (existsSync(LOCK_FILE)) {
        const pidText = readFileSync(LOCK_FILE, 'utf-8').trim();
        if (!/^[1-9][0-9]*$/.test(pidText)) {
          logger.error({ lockFile: LOCK_FILE }, 'Invalid self-update lock owner; failing closed');
          return false;
        }
        const ownerPid = Number(pidText);
        try {
          process.kill(ownerPid, 0);
          logger.debug({ ownerPid }, 'Self-update lock owner is alive');
          return false;
        } catch (err) {
          const error = err as NodeJS.ErrnoException;
          if (error.code !== 'ESRCH') {
            logger.error({ err, ownerPid }, 'Could not prove self-update lock owner is dead');
            return false;
          }
        }
        logger.warn({ ownerPid }, 'Dead self-update lock owner detected; recovering lock');
        unlinkSync(LOCK_FILE);
      }

      // Atomic lock acquisition using O_EXCL (fails if file exists)
      const fd = openSync(
        LOCK_FILE,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600
      );
      try {
        writeFileSync(fd, String(process.pid), { encoding: 'utf8' });
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }

      logger.debug({ pid: process.pid }, 'Lock acquired');
      return true;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;

      // EEXIST means another process acquired the lock between our check and create
      if (error.code === 'EEXIST') {
        logger.debug('Lock acquisition failed - another process holds the lock');
        return false;
      }

      // The RuntimeDirectory is provisioned for the service user. Any other
      // error (notably EACCES) means mutual exclusion cannot be proven, so the
      // update must fail closed.
      logger.error({ err, lockFile: LOCK_FILE }, 'Could not acquire self-update lock');
      return false;
    }
  }

  /**
   * Release update lock file.
   */
  private releaseLock(): void {
    try {
      // Verify we still own the lock before releasing
      if (existsSync(LOCK_FILE)) {
        const pid = readFileSync(LOCK_FILE, 'utf-8').trim();
        if (pid === String(process.pid)) {
          unlinkSync(LOCK_FILE);
          logger.debug('Lock released');
        } else {
          logger.warn({ ourPid: process.pid, lockPid: pid }, 'Lock file owned by different process');
        }
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Check if running as root user.
   * If not root, we'll need sudo for npm global installs.
   */
  private isRoot(): boolean {
    return process.getuid?.() === 0;
  }

  private validateEvidenceParent(file: string, ownerUid: number): void {
    const parent = lstatSync(dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== ownerUid
      || (parent.mode & 0o022) !== 0) {
      throw new SelfUpdateRailError(
        'UNTRUSTED_SELF_UPDATE_EVIDENCE',
        `Untrusted Agent update evidence directory: ${dirname(file)}`
      );
    }
  }

  private readTrustedRequestEvidence(
    file: string,
    ownerUid: number,
    mode: number,
    label: string
  ): SelfUpdateRequestEvidence | null {
    try {
      this.validateEvidenceParent(file, ownerUid);
      const before = lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.uid !== ownerUid
        || (before.mode & 0o777) !== mode || before.nlink < 1 || before.nlink > 2
        || before.size < 1 || before.size > 512 || !constants.O_NOFOLLOW) {
        throw new SelfUpdateRailError(
          'UNTRUSTED_SELF_UPDATE_EVIDENCE',
          `Untrusted Agent update ${label}: ${file}`
        );
      }
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: string;
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
          || opened.uid !== before.uid || (opened.mode & 0o777) !== mode
          || opened.nlink !== before.nlink || opened.size !== before.size) {
          throw new SelfUpdateRailError(
            'UNTRUSTED_SELF_UPDATE_EVIDENCE',
            `Agent update ${label} changed during trusted read`
          );
        }
        content = readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
      if (!content.endsWith('\n') || content.slice(0, -1).includes('\n') || content.includes('\r')) {
        throw new SelfUpdateRailError(
          'INVALID_SELF_UPDATE_EVIDENCE',
          `Invalid Agent update ${label} framing`
        );
      }
      const fields = content.slice(0, -1).split(' ');
      if (fields.length !== 6) {
        throw new SelfUpdateRailError(
          'INVALID_SELF_UPDATE_EVIDENCE',
          `Invalid Agent update ${label} schema`
        );
      }
      const [schema, requestId, currentVersion, targetVersion, channel, requestedAt] = fields;
      if (schema !== 'v1' || !UUID_V4_RE.test(requestId)
        || semver.valid(currentVersion) !== currentVersion
        || semver.valid(targetVersion) !== targetVersion
        || !SELF_UPDATE_CHANNELS.has(channel) || !isExactIsoTimestamp(requestedAt)) {
        throw new SelfUpdateRailError(
          'INVALID_SELF_UPDATE_EVIDENCE',
          `Invalid Agent update ${label} identity`
        );
      }
      return { requestId, currentVersion, targetVersion, channel, requestedAt };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (err instanceof SelfUpdateRailError) throw err;
      throw new SelfUpdateRailError(
        'UNTRUSTED_SELF_UPDATE_EVIDENCE',
        `Could not inspect Agent update ${label}: ${file}`
      );
    }
  }

  private readTrustedReceipt(
    file: string,
    requestId: string
  ): SelfUpdateReceiptEvidence | null {
    try {
      this.validateEvidenceParent(file, this.rootUid);
      const before = lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.uid !== this.rootUid
        || (before.mode & 0o777) !== 0o644 || before.size < 1 || before.size > 2048
        || before.nlink < 1 || before.nlink > 2) {
        throw new SelfUpdateRailError(
          'UNTRUSTED_SELF_UPDATE_RECEIPT',
          'Untrusted Agent update receipt inode'
        );
      }
      // The root helper may have committed the final hardlink but not yet
      // removed its private temp name. The unprivileged Agent never repairs or
      // unlinks root evidence; it reports this crash window as pending.
      if (!constants.O_NOFOLLOW) {
        throw new SelfUpdateRailError(
          'UNTRUSTED_SELF_UPDATE_RECEIPT',
          'Secure Agent update receipt reads require O_NOFOLLOW support'
        );
      }

      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: string;
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
          || opened.uid !== before.uid || (opened.mode & 0o777) !== 0o644
          || opened.nlink !== before.nlink || opened.size !== before.size) {
          throw new SelfUpdateRailError(
            'UNTRUSTED_SELF_UPDATE_RECEIPT',
            'Agent update receipt changed during trusted read'
          );
        }
        content = readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }

      if (!content.endsWith('\n') || content.slice(0, -1).includes('\n') || content.includes('\r')) {
        throw new SelfUpdateRailError(
          'INVALID_SELF_UPDATE_RECEIPT',
          'Invalid Agent update receipt framing'
        );
      }
      const fields = content.slice(0, -1).split(' ');
      if (fields.length !== 12 || fields.some((field) => field.length === 0)) {
        throw new SelfUpdateRailError(
          'INVALID_SELF_UPDATE_RECEIPT',
          'Invalid Agent update receipt schema'
        );
      }
      const [schema, id, packageName, channel, previousVersion, targetVersion,
        installed, terminal, requestedAt, startedAt, finishedAt, reason] = fields;
      const installedValid = installed === 'none' || semver.valid(installed) === installed;
      if (schema !== 'v1' || id !== requestId || packageName !== PACKAGE_NAME
        || !SELF_UPDATE_CHANNELS.has(channel) || semver.valid(previousVersion) !== previousVersion
        || semver.valid(targetVersion) !== targetVersion || !installedValid
        || (terminal !== 'success' && terminal !== 'failure')
        || (terminal === 'success' && installed !== targetVersion)
        || !isExactIsoTimestamp(requestedAt) || !isExactIsoTimestamp(startedAt)
        || !isExactIsoTimestamp(finishedAt)
        || Date.parse(startedAt) < Date.parse(requestedAt)
        || Date.parse(finishedAt) < Date.parse(startedAt)
        || !/^[a-z][a-z0-9_]{1,63}$/.test(reason)) {
        throw new SelfUpdateRailError(
          'INVALID_SELF_UPDATE_RECEIPT',
          'Agent update receipt identity or terminal data is invalid'
        );
      }

      return {
        committing: before.nlink === 2,
        terminal: {
          status: terminal === 'success' ? 'succeeded' : 'failed',
          requestId,
          package: PACKAGE_NAME,
          channel,
          previousVersion,
          targetVersion,
          installedVersion: installed === 'none' ? null : installed,
          requestedAt,
          startedAt,
          finishedAt,
          reason,
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (err instanceof SelfUpdateRailError) throw err;
      throw new SelfUpdateRailError(
        'UNTRUSTED_SELF_UPDATE_RECEIPT',
        'Could not read trusted Agent update receipt'
      );
    }
  }

  /**
   * Get the sudo prefix if running as non-root.
   * Returns 'sudo ' for non-root users, empty string for root.
   */
  private getSudoPrefix(): string {
    return this.isRoot() ? '' : 'sudo ';
  }

  /** Require the root-owned path watcher to be actively consuming triggers. */
  private async isUpdaterPathUnitActive(): Promise<boolean> {
    try {
      await execFileAsync(
        SYSTEMCTL_BIN,
        ['is-active', '--quiet', UPDATER_PATH_UNIT],
        { timeout: 10_000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Trigger an update by atomically creating the trigger file. The root-owned
   * `.path` unit activates the updater oneshot, which reads + deletes the
   * trigger and installs the target. The agent only ever CREATES the trigger;
   * the root wrapper is the sole deleter.
   */
  private async installViaTriggerFile(
    requestId: string,
    targetVersion: string,
    currentVersion: string
  ): Promise<{
    requestId: string;
    currentVersion: string;
    targetVersion: string;
    channel: string;
    requestedAt: string;
  }> {
    const channel = this.config.channel;
    if (!SELF_UPDATE_CHANNELS.has(channel)) {
      throw new Error(`Unsupported self-update channel: ${channel}`);
    }
    if (semver.valid(currentVersion) !== currentVersion) {
      throw new Error(`Invalid current self-update version: ${currentVersion}`);
    }
    if (semver.valid(targetVersion) !== targetVersion) {
      throw new Error(`Invalid target self-update version: ${targetVersion}`);
    }

    if (!UUID_V4_RE.test(requestId)) {
      throw new Error('Invalid self-update requestId');
    }
    const requestedAt = new Date().toISOString();
    const line = `v1 ${requestId} ${currentVersion} ${targetVersion} ${channel} ${requestedAt}\n`;
    logger.info(
      { trigger: this.triggerFile, requestId, currentVersion, targetVersion, channel },
      'Publishing self-update trigger file'
    );
    publishSelfUpdateTriggerAtomically(this.triggerFile, line);
    logger.info(
      { trigger: this.triggerFile, requestId },
      'Trigger published; updater .path will install + restart the agent'
    );
    return { requestId, currentVersion, targetVersion, channel, requestedAt };
  }

  /**
   * Detect whether the root-owned updater unit is installed on this host.
   * `systemctl cat <unit>` exits 0 when the unit exists, non-zero otherwise,
   * so a resolved exec means the unit is available.
   */
  private async hasUpdaterUnit(): Promise<boolean> {
    try {
      await execAsync(`systemctl cat ${UPDATER_UNIT}`, { timeout: 10_000 });
      return true;
    } catch {
      // Non-zero exit (unit absent) or systemctl unavailable (non-systemd / dev).
      return false;
    }
  }

  /**
   * Install the update by starting the root-owned updater unit AS the agent
   * user via sudo.
   *
   * The agent runs as the unprivileged `zn-vault-agent` user. A bare
   * `systemctl start` is denied by polkit ("Interactive authentication
   * required"), but the provisioned sudoers rule permits exactly:
   *   `sudo /usr/bin/systemctl start zn-vault-agent-updater.service`
   * (NOPASSWD). The oneshot's root wrapper validates the durable trigger, runs
   * `npm install -g -- <package>@<exact-target>`, verifies readback, persists a
   * receipt, and invokes `systemctl try-restart zn-vault-agent` as root in its
   * OWN namespace where /usr/bin is writable. Because the wrapper already restarts
   * the agent, callers MUST NOT also self-restart (see performUpdate's return
   * contract).
   *
   * The command string is `sudo /usr/bin/systemctl start <unit>` for the
   * non-root agent; this is the only privilege path used here. The absolute
   * systemctl path is required so it matches the sudoers rule exactly.
   *
   * The exact target is carried only in the immutable trigger; it is never
   * interpolated into this systemctl command.
   */
  private async installViaUpdaterUnit(): Promise<void> {
    const startCmd = `${this.getSudoPrefix()}${SYSTEMCTL_BIN} start ${UPDATER_UNIT}`;
    logger.info({ unit: UPDATER_UNIT, cmd: startCmd }, 'Delegating install to root-owned updater unit');
    const { stdout, stderr } = await execAsync(startCmd, {
      timeout: 5 * 60 * 1000, // 5 minute timeout (matches npm install)
    });
    if (stdout) logger.debug({ stdout: stdout.trim() }, 'updater unit start stdout');
    if (stderr) logger.debug({ stderr: stderr.trim() }, 'updater unit start stderr');
    logger.info({ unit: UPDATER_UNIT }, 'Updater unit started; it will install and restart the agent');
  }

  /**
   * Clear npm cache to ensure clean install.
   * This helps prevent issues from interrupted previous installs.
   */
  private async clearNpmCache(): Promise<void> {
    try {
      // npm cache clean doesn't require sudo
      await execAsync('npm cache clean --force', { timeout: 60_000 });
      logger.debug('npm cache cleared');
    } catch (err) {
      // Cache clear failure is not critical - log and continue
      logger.warn({ err }, 'Failed to clear npm cache, proceeding anyway');
    }
  }

  /**
   * Perform the update, choosing the install strategy by privilege/environment.
   *
   * Live testing (INC-2026-06-12-01) PROVED that an in-process `sudo npm
   * install` cannot write `/usr/bin` for a sandboxed agent: `ProtectSystem=strict`
   * makes `/usr` read-only IN THE AGENT'S MOUNT NAMESPACE, and `sudo` only
   * changes the uid — it does NOT escape the namespace — so the install fails
   * `EROFS`. The only working path for a non-root sandboxed agent is the
   * root-owned updater unit, which runs in its OWN clean namespace.
   *
   * Strategy:
   * - **root** → `npm install -g <package>@<exact-target>` directly (no sudo). Root is
   *   not sandboxed the same way, and the caller still verifies + restarts.
   * - **non-root + updater unit present** → `sudo /usr/bin/systemctl start
   *   <unit>` (permitted by the provisioned sudoers rule) after publishing the
   *   exact trigger. The wrapper installs + restarts outside the sandbox, so
   *   this returns `true` (restart
   *   handled externally) and the caller MUST NOT self-verify/self-restart
   *   (avoids a double restart, which would kill the agent mid-verify).
   * - **non-root + no updater unit** → best-effort `sudo npm install -g`. This
   *   fails `EROFS` under a strict sandbox but works in dev / on non-systemd
   *   hosts where there is no `ProtectSystem`. Caller keeps verify + restart.
   *
   * @returns `restartHandledExternally` — `true` when the updater unit was used
   *   (the unit's wrapper restarts the agent), `false` for the root and
   *   sudo-npm fallback paths (caller verifies the install and triggers restart).
   */
  private async performUpdate(
    targetVersion: string,
    currentVersion: string = this.getCurrentVersion()
  ): Promise<boolean> {
    // Non-root + .path unit present → sudo-free file trigger (preferred).
    if (!this.isRoot() && (await this.isUpdaterPathUnitActive())) {
      logger.info(
        { package: PACKAGE_NAME, targetVersion, strategy: 'trigger-file' },
        'Installing update via updater .path trigger file'
      );
      await this.clearNpmCache();
      await this.installViaTriggerFile(randomUUID(), targetVersion, currentVersion);
      return true; // The oneshot restarts the agent; caller must not double-restart.
    }

    // Non-root + only the old updater .service/sudoers → sudo systemctl start.
    if (!this.isRoot() && (await this.hasUpdaterUnit())) {
      logger.info(
        { package: PACKAGE_NAME, channel: this.config.channel, targetVersion, strategy: 'updater-unit' },
        'Installing update via root-owned updater unit'
      );
      await this.clearNpmCache();
      await this.installViaTriggerFile(randomUUID(), targetVersion, currentVersion);
      await this.installViaUpdaterUnit();
      return true;
    }

    // Root, or non-root without any unit: npm install (sudo when non-root).
    await this.performNpmInstall(targetVersion);
    return false;
  }

  /**
   * Run the in-process `npm install -g` with cache clearing and retries.
   * Uses sudo for non-root users (requires appropriate sudoers config).
   * Used by the root path and the non-root/no-unit best-effort fallback.
   */
  private async performNpmInstall(targetVersion: string): Promise<void> {
    const maxRetries = 2;
    const sudoPrefix = this.getSudoPrefix();

    logger.info(
      { package: PACKAGE_NAME, channel: this.config.channel, targetVersion, usingSudo: !this.isRoot() },
      'Installing update via npm'
    );

    // Step 1: Clear npm cache to ensure clean install
    await this.clearNpmCache();

    // Step 2: Perform install with retries
    let lastError: Error | null = null;
    const installCmd = `${sudoPrefix}npm install -g ${PACKAGE_NAME}@${targetVersion}`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const { stdout, stderr } = await execAsync(installCmd, {
          timeout: 5 * 60 * 1000, // 5 minute timeout
        });

        if (stdout) logger.debug({ stdout: stdout.trim() }, 'npm install stdout');
        if (stderr) logger.debug({ stderr: stderr.trim() }, 'npm install stderr');

        logger.info({ attempt, usingSudo: !this.isRoot() }, 'npm install succeeded');
        return; // Success
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries) {
          logger.warn(
            { attempt, maxRetries, err, usingSudo: !this.isRoot() },
            'npm install failed, retrying after delay'
          );
          await this.sleep(5000); // Wait 5s before retry
        }
      }
    }

    logger.error({ err: lastError, attempts: maxRetries, usingSudo: !this.isRoot() }, 'npm install failed after all retries');
    throw lastError ?? new Error('npm install failed after all retries');
  }

  /**
   * Verify the update was successful by checking the installed version.
   */
  private async verifyUpdate(expectedVersion: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(`npm list -g ${PACKAGE_NAME} --depth=0 2>/dev/null || true`, {
        timeout: 30_000,
      });

      // Parse output like "@zincapp/zn-vault-agent@1.4.0"
      const match = /@zincapp\/zn-vault-agent@(\S+)/.exec(stdout);
      if (!match) {
        logger.warn({ stdout: stdout.trim() }, 'Could not parse installed version');
        return true; // Proceed anyway - version might be installed correctly
      }

      const installedVersion = match[1];
      const matches = installedVersion === expectedVersion;

      if (matches) {
        logger.info({ installedVersion }, 'Update verified - version matches');
      } else {
        logger.error(
          { installedVersion, expectedVersion },
          'Update verification failed - version mismatch'
        );
      }

      return matches;
    } catch (err) {
      logger.warn({ err }, 'Could not verify installed version');
      return true; // Proceed anyway - verification is best-effort
    }
  }

  /**
   * Perform real health check by spawning new binary and verifying it responds.
   * This catches issues like missing dependencies, corrupted installs, etc.
   */
  private async performHealthCheck(): Promise<boolean> {
    try {
      // Find the new binary path
      const binaryPath = await this.findInstalledBinaryPath();
      if (!binaryPath) {
        logger.warn('Could not find installed binary path, skipping health check');
        return true; // Fail-open if we can't find binary
      }

      logger.debug({ binaryPath }, 'Running health check on new binary');

      // Run the new binary with --version to verify it starts
      const versionOk = await this.runBinaryHealthCheck(binaryPath, ['--version']);
      if (!versionOk) {
        logger.error('New binary failed --version check');
        return false;
      }

      // Run with --help to verify CLI parsing works
      const helpOk = await this.runBinaryHealthCheck(binaryPath, ['--help']);
      if (!helpOk) {
        logger.error('New binary failed --help check');
        return false;
      }

      logger.info('Health check passed - new binary is working');
      return true;
    } catch (err) {
      logger.error({ err }, 'Health check failed with exception');
      return false;
    }
  }

  /**
   * Find the path to the globally installed binary.
   */
  private async findInstalledBinaryPath(): Promise<string | null> {
    try {
      // npm bin -g returns the global bin directory
      const { stdout } = await execAsync('npm bin -g', { timeout: 10_000 });
      const binDir = stdout.trim();
      const binaryPath = join(binDir, 'zn-vault-agent');

      if (existsSync(binaryPath)) {
        return binaryPath;
      }

      // Try common paths
      const commonPaths = [
        '/usr/local/bin/zn-vault-agent',
        '/usr/bin/zn-vault-agent',
        join(process.env.HOME ?? '', '.npm-global/bin/zn-vault-agent'),
      ];

      for (const path of commonPaths) {
        if (existsSync(path)) {
          return path;
        }
      }

      return null;
    } catch (err) {
      logger.warn({ err }, 'Could not determine binary path');
      return null;
    }
  }

  /**
   * Run a health check command on the binary.
   */
  private runBinaryHealthCheck(binaryPath: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = this.config.healthCheckTimeoutMs;
      let resolved = false;

      const child = spawn(binaryPath, args, {
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.kill('SIGKILL');
          logger.warn({ binaryPath, args, timeout }, 'Health check timed out');
          resolve(false);
        }
      }, timeout);

      child.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          const success = code === 0;
          if (!success) {
            logger.warn({ binaryPath, args, exitCode: code }, 'Health check command failed');
          }
          resolve(success);
        }
      });

      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          logger.warn({ err, binaryPath, args }, 'Health check spawn error');
          resolve(false);
        }
      });
    });
  }

  /**
   * Rollback to previous version after failed update.
   * Uses sudo for non-root users.
   */
  private async rollback(previousVersion: string): Promise<void> {
    logger.warn({ previousVersion, usingSudo: !this.isRoot() }, 'Rolling back to previous version');

    try {
      const sudoPrefix = this.getSudoPrefix();
      const { stdout, stderr } = await execAsync(
        `${sudoPrefix}npm install -g ${PACKAGE_NAME}@${previousVersion}`,
        { timeout: 5 * 60 * 1000 }
      );

      if (stdout) logger.debug({ stdout: stdout.trim() }, 'Rollback npm install stdout');
      if (stderr) logger.debug({ stderr: stderr.trim() }, 'Rollback npm install stderr');

      // Verify rollback succeeded
      const verified = await this.verifyUpdate(previousVersion);
      if (verified) {
        logger.info({ previousVersion }, 'Rollback successful');
      } else {
        logger.error({ previousVersion }, 'Rollback verification failed - system may be in inconsistent state');
      }
    } catch (err) {
      logger.error({ err, previousVersion }, 'Rollback failed - system may be in inconsistent state');
    }
  }

  /**
   * Request daemon restart via SIGTERM.
   * systemd will restart us with the new version.
   * Ensures logs are flushed before sending signal.
   */
  private requestRestart(): void {
    logger.info('Sending SIGTERM to self for restart');

    // Flush logs before restart to ensure all messages are persisted
    flushLogs()
      .catch((err: unknown) => {
        // Log flush failure shouldn't prevent restart
        logger.warn({ err }, 'Failed to flush logs before restart');
      })
      .finally(() => {
        // Small delay after flush to ensure async writes complete
        setTimeout(() => {
          process.kill(process.pid, 'SIGTERM');
        }, 500);
      });
  }
}

/**
 * Load update config from environment or use defaults.
 */
export function loadUpdateConfig(): UpdateConfig {
  const config: UpdateConfig = { ...DEFAULT_UPDATE_CONFIG };

  // Check for environment overrides
  const autoUpdate = process.env.AUTO_UPDATE?.trim().toLowerCase();
  if (autoUpdate === 'true' || autoUpdate === '1') {
    config.enabled = true;
  } else if (autoUpdate === 'false' || autoUpdate === '0') {
    config.enabled = false;
  }

  if (process.env.AUTO_UPDATE_INTERVAL) {
    const interval = parseInt(process.env.AUTO_UPDATE_INTERVAL, 10);
    if (!isNaN(interval) && interval > 0) {
      config.checkIntervalMs = interval * 1000; // Convert seconds to ms
    }
  }

  if (process.env.AUTO_UPDATE_CHANNEL) {
    const channel = process.env.AUTO_UPDATE_CHANNEL.toLowerCase();
    if (channel === 'latest' || channel === 'beta' || channel === 'next' || channel === 'dr-m4') {
      config.channel = channel;
    }
  }

  if (process.env.AUTO_UPDATE_STAGED_DELAY) {
    const delay = parseInt(process.env.AUTO_UPDATE_STAGED_DELAY, 10);
    if (!isNaN(delay) && delay >= 0) {
      config.stagedRolloutMaxDelayMs = delay * 1000; // Convert seconds to ms
    }
  }

  if (process.env.AUTO_UPDATE_ROLLBACK === 'false' || process.env.AUTO_UPDATE_ROLLBACK === '0') {
    config.rollbackOnFailure = false;
  }

  return config;
}
