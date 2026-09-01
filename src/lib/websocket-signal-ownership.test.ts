import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SharedMutationLock,
  SHARED_MUTATION_SIGNAL_COORDINATOR_KEY,
} from './shared-mutation-lock.js';
import { daemonSignalLifecycleForTest } from './websocket.js';

describe('daemon termination signal ownership', () => {
  let originalSigintListeners: NodeJS.SignalsListener[];
  let originalSigtermListeners: NodeJS.SignalsListener[];
  let directory: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    originalSigintListeners = process.listeners('SIGINT') as NodeJS.SignalsListener[];
    originalSigtermListeners = process.listeners('SIGTERM') as NodeJS.SignalsListener[];
    Reflect.deleteProperty(globalThis, SHARED_MUTATION_SIGNAL_COORDINATOR_KEY);
    directory = await mkdtemp(path.join(tmpdir(), 'znvault-daemon-signals-'));
  });

  afterEach(async () => {
    daemonSignalLifecycleForTest.cleanup();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    for (const listener of originalSigintListeners) process.on('SIGINT', listener);
    for (const listener of originalSigtermListeners) process.on('SIGTERM', listener);
    Reflect.deleteProperty(globalThis, SHARED_MUTATION_SIGNAL_COORDINATOR_KEY);
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('removes a transitive listener that would synchronously re-raise SIGTERM', async () => {
    const reRaise = vi.fn(() => process.kill(process.pid, 'SIGTERM'));
    process.on('SIGTERM', reRaise);
    const shutdown = vi.fn(async () => undefined);
    const killSpy = vi.spyOn(process, 'kill');

    daemonSignalLifecycleForTest.setup(shutdown);
    process.emit('SIGTERM', 'SIGTERM');
    await Promise.resolve();

    expect(shutdown).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledWith('SIGTERM');
    expect(reRaise).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('swaps startup for runtime behavior without bypassing active signal deferral', async () => {
    const startupShutdown = vi.fn(async () => undefined);
    const runtimeShutdown = vi.fn(async () => {
      daemonSignalLifecycleForTest.cleanup();
    });
    daemonSignalLifecycleForTest.setup(startupShutdown);

    const lock = new SharedMutationLock(path.join(directory, 'znvault-deploy.lock'));
    await lock.acquire('certificate');
    daemonSignalLifecycleForTest.setup(runtimeShutdown);

    process.emit('SIGTERM', 'SIGTERM');
    expect(startupShutdown).not.toHaveBeenCalled();
    expect(runtimeShutdown).not.toHaveBeenCalled();

    const nativeKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid, signal) => {
      if (pid === process.pid && signal === 'SIGTERM') {
        process.emit('SIGTERM', 'SIGTERM');
        return true;
      }
      return nativeKill(pid, signal);
    }) as typeof process.kill);

    await lock.release();
    await vi.runAllTimersAsync();

    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(startupShutdown).not.toHaveBeenCalled();
    expect(runtimeShutdown).toHaveBeenCalledOnce();
    expect(runtimeShutdown).toHaveBeenCalledWith('SIGTERM');
  });
});
