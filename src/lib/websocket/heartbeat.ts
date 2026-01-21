// Path: src/lib/websocket/heartbeat.ts
// WebSocket heartbeat management

import type WebSocket from 'ws';
import { ManagedTimer } from '../../utils/timer.js';
import { WS_CONSTANTS } from './types.js';
import { wsLogger as log } from '../logger.js';

/**
 * Heartbeat manager for WebSocket connection health monitoring.
 * Sends periodic pings and monitors for pong responses to detect stale connections.
 */
export class HeartbeatManager {
  private readonly heartbeatTimer = new ManagedTimer();
  private readonly pongTimeoutTimer = new ManagedTimer();
  private lastPongReceived = Date.now();

  private readonly onStaleConnection: () => void;

  constructor(options: {
    onStaleConnection: () => void;
  }) {
    this.onStaleConnection = options.onStaleConnection;
  }

  /**
   * Start the heartbeat loop.
   *
   * @param ws - WebSocket instance to send pings on
   */
  start(ws: WebSocket): void {
    this.stop();
    this.lastPongReceived = Date.now();

    this.heartbeatTimer.setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        return;
      }

      // Check if we received a pong since last ping
      const timeSinceLastPong = Date.now() - this.lastPongReceived;
      if (timeSinceLastPong > WS_CONSTANTS.PONG_TIMEOUT + WS_CONSTANTS.HEARTBEAT_INTERVAL) {
        // No pong received for too long - connection is stale
        log.warn({
          ws: 'unified',
          timeSinceLastPong,
          threshold: WS_CONSTANTS.PONG_TIMEOUT + WS_CONSTANTS.HEARTBEAT_INTERVAL,
        }, 'Connection stale - no pong received, forcing reconnect');
        this.onStaleConnection();
        return;
      }

      // Send ping
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
        log.trace({ ws: 'unified' }, 'Sending heartbeat ping');
      } catch (err) {
        log.warn({ ws: 'unified', err }, 'Failed to send heartbeat ping');
        return;
      }

      // Set a timeout to check for pong response
      this.pongTimeoutTimer.setTimeout(() => {
        const elapsed = Date.now() - this.lastPongReceived;
        if (elapsed > WS_CONSTANTS.PONG_TIMEOUT && ws.readyState === ws.OPEN) {
          log.warn({ ws: 'unified', elapsed }, 'Pong timeout - forcing reconnect');
          this.onStaleConnection();
        }
      }, WS_CONSTANTS.PONG_TIMEOUT);
    }, WS_CONSTANTS.HEARTBEAT_INTERVAL);
  }

  /**
   * Stop the heartbeat loop.
   */
  stop(): void {
    this.heartbeatTimer.clear();
    this.pongTimeoutTimer.clear();
  }

  /**
   * Record that a pong was received.
   */
  onPongReceived(): void {
    this.lastPongReceived = Date.now();
    this.pongTimeoutTimer.clear();
    log.trace({ lastPongReceived: this.lastPongReceived }, 'Received heartbeat pong');
  }

  /**
   * Get time since last pong (for diagnostics).
   */
  getTimeSinceLastPong(): number {
    return Date.now() - this.lastPongReceived;
  }
}
