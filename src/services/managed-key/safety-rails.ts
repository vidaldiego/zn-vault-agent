// Path: src/services/managed-key/safety-rails.ts
// Safety rails for managed API key renewal: grace period polling, heartbeat, connection recovery

import { createLogger } from '../../lib/logger.js';
import { incCounter, setGauge } from '../../lib/metrics.js';
import { ManagedTimer } from '../../utils/timer.js';
import {
  type RotationTracking,
  GRACE_PERIOD_POLL_RATIO,
  MIN_GRACE_POLL_DELAY_MS,
  HEARTBEAT_INTERVAL_MS,
} from './types.js';

const log = createLogger({ module: 'managed-key-safety' });

// ============================================================================
// Grace Period Metrics
// ============================================================================

/**
 * Update grace period metrics gauge.
 */
export function updateGraceMetrics(graceExpiresAtMs: number): void {
  const now = Date.now();
  const remainingSeconds = Math.max(0, (graceExpiresAtMs - now) / 1000);
  setGauge('znvault_agent_managed_key_grace_remaining_seconds', remainingSeconds);
}

// ============================================================================
// Grace Period Polling
// ============================================================================

/**
 * Grace period polling manager.
 * Schedules safety polls when WS events are not received.
 */
export class GracePeriodPoller {
  private readonly timer = new ManagedTimer();
  private readonly isRunning: () => boolean;
  private readonly getTracking: () => RotationTracking;
  private readonly onPoll: () => Promise<{ graceExpiresAt?: string } | null>;

  constructor(options: {
    isRunning: () => boolean;
    getTracking: () => RotationTracking;
    onPoll: () => Promise<{ graceExpiresAt?: string } | null>;
  }) {
    this.isRunning = options.isRunning;
    this.getTracking = options.getTracking;
    this.onPoll = options.onPoll;
  }

  /**
   * Schedule a grace period safety poll.
   * If we haven't received a WebSocket rotation event by the time 50% of the
   * grace period has elapsed, poll the server to detect rotations.
   */
  schedule(graceExpiresAt: Date | null): void {
    this.timer.clear();

    if (!this.isRunning() || !graceExpiresAt) return;

    const now = Date.now();
    const graceEnd = graceExpiresAt.getTime();

    // Don't schedule if grace period has already expired
    if (graceEnd <= now) {
      log.debug('Grace period already expired, skipping safety poll');
      return;
    }

    const graceDuration = graceEnd - now;
    // Poll at 50% of remaining grace period, with a minimum of 10 seconds
    const pollDelay = Math.max(graceDuration * GRACE_PERIOD_POLL_RATIO, MIN_GRACE_POLL_DELAY_MS);

    this.timer.setTimeout(() => {
      void this.executePoll(graceExpiresAt, graceEnd);
    }, pollDelay);

    log.debug({
      pollDelayMs: pollDelay,
      pollAt: new Date(now + pollDelay).toISOString(),
      graceExpiresAt: graceExpiresAt.toISOString(),
    }, 'Grace period safety poll scheduled');
  }

  private async executePoll(graceExpiresAt: Date, graceEnd: number): Promise<void> {
    if (!this.isRunning()) return;

    const tracking = this.getTracking();

    // Only poll if we haven't received a WS event
    if (tracking.wsEventReceived) {
      log.debug('WebSocket rotation event already received, skipping grace period poll');
      return;
    }

    log.info({
      graceExpiresAt: graceExpiresAt.toISOString(),
      graceRemainingMs: graceEnd - Date.now(),
    }, 'Grace period safety poll - no WebSocket event received');

    incCounter('znvault_agent_managed_key_grace_polls_total');

    try {
      const response = await this.onPoll();
      if (response?.graceExpiresAt) {
        // Schedule next grace period poll based on new response
        this.schedule(new Date(response.graceExpiresAt));
      }
    } catch (err) {
      log.error({ err }, 'Grace period poll failed');
      // Retry in 10 seconds on failure
      this.timer.setTimeout(() => {
        this.schedule(graceExpiresAt);
      }, MIN_GRACE_POLL_DELAY_MS);
    }
  }

  stop(): void {
    this.timer.clear();
  }
}

// ============================================================================
// Heartbeat Freshness Monitor
// ============================================================================

/**
 * Heartbeat monitor that detects stale keys.
 * Periodically checks if the key should have rotated but we missed it.
 */
export class HeartbeatMonitor {
  private readonly timer = new ManagedTimer();
  private readonly isRunning: () => boolean;
  private readonly getTracking: () => RotationTracking;
  private readonly onStale: () => Promise<{ nextRotationAt?: string; graceExpiresAt?: string } | null>;
  private readonly onRefreshSchedule: (response: { nextRotationAt?: string; graceExpiresAt?: string } | null) => void;

  constructor(options: {
    isRunning: () => boolean;
    getTracking: () => RotationTracking;
    onStale: () => Promise<{ nextRotationAt?: string; graceExpiresAt?: string } | null>;
    onRefreshSchedule: (response: { nextRotationAt?: string; graceExpiresAt?: string } | null) => void;
  }) {
    this.isRunning = options.isRunning;
    this.getTracking = options.getTracking;
    this.onStale = options.onStale;
    this.onRefreshSchedule = options.onRefreshSchedule;
  }

  /**
   * Start the heartbeat freshness monitor.
   * Every 60 seconds, checks if the current key should have rotated but we missed it.
   */
  start(): void {
    this.timer.setInterval(() => {
      void this.check();
    }, HEARTBEAT_INTERVAL_MS);

    log.debug({ intervalMs: HEARTBEAT_INTERVAL_MS }, 'Heartbeat freshness monitor started');
  }

  private async check(): Promise<void> {
    if (!this.isRunning()) return;

    incCounter('znvault_agent_managed_key_heartbeat_checks_total');

    const tracking = this.getTracking();
    const now = Date.now();

    // Update grace period metrics
    if (tracking.graceExpiresAt) {
      updateGraceMetrics(tracking.graceExpiresAt);
    }

    // Check if key should have rotated by now
    if (tracking.expectedRotationAt && now > tracking.expectedRotationAt) {
      const staleness = now - tracking.expectedRotationAt;

      // Only warn if significantly stale (more than 1 minute past rotation time)
      if (staleness > 60_000 && !tracking.wsEventReceived) {
        log.warn({
          expectedRotationAt: new Date(tracking.expectedRotationAt).toISOString(),
          stalenessMs: staleness,
          wsEventReceived: tracking.wsEventReceived,
        }, 'Key may be stale - expected rotation time has passed without WS event');

        // Trigger a poll to check
        try {
          const response = await this.onStale();
          if (response) {
            this.onRefreshSchedule(response);
          }
        } catch (err) {
          log.error({ err }, 'Heartbeat refresh failed');
        }
      }
    }
  }

  stop(): void {
    this.timer.clear();
  }
}

// ============================================================================
// Rotation Retry Logic
// ============================================================================

/**
 * Retry rotation handling with exponential backoff.
 */
export class RotationRetryHandler {
  private readonly isRunning: () => boolean;
  private readonly onRetry: () => Promise<{ nextRotationAt?: string; graceExpiresAt?: string } | null>;
  private readonly onSuccess: (response: { nextRotationAt?: string; graceExpiresAt?: string }) => void;
  private readonly maxAttempts: number;

  constructor(options: {
    isRunning: () => boolean;
    onRetry: () => Promise<{ nextRotationAt?: string; graceExpiresAt?: string } | null>;
    onSuccess: (response: { nextRotationAt?: string; graceExpiresAt?: string }) => void;
    maxAttempts: number;
  }) {
    this.isRunning = options.isRunning;
    this.onRetry = options.onRetry;
    this.onSuccess = options.onSuccess;
    this.maxAttempts = options.maxAttempts;
  }

  /**
   * Schedule a retry with exponential backoff.
   */
  schedule(keyName: string, attempt: number): void {
    if (!this.isRunning() || attempt > this.maxAttempts) {
      if (attempt > this.maxAttempts) {
        log.error({ keyName, attempts: attempt }, 'Max retry attempts reached for rotation handling');
      }
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, attempt), 60_000); // Max 60s

    log.debug({ keyName, attempt, delayMs: delay }, 'Scheduling rotation retry');

    setTimeout(() => {
      void this.executeRetry(keyName, attempt);
    }, delay);
  }

  private async executeRetry(keyName: string, attempt: number): Promise<void> {
    if (!this.isRunning()) return;

    try {
      const response = await this.onRetry();
      if (response) {
        this.onSuccess(response);
      }
    } catch (err) {
      log.error({ err, attempt }, 'Rotation retry failed');
      this.schedule(keyName, attempt + 1);
    }
  }
}
