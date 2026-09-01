// Path: src/lib/shared-mutation-lock.ts
// Cross-process fence shared with znvault-plugin-payara.

import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isAbsolute } from 'node:path';

export const DEFAULT_SHARED_MUTATION_LOCK_PATH =
  '/var/lib/zn-vault-agent/znvault-deploy.lock';

/**
 * Resolve the cross-process lock path once at process startup.
 *
 * Production intentionally keeps the host-wide path shared with the Payara
 * plugin. Isolated test processes may opt into a private shared path before
 * importing the agent entrypoint.
 */
export function getSharedMutationLockPath(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const testOverride = environment.ZNVAULT_TEST_DEPLOY_LOCK_PATH?.trim();
  if (!testOverride) return DEFAULT_SHARED_MUTATION_LOCK_PATH;
  if (!isAbsolute(testOverride)) {
    throw new Error('ZNVAULT_TEST_DEPLOY_LOCK_PATH must be an absolute path');
  }
  return testOverride;
}

export const SHARED_MUTATION_LOCK_PATH = getSharedMutationLockPath();

const MAX_LOCK_BYTES = 64 * 1024;
const DEFERRED_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

type DeferredSignal = typeof DEFERRED_SIGNALS[number];

export const SHARED_MUTATION_SIGNAL_COORDINATOR_KEY = Symbol.for(
  '@zincapp/znvault-mutation-signal-deferral/v1'
);

/** Cross-package contract shared by agent and in-process Payara plugin. */
export interface SharedMutationSignalCoordinatorV1 {
  version: 1;
  participants: Set<symbol>;
  originalHandlers: Map<DeferredSignal, NodeJS.SignalsListener[]>;
  deferredHandlers: Map<DeferredSignal, NodeJS.SignalsListener>;
  pendingSignal: DeferredSignal | null;
  replayTimer: NodeJS.Timeout | null;
  deferredSequence: number;
  shutdownRequested: boolean;
  replayed: boolean;
  logger?: unknown;
}

const globalSignalRegistry = globalThis as unknown as {
  [key: symbol]: SharedMutationSignalCoordinatorV1 | undefined;
};

const coordinatorShapeIsValid = (
  value: SharedMutationSignalCoordinatorV1 | undefined
): value is SharedMutationSignalCoordinatorV1 =>
  value?.version === 1
  && value.participants instanceof Set
  && value.originalHandlers instanceof Map
  && value.deferredHandlers instanceof Map
  && (value.pendingSignal === null || DEFERRED_SIGNALS.includes(value.pendingSignal))
  && 'replayTimer' in value
  && Number.isSafeInteger(value.deferredSequence)
  && value.deferredSequence >= 0
  && typeof value.shutdownRequested === 'boolean'
  && typeof value.replayed === 'boolean';

function getSignalCoordinator(): SharedMutationSignalCoordinatorV1 {
  const existing = globalSignalRegistry[SHARED_MUTATION_SIGNAL_COORDINATOR_KEY];
  if (existing !== undefined) {
    if (!coordinatorShapeIsValid(existing)) {
      throw new SharedMutationLockError(
        'SHARED_MUTATION_LOCK_INITIALIZATION_FAILED',
        'Incompatible shared mutation signal coordinator is already installed'
      );
    }
    return existing;
  }

  const created: SharedMutationSignalCoordinatorV1 = {
    version: 1,
    participants: new Set(),
    originalHandlers: new Map(),
    deferredHandlers: new Map(),
    pendingSignal: null,
    replayTimer: null,
    deferredSequence: 0,
    shutdownRequested: false,
    replayed: false,
  };
  globalSignalRegistry[SHARED_MUTATION_SIGNAL_COORDINATOR_KEY] = created;
  return created;
}

function enterSignalDeferral(participant: symbol): void {
  const coordinator = getSignalCoordinator();
  if (coordinator.participants.has(participant)) {
    throw new SharedMutationLockError(
      'SHARED_MUTATION_LOCK_ALREADY_ACQUIRED',
      'Shared mutation signal participant is already active'
    );
  }
  if (
    coordinator.shutdownRequested
    || coordinator.pendingSignal
    || coordinator.replayTimer
  ) {
    throw new SharedMutationLockError(
      'SHARED_MUTATION_LOCK_SHUTDOWN_PENDING',
      'Shutdown is pending; refusing to admit a new shared mutation'
    );
  }

  if (coordinator.participants.size === 0) {
    for (const signal of DEFERRED_SIGNALS) {
      const originalHandlers = process.listeners(signal) as NodeJS.SignalsListener[];
      coordinator.originalHandlers.set(signal, originalHandlers);
      for (const handler of originalHandlers) process.removeListener(signal, handler);

      const deferredHandler: NodeJS.SignalsListener = () => {
        coordinator.deferredSequence++;
        coordinator.shutdownRequested = true;
        coordinator.pendingSignal ??= signal;
      };
      coordinator.deferredHandlers.set(signal, deferredHandler);
      process.on(signal, deferredHandler);
    }
  }

  coordinator.participants.add(participant);
}

function leaveSignalDeferral(participant: symbol): void {
  const coordinator = getSignalCoordinator();
  if (!coordinator.participants.delete(participant)) return;
  if (coordinator.participants.size > 0) return;

  for (const signal of DEFERRED_SIGNALS) {
    const deferredHandler = coordinator.deferredHandlers.get(signal);
    if (deferredHandler) process.removeListener(signal, deferredHandler);

    const currentHandlerCounts = new Map<NodeJS.SignalsListener, number>();
    for (const handler of process.listeners(signal) as NodeJS.SignalsListener[]) {
      currentHandlerCounts.set(handler, (currentHandlerCounts.get(handler) ?? 0) + 1);
    }
    const requiredHandlerCounts = new Map<NodeJS.SignalsListener, number>();
    for (const handler of coordinator.originalHandlers.get(signal) ?? []) {
      const requiredCount = (requiredHandlerCounts.get(handler) ?? 0) + 1;
      requiredHandlerCounts.set(handler, requiredCount);
      const currentCount = currentHandlerCounts.get(handler) ?? 0;
      if (currentCount < requiredCount) {
        process.on(signal, handler);
        currentHandlerCounts.set(handler, currentCount + 1);
      }
    }
  }
  coordinator.originalHandlers.clear();
  coordinator.deferredHandlers.clear();

  const pendingSignal = coordinator.pendingSignal;
  if (pendingSignal && !coordinator.replayed && !coordinator.replayTimer) {
    coordinator.replayTimer = setTimeout(() => {
      try {
        process.kill(process.pid, pendingSignal);
      } finally {
        // Sticky until process exit: a microtask cannot admit new work between
        // replay authorization and delivery to the restored shutdown handler.
        coordinator.replayed = true;
        coordinator.replayTimer = null;
      }
    }, 0);
  }
}

export type SharedMutationOperation =
  | 'certificate'
  | 'secret'
  | 'secret-cli'
  | 'startup-cleanup';

export type SharedMutationLockErrorCode =
  | 'SHARED_MUTATION_LOCK_ALREADY_ACQUIRED'
  | 'SHARED_MUTATION_LOCK_CONTENDED'
  | 'SHARED_MUTATION_LOCK_INITIALIZATION_FAILED'
  | 'SHARED_MUTATION_LOCK_LOST'
  | 'SHARED_MUTATION_LOCK_SHUTDOWN_PENDING';

export class SharedMutationLockError extends Error {
  readonly code: SharedMutationLockErrorCode;

  constructor(code: SharedMutationLockErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SharedMutationLockError';
    this.code = code;
  }
}

interface CompatibleLockData {
  pid: number;
  started: number;
  deploymentId: string;
  step: 'init';
  ownerToken: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface LockSnapshot {
  data?: CompatibleLockData;
  identity: FileIdentity;
}

const isErrno = (error: unknown, code: string): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === code;

const identityOf = (stats: Stats): FileIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
});

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const parseCompatibleLockData = (raw: string): CompatibleLockData | undefined => {
  try {
    const value = JSON.parse(raw) as Partial<CompatibleLockData>;
    if (
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.started !== 'number' ||
      !Number.isFinite(value.started) ||
      value.started <= 0 ||
      typeof value.deploymentId !== 'string' ||
      value.deploymentId.length === 0 ||
      value.step !== 'init' ||
      typeof value.ownerToken !== 'string' ||
      value.ownerToken.length === 0
    ) {
      return undefined;
    }

    return value as CompatibleLockData;
  } catch {
    return undefined;
  }
};

/**
 * Exclusive file lock compatible with znvault-plugin-payara's DeploymentLock.
 *
 * Existing paths are authoritative regardless of age or PID state. This class
 * deliberately never reaps a stale or malformed lock: recovery is an explicit
 * operator action performed only after all mutation entry points are quiesced.
 */
export class SharedMutationLock {
  private readonly lockPath: string;
  private readonly signalParticipant = Symbol('znvault-agent-mutation');
  private signalDeferralEntered = false;
  private ownedData: CompatibleLockData | null = null;
  private ownedHandle: FileHandle | null = null;
  private ownedIdentity: FileIdentity | null = null;

  constructor(lockPath = SHARED_MUTATION_LOCK_PATH) {
    this.lockPath = lockPath;
  }

  async acquire(operation: SharedMutationOperation): Promise<void> {
    if (
      this.signalDeferralEntered
      || this.ownedHandle
      || this.ownedData
      || this.ownedIdentity
    ) {
      throw new SharedMutationLockError(
        'SHARED_MUTATION_LOCK_ALREADY_ACQUIRED',
        'Shared mutation lock instance is already acquired'
      );
    }

    // Install the fence before the first asynchronous filesystem operation.
    // Otherwise a signal can land after O_EXCL creates the pathname but before
    // ownership initialization finishes, leaving a stale lock behind.
    enterSignalDeferral(this.signalParticipant);
    this.signalDeferralEntered = true;

    const data: CompatibleLockData = {
      pid: process.pid,
      started: Date.now(),
      deploymentId: `agent-${operation}-${randomUUID()}`,
      step: 'init',
      ownerToken: randomUUID(),
    };

    let handle: FileHandle;
    try {
      // O_CREAT | O_EXCL makes acquisition one atomic filesystem operation.
      handle = await open(this.lockPath, 'wx+', 0o644);
    } catch (error) {
      this.finishSignalDeferral();
      if (isErrno(error, 'EEXIST')) {
        throw new SharedMutationLockError(
          'SHARED_MUTATION_LOCK_CONTENDED',
          `Shared Payara mutation lock is already held: ${this.lockPath}`,
          error
        );
      }
      throw new SharedMutationLockError(
        'SHARED_MUTATION_LOCK_INITIALIZATION_FAILED',
        `Unable to acquire shared Payara mutation lock: ${this.lockPath}`,
        error
      );
    }

    let identity: FileIdentity | undefined;
    try {
      identity = identityOf(await handle.stat());
      await this.writeHandle(handle, data);
      const snapshot = await this.readSnapshot(this.lockPath);
      if (
        !snapshot ||
        !sameIdentity(snapshot.identity, identity) ||
        snapshot.data?.ownerToken !== data.ownerToken
      ) {
        throw new SharedMutationLockError(
          'SHARED_MUTATION_LOCK_INITIALIZATION_FAILED',
          'Shared Payara mutation lock ownership changed during acquisition'
        );
      }

      this.ownedData = data;
      this.ownedHandle = handle;
      this.ownedIdentity = identity;
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (identity) {
        await this.removeOwnedPath(identity, data.ownerToken).catch(() => false);
      }
      this.finishSignalDeferral();
      if (error instanceof SharedMutationLockError) {
        throw error;
      }
      throw new SharedMutationLockError(
        'SHARED_MUTATION_LOCK_INITIALIZATION_FAILED',
        'Unable to initialize shared Payara mutation lock',
        error
      );
    }
  }

  /** Release only the inode and owner token acquired by this instance. */
  async release(): Promise<void> {
    const handle = this.ownedHandle;
    const identity = this.ownedIdentity;
    const ownerToken = this.ownedData?.ownerToken;

    if (!handle || !identity || !ownerToken) {
      return;
    }

    let releaseError: SharedMutationLockError | undefined;
    try {
      const removed = await this.removeOwnedPath(identity, ownerToken);
      if (!removed) {
        releaseError = new SharedMutationLockError(
          'SHARED_MUTATION_LOCK_LOST',
          'Shared Payara mutation lock ownership changed during release'
        );
      }
    } catch (error) {
      releaseError = new SharedMutationLockError(
        'SHARED_MUTATION_LOCK_LOST',
        'Unable to release shared Payara mutation lock safely',
        error
      );
    } finally {
      await handle.close().catch(() => undefined);
      this.ownedData = null;
      this.ownedHandle = null;
      this.ownedIdentity = null;
      this.finishSignalDeferral();
    }

    if (releaseError) {
      throw releaseError;
    }
  }

  private async readSnapshot(filePath: string): Promise<LockSnapshot | null> {
    let handle: FileHandle;
    try {
      handle = await open(filePath, 'r');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return null;
      }
      throw error;
    }

    try {
      const stats = await handle.stat();
      const raw = stats.size > 0 && stats.size <= MAX_LOCK_BYTES
        ? await this.readHandle(handle, stats.size)
        : '';
      return {
        data: parseCompatibleLockData(raw),
        identity: identityOf(stats),
      };
    } finally {
      await handle.close();
    }
  }

  private async readHandle(handle: FileHandle, size: number): Promise<string> {
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8');
  }

  private async writeHandle(handle: FileHandle, data: CompatibleLockData): Promise<void> {
    const buffer = Buffer.from(JSON.stringify(data, null, 2));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (bytesWritten === 0) {
        throw new Error('Unable to write shared mutation lock');
      }
      offset += bytesWritten;
    }
    await handle.truncate(buffer.length);
    await handle.sync();
  }

  /**
   * Move the owned pathname to a unique tombstone and verify it before rm.
   * A pre-existing replacement is never unlinked by this instance.
   */
  private async removeOwnedPath(
    identity: FileIdentity,
    ownerToken: string
  ): Promise<boolean> {
    const snapshot = await this.readSnapshot(this.lockPath);
    if (
      !snapshot ||
      !sameIdentity(snapshot.identity, identity) ||
      snapshot.data?.ownerToken !== ownerToken
    ) {
      return false;
    }

    const tombstonePath = `${this.lockPath}.released-${randomUUID()}`;
    try {
      await rename(this.lockPath, tombstonePath);
      const moved = await this.readSnapshot(tombstonePath);
      if (
        !moved ||
        !sameIdentity(moved.identity, identity) ||
        moved.data?.ownerToken !== ownerToken
      ) {
        return false;
      }
      await rm(tombstonePath);
      return true;
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return false;
      }
      throw error;
    }
  }

  private finishSignalDeferral(): void {
    if (!this.signalDeferralEntered) return;
    this.signalDeferralEntered = false;
    leaveSignalDeferral(this.signalParticipant);
  }
}

/** Monotonic observation point used to stop multi-target startup loops. */
export function getDeferredShutdownSequence(): number {
  return getSignalCoordinator().deferredSequence;
}

/** Signal associated with the most recent deferred-shutdown observation. */
export function getLastDeferredShutdownSignal(): DeferredSignal | null {
  return getSignalCoordinator().pendingSignal;
}

/** True while a mutation owns signal deferral and will restore captured handlers. */
export function isSharedMutationSignalDeferralActive(): boolean {
  return getSignalCoordinator().participants.size > 0;
}

export async function withSharedMutationLock<T>(
  operation: SharedMutationOperation,
  callback: () => Promise<T>,
  lockPath = SHARED_MUTATION_LOCK_PATH
): Promise<T> {
  const lock = new SharedMutationLock(lockPath);
  await lock.acquire(operation);
  try {
    return await callback();
  } finally {
    await lock.release();
  }
}
