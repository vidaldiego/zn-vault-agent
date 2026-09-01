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
  type HostConfigEvent,
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
import { ManagedTimer } from '../../utils/timer.js';

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

  // Healthy-connection tracking: a socket opening is NOT success (the server
  // may close it with 4001 right after the handshake). The reconnect attempt
  // counter is only reset once we received a server ack AND the connection
  // survived HEALTHY_CONNECTION_THRESHOLD. See INC-2026-06-12-01.
  const healthyConnectionTimer = new ManagedTimer();
  let serverAckReceived = false;
  let healthyThresholdElapsed = false;

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

  // Internal subscription: the dispatcher fires connect handlers when the
  // server acknowledges us (registered message). connection_established also
  // counts as an ack and is detected via dispatcher.getAgentId().
  dispatcher.onConnect(() => {
    markServerAcknowledged();
  });

  /**
   * Publish connectivity only after the vault acknowledges this socket. A
   * transport-level `open` can still be rejected or never subscribed, so it
   * must not make /health claim that push delivery is available.
   */
  function markServerAcknowledged(): void {
    if (serverAckReceived) return;
    serverAckReceived = true;
    const acknowledgedAt = new Date();
    setWebSocketStatus(true, acknowledgedAt);
    setSecretWebSocketStatus(true, acknowledgedAt);
    metrics.wsConnected();
    maybeMarkConnectionHealthy();
  }

  /**
   * Reset healthy-connection tracking (called on open/close/disconnect).
   */
  function resetHealthyTracking(): void {
    healthyConnectionTimer.clear();
    serverAckReceived = false;
    healthyThresholdElapsed = false;
  }

  /**
   * Reset the reconnect attempt counter once the connection has proven
   * itself: server ack received AND open beyond HEALTHY_CONNECTION_THRESHOLD.
   */
  function maybeMarkConnectionHealthy(): void {
    if (!healthyThresholdElapsed) return;
    if (ws?.readyState !== WebSocket.OPEN) return;
    // connection_established sets the agentId without firing connect
    // handlers, so accept it as a server ack too.
    if (!serverAckReceived && dispatcher.getAgentId() === null) return;

    log.debug({ ws: 'unified' }, 'Connection healthy - resetting reconnect attempts');
    reconnectManager.resetAttempts();
  }

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
   * Retire a socket without leaving an unhandled error behind.
   *
   * `ws` emits an asynchronous error when close()/terminate() aborts a socket
   * that is still CONNECTING. Removing its error listener first turns that
   * expected lifecycle event into a process-level uncaught exception. Detach
   * data/reconnect listeners now, but retain the existing error path until the
   * socket emits close so real retirement errors remain logged and dispatched.
   */
  function retireSocket(socket: WebSocket, action: 'close' | 'terminate'): void {
    const listeners = wsListeners;
    const errorListener = listeners?.error ?? handleError;
    let cleaned = false;

    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      socket.off('error', errorListener);
      socket.off('close', cleanup);
    };

    if (listeners) {
      socket.off('open', listeners.open);
      socket.off('message', listeners.message);
      socket.off('close', listeners.close);
    } else {
      // Defensive fallback: every socket created here normally has listeners,
      // but a locally-retired CONNECTING socket must never be left unhandled.
      socket.on('error', errorListener);
    }
    socket.once('close', cleanup);
    wsListeners = null;

    try {
      if (action === 'terminate') socket.terminate();
      else socket.close();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      handleError(error);
      cleanup();
    }

    if (socket.readyState === WebSocket.CLOSED) cleanup();
  }

  /**
   * Force a reconnection due to connection issues.
   */
  function forceReconnect(reason: string): void {
    log.info({ ws: 'unified', reason }, 'Forcing WebSocket reconnect');

    resetHealthyTracking();

    try {
      heartbeatManager.stop();
    } catch (err) {
      log.warn({ err }, 'Failed to stop heartbeat manager');
    }

    // Clear reference BEFORE terminating to prevent race conditions
    if (ws) {
      const oldWs = ws;
      ws = null;
      retireSocket(oldWs, 'terminate');
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

    // Do NOT reset reconnect attempts here. A TCP/TLS-level open is not a
    // successful connection - the server may still close with 4001
    // (Unauthorized) immediately after the handshake. Resetting here caused
    // a tight connect->4001->reconnect loop (INC-2026-06-12-01). Attempts
    // are reset only once the connection proves healthy (server ack + open
    // beyond HEALTHY_CONNECTION_THRESHOLD) or a fresh key bind succeeds.
    resetHealthyTracking();
    healthyConnectionTimer.setTimeout(() => {
      healthyThresholdElapsed = true;
      maybeMarkConnectionHealthy();
    }, WS_CONSTANTS.HEALTHY_CONNECTION_THRESHOLD);

    if (ws) {
      heartbeatManager.start(ws);
    }
    // Keep health disconnected until `connection_established`/`registered`.
    setWebSocketStatus(false);
    setSecretWebSocketStatus(false);
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
      if (message.type === 'connection_established') {
        markServerAcknowledged();
      }
    } catch (err) {
      const dataStr = dataToString(data);
      log.warn({
        ws: 'unified',
        errorType: err instanceof Error ? err.name : typeof err,
        messageBytes: Buffer.byteLength(dataStr),
      }, 'Failed to parse message');
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

    resetHealthyTracking();
    setWebSocketStatus(false);
    setSecretWebSocketStatus(false);
    metrics.wsDisconnected();
    dispatcher.clearAgentId();

    const reasonStr = reason.length > 0 ? reason.toString() : `Code: ${code}`;
    log.warn({ ws: 'unified', code, reason: reasonStr }, 'WebSocket disconnected');
    dispatcher.fireDisconnect(reasonStr);

    // Auth-rejection close family (4000-4099): the server accepted the
    // socket but refused our credentials. These MUST count as failed
    // attempts with growing backoff - retrying quickly with the same
    // rejected key only hammers the server and keeps refreshing IP
    // quarantines (INC-2026-06-12-01).
    const isAuthRejectionClose = code >= 4000 && code <= 4099;

    // Check for authentication failure (code 4001 = Unauthorized)
    // This happens when the agent's API key is stale/expired/revoked
    if (code === 4001 && managedKeyNames.length > 0) {
      log.warn({ ws: 'unified' }, 'WebSocket closed with 4001 (Unauthorized) - attempting managed key recovery');

      // BLOCKING recovery - await the result before scheduling reconnect
      // Previously this was fire-and-forget which could cause reconnect with stale credentials
      handleAuthFailureRecovery().catch((err: unknown) => {
        log.error({ err }, 'Auth failure recovery threw exception');
        // Still try to reconnect with auth-failure backoff
        reconnectManager.schedule({ authFailure: true });
      });
    } else if (isAuthRejectionClose) {
      log.warn({ ws: 'unified', code }, 'WebSocket closed with auth-rejection code - scheduling reconnect with auth backoff');
      reconnectManager.schedule({ authFailure: true });
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
    let recovered = false;
    try {
      recovered = await notifyManagedKeyAuthFailure();

      if (recovered) {
        log.info({ ws: 'unified' }, 'Managed key recovered successfully');
        // An authenticated bind just succeeded with a fresh key, so a quick
        // retry is justified - this is the only auth-path reset allowed.
        reconnectManager.resetAttempts();
      } else {
        log.error({ ws: 'unified' }, 'Managed key recovery failed - using exponential backoff');
        // Don't reset attempts - use backoff for failed recovery
      }
    } catch (err) {
      log.error({ err }, 'Managed key recovery threw exception');
      // Don't reset attempts - use backoff for errors
    }

    log.info({ ws: 'unified', recovered, shouldReconnect: reconnectManager.isEnabled(), isShuttingDown }, 'Triggering reconnect after auth recovery');
    reconnectManager.schedule(recovered ? undefined : { authFailure: true });
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
    resetHealthyTracking();

    try {
      heartbeatManager.stop();
    } catch (err) {
      log.warn({ err }, 'Failed to stop heartbeat manager during disconnect');
    }

    // Clear dynamic secrets WebSocket reference
    setDynamicSecretsWebSocket(null);

    if (ws) {
      log.info({ ws: 'unified' }, 'Disconnecting WebSocket');
      const oldWs = ws;
      ws = null;
      retireSocket(oldWs, 'close');
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
    onHostConfigEvent: (handler: (event: HostConfigEvent) => void) => { dispatcher.onHostConfigEvent(handler); },
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
