// Path: src/lib/coalescing-retry-queue.ts
// Per-target retry queue that retains only the newest observed generation.

export type RetryDecision = 'resolved' | 'retry' | 'failed';

export interface CoalescingRetryQueueOptions<T> {
  process: (key: string, value: T, generation: number) => Promise<RetryDecision>;
  retryDelayMs?: number;
  maxRetryMs?: number;
  onPendingChange?: (pendingCount: number) => void;
  onExhausted?: (key: string, value: T, generation: number) => void;
}

export type MutationPreparation<Evidence> =
  | { decision: 'resolved'; evidence: Evidence }
  | { decision: 'retry' | 'failed' };

export interface RestartRequiredMutationQueueOptions<Value, Evidence> {
  prepare: (value: Value) => Promise<MutationPreparation<Evidence>>;
  notify?: (value: Value, evidence: Evidence) => Promise<void>;
  restart: (value: Value, evidence: Evidence) => Promise<void>;
  acknowledge?: (value: Value, evidence: Evidence) => void;
  account?: <Result>(operation: () => Promise<Result>) => Promise<Result>;
  retryDelayMs?: number;
  maxRetryMs?: number;
  onPendingChange?: (pendingCount: number) => void;
  onExhausted?: (key: string, value: Value, generation: number) => void;
}

interface RestartRequiredMutation<Value, Evidence> {
  value: Value;
  prepared: boolean;
  evidence?: Evidence;
  notified: boolean;
}

interface QueueEntry<T> {
  value: T;
  generation: number;
  revision: number;
  retryStartedAt: number;
  running: boolean;
  timer: NodeJS.Timeout | null;
}

const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 15 * 60_000;

/**
 * Retry contended work without losing a newer WebSocket generation.
 *
 * An exhausted key deliberately remains pending (and therefore unhealthy)
 * until a newer event restarts the bounded retry or a polling rail retries the
 * complete queued mutation successfully.
 */
export class CoalescingRetryQueue<T> {
  private readonly entries = new Map<string, QueueEntry<T>>();
  private readonly pendingKeys = new Set<string>();
  private readonly pendingGenerations = new Map<string, number>();
  private readonly options: Required<Pick<
    CoalescingRetryQueueOptions<T>,
    'retryDelayMs' | 'maxRetryMs'
  >> & CoalescingRetryQueueOptions<T>;
  private stopped = false;

  constructor(options: CoalescingRetryQueueOptions<T>) {
    this.options = {
      ...options,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      maxRetryMs: options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS,
    };
  }

  /** Queue only the newest generation for a target. */
  enqueue(key: string, generation: number, value: T): void {
    if (this.stopped) return;

    const newestPendingGeneration = this.pendingGenerations.get(key);
    if (newestPendingGeneration !== undefined && generation < newestPendingGeneration) {
      return;
    }
    this.pendingGenerations.set(key, generation);

    const current = this.entries.get(key);
    if (current) {
      if (generation < current.generation) return;
      const isNewerGeneration = generation > current.generation;
      // An equal-generation duplicate is not new work. In particular, do not
      // replace a RestartRequiredMutation wrapper here: it may hold deployment
      // and notification evidence that must survive until restart succeeds.
      if (!isNewerGeneration) return;

      current.value = value;
      current.generation = generation;
      current.revision++;
      // A strictly newer remote generation is fresh work and gets the full
      // bounded retry window.
      current.retryStartedAt = Date.now();
      if (!current.running && !current.timer) {
        this.scheduleRetry(key, current);
      }
      return;
    }

    this.markPending(key);
    const entry: QueueEntry<T> = {
      value,
      generation,
      revision: 1,
      retryStartedAt: Date.now(),
      running: false,
      timer: null,
    };
    this.entries.set(key, entry);
    this.scheduleRetry(key, entry);
  }

  /** True while a target has unapplied work, including exhausted retries. */
  isPending(key: string): boolean {
    return this.pendingKeys.has(key);
  }

  getPendingGeneration(key: string): number | undefined {
    return this.pendingGenerations.get(key);
  }

  get pendingCount(): number {
    return this.pendingKeys.size;
  }

  /**
   * Give an exhausted/pending target one immediate full retry.
   *
   * This uses the same serialized process callback as timer retries, so a poll
   * cannot run a second deploy/restart concurrently or treat file convergence
   * as proof that the consumer restart completed.
   */
  async retryNow(key: string): Promise<boolean> {
    const entry = this.entries.get(key);
    if (this.stopped || !entry || entry.running) return false;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    await this.run(key, entry);
    return !this.isPending(key);
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.entries.clear();
    this.pendingGenerations.clear();
    if (this.pendingKeys.size > 0) {
      this.pendingKeys.clear();
      this.options.onPendingChange?.(0);
    }
  }

  private async run(key: string, expectedEntry: QueueEntry<T>): Promise<void> {
    const entry = this.entries.get(key);
    if (this.stopped || entry !== expectedEntry || entry.running) return;

    entry.running = true;
    entry.timer = null;
    const revision = entry.revision;
    const value = entry.value;
    const generation = entry.generation;

    let decision: RetryDecision;
    try {
      decision = await this.options.process(key, value, generation);
    } catch {
      decision = 'failed';
    } finally {
      entry.running = false;
    }

    if (this.stopped || this.entries.get(key) !== entry) return;

    // A newer generation arrived during processing. It always gets its own
    // attempt, regardless of the result for the superseded generation.
    if (entry.revision !== revision) {
      if (decision !== 'resolved') {
        this.scheduleRetry(key, entry);
      } else {
        void this.run(key, entry);
      }
      return;
    }

    if (decision === 'resolved') {
      this.entries.delete(key);
      this.clearPending(key);
      return;
    }

    // Contention and terminal deployment failures both mean this generation
    // remains unapplied. Retry them within the same bounded window; exhaustion
    // deliberately latches pending/unhealthy until polling or a newer event
    // proves that the target converged.
    this.scheduleRetry(key, entry);
  }

  private scheduleRetry(key: string, entry: QueueEntry<T>): void {
    if (Date.now() - entry.retryStartedAt >= this.options.maxRetryMs) {
      // Do not clear pending: the generation is still unapplied. Polling or a
      // newer event must explicitly resolve it, keeping health fail-closed.
      this.options.onExhausted?.(key, entry.value, entry.generation);
      return;
    }

    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.run(key, entry);
    }, this.options.retryDelayMs);
  }

  private markPending(key: string): void {
    const previousSize = this.pendingKeys.size;
    this.pendingKeys.add(key);
    if (this.pendingKeys.size !== previousSize) {
      this.options.onPendingChange?.(this.pendingKeys.size);
    }
  }

  private clearPending(key: string): void {
    this.pendingGenerations.delete(key);
    if (this.pendingKeys.delete(key)) {
      this.options.onPendingChange?.(this.pendingKeys.size);
    }
  }
}

/**
 * Own a mutation from deployment through consumer restart.
 *
 * Preparation evidence is retained after files/config fingerprints have been
 * persisted, so a failed restart retries the missing consumer transition
 * instead of treating an "unchanged" deployment as convergence. Polling may
 * also enqueue already-prepared evidence when it discovers a missed event.
 */
export class RestartRequiredMutationQueue<Value, Evidence> {
  private readonly queue: CoalescingRetryQueue<RestartRequiredMutation<Value, Evidence>>;
  private readonly options: RestartRequiredMutationQueueOptions<Value, Evidence>;

  constructor(options: RestartRequiredMutationQueueOptions<Value, Evidence>) {
    this.options = options;
    this.queue = new CoalescingRetryQueue({
      process: async (_key, mutation) => this.process(mutation),
      retryDelayMs: options.retryDelayMs,
      maxRetryMs: options.maxRetryMs,
      onPendingChange: options.onPendingChange,
      onExhausted: (key, mutation, generation) => {
        options.onExhausted?.(key, mutation.value, generation);
      },
    });
  }

  enqueue(key: string, generation: number, value: Value): void {
    this.queue.enqueue(key, generation, {
      value,
      prepared: false,
      notified: false,
    });
  }

  /** Enqueue deployment evidence produced by a polling recovery rail. */
  enqueuePrepared(
    key: string,
    generation: number,
    value: Value,
    evidence: Evidence
  ): void {
    this.queue.enqueue(key, generation, {
      value,
      prepared: true,
      evidence,
      notified: false,
    });
  }

  isPending(key: string): boolean {
    return this.queue.isPending(key);
  }

  getPendingGeneration(key: string): number | undefined {
    return this.queue.getPendingGeneration(key);
  }

  get pendingCount(): number {
    return this.queue.pendingCount;
  }

  retryNow(key: string): Promise<boolean> {
    return this.queue.retryNow(key);
  }

  stop(): void {
    this.queue.stop();
  }

  private async process(
    mutation: RestartRequiredMutation<Value, Evidence>
  ): Promise<RetryDecision> {
    const operation = async (): Promise<RetryDecision> => {
      if (!mutation.prepared) {
        const preparation = await this.options.prepare(mutation.value);
        if (preparation.decision !== 'resolved') return preparation.decision;
        mutation.evidence = preparation.evidence;
        mutation.prepared = true;
      }

      const evidence = mutation.evidence as Evidence;
      if (!mutation.notified && this.options.notify) {
        await this.options.notify(mutation.value, evidence);
        mutation.notified = true;
      }

      await this.options.restart(mutation.value, evidence);
      this.options.acknowledge?.(mutation.value, evidence);
      return 'resolved';
    };

    try {
      return this.options.account
        ? await this.options.account(operation)
        : await operation();
    } catch {
      return 'failed';
    }
  }
}

export type PolledMutationStatus = 'unchanged' | 'resolved' | 'pending';

/**
 * Hand polling-discovered evidence to the same fail-closed queue as WebSocket
 * events. The consumed marker advances only through the queue's acknowledge
 * callback after notification and restart complete.
 */
export async function reconcilePolledMutation<Value, Evidence, Marker>(options: {
  queue: RestartRequiredMutationQueue<Value, Evidence>;
  key: string;
  generation: number;
  value: Value;
  evidence: Evidence;
  consumedMarker: Marker | undefined;
  observedMarker: Marker | undefined;
}): Promise<PolledMutationStatus> {
  if (options.observedMarker === undefined
      || Object.is(options.observedMarker, options.consumedMarker)) {
    return 'unchanged';
  }

  options.queue.enqueuePrepared(
    options.key,
    options.generation,
    options.value,
    options.evidence
  );
  return await options.queue.retryNow(options.key) ? 'resolved' : 'pending';
}
