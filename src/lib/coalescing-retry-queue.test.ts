import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CoalescingRetryQueue,
  reconcilePolledMutation,
  RestartRequiredMutationQueue,
  type RetryDecision,
} from './coalescing-retry-queue.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CoalescingRetryQueue', () => {
  it.each(['certificate', 'secret'])('coalesces a contended %s target to its latest generation', async (kind) => {
    vi.useFakeTimers();
    const attempts: Array<{ generation: number; value: string }> = [];
    const decisions: RetryDecision[] = ['retry', 'resolved'];
    const pending: number[] = [];
    const queue = new CoalescingRetryQueue<string>({
      retryDelayMs: 100,
      maxRetryMs: 1_000,
      process: async (_key, value, generation) => {
        attempts.push({ generation, value });
        return decisions.shift() ?? 'resolved';
      },
      onPendingChange: count => pending.push(count),
    });

    queue.enqueue(`${kind}-target`, 1, `${kind}-v1`);
    queue.enqueue(`${kind}-target`, 2, `${kind}-v2`);
    queue.enqueue(`${kind}-target`, 3, `${kind}-v3`);
    queue.enqueue(`${kind}-target`, 2, `${kind}-stale-v2`);

    await vi.advanceTimersByTimeAsync(200);

    expect(attempts).toEqual([
      { generation: 3, value: `${kind}-v3` },
      { generation: 3, value: `${kind}-v3` },
    ]);
    expect(queue.pendingCount).toBe(0);
    expect(pending).toEqual([1, 0]);
  });

  it('remains pending and unhealthy after bounded retries are exhausted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T00:00:00Z'));
    const exhausted = vi.fn();
    const queue = new CoalescingRetryQueue<string>({
      retryDelayMs: 100,
      maxRetryMs: 200,
      process: async () => 'retry',
      onExhausted: exhausted,
    });

    queue.enqueue('certificate-target', 7, 'v7');
    await vi.advanceTimersByTimeAsync(250);

    expect(exhausted).toHaveBeenCalledWith('certificate-target', 'v7', 7);
    expect(queue.isPending('certificate-target')).toBe(true);
    expect(queue.pendingCount).toBe(1);
  });

  it('keeps post-apply work pending until the full retry including restart succeeds', async () => {
    vi.useFakeTimers();
    const pending: number[] = [];
    const decisions: RetryDecision[] = ['failed', 'resolved'];
    const queue = new CoalescingRetryQueue<string>({
      retryDelayMs: 60_000,
      process: async () => decisions.shift() ?? 'failed',
      onPendingChange: count => pending.push(count),
    });
    queue.enqueue('secret-target', 9, 'v9');

    await expect(queue.retryNow('secret-target')).resolves.toBe(false);

    expect(queue.isPending('secret-target')).toBe(true);
    expect(pending).toEqual([1]);

    await expect(queue.retryNow('secret-target')).resolves.toBe(true);

    expect(queue.isPending('secret-target')).toBe(false);
    expect(pending).toEqual([1, 0]);
  });

  it('does not run a polling retry concurrently with an in-flight retry', async () => {
    vi.useFakeTimers();
    let releaseAttempt: (() => void) | undefined;
    const attemptGate = new Promise<void>((resolve) => {
      releaseAttempt = resolve;
    });
    const attempts: number[] = [];
    const queue = new CoalescingRetryQueue<string>({
      retryDelayMs: 60_000,
      process: async (_key, _value, generation) => {
        attempts.push(generation);
        await attemptGate;
        return 'failed';
      },
    });
    queue.enqueue('certificate-target', 12, 'v12');

    const firstRetry = queue.retryNow('certificate-target');
    await expect(queue.retryNow('certificate-target')).resolves.toBe(false);
    expect(attempts).toEqual([12]);

    releaseAttempt?.();
    await expect(firstRetry).resolves.toBe(false);
    expect(queue.isPending('certificate-target')).toBe(true);

    queue.stop();
  });

  it('does not schedule a trailing restart for an equal-generation duplicate', async () => {
    vi.useFakeTimers();
    let releaseAttempt!: () => void;
    const attemptGate = new Promise<void>(resolve => {
      releaseAttempt = resolve;
    });
    const attempts: string[] = [];
    const queue = new CoalescingRetryQueue<string>({
      retryDelayMs: 100,
      process: async (_key, value) => {
        attempts.push(value);
        await attemptGate;
        return 'resolved';
      },
    });

    queue.enqueue('secret-target', 6, 'first-v6');
    const first = queue.retryNow('secret-target');
    queue.enqueue('secret-target', 6, 'duplicate-v6');
    releaseAttempt();
    await expect(first).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(500);

    expect(attempts).toEqual(['first-v6']);
    expect(queue.isPending('secret-target')).toBe(false);
  });

  it('gives a strictly newer generation a full retry window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T00:00:00Z'));
    const attempts: number[] = [];
    const exhausted = vi.fn();
    const queue = new CoalescingRetryQueue<string>({
      retryDelayMs: 100,
      maxRetryMs: 200,
      process: async (_key, _value, generation) => {
        attempts.push(generation);
        return 'retry';
      },
      onExhausted: exhausted,
    });

    queue.enqueue('certificate-target', 1, 'v1');
    await vi.advanceTimersByTimeAsync(190);
    queue.enqueue('certificate-target', 2, 'v2');

    // The original generation's window ends at t=200. Generation 2 arrived
    // at t=190 and therefore must still be retryable beyond that boundary.
    await vi.advanceTimersByTimeAsync(20);
    expect(exhausted).not.toHaveBeenCalled();
    expect(queue.isPending('certificate-target')).toBe(true);
    expect(attempts.at(-1)).toBe(2);

    await vi.advanceTimersByTimeAsync(200);
    expect(exhausted).toHaveBeenCalledWith('certificate-target', 'v2', 2);
  });

  it('does not let an equal-generation duplicate replace evidence or extend the retry window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T00:00:00Z'));
    const exhausted = vi.fn();
    const queue = new CoalescingRetryQueue<string>({
      retryDelayMs: 100,
      maxRetryMs: 200,
      process: async () => 'retry',
      onExhausted: exhausted,
    });

    queue.enqueue('secret-target', 5, 'first-payload');
    await vi.advanceTimersByTimeAsync(190);
    queue.enqueue('secret-target', 5, 'refreshed-payload');
    await vi.advanceTimersByTimeAsync(10);

    expect(exhausted).toHaveBeenCalledWith(
      'secret-target',
      'first-payload',
      5
    );
    expect(queue.isPending('secret-target')).toBe(true);
  });

  it('keeps a generation pending after contention is followed by a deployment failure', async () => {
    vi.useFakeTimers();
    const decisions: RetryDecision[] = ['retry', 'failed'];
    const pending: number[] = [];
    const queue = new CoalescingRetryQueue<string>({
      retryDelayMs: 100,
      maxRetryMs: 1_000,
      process: async () => decisions.shift() ?? 'failed',
      onPendingChange: count => pending.push(count),
    });

    queue.enqueue('certificate-target', 8, 'v8');
    await vi.advanceTimersByTimeAsync(200);

    expect(queue.isPending('certificate-target')).toBe(true);
    expect(queue.pendingCount).toBe(1);
    expect(pending).toEqual([1]);
  });

  it('keeps an exhausted equal generation latched but restarts for a newer one', async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const queue = new CoalescingRetryQueue<string>({
      retryDelayMs: 100,
      maxRetryMs: 100,
      process: async (_key, _value, generation) => {
        attempts.push(generation);
        return 'retry';
      },
    });

    queue.enqueue('secret-target', 10, 'v10');
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toEqual([10]);

    queue.enqueue('secret-target', 10, 'duplicate-v10');
    await vi.advanceTimersByTimeAsync(500);
    expect(attempts).toEqual([10]);

    queue.enqueue('secret-target', 11, 'v11');
    await vi.advanceTimersByTimeAsync(100);
    expect(attempts).toEqual([10, 11]);
  });
});

describe('RestartRequiredMutationQueue wiring', () => {
  it('retains deployment evidence and health pending until restart recovery', async () => {
    vi.useFakeTimers();
    const prepare = vi.fn().mockResolvedValue({
      decision: 'resolved',
      evidence: { version: 12 },
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn()
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValueOnce(undefined);
    const acknowledge = vi.fn();
    const pending: number[] = [];
    const queue = new RestartRequiredMutationQueue<string, { version: number }>({
      prepare,
      notify,
      restart,
      acknowledge,
      retryDelayMs: 60_000,
      onPendingChange: count => pending.push(count),
    });

    queue.enqueue('secret-target', 12, 'secret-v12');
    await expect(queue.retryNow('secret-target')).resolves.toBe(false);

    expect(queue.isPending('secret-target')).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(pending).toEqual([1]);

    await expect(queue.retryNow('secret-target')).resolves.toBe(true);

    // The persisted file/plugin evidence is reused; only the missing restart
    // is repeated before the consumer watermark advances.
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledWith('secret-v12', { version: 12 });
    expect(pending).toEqual([1, 0]);
  });

  it('does not discard retained evidence when the failed generation is redelivered', async () => {
    vi.useFakeTimers();
    const prepare = vi.fn().mockResolvedValue({
      decision: 'resolved',
      evidence: { version: 14 },
    });
    const notify = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn()
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValueOnce(undefined);
    const acknowledge = vi.fn();
    const queue = new RestartRequiredMutationQueue<string, { version: number }>({
      prepare,
      notify,
      restart,
      acknowledge,
      retryDelayMs: 60_000,
    });

    queue.enqueue('secret-target', 14, 'original-v14');
    await expect(queue.retryNow('secret-target')).resolves.toBe(false);

    // A duplicate delivery after the file was written must not replace the
    // wrapper that holds preparation and notification evidence.
    queue.enqueue('secret-target', 14, 'duplicate-v14');
    await expect(queue.retryNow('secret-target')).resolves.toBe(true);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledWith('original-v14', { version: 14 });
  });

  it('accepts a polling-discovered deployment without declaring convergence early', async () => {
    vi.useFakeTimers();
    const prepare = vi.fn();
    let consumedFingerprint = 'sha256:v7';
    const restart = vi.fn()
      .mockRejectedValueOnce(new Error('consumer unavailable'))
      .mockResolvedValueOnce(undefined);
    const queue = new RestartRequiredMutationQueue<string, { fingerprint: string }>({
      prepare,
      restart,
      acknowledge: (_value, evidence) => {
        consumedFingerprint = evidence.fingerprint;
      },
      retryDelayMs: 60_000,
    });

    await expect(reconcilePolledMutation({
      queue,
      key: 'certificate-target',
      generation: 8,
      value: 'certificate-v8',
      evidence: { fingerprint: 'sha256:v8' },
      consumedMarker: consumedFingerprint,
      observedMarker: 'sha256:v8',
    })).resolves.toBe('pending');
    expect(queue.isPending('certificate-target')).toBe(true);
    expect(prepare).not.toHaveBeenCalled();

    await expect(queue.retryNow('certificate-target')).resolves.toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledTimes(2);

    await expect(reconcilePolledMutation({
      queue,
      key: 'certificate-target',
      generation: 8,
      value: 'certificate-v8',
      evidence: { fingerprint: 'sha256:v8' },
      consumedMarker: consumedFingerprint,
      observedMarker: 'sha256:v8',
    })).resolves.toBe('unchanged');
    expect(restart).toHaveBeenCalledTimes(2);
  });
});
