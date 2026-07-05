// Path: src/services/managed-key/tracked-keys-poller.ts
// Polling rail for tracked managed keys beyond the agent's own auth key

/**
 * Polls every tracked managed API key that is NOT the agent's own auth key
 * and feeds the bound value through the key-rotation propagator.
 *
 * Follow-up to the 2026-07-05 incident fix: the renewal service's safety
 * rails (scheduled refresh, grace poll, heartbeat, reconnect) cover only
 * `config.managedKey.name`. Keys tracked for exec/plugin `api-key:` mappings
 * previously had the live WebSocket `apikey.rotated` event as their SINGLE
 * runtime refresh path — a lost event left their consumers stale until the
 * agent restarted. This poller closes that gap.
 *
 * Scheduling mirrors the renewal service: each poll binds the key, and the
 * next poll is scheduled at `nextRotationAt` minus a small lead, clamped to a
 * minimum interval (so polling converges to once-per-minute around a rotation
 * and stays at one bind per rotation interval otherwise). Without rotation
 * metadata — or after a bind failure — it falls back to a fixed interval.
 *
 * Unchanged values are cheap: the propagator's per-key dedup turns them into
 * no-ops. The first poll after start intentionally propagates the current
 * value — consumers are idempotent, and this self-heals any rotation that
 * landed between consumer initialization and poller start.
 */

import { bindManagedApiKey, type ManagedApiKeyBindResponse } from '../../lib/api.js';
import type { KeyRotationMeta, PropagationResult } from '../../lib/key-rotation-propagation.js';
import { createLogger } from '../../lib/logger.js';
import {
  DEFAULT_REFRESH_BEFORE_MS,
  MIN_REFRESH_INTERVAL_MS,
  FALLBACK_REFRESH_INTERVAL_MS,
} from './types.js';

export interface TrackedKeyPollerOptions {
  /** Managed key names to poll (the agent's own key must NOT be included —
   * the renewal service covers it). */
  keyNames: string[];
  /** Propagation sink — normally the daemon's key-rotation propagator. */
  propagate: (
    newKey: string,
    meta: KeyRotationMeta,
    opts?: { persist?: boolean; detectedAt?: number }
  ) => Promise<PropagationResult>;
  /** Bind function — defaults to the vault API client (injectable for tests). */
  bindKey?: (name: string) => Promise<ManagedApiKeyBindResponse>;
  /** Shutdown probe — suppresses polls during shutdown. */
  isShuttingDown?: () => boolean;
  /** How early before a key's nextRotationAt to poll (default 30s). */
  refreshBeforeMs?: number;
  /** Minimum delay between polls of one key (default 60s). */
  minIntervalMs?: number;
  /** Delay when no rotation metadata is available or a poll failed (default 5min). */
  fallbackIntervalMs?: number;
  /** Logger override (injectable for tests). */
  logger?: ReturnType<typeof createLogger>;
}

export class TrackedKeyPoller {
  private readonly keyNames: string[];
  private readonly propagate: TrackedKeyPollerOptions['propagate'];
  private readonly bindKey: (name: string) => Promise<ManagedApiKeyBindResponse>;
  private readonly isShuttingDown: () => boolean;
  private readonly refreshBeforeMs: number;
  private readonly minIntervalMs: number;
  private readonly fallbackIntervalMs: number;
  private readonly log: ReturnType<typeof createLogger>;

  private readonly timers = new Map<string, NodeJS.Timeout>();
  private running = false;

  constructor(options: TrackedKeyPollerOptions) {
    this.keyNames = [...new Set(options.keyNames)];
    this.propagate = options.propagate;
    this.bindKey = options.bindKey ?? bindManagedApiKey;
    this.isShuttingDown = options.isShuttingDown ?? ((): boolean => false);
    this.refreshBeforeMs = options.refreshBeforeMs ?? DEFAULT_REFRESH_BEFORE_MS;
    this.minIntervalMs = options.minIntervalMs ?? MIN_REFRESH_INTERVAL_MS;
    this.fallbackIntervalMs = options.fallbackIntervalMs ?? FALLBACK_REFRESH_INTERVAL_MS;
    this.log = options.logger ?? createLogger({ module: 'tracked-key-poller' });
  }

  /** Start polling. No-op when no keys are configured. */
  start(): void {
    if (this.running) {
      this.log.warn('Tracked key poller already running');
      return;
    }
    if (this.keyNames.length === 0) {
      this.log.debug('No tracked managed keys beyond the agent\'s own - poller not started');
      return;
    }

    this.running = true;
    this.log.info({
      keys: this.keyNames,
      minIntervalMs: this.minIntervalMs,
      fallbackIntervalMs: this.fallbackIntervalMs,
    }, 'Tracked managed key poller started (polling rail for non-own keys)');

    for (const keyName of this.keyNames) {
      // First poll immediately: propagating the current value is idempotent
      // and self-heals any rotation that landed before the poller started.
      this.schedule(keyName, 0);
    }
  }

  /** Stop polling and cancel all timers. */
  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private schedule(keyName: string, delayMs: number): void {
    if (!this.running) return;

    const existing = this.timers.get(keyName);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(keyName);
      void this.pollKey(keyName);
    }, delayMs);
    timer.unref?.();
    this.timers.set(keyName, timer);
  }

  private async pollKey(keyName: string): Promise<void> {
    if (!this.running || this.isShuttingDown()) return;

    try {
      const bindResponse = await this.bindKey(keyName);
      const detectedAt = Date.now();

      try {
        await this.propagate(bindResponse.key, {
          keyName,
          newPrefix: bindResponse.prefix,
          nextRotationAt: bindResponse.nextRotationAt,
          graceExpiresAt: bindResponse.graceExpiresAt,
          rotationMode: bindResponse.rotationMode,
          source: 'scheduled',
        }, { detectedAt });
      } catch (err) {
        // The propagator contains its own error handling and should never
        // reject; keep the poll loop alive regardless.
        this.log.error({ err, keyName }, 'Tracked key propagation threw unexpectedly');
      }

      this.schedule(keyName, this.delayFromRotationTime(bindResponse.nextRotationAt));
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      this.log.warn({
        err,
        keyName,
        statusCode: error.statusCode,
        retryInMs: this.fallbackIntervalMs,
      }, 'Failed to poll tracked managed key - will retry');
      this.schedule(keyName, this.fallbackIntervalMs);
    }
  }

  private delayFromRotationTime(nextRotationAt?: string): number {
    if (nextRotationAt) {
      const rotationTime = new Date(nextRotationAt).getTime();
      if (!Number.isNaN(rotationTime)) {
        return Math.max(rotationTime - this.refreshBeforeMs - Date.now(), this.minIntervalMs);
      }
    }
    return this.fallbackIntervalMs;
  }
}
