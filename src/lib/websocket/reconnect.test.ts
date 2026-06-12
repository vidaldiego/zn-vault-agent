// Path: src/lib/websocket/reconnect.test.ts

/**
 * ReconnectManager unit tests.
 *
 * Regression coverage for INC-2026-06-12-01: auth-rejection closes (4001)
 * must keep growing the backoff (with a 5-minute cap) instead of being
 * treated as successful connections.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  wsLogger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../metrics.js', () => ({
  metrics: {
    wsReconnect: vi.fn(),
    wsConnected: vi.fn(),
    wsDisconnected: vi.fn(),
  },
}));

import { ReconnectManager } from './reconnect.js';
import { WS_CONSTANTS } from './types.js';

describe('ReconnectManager', () => {
  let onReconnect: ReturnType<typeof vi.fn<() => void>>;
  let manager: ReconnectManager;

  beforeEach(() => {
    vi.useFakeTimers();
    // Remove jitter for deterministic delay assertions
    vi.spyOn(Math, 'random').mockReturnValue(0);

    onReconnect = vi.fn<() => void>();
    manager = new ReconnectManager({
      onReconnect,
      isShuttingDown: () => false,
    });
  });

  afterEach(() => {
    manager.cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('test_should_grow_delay_exponentially_when_auth_failures_repeat', () => {
    // attempt counter: 0 -> 500ms, 1 -> 1000ms, 2 -> 2000ms, 3 -> 4000ms
    const expectedDelays = [500, 1000, 2000, 4000];

    for (const expected of expectedDelays) {
      expect(manager.getReconnectDelay()).toBe(expected);
      manager.schedule({ authFailure: true });
      vi.advanceTimersByTime(expected);
    }

    expect(onReconnect).toHaveBeenCalledTimes(expectedDelays.length);
    expect(manager.getAttemptCount()).toBe(expectedDelays.length);
  });

  it('test_should_cap_auth_failure_delay_at_max_auth_reconnect_delay', () => {
    // Drive the attempt counter high enough that the uncapped delay
    // (500 * 2^n) exceeds both the normal and the auth cap.
    for (let i = 0; i < 12; i++) {
      manager.schedule({ authFailure: true });
      vi.runOnlyPendingTimers();
    }

    const delay = manager.getReconnectDelay();
    expect(delay).toBe(WS_CONSTANTS.MAX_AUTH_RECONNECT_DELAY);
    expect(delay).toBeGreaterThan(WS_CONSTANTS.MAX_RECONNECT_DELAY);
  });

  it('test_should_cap_normal_delay_at_max_reconnect_delay_when_no_auth_failure', () => {
    for (let i = 0; i < 12; i++) {
      manager.schedule();
      vi.runOnlyPendingTimers();
    }

    expect(manager.getReconnectDelay()).toBe(WS_CONSTANTS.MAX_RECONNECT_DELAY);
    expect(manager.isInAuthFailureMode()).toBe(false);
  });

  it('test_should_stay_in_auth_failure_mode_until_reset', () => {
    manager.schedule({ authFailure: true });
    vi.runOnlyPendingTimers();
    expect(manager.isInAuthFailureMode()).toBe(true);

    // A subsequent non-auth schedule does NOT clear auth mode - only a
    // proven-healthy connection (resetAttempts) may do that.
    manager.schedule();
    vi.runOnlyPendingTimers();
    expect(manager.isInAuthFailureMode()).toBe(true);
  });

  it('test_should_clear_attempts_and_auth_mode_when_reset', () => {
    for (let i = 0; i < 5; i++) {
      manager.schedule({ authFailure: true });
      vi.runOnlyPendingTimers();
    }
    expect(manager.getAttemptCount()).toBe(5);
    expect(manager.isInAuthFailureMode()).toBe(true);

    manager.resetAttempts();

    expect(manager.getAttemptCount()).toBe(0);
    expect(manager.isInAuthFailureMode()).toBe(false);
    expect(manager.getReconnectDelay()).toBe(WS_CONSTANTS.INITIAL_RECONNECT_DELAY);
  });

  it('test_should_not_fire_reconnect_before_auth_backoff_delay_elapses', () => {
    // Two prior auth failures -> next delay is 2000ms (attempts = 2)
    manager.schedule({ authFailure: true });
    vi.runOnlyPendingTimers();
    manager.schedule({ authFailure: true });
    vi.runOnlyPendingTimers();
    onReconnect.mockClear();

    manager.schedule({ authFailure: true });
    vi.advanceTimersByTime(1999);
    expect(onReconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('test_should_skip_scheduling_when_shutting_down', () => {
    const shuttingDownManager = new ReconnectManager({
      onReconnect,
      isShuttingDown: () => true,
    });

    shuttingDownManager.schedule({ authFailure: true });
    vi.advanceTimersByTime(WS_CONSTANTS.MAX_AUTH_RECONNECT_DELAY * 2);
    expect(onReconnect).not.toHaveBeenCalled();
    shuttingDownManager.cleanup();
  });
});
