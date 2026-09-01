import { mkdtemp, rm as realRm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tombstoneGate = vi.hoisted(() => ({
  block: false,
  entered: null as (() => void) | null,
  wait: null as Promise<void> | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (...args: unknown[]) => {
      const target = String(args[0]);
      if (tombstoneGate.block && target.includes('.released-')) {
        tombstoneGate.entered?.();
        if (tombstoneGate.wait) await tombstoneGate.wait;
      }
      return (actual.rm as (...values: unknown[]) => Promise<void>)(...args);
    },
  };
});

import {
  SharedMutationLock,
  SHARED_MUTATION_SIGNAL_COORDINATOR_KEY,
} from './shared-mutation-lock.js';

describe('shared mutation signal handoff', () => {
  let directory: string;
  let lockPath: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    Reflect.deleteProperty(globalThis, SHARED_MUTATION_SIGNAL_COORDINATOR_KEY);
    directory = await mkdtemp(path.join(tmpdir(), 'znvault-lock-handoff-'));
    lockPath = path.join(directory, 'znvault-deploy.lock');
  });

  afterEach(async () => {
    tombstoneGate.block = false;
    tombstoneGate.entered = null;
    tombstoneGate.wait = null;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await realRm(directory, { recursive: true, force: true });
  });

  it('keeps one global signal gate across an A-to-B pathname handoff', async () => {
    const originalHandler = vi.fn();
    process.on('SIGTERM', originalHandler);
    const nativeKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid, signal) => {
      if (pid === process.pid && signal === 'SIGTERM') {
        process.emit('SIGTERM', 'SIGTERM');
        return true;
      }
      return nativeKill(pid, signal);
    }) as typeof process.kill);

    let markTombstoneEntered!: () => void;
    const tombstoneEntered = new Promise<void>(resolve => {
      markTombstoneEntered = resolve;
    });
    let resumeTombstoneRemoval!: () => void;
    tombstoneGate.wait = new Promise<void>(resolve => {
      resumeTombstoneRemoval = resolve;
    });
    tombstoneGate.entered = markTombstoneEntered;
    tombstoneGate.block = true;

    const first = new SharedMutationLock(lockPath);
    const second = new SharedMutationLock(lockPath);
    await first.acquire('certificate');

    // release() has renamed away the pathname, but its process-wide signal
    // participant remains active while tombstone removal is paused.
    const firstRelease = first.release();
    await tombstoneEntered;
    await second.acquire('secret');

    process.emit('SIGTERM', 'SIGTERM');
    expect(originalHandler).not.toHaveBeenCalled();

    tombstoneGate.block = false;
    await second.release();
    expect(originalHandler).not.toHaveBeenCalled();

    resumeTombstoneRemoval();
    await firstRelease;
    expect(killSpy).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');

    await expect(new SharedMutationLock(lockPath).acquire('certificate')).rejects
      .toMatchObject({ code: 'SHARED_MUTATION_LOCK_SHUTDOWN_PENDING' });

    await vi.runAllTimersAsync();
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(originalHandler).toHaveBeenCalledTimes(1);
    expect(
      process.listeners('SIGTERM').filter(handler => handler === originalHandler)
    ).toHaveLength(1);

    // Shutdown authorization is sticky after replay; a microtask cannot start
    // another mutation before the daemon's restored handler exits the process.
    await expect(new SharedMutationLock(lockPath).acquire('certificate')).rejects
      .toMatchObject({
        code: 'SHARED_MUTATION_LOCK_SHUTDOWN_PENDING',
      });

    process.removeListener('SIGTERM', originalHandler);
  });
});
