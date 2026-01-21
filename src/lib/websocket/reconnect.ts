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
   */
  getReconnectDelay(): number {
    // First retry is immediate (500ms), then exponential backoff
    if (this.reconnectAttempts === 0) {
      return WS_CONSTANTS.INITIAL_RECONNECT_DELAY;
    }
    const baseDelay = WS_CONSTANTS.INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts);
    const delay = Math.min(baseDelay, WS_CONSTANTS.MAX_RECONNECT_DELAY);
    // Add jitter to prevent thundering herd
    return delay + Math.random() * 500;
  }

  /**
   * Schedule a reconnection attempt.
   */
  schedule(): void {
    if (!this.shouldReconnect || this.isShuttingDown()) {
      log.debug({ shouldReconnect: this.shouldReconnect, isShuttingDown: this.isShuttingDown() }, 'Skipping reconnect - shutdown or disabled');
      return;
    }

    const delay = this.getReconnectDelay();
    this.reconnectAttempts++;
    metrics.wsReconnect();

    log.info({ ws: 'unified', attempt: this.reconnectAttempts, delay }, 'Scheduling reconnect');

    this.reconnectTimer.setTimeout(() => {
      log.info({ ws: 'unified', attempt: this.reconnectAttempts }, 'Reconnect timer fired - attempting connection');
      this.onReconnect();
    }, delay);
  }

  /**
   * Reset reconnection attempts (e.g., after successful connection).
   */
  resetAttempts(): void {
    this.reconnectAttempts = 0;
  }

  /**
   * Force an immediate reconnection.
   * Resets attempts for faster retry.
   */
  forceReconnect(): void {
    this.reconnectAttempts = 0;
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
  }
}
