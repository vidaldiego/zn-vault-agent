// Path: src/lib/websocket/reconnect.ts
// WebSocket reconnection strategy

import { ManagedTimer } from '../../utils/timer.js';
import { WS_CONSTANTS } from './types.js';
import { wsLogger as log } from '../logger.js';
import { metrics } from '../metrics.js';

/**
 * Reconnection manager with exponential backoff and jitter.
 * Handles scheduling reconnection attempts with configurable delays.
 */
export class ReconnectManager {
  private readonly reconnectTimer = new ManagedTimer();
  private reconnectAttempts = 0;
  private shouldReconnect = true;
  private authFailureMode = false;

  private readonly onReconnect: () => void;
  private readonly isShuttingDown: () => boolean;

  constructor(options: {
    onReconnect: () => void;
    isShuttingDown: () => boolean;
  }) {
    this.onReconnect = options.onReconnect;
    this.isShuttingDown = options.isShuttingDown;
  }

  /**
   * Calculate reconnection delay with exponential backoff and jitter.
   * In auth-failure mode the cap is MAX_AUTH_RECONNECT_DELAY (5 minutes)
   * instead of MAX_RECONNECT_DELAY: hammering a server that is rejecting
   * our credentials only refreshes IP quarantines (INC-2026-06-12-01).
   */
  getReconnectDelay(): number {
    const maxDelay = this.authFailureMode
      ? WS_CONSTANTS.MAX_AUTH_RECONNECT_DELAY
      : WS_CONSTANTS.MAX_RECONNECT_DELAY;

    // First retry is immediate (500ms), then exponential backoff
    if (this.reconnectAttempts === 0) {
      return WS_CONSTANTS.INITIAL_RECONNECT_DELAY;
    }
    const baseDelay = WS_CONSTANTS.INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts);
    const delay = Math.min(baseDelay, maxDelay);
    // Add jitter to prevent thundering herd
    return delay + Math.random() * 500;
  }

  /**
   * Schedule a reconnection attempt.
   *
   * @param options.authFailure - The previous connection was closed by the
   *   server with an auth-rejection code (4000-4099). Counts as a failed
   *   attempt and raises the backoff cap to MAX_AUTH_RECONNECT_DELAY.
   */
  schedule(options?: { authFailure?: boolean }): void {
    if (options?.authFailure) {
      this.authFailureMode = true;
    }

    if (!this.shouldReconnect || this.isShuttingDown()) {
      log.debug({ shouldReconnect: this.shouldReconnect, isShuttingDown: this.isShuttingDown() }, 'Skipping reconnect - shutdown or disabled');
      return;
    }

    const delay = this.getReconnectDelay();
    this.reconnectAttempts++;
    metrics.wsReconnect();

    log.info({ ws: 'unified', attempt: this.reconnectAttempts, delay, authFailureMode: this.authFailureMode }, 'Scheduling reconnect');

    this.reconnectTimer.setTimeout(() => {
      log.info({ ws: 'unified', attempt: this.reconnectAttempts }, 'Reconnect timer fired - attempting connection');
      this.onReconnect();
    }, delay);
  }

  /**
   * Reset reconnection attempts and leave auth-failure mode.
   *
   * Must only be called once a connection has proven itself healthy
   * (server ack received AND open beyond HEALTHY_CONNECTION_THRESHOLD)
   * or after an authenticated API call succeeded with fresh credentials.
   * Never call this merely because a socket emitted 'open' - the server
   * can still reject it with 4001 right after the handshake.
   */
  resetAttempts(): void {
    this.reconnectAttempts = 0;
    this.authFailureMode = false;
  }

  /**
   * Force an immediate reconnection.
   * Resets attempts for faster retry.
   */
  forceReconnect(): void {
    this.resetAttempts();
    this.schedule();
  }

  /**
   * Get current attempt count.
   */
  getAttemptCount(): number {
    return this.reconnectAttempts;
  }

  /**
   * Enable reconnection.
   */
  enable(): void {
    this.shouldReconnect = true;
  }

  /**
   * Disable reconnection and cancel any pending timer.
   */
  disable(): void {
    this.shouldReconnect = false;
    this.reconnectTimer.clear();
  }

  /**
   * Check if reconnection is enabled.
   */
  isEnabled(): boolean {
    return this.shouldReconnect;
  }

  /**
   * Cancel any pending reconnection timer.
   */
  cancel(): void {
    this.reconnectTimer.clear();
  }

  /**
   * Clean up all resources.
   */
  cleanup(): void {
    this.disable();
    this.reconnectAttempts = 0;
    this.authFailureMode = false;
  }

  /**
   * Whether the manager is currently applying the auth-failure backoff cap.
   */
  isInAuthFailureMode(): boolean {
    return this.authFailureMode;
  }
}
