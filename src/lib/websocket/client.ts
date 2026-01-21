// Path: src/lib/websocket/client.ts
// Unified WebSocket client implementation

import WebSocket from 'ws';
import { loadConfig } from '../config.js';
import { wsLogger as log } from '../logger.js';
import { metrics } from '../metrics.js';
import { setWebSocketStatus, setSecretWebSocketStatus } from '../health.js';
import { onWebSocketReconnect as notifyManagedKeyReconnect, onWebSocketAuthFailure as notifyManagedKeyAuthFailure } from '../../services/managed-key-renewal.js';
import { setWebSocket as setDynamicSecretsWebSocket } from '../../services/dynamic-secrets/index.js';

import {
  type CertificateEvent,
  type SecretEvent,
  type AgentUpdateEvent,
  type ApiKeyRotationEvent,
  type DegradedConnectionInfo,
  type UnifiedWebSocketClient,
  type SubscriptionUpdate,
  type UnifiedAgentEvent,
  WS_CONSTANTS,
} from './types.js';
import { buildWebSocketUrl, maskSensitiveUrl } from './connection.js';
import { HeartbeatManager } from './heartbeat.js';
import { ReconnectManager } from './reconnect.js';
import { MessageDispatcher } from './dispatcher.js';

// Graceful shutdown state (shared across clients)
let isShuttingDown = false;

/**
 * Set the shutdown state.
 * Called during graceful shutdown to prevent reconnection attempts.
 */
export function setShuttingDown(value: boolean): void {
  isShuttingDown = value;
}

/**
 * Check if shutting down.
 */
export function getIsShuttingDown(): boolean {
  return isShuttingDown;
}

/**
 * Create unified WebSocket client for /v1/ws/agent
 *
 * This client connects to a single endpoint and subscribes to topics:
 * - certificates: certificate rotation events
 * - secrets: secret update events
 * - updates: agent update availability events
 * - apikeys: managed API key rotation events
 *
 * @param additionalSecretIds - Additional secret IDs to subscribe to (e.g., exec secrets)
 * @param managedKeyNames - Managed API key names to subscribe to for rotation events
 */
/**
 * Stored WebSocket listener references for cleanup.
 */
interface WebSocketListeners {
  open: () => void;
  message: (data: WebSocket.Data) => void;
  close: (code: number, reason: Buffer) => void;
  error: (err: Error) => void;
}

export function createUnifiedWebSocketClient(
  additionalSecretIds: string[] = [],
  managedKeyNames: string[] = []
): UnifiedWebSocketClient {
  let ws: WebSocket | null = null;
  let wasConnectedBefore = false;
  let wsListeners: WebSocketListeners | null = null;

  // Create managers
  const heartbeatManager = new HeartbeatManager({
    onStaleConnection: () => { forceReconnect('pong_timeout'); },
  });

  const reconnectManager = new ReconnectManager({
    onReconnect: () => { connect(); },
    isShuttingDown: () => isShuttingDown,
  });

  const dispatcher = new MessageDispatcher({
    managedKeyNames,
    onPongReceived: () => { heartbeatManager.onPongReceived(); },
  });

  /**
   * Attach event listeners to WebSocket and store references for cleanup.
   */
  function attachListeners(socket: WebSocket): void {
    // Store listener references for cleanup
    wsListeners = {
      open: handleOpen,
      message: handleMessage,
      close: handleClose,
      error: handleError,
    };

    socket.on('open', wsListeners.open);
    socket.on('message', wsListeners.message);
    socket.on('close', wsListeners.close);
    socket.on('error', wsListeners.error);
  }

  /**
   * Remove event listeners from WebSocket to prevent memory leaks.
   */
  function removeListeners(socket: WebSocket): void {
    if (!wsListeners) return;

    try {
      socket.off('open', wsListeners.open);
      socket.off('message', wsListeners.message);
      socket.off('close', wsListeners.close);
      socket.off('error', wsListeners.error);
    } catch {
      // Ignore errors during listener removal
    }

    wsListeners = null;
  }

  /**
   * Force a reconnection due to connection issues.
   */
  function forceReconnect(reason: string): void {
    log.info({ ws: 'unified', reason }, 'Forcing WebSocket reconnect');

    try {
      heartbeatManager.stop();
    } catch (err) {
      log.warn({ err }, 'Failed to stop heartbeat manager');
    }

    // Clear reference BEFORE terminating to prevent race conditions
    if (ws) {
      const oldWs = ws;
      ws = null;
      try {
        removeListeners(oldWs);
        oldWs.terminate();
      } catch {
        // Ignore errors during terminate
      }
    }

    // Reset reconnect attempts for faster initial retry
    reconnectManager.forceReconnect();
  }

  /**
   * Connect to the WebSocket server.
   */
  function connect(): void {
    if (isShuttingDown) {
      log.debug({ ws: 'unified' }, 'Shutdown in progress, not connecting');
      return;
    }

    // Reset shouldReconnect - if connect() is called explicitly, we want reconnection enabled
    reconnectManager.enable();

    const config = loadConfig();

    if (!config.vaultUrl) {
      const err = new Error('Vault URL not configured');
      log.error({ ws: 'unified' }, 'Cannot connect');
      dispatcher.fireError(err);
      return;
    }

    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
      log.debug({ ws: 'unified' }, 'Already connected or connecting');
      return;
    }

    try {
      const wsUrl = buildWebSocketUrl(additionalSecretIds, managedKeyNames);
      log.info({ ws: 'unified', url: maskSensitiveUrl(wsUrl) }, 'Connecting to unified WebSocket');

      ws = new WebSocket(wsUrl, {
        rejectUnauthorized: !config.insecure,
        handshakeTimeout: WS_CONSTANTS.HANDSHAKE_TIMEOUT,
      });

      // Attach listeners with tracking for cleanup
      attachListeners(ws);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ ws: 'unified', err: error }, 'Failed to create WebSocket');
      dispatcher.fireError(error);
      reconnectManager.schedule();
    }
  }

  /**
   * Handle WebSocket open event.
   */
  function handleOpen(): void {
    const isReconnect = wasConnectedBefore;
    wasConnectedBefore = true;
    reconnectManager.resetAttempts();
    if (ws) {
      heartbeatManager.start(ws);
    }
    setWebSocketStatus(true, new Date());
    setSecretWebSocketStatus(true, new Date());
    metrics.wsConnected();
    log.info({ ws: 'unified', isReconnect }, 'Unified WebSocket connected');

    // Set WebSocket for dynamic secrets
    setDynamicSecretsWebSocket(ws);

    // Note: Registration with capabilities/publicKey is sent AFTER receiving
    // connection_established from the vault to ensure proper timing

    // Notify managed key renewal service of reconnection (for connection loss recovery)
    if (isReconnect && managedKeyNames.length > 0) {
      log.debug('Notifying managed key renewal service of reconnection');
      void notifyManagedKeyReconnect();
    }
  }

  /**
   * Handle incoming WebSocket message.
   */
  function handleMessage(data: WebSocket.Data): void {
    // Convert WebSocket.Data (string | Buffer | ArrayBuffer | Buffer[]) to string
    function dataToString(d: WebSocket.Data): string {
      if (typeof d === 'string') return d;
      if (Buffer.isBuffer(d)) return d.toString('utf-8');
      if (d instanceof ArrayBuffer) return Buffer.from(d).toString('utf-8');
      if (Array.isArray(d)) return Buffer.concat(d).toString('utf-8');
      return '';
    }

    try {
      const dataStr = dataToString(data);
      const message = JSON.parse(dataStr) as UnifiedAgentEvent;
      dispatcher.handleMessage(ws, message);
    } catch (err) {
      const dataStr = dataToString(data);
      log.warn({ ws: 'unified', err, data: dataStr.substring(0, 100) }, 'Failed to parse message');
    }
  }

  /**
   * Handle WebSocket close event.
   * For auth failures (4001), recovery is blocking to ensure proper credential refresh.
   */
  function handleClose(code: number, reason: Buffer): void {
    try {
      heartbeatManager.stop();
    } catch (err) {
      log.warn({ err }, 'Failed to stop heartbeat manager during close');
    }

    setWebSocketStatus(false);
    setSecretWebSocketStatus(false);
    metrics.wsDisconnected();
    dispatcher.clearAgentId();

    const reasonStr = reason.length > 0 ? reason.toString() : `Code: ${code}`;
    log.warn({ ws: 'unified', code, reason: reasonStr }, 'WebSocket disconnected');
    dispatcher.fireDisconnect(reasonStr);

    // Check for authentication failure (code 4001 = Unauthorized)
    // This happens when the agent's API key is stale/expired/revoked
    if (code === 4001 && managedKeyNames.length > 0) {
      log.warn({ ws: 'unified' }, 'WebSocket closed with 4001 (Unauthorized) - attempting managed key recovery');

      // BLOCKING recovery - await the result before scheduling reconnect
      // Previously this was fire-and-forget which could cause reconnect with stale credentials
      handleAuthFailureRecovery().catch((err: unknown) => {
        log.error({ err }, 'Auth failure recovery threw exception');
        // Still try to reconnect with backoff
        reconnectManager.schedule();
      });
    } else {
      log.info({ ws: 'unified', shouldReconnect: reconnectManager.isEnabled(), isShuttingDown }, 'Triggering reconnect from close handler');
      reconnectManager.schedule();
    }
  }

  /**
   * Handle authentication failure recovery (blocking).
   * Attempts to refresh managed key credentials before reconnecting.
   */
  async function handleAuthFailureRecovery(): Promise<void> {
    try {
      const recovered = await notifyManagedKeyAuthFailure();

      if (recovered) {
        log.info({ ws: 'unified' }, 'Managed key recovered successfully');
        // Reset reconnect attempts since we have a fresh key
        reconnectManager.resetAttempts();
      } else {
        log.error({ ws: 'unified' }, 'Managed key recovery failed - using exponential backoff');
        // Don't reset attempts - use backoff for failed recovery
      }
    } catch (err) {
      log.error({ err }, 'Managed key recovery threw exception');
      // Don't reset attempts - use backoff for errors
    }

    log.info({ ws: 'unified', shouldReconnect: reconnectManager.isEnabled(), isShuttingDown }, 'Triggering reconnect after auth recovery');
    reconnectManager.schedule();
  }

  /**
   * Handle WebSocket error event.
   */
  function handleError(err: Error): void {
    log.error({ ws: 'unified', err }, 'WebSocket error');
    dispatcher.fireError(err);
  }

  /**
   * Disconnect from the WebSocket server.
   */
  function disconnect(): void {
    reconnectManager.disable();

    try {
      heartbeatManager.stop();
    } catch (err) {
      log.warn({ err }, 'Failed to stop heartbeat manager during disconnect');
    }

    // Clear dynamic secrets WebSocket reference
    setDynamicSecretsWebSocket(null);

    if (ws) {
      log.info({ ws: 'unified' }, 'Disconnecting WebSocket');
      // Remove listeners before closing to prevent memory leaks
      removeListeners(ws);
      ws.close();
      ws = null;
    }

    setWebSocketStatus(false);
    setSecretWebSocketStatus(false);
    metrics.wsDisconnected();
    dispatcher.clearAgentId();
    wasConnectedBefore = false;
  }

  /**
   * Update subscriptions on the WebSocket connection.
   */
  function updateSubscriptions(subs: SubscriptionUpdate): boolean {
    if (ws?.readyState !== WebSocket.OPEN) {
      log.warn('Cannot update subscriptions: not connected');
      return false;
    }

    const message = {
      type: 'subscribe',
      topics: [] as string[],
      certIds: subs.certIds,
      secretIds: subs.secretIds,
      managedKeys: subs.managedKeys,
      channel: subs.updateChannel,
    };

    if (subs.certIds?.length) message.topics.push('certificates');
    if (subs.secretIds?.length) message.topics.push('secrets');
    if (subs.managedKeys?.length) message.topics.push('apikeys');
    if (subs.updateChannel) message.topics.push('updates');

    ws.send(JSON.stringify(message));
    log.info({ subs }, 'Sent subscription update');
    return true;
  }

  return {
    connect,
    disconnect,
    isConnected: () => ws?.readyState === WebSocket.OPEN,
    onCertificateEvent: (handler: (event: CertificateEvent) => void) => { dispatcher.onCertificateEvent(handler); },
    onSecretEvent: (handler: (event: SecretEvent) => void) => { dispatcher.onSecretEvent(handler); },
    onUpdateEvent: (handler: (event: AgentUpdateEvent) => void) => { dispatcher.onUpdateEvent(handler); },
    onApiKeyRotationEvent: (handler: (event: ApiKeyRotationEvent) => void) => { dispatcher.onApiKeyRotationEvent(handler); },
    onDegradedConnection: (handler: (info: DegradedConnectionInfo) => void) => { dispatcher.onDegradedConnection(handler); },
    onReprovisionAvailable: (handler: (expiresAt: string) => void) => { dispatcher.onReprovisionAvailable(handler); },
    onConnect: (handler: (agentId: string) => void) => { dispatcher.onConnect(handler); },
    onDisconnect: (handler: (reason: string) => void) => { dispatcher.onDisconnect(handler); },
    onError: (handler: (error: Error) => void) => { dispatcher.onError(handler); },
    updateSubscriptions: (subs: SubscriptionUpdate) => { updateSubscriptions(subs); },
    // Handler removal for cleanup (Phase 8 improvement)
    offCertificateEvent: (handler: (event: CertificateEvent) => void) => { dispatcher.offCertificateEvent(handler); },
    offSecretEvent: (handler: (event: SecretEvent) => void) => { dispatcher.offSecretEvent(handler); },
    removeAllHandlers: () => { dispatcher.removeAllHandlers(); },
  };
}
