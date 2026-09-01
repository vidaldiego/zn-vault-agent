import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgeSecretMutation,
  admitSecretMutationAfterAwait,
  admitSecretEventToRetryQueue,
  createSingleFlightOperation,
  drainActiveDeployments,
  InitialChildStartBarrier,
  initializeExecSecretIdentity,
  isSecretVersionConsumed,
  pollExecOnlySecretVersions,
  runAdmittedChildRestart,
  type SecretMutationEvidence,
  type SecretRetryItem,
  withActiveDeployment,
} from './websocket.js';
import { RestartRequiredMutationQueue } from './coalescing-retry-queue.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('daemon mutation drain', () => {
  it('does not complete teardown drain before an admitted mutation unwinds', async () => {
    vi.useFakeTimers();
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>(resolve => {
      releaseMutation = resolve;
    });
    const mutation = withActiveDeployment(async () => mutationGate);

    let drainFinished = false;
    const drain = drainActiveDeployments(1_000, 10).then((remaining) => {
      drainFinished = true;
      return remaining;
    });
    await Promise.resolve();
    expect(drainFinished).toBe(false);

    releaseMutation();
    await mutation;
    await vi.advanceTimersByTimeAsync(10);

    await expect(drain).resolves.toBe(0);
    expect(drainFinished).toBe(true);
  });

  it.each(['secret', 'exec'])('keeps drain blocked through an admitted %s restart', async (kind) => {
    vi.useFakeTimers();
    let releaseRestart!: () => void;
    const restartGate = new Promise<void>(resolve => {
      releaseRestart = resolve;
    });
    const queue = new RestartRequiredMutationQueue<string, { version: number }>({
      prepare: async () => ({ decision: 'resolved', evidence: { version: 3 } }),
      restart: async () => runAdmittedChildRestart(
        `${kind} mutation`,
        () => false,
        async () => restartGate
      ),
      account: withActiveDeployment,
      retryDelayMs: 60_000,
    });
    queue.enqueuePrepared(`${kind}-target`, 3, `${kind}-v3`, { version: 3 });
    const mutation = queue.retryNow(`${kind}-target`);
    await Promise.resolve();

    // Shutdown stops future queue work before draining, but the already
    // admitted restart must retain its active lease.
    queue.stop();
    let drainFinished = false;
    const drain = drainActiveDeployments(1_000, 10).then(remaining => {
      drainFinished = true;
      return remaining;
    });
    await Promise.resolve();
    expect(drainFinished).toBe(false);

    releaseRestart();
    await mutation;
    await vi.advanceTimersByTimeAsync(10);

    await expect(drain).resolves.toBe(0);
  });

  it('rejects a restart admitted after shutdown even if unrelated work is active', async () => {
    let releaseUnrelated!: () => void;
    const unrelatedGate = new Promise<void>(resolve => {
      releaseUnrelated = resolve;
    });
    const unrelatedMutation = withActiveDeployment(async () => unrelatedGate);
    const restart = vi.fn().mockResolvedValue(undefined);

    await expect(runAdmittedChildRestart(
      'late plugin restart',
      () => true,
      restart
    )).rejects.toThrow('shutdown admission closed');
    expect(restart).not.toHaveBeenCalled();

    releaseUnrelated();
    await unrelatedMutation;
  });

  it('keeps a pre-sync mutation pending when initial start fails, then restarts and acknowledges', async () => {
    const initialStart = new InitialChildStartBarrier();
    const restart = vi.fn().mockResolvedValue(undefined);
    const acknowledge = vi.fn();
    const queue = new RestartRequiredMutationQueue<string, { version: number }>({
      prepare: async () => ({ decision: 'resolved', evidence: { version: 5 } }),
      restart: async () => {
        const disposition = await initialStart.beforeRestart();
        if (disposition === 'covered-by-initial-start') return;
        await runAdmittedChildRestart(
          'secret before initial sync',
          () => false,
          restart
        );
      },
      acknowledge,
      retryDelayMs: 60_000,
    });
    queue.enqueuePrepared('secret-target', 5, 'secret-v5', { version: 5 });

    const initialAttempt = queue.retryNow('secret-target');
    await Promise.resolve();
    expect(queue.isPending('secret-target')).toBe(true);
    expect(restart).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();

    initialStart.fail(new Error('initial child start failed'));
    await expect(initialAttempt).resolves.toBe(false);
    expect(queue.isPending('secret-target')).toBe(true);
    expect(acknowledge).not.toHaveBeenCalled();

    // A later queue retry owns recovery after the failed initial start.
    await expect(queue.retryNow('secret-target')).resolves.toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('does not acknowledge a pre-sync mutation until initial child start completes', async () => {
    const initialStart = new InitialChildStartBarrier();
    const restart = vi.fn();
    const acknowledge = vi.fn();
    const queue = new RestartRequiredMutationQueue<string, { version: number }>({
      prepare: async () => ({ decision: 'resolved', evidence: { version: 8 } }),
      restart: async () => {
        const disposition = await initialStart.beforeRestart();
        if (disposition === 'restart-required') await restart();
      },
      acknowledge,
      retryDelayMs: 60_000,
    });
    queue.enqueuePrepared('secret-target', 8, 'secret-v8', { version: 8 });

    const attempt = queue.retryNow('secret-target');
    await Promise.resolve();
    initialStart.open();
    await Promise.resolve();
    expect(queue.isPending('secret-target')).toBe(true);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();

    initialStart.complete();
    await expect(attempt).resolves.toBe(true);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it('lets an awaited plugin startup restart defer to the later initial start', async () => {
    const initialStart = new InitialChildStartBarrier();

    await expect(initialStart.beforePluginRestart())
      .resolves.toBe('covered-by-initial-start');
  });

  it('revalidates a monotonic secret watermark after a concurrent plugin await', async () => {
    let consumedVersion: number | undefined;
    let pendingGeneration: number | undefined;
    const enqueue = vi.fn(() => {
      pendingGeneration = 2;
    });
    let releaseSecondPlugin!: () => void;
    const secondPluginGate = new Promise<void>(resolve => {
      releaseSecondPlugin = resolve;
    });
    const second = admitSecretMutationAfterAwait({
      isAlreadyConsumed: () => isSecretVersionConsumed(
        consumedVersion,
        2,
        pendingGeneration
      ),
      beforeEnqueue: async () => secondPluginGate,
      enqueue,
    });

    const first = await admitSecretMutationAfterAwait({
      isAlreadyConsumed: () => isSecretVersionConsumed(
        consumedVersion,
        2,
        pendingGeneration
      ),
      beforeEnqueue: async () => undefined,
      enqueue,
    });
    expect(first).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);

    releaseSecondPlugin();
    await expect(second).resolves.toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(isSecretVersionConsumed(2, 1, undefined)).toBe(true);
    expect(isSecretVersionConsumed(undefined, 0, 0)).toBe(true);
    expect(isSecretVersionConsumed(1, 2, 3)).toBe(true);
  });

  it('handles a real alias-configured exec event under its canonical key exactly once', async () => {
    const execSecretIdentityByReference = new Map<string, string>();
    const execSecretReferences = initializeExecSecretIdentity(
      ['alias:example/prod'],
      execSecretIdentityByReference
    );
    const consumedSecretVersions = new Map<string, number>();
    const consumedExecSecretVersions = new Map<string, number>();
    const notify = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn().mockResolvedValue(undefined);
    const acknowledgedIdentities: string[] = [];
    const prepare = vi.fn().mockResolvedValue({ decision: 'failed' as const });
    const queue = new RestartRequiredMutationQueue<
      SecretRetryItem,
      SecretMutationEvidence
    >({
      prepare,
      notify: async (item, evidence) => notify(item, evidence),
      restart: async (item, evidence) => restart(item, evidence),
      acknowledge: (item, evidence) => {
        acknowledgedIdentities.push(acknowledgeSecretMutation(item, evidence, {
          consumedSecretVersions,
          consumedExecSecretVersions,
          execSecretIdentityByReference,
        }));
      },
      retryDelayMs: 60_000,
    });
    const event = {
      event: 'secret.updated' as const,
      secretId: '00000000-0000-0000-0000-000000000000',
      alias: 'example/prod',
      version: 2,
      timestamp: '2026-08-31T21:30:00.000Z',
      tenantId: 'tenant-1',
    };
    const handle = async () => admitSecretEventToRetryQueue({
      event: { ...event },
      execSecretReferences,
      execSecretIdentityByReference,
      consumedSecretVersions,
      consumedExecSecretVersions,
      queue,
      findTarget: () => undefined,
    });

    await expect(handle()).resolves.toEqual({
      status: 'queued',
      queuedKey: 'exec:alias:example/prod',
      execIdentity: 'alias:example/prod',
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(acknowledgedIdentities).toEqual(['alias:example/prod']);
    expect(consumedExecSecretVersions.get('alias:example/prod')).toBe(2);
    expect(consumedExecSecretVersions.has(event.secretId)).toBe(false);
    expect(execSecretIdentityByReference.get(event.secretId)).toBe('alias:example/prod');
    expect(queue.pendingCount).toBe(0);

    await expect(handle()).resolves.toEqual({ status: 'consumed' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(acknowledgedIdentities).toEqual(['alias:example/prod']);
    expect(queue.pendingCount).toBe(0);
  });

  it('keeps polling single-flight across overlapping timer callbacks', async () => {
    let releasePoll!: () => void;
    const pollGate = new Promise<void>(resolve => {
      releasePoll = resolve;
    });
    const operation = vi.fn(async () => pollGate);
    const poll = createSingleFlightOperation(operation);

    const first = poll();
    await poll();
    await poll();
    expect(operation).toHaveBeenCalledTimes(1);

    releasePoll();
    await first;
    await poll();
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('recovers a lost exec-only event once across alias and UUID references', async () => {
    const identityByReference = new Map<string, string>();
    const consumedVersions = new Map<string, number>([['alias:example/prod', 1]]);
    const restart = vi.fn().mockResolvedValue(undefined);
    const queue = new RestartRequiredMutationQueue<
      { identity: string; version: number },
      { version: number }
    >({
      prepare: async value => ({
        decision: 'resolved',
        evidence: { version: value.version },
      }),
      restart: async () => restart(),
      acknowledge: (value, evidence) => {
        consumedVersions.set(value.identity, evidence.version);
      },
      retryDelayMs: 60_000,
    });
    const fetchMetadata = vi.fn(async (reference: string) => {
      if (reference !== 'alias:example/prod') {
        throw new Error(`unexpected duplicate fetch for ${reference}`);
      }
      return { id: 'secret-uuid', alias: 'example/prod', version: 2 };
    });
    const runExecPoll = async (): Promise<void> => pollExecOnlySecretVersions({
      references: ['alias:example/prod', 'secret-uuid', 'file-secret'],
      fileTargetReferences: ['file-secret'],
      identityByReference,
      consumedVersions,
      fetchMetadata,
      onMutation: async ({ identity, metadata }) => {
        const key = `exec:${identity}`;
        queue.enqueuePrepared(
          key,
          metadata.version,
          { identity, version: metadata.version },
          { version: metadata.version }
        );
        await queue.retryNow(key);
      },
    });

    // No WebSocket event is delivered: HTTP metadata alone observes v2 and
    // drives the real restart-required queue before advancing the watermark.
    await runExecPoll();
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(consumedVersions.get('alias:example/prod')).toBe(2);

    fetchMetadata.mockClear();
    await runExecPoll();
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('clears unknown exec metadata without a false restart, then restarts exactly once for a newer version', async () => {
    const identityByReference = new Map<string, string>();
    const consumedVersions = new Map<string, number>([['alias:example/prod', 7]]);
    const unknownIdentities = new Set<string>();
    const restart = vi.fn().mockResolvedValue(undefined);
    const queue = new RestartRequiredMutationQueue<
      { identity: string; version: number },
      { version: number }
    >({
      prepare: async value => ({
        decision: 'resolved',
        evidence: { version: value.version },
      }),
      restart: async () => restart(),
      acknowledge: (value, evidence) => {
        consumedVersions.set(value.identity, evidence.version);
      },
      maxRetryMs: 0,
    });
    const fetchMetadata = vi.fn<() => Promise<{
      id: string;
      alias: string;
      version: number;
    }>>()
      .mockRejectedValueOnce(new Error('metadata temporarily unavailable'))
      .mockRejectedValueOnce(new Error('metadata temporarily unavailable'));
    const runPoll = async (): Promise<void> => pollExecOnlySecretVersions({
      references: ['alias:example/prod', 'secret-uuid'],
      fileTargetReferences: [],
      identityByReference,
      consumedVersions,
      fetchMetadata,
      onFetchFailure: (_reference, identity) => {
        unknownIdentities.add(identity);
      },
      onFetchSuccess: (reference, identity, metadata) => {
        for (const candidate of [reference, identity, metadata.id, metadata.alias]) {
          unknownIdentities.delete(candidate);
          unknownIdentities.delete(`alias:${candidate}`);
          unknownIdentities.delete(candidate.replace(/^alias:/, ''));
        }
      },
      onMutation: async ({ identity, metadata }) => {
        const key = `exec:${identity}`;
        queue.enqueuePrepared(
          key,
          metadata.version,
          { identity, version: metadata.version },
          { version: metadata.version }
        );
        await queue.retryNow(key);
      },
    });

    await runPoll();
    expect(unknownIdentities).toEqual(new Set(['alias:example/prod', 'secret-uuid']));
    expect(queue.pendingCount).toBe(0);
    expect(restart).not.toHaveBeenCalled();
    expect(consumedVersions.get('alias:example/prod')).toBe(7);

    fetchMetadata.mockResolvedValueOnce({
      id: 'secret-uuid',
      alias: 'example/prod',
      version: 7,
    });
    await runPoll();
    expect(unknownIdentities.size).toBe(0);
    expect(queue.pendingCount).toBe(0);
    expect(restart).not.toHaveBeenCalled();
    expect(consumedVersions.get('alias:example/prod')).toBe(7);

    fetchMetadata.mockResolvedValueOnce({
      id: 'secret-uuid',
      alias: 'example/prod',
      version: 8,
    });
    await runPoll();
    expect(queue.pendingCount).toBe(0);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(consumedVersions.get('alias:example/prod')).toBe(8);
  });
});
