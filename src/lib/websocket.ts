// Path: zn-vault-agent/src/lib/websocket.ts
// WebSocket client for real-time certificate and secret updates (unified mode)

import WebSocket from 'ws';
import os from 'node:os';
import { createRequire } from 'node:module';
import { loadConfig, syncManagedKeyFile, type ExecConfig, type AgentConfig } from './config.js';

// ESM-compatible way to read package.json
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version: string };
import { deployCertificate, deployAllCertificates } from './deployer.js';
import { deploySecret, deployAllSecrets, findSecretTarget } from './secret-deployer.js';
import { wsLogger as log } from './logger.js';
import { metrics, initializeMetrics } from './metrics.js';
import {
  setWebSocketStatus,
  setSecretWebSocketStatus,
  startHealthServer,
  stopHealthServer,
  updateCertStatus,
  updateSecretStatus,
  setChildProcessManager,
  setPluginAutoUpdateService,
} from './health.js';
import { flushLogs, setupLogRotation } from './logger.js';
import type { PluginAutoUpdateService } from '../services/plugin-auto-update.js';
import { startApiKeyRenewal, stopApiKeyRenewal } from '../services/api-key-renewal.js';
import {
  startManagedKeyRenewal,
  stopManagedKeyRenewal,
  onKeyChanged as onManagedKeyChanged,
  onWebSocketReconnect as notifyManagedKeyReconnect,
  onWebSocketRotationEvent as notifyManagedKeyRotationEvent,
  onWebSocketAuthFailure as notifyManagedKeyAuthFailure,
} from '../services/managed-key-renewal.js';
import { isManagedKeyMode } from './config.js';
import { ChildProcessManager } from '../services/child-process-manager.js';
import {
  extractSecretIds,
  extractApiKeyNames,
  parseSecretMappingFromConfig,
  updateEnvFile,
  findEnvVarsForApiKey,
  type SecretMapping,
} from './secret-env.js';
import { bindManagedApiKey } from './api.js';
import {
  createPluginLoader,
  clearPluginLoader,
  type PluginLoader,
} from '../plugins/loader.js';
import type {
  CertificateDeployedEvent,
  SecretDeployedEvent,
  KeyRotatedEvent,
  ChildProcessEvent,
} from '../plugins/types.js';
import {
  initDegradedModeHandler,
  handleDegradedConnection,
  handleReprovisionAvailable,
  cleanupDegradedModeHandler,
  setAgentId,
} from '../services/degraded-mode-handler.js';

export interface CertificateEvent {
  event: 'certificate.rotated' | 'certificate.created' | 'certificate.deleted';
  certificateId: string;
  fingerprint: string;
  version: number;
  timestamp: string;
}

export interface SecretEvent {
  event: 'secret.created' | 'secret.updated' | 'secret.rotated' | 'secret.deleted';
  secretId: string;
  alias: string;
  version: number;
  timestamp: string;
  tenantId: string;
}

export interface AgentUpdateEvent {
  event: 'update.available';
  channel: 'stable' | 'beta' | 'staging';
  version: string;
  releaseNotes?: string;
  timestamp: string;
}

export interface ApiKeyRotationEvent {
  event: 'apikey.rotated';
  apiKeyId: string;
  apiKeyName: string;
  tenantId: string;
  newPrefix: string;
  graceExpiresAt: string;
  rotationMode: 'scheduled' | 'on-use' | 'on-bind';
  rotationCount: number;
  reason: string;
  timestamp: string;
}

/**
 * Degraded connection reason
 */
export type DegradedReason = 'key_expired' | 'key_revoked' | 'key_disabled' | 'auth_failed';

/**
 * Degraded connection info from server
 */
export interface DegradedConnectionInfo {
  isDegraded: true;
  reason: DegradedReason;
  agentId?: string;
  message: string;
  canReceiveReprovision: boolean;
}

/**
 * Reprovision event from server
 */
export interface ReprovisionEvent {
  event: 'agent.reprovision.available' | 'agent.reprovision.cancelled';
  agentId: string;
  tenantId: string;
  expiresAt?: string;
  reason?: string;
  timestamp: string;
}

/**
 * Unified agent event (from /v1/ws/agent)
 */
export interface UnifiedAgentEvent {
  type: 'pong' | 'event' | 'subscribed' | 'registered' | 'error' | 'connection_established' | 'degraded_connection' | 'reprovision_available';
  topic?: 'certificates' | 'secrets' | 'updates' | 'apikeys' | 'reprovision';
  data?: CertificateEvent | SecretEvent | AgentUpdateEvent | ApiKeyRotationEvent | ReprovisionEvent | DegradedConnectionInfo;
  subscriptions?: { certificates: string[]; secrets: string[]; managedKeys: string[]; updates: string | null };
  agentId?: string;
  message?: string;
  timestamp?: string;
  // For reprovision_available message
  reprovisionToken?: string;
  expiresAt?: string;
}

// Graceful shutdown state
let isShuttingDown = false;
let activeDeployments = 0;

/**
 * Unified WebSocket client interface for /v1/ws/agent
 */
export interface UnifiedWebSocketClient {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  onCertificateEvent(handler: (event: CertificateEvent) => void): void;
  onSecretEvent(handler: (event: SecretEvent) => void): void;
  onUpdateEvent(handler: (event: AgentUpdateEvent) => void): void;
  onApiKeyRotationEvent(handler: (event: ApiKeyRotationEvent) => void): void;
  onDegradedConnection(handler: (info: DegradedConnectionInfo) => void): void;
  onReprovisionAvailable(handler: (expiresAt: string) => void): void;
  onConnect(handler: (agentId: string) => void): void;
  onDisconnect(handler: (reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
  updateSubscriptions(subs: { certIds?: string[]; secretIds?: string[]; managedKeys?: string[]; updateChannel?: string }): void;
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
export function createUnifiedWebSocketClient(
  additionalSecretIds: string[] = [],
  managedKeyNames: string[] = []
): UnifiedWebSocketClient {
  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let shouldReconnect = true;
  let registeredAgentId: string | null = null;
  let wasConnectedBefore = false; // Track if we've connected before (for reconnection detection)

  const certEventHandlers: ((event: CertificateEvent) => void)[] = [];
  const secretEventHandlers: ((event: SecretEvent) => void)[] = [];
  const updateEventHandlers: ((event: AgentUpdateEvent) => void)[] = [];
  const apiKeyRotationEventHandlers: ((event: ApiKeyRotationEvent) => void)[] = [];
  const degradedConnectionHandlers: ((info: DegradedConnectionInfo) => void)[] = [];
  const reprovisionAvailableHandlers: ((expiresAt: string) => void)[] = [];
  const connectHandlers: ((agentId: string) => void)[] = [];
  const disconnectHandlers: ((reason: string) => void)[] = [];
  const errorHandlers: ((error: Error) => void)[] = [];

  // Aggressive reconnection settings
  const MAX_RECONNECT_DELAY = 30000;      // Max 30 seconds between retries
  const INITIAL_RECONNECT_DELAY = 500;    // Start with 500ms
  const HEARTBEAT_INTERVAL = 15000;       // Send ping every 15 seconds
  const PONG_TIMEOUT = 10000;             // Expect pong within 10 seconds

  let lastPongReceived = Date.now();
  let pongTimeoutTimer: NodeJS.Timeout | null = null;

  function getReconnectDelay(): number {
    // First retry is immediate (500ms), then exponential backoff
    if (reconnectAttempts === 0) {
      return INITIAL_RECONNECT_DELAY;
    }
    const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    return delay + Math.random() * 500; // Smaller jitter
  }

  function buildWebSocketUrl(): string {
    const config = loadConfig();
    const url = new URL(config.vaultUrl);

    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/v1/ws/agent';

    // Build initial subscription query params
    const certIds = config.targets.map(t => t.certId);
    const secretTargets = config.secretTargets || [];
    const secretTargetIds = secretTargets.map(t => t.secretId);

    // Combine secret target IDs with additional exec secret IDs
    const allSecretIds = [...new Set([...secretTargetIds, ...additionalSecretIds])];

    if (certIds.length > 0) {
      url.searchParams.set('certIds', certIds.join(','));
    }
    if (allSecretIds.length > 0) {
      url.searchParams.set('secretIds', allSecretIds.join(','));
    }
    // Subscribe to managed API key rotation events
    if (managedKeyNames.length > 0) {
      url.searchParams.set('managedKeys', managedKeyNames.join(','));
    }
    // Subscribe to stable update channel by default
    url.searchParams.set('updateChannel', 'stable');

    // Authentication
    if (config.auth.apiKey) {
      url.searchParams.set('apiKey', config.auth.apiKey);
    }

    // Hostname for registration
    const hostname = process.env.HOSTNAME || os.hostname();
    url.searchParams.set('hostname', hostname);
    url.searchParams.set('version', packageJson.version || 'unknown');
    url.searchParams.set('platform', process.platform);

    return url.toString();
  }

  function startHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pongTimeoutTimer) clearTimeout(pongTimeoutTimer);

    lastPongReceived = Date.now();

    heartbeatTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        // Check if we received a pong since last ping
        const timeSinceLastPong = Date.now() - lastPongReceived;
        if (timeSinceLastPong > PONG_TIMEOUT + HEARTBEAT_INTERVAL) {
          // No pong received for too long - connection is stale
          log.warn({
            ws: 'unified',
            timeSinceLastPong,
            threshold: PONG_TIMEOUT + HEARTBEAT_INTERVAL
          }, 'Connection stale - no pong received, forcing reconnect');
          forceReconnect('pong_timeout');
          return;
        }

        // Send ping and start pong timeout
        ws.send(JSON.stringify({ type: 'ping' }));
        log.trace({ ws: 'unified' }, 'Sending heartbeat ping');

        // Set a timeout to check for pong response
        if (pongTimeoutTimer) clearTimeout(pongTimeoutTimer);
        pongTimeoutTimer = setTimeout(() => {
          const elapsed = Date.now() - lastPongReceived;
          if (elapsed > PONG_TIMEOUT && ws?.readyState === WebSocket.OPEN) {
            log.warn({ ws: 'unified', elapsed }, 'Pong timeout - forcing reconnect');
            forceReconnect('pong_timeout');
          }
        }, PONG_TIMEOUT);
      }
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (pongTimeoutTimer) {
      clearTimeout(pongTimeoutTimer);
      pongTimeoutTimer = null;
    }
  }

  function forceReconnect(reason: string): void {
    log.info({ ws: 'unified', reason }, 'Forcing WebSocket reconnect');
    stopHeartbeat();

    if (ws) {
      try {
        ws.terminate(); // Force close without waiting
      } catch {
        // Ignore errors during terminate
      }
      ws = null;
    }

    // Reset reconnect attempts for faster initial retry
    reconnectAttempts = 0;
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (!shouldReconnect || isShuttingDown) {
      log.debug({ shouldReconnect, isShuttingDown }, 'Skipping reconnect - shutdown or disabled');
      return;
    }

    if (reconnectTimer) clearTimeout(reconnectTimer);

    const delay = getReconnectDelay();
    reconnectAttempts++;
    metrics.wsReconnect();

    log.info({ ws: 'unified', attempt: reconnectAttempts, delay }, 'Scheduling reconnect');

    reconnectTimer = setTimeout(() => {
      log.info({ ws: 'unified', attempt: reconnectAttempts }, 'Reconnect timer fired - attempting connection');
      connect();
    }, delay);
  }

  function handleMessage(message: UnifiedAgentEvent): void {
    switch (message.type) {
      case 'registered':
        registeredAgentId = message.agentId || null;
        log.info({ agentId: registeredAgentId }, 'Agent registered with vault');
        break;

      case 'subscribed':
        log.info({ subscriptions: message.subscriptions }, 'Subscriptions updated');
        break;

      case 'pong':
        lastPongReceived = Date.now();
        if (pongTimeoutTimer) {
          clearTimeout(pongTimeoutTimer);
          pongTimeoutTimer = null;
        }
        log.trace({ lastPongReceived }, 'Received heartbeat pong');
        break;

      case 'event':
        if (message.topic === 'certificates' && message.data) {
          const event = message.data as CertificateEvent;
          log.info({ event: event.event, certId: event.certificateId }, 'Received certificate event');
          setWebSocketStatus(true, new Date());
          certEventHandlers.forEach(h => { h(event); });
        } else if (message.topic === 'secrets' && message.data) {
          const event = message.data as SecretEvent;
          log.info({ event: event.event, secretId: event.secretId }, 'Received secret event');
          setSecretWebSocketStatus(true, new Date());
          secretEventHandlers.forEach(h => { h(event); });
        } else if (message.topic === 'updates' && message.data) {
          const event = message.data as AgentUpdateEvent;
          log.info({ version: event.version, channel: event.channel }, 'Received update event');
          updateEventHandlers.forEach(h => { h(event); });
        } else if (message.topic === 'apikeys' && message.data) {
          const event = message.data as ApiKeyRotationEvent;
          log.info({
            event: event.event,
            keyName: event.apiKeyName,
            newPrefix: event.newPrefix,
            graceExpiresAt: event.graceExpiresAt,
          }, 'Received API key rotation event');

          // Notify managed key renewal service (for safety rail tracking)
          // This must be called BEFORE the handlers to properly mark WS event received
          void notifyManagedKeyRotationEvent(event.apiKeyName);

          apiKeyRotationEventHandlers.forEach(h => { h(event); });
        }
        break;

      case 'error':
        log.error({ message: message.message }, 'Server error');
        break;

      case 'connection_established':
        log.debug('Connection established with server');
        break;

      case 'degraded_connection':
        if (message.data) {
          const info = message.data as DegradedConnectionInfo;
          log.warn({
            reason: info.reason,
            agentId: info.agentId,
            message: info.message,
          }, 'Agent in degraded mode');
          degradedConnectionHandlers.forEach(h => { h(info); });
        }
        break;

      case 'reprovision_available':
        if (message.expiresAt) {
          log.info({
            expiresAt: message.expiresAt,
          }, 'Reprovision token available');
          reprovisionAvailableHandlers.forEach(h => { h(message.expiresAt!); });
        }
        break;
    }

    // Also check for reprovision events in the event topic
    if (message.type === 'event' && message.topic === 'reprovision' && message.data) {
      const event = message.data as ReprovisionEvent;
      if (event.event === 'agent.reprovision.available' && event.expiresAt) {
        log.info({
          agentId: event.agentId,
          expiresAt: event.expiresAt,
          reason: event.reason,
        }, 'Reprovision event received');
        reprovisionAvailableHandlers.forEach(h => { h(event.expiresAt!); });
      }
    }
  }

  function connect(): void {
    if (isShuttingDown) {
      log.debug({ ws: 'unified' }, 'Shutdown in progress, not connecting');
      return;
    }

    // Reset shouldReconnect - if connect() is called explicitly, we want reconnection enabled
    shouldReconnect = true;

    const config = loadConfig();

    if (!config.vaultUrl) {
      const err = new Error('Vault URL not configured');
      log.error({ ws: 'unified' }, 'Cannot connect');
      errorHandlers.forEach(h => { h(err); });
      return;
    }

    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) {
      log.debug({ ws: 'unified' }, 'Already connected or connecting');
      return;
    }

    try {
      const wsUrl = buildWebSocketUrl();
      log.info({ ws: 'unified', url: wsUrl.replace(/apiKey=[^&]+/, 'apiKey=***') }, 'Connecting to unified WebSocket');

      ws = new WebSocket(wsUrl, {
        rejectUnauthorized: !config.insecure,
        handshakeTimeout: 10000,
      });

      ws.on('open', () => {
        const isReconnect = wasConnectedBefore;
        wasConnectedBefore = true;
        reconnectAttempts = 0;
        startHeartbeat();
        setWebSocketStatus(true, new Date());
        setSecretWebSocketStatus(true, new Date());
        metrics.wsConnected();
        log.info({ ws: 'unified', isReconnect }, 'Unified WebSocket connected');

        // Notify managed key renewal service of reconnection (for connection loss recovery)
        if (isReconnect && managedKeyNames.length > 0) {
          log.debug('Notifying managed key renewal service of reconnection');
          void notifyManagedKeyReconnect();
        }
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as UnifiedAgentEvent;
          handleMessage(message);

          // Fire connect handlers when we get registered
          if (message.type === 'registered' && registeredAgentId) {
            connectHandlers.forEach(h => { h(registeredAgentId!); });
          }
        } catch (err) {
          log.warn({ ws: 'unified', err, data: data.toString().substring(0, 100) }, 'Failed to parse message');
        }
      });

      ws.on('close', (code, reason) => {
        stopHeartbeat();
        setWebSocketStatus(false);
        setSecretWebSocketStatus(false);
        metrics.wsDisconnected();
        registeredAgentId = null;
        const reasonStr = reason?.toString() || `Code: ${code}`;
        log.warn({ ws: 'unified', code, reason: reasonStr }, 'WebSocket disconnected');
        disconnectHandlers.forEach(h => { h(reasonStr); });

        // Check for authentication failure (code 4001 = Unauthorized)
        // This happens when the agent's API key is stale/expired/revoked
        if (code === 4001 && managedKeyNames.length > 0) {
          log.warn({ ws: 'unified' }, 'WebSocket closed with 4001 (Unauthorized) - attempting managed key recovery');

          // Try to refresh the managed key before reconnecting
          void notifyManagedKeyAuthFailure().then((recovered) => {
            if (recovered) {
              log.info({ ws: 'unified' }, 'Managed key recovered, scheduling reconnect');
              // Reset reconnect attempts since we have a fresh key
              reconnectAttempts = 0;
            } else {
              log.error({ ws: 'unified' }, 'Managed key recovery failed - agent needs manual intervention');
              // Still try to reconnect, but don't reset attempts (exponential backoff)
            }
            log.info({ ws: 'unified', shouldReconnect, isShuttingDown }, 'Triggering reconnect from close handler');
            scheduleReconnect();
          });
        } else {
          log.info({ ws: 'unified', shouldReconnect, isShuttingDown }, 'Triggering reconnect from close handler');
          scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        log.error({ ws: 'unified', err }, 'WebSocket error');
        errorHandlers.forEach(h => { h(err); });
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ ws: 'unified', err: error }, 'Failed to create WebSocket');
      errorHandlers.forEach(h => { h(error); });
      scheduleReconnect();
    }
  }

  function disconnect(): void {
    shouldReconnect = false;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    stopHeartbeat();

    if (ws) {
      log.info({ ws: 'unified' }, 'Disconnecting WebSocket');
      ws.close();
      ws = null;
    }

    setWebSocketStatus(false);
    setSecretWebSocketStatus(false);
    metrics.wsDisconnected();
    registeredAgentId = null;
    wasConnectedBefore = false; // Reset for clean reconnection tracking
  }

  function updateSubscriptions(subs: { certIds?: string[]; secretIds?: string[]; managedKeys?: string[]; updateChannel?: string }): void {
    if (ws?.readyState !== WebSocket.OPEN) {
      log.warn('Cannot update subscriptions: not connected');
      return;
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
  }

  return {
    connect,
    disconnect,
    isConnected: () => ws?.readyState === WebSocket.OPEN,
    onCertificateEvent: (handler) => certEventHandlers.push(handler),
    onSecretEvent: (handler) => secretEventHandlers.push(handler),
    onUpdateEvent: (handler) => updateEventHandlers.push(handler),
    onApiKeyRotationEvent: (handler) => apiKeyRotationEventHandlers.push(handler),
    onDegradedConnection: (handler) => degradedConnectionHandlers.push(handler),
    onReprovisionAvailable: (handler) => reprovisionAvailableHandlers.push(handler),
    onConnect: (handler) => connectHandlers.push(handler),
    onDisconnect: (handler) => disconnectHandlers.push(handler),
    onError: (handler) => errorHandlers.push(handler),
    updateSubscriptions,
  };
}

/**
 * Start the agent daemon with unified WebSocket connection
 */
export async function startDaemon(options: {
  verbose?: boolean;
  healthPort?: number;
  exec?: ExecConfig;
  pluginAutoUpdateService?: PluginAutoUpdateService | null;
} = {}): Promise<void> {
  const config = loadConfig();
  const secretTargets = config.secretTargets || [];

  // Initialize plugin loader
  let pluginLoader: PluginLoader | null = null;

  // Initialize metrics
  initializeMetrics();

  // Setup log rotation handler
  setupLogRotation();

  // CRITICAL: Verify and sync managed key file before doing anything else
  // This ensures apps that read from file always have the correct key
  if (config.managedKey?.filePath) {
    const syncResult = syncManagedKeyFile();
    if (syncResult.wasOutOfSync) {
      if (syncResult.synced) {
        log.warn({
          filePath: config.managedKey.filePath,
        }, 'Managed key file was out of sync - auto-fixed on startup');
      } else {
        log.error({
          filePath: config.managedKey.filePath,
          error: syncResult.error,
        }, 'CRITICAL: Managed key file sync failed - app may fail to authenticate');
      }
    } else {
      log.info({
        filePath: config.managedKey.filePath,
      }, 'Managed key file verified - in sync');
    }
  }

  // Extract exec secret IDs and managed API key names for WebSocket subscription
  let execSecretIds: string[] = [];
  let execManagedKeyNames: string[] = [];
  let execSecretMappings: (SecretMapping & { literal?: string })[] = [];
  const execOutputFile = options.exec?.envFile; // Output file path for env file mode

  if (options.exec) {
    execSecretMappings = options.exec.secrets.map(parseSecretMappingFromConfig);
    execSecretIds = extractSecretIds(execSecretMappings);
    execManagedKeyNames = extractApiKeyNames(execSecretMappings);
  }

  log.info({
    vault: config.vaultUrl,
    certTargets: config.targets.length,
    secretTargets: secretTargets.length,
    execSecrets: execSecretIds.length,
    execManagedKeys: execManagedKeyNames.length,
    execCommand: options.exec?.command.join(' '),
  }, 'Starting ZnVault Agent');

  // Initialize child process manager if exec config provided
  let childManager: ChildProcessManager | null = null;
  if (options.exec) {
    childManager = new ChildProcessManager(options.exec);

    // Register with health module for status reporting
    setChildProcessManager(childManager);

    childManager.on('started', (pid) => {
      log.info({ pid }, 'Child process started');
    });

    childManager.on('stopped', (code, signal) => {
      log.info({ code, signal }, 'Child process stopped');
    });

    childManager.on('restarting', (reason) => {
      log.info({ reason }, 'Restarting child process');
    });

    childManager.on('maxRestartsExceeded', () => {
      log.error('Child process max restarts exceeded, entering degraded state');
    });

    childManager.on('error', (err) => {
      log.error({ err }, 'Child process error');
    });
  }

  // Initialize plugin system if plugins are configured
  const pluginConfigs = (config as AgentConfig & { plugins?: unknown[] }).plugins;
  if (pluginConfigs && pluginConfigs.length > 0) {
    log.info({ pluginCount: pluginConfigs.length }, 'Initializing plugin system');

    pluginLoader = createPluginLoader(
      {
        config,
        childProcessManager: childManager,
        restartChild: childManager ? (reason: string) => childManager!.restart(reason) : undefined,
      },
      {
        pluginDir: process.env.ZNVAULT_AGENT_PLUGIN_DIR,
      }
    );

    try {
      // Load plugins from config
      await pluginLoader.loadPlugins(config);

      // Initialize plugins
      await pluginLoader.initializePlugins();

      log.info({ plugins: pluginLoader.getAllPluginStatuses() }, 'Plugins initialized');
    } catch (err) {
      log.error({ err }, 'Failed to initialize plugins');
      // Continue running agent without plugins
    }

    // Wire up child process events to plugins - use .catch() for error handling in event callbacks
    if (childManager) {
      childManager.on('started', (pid: number) => {
        const event: ChildProcessEvent = { type: 'started', pid };
        pluginLoader?.dispatchEvent('childProcess', event).catch((err) => {
          log.error({ err, type: 'started' }, 'Plugin failed to handle childProcess event');
        });
      });

      childManager.on('stopped', (code: number | null, signal: string | null) => {
        const event: ChildProcessEvent = {
          type: 'stopped',
          exitCode: code ?? undefined,
          signal: signal ?? undefined,
        };
        pluginLoader?.dispatchEvent('childProcess', event).catch((err) => {
          log.error({ err, type: 'stopped' }, 'Plugin failed to handle childProcess event');
        });
      });

      childManager.on('restarting', (reason: string) => {
        const event: ChildProcessEvent = { type: 'restarting', reason };
        pluginLoader?.dispatchEvent('childProcess', event).catch((err) => {
          log.error({ err, type: 'restarting' }, 'Plugin failed to handle childProcess event');
        });
      });

      childManager.on('maxRestartsExceeded', () => {
        const event: ChildProcessEvent = { type: 'max_restarts' };
        pluginLoader?.dispatchEvent('childProcess', event).catch((err) => {
          log.error({ err, type: 'max_restarts' }, 'Plugin failed to handle childProcess event');
        });
      });
    }
  }

  // Register plugin auto-update service with health module for HTTP endpoints
  if (options.pluginAutoUpdateService) {
    setPluginAutoUpdateService(options.pluginAutoUpdateService);
  }

  // Start health server if port specified (pass plugin loader for routes and health aggregation)
  if (options.healthPort) {
    try {
      await startHealthServer(options.healthPort, pluginLoader ?? undefined);
    } catch (err) {
      log.error({ err }, 'Failed to start health server');
    }
  }

  // Update tracked metrics
  metrics.setCertsTracked(config.targets.length);

  // Create unified WebSocket client with exec secret IDs and managed key names
  const unifiedClient = createUnifiedWebSocketClient(execSecretIds, execManagedKeyNames);

  // Initialize degraded mode handler
  initDegradedModeHandler({
    onCredentialsUpdated: (newKey) => {
      log.info({ keyPrefix: newKey.substring(0, 8) }, 'Credentials updated via reprovision, reconnecting');
      // Reconnect with new credentials
      unifiedClient.disconnect();
      setTimeout(() => {
        if (!isShuttingDown) {
          unifiedClient.connect();
        }
      }, 500);
    },
    onStateChanged: (isDegraded, reason) => {
      if (isDegraded) {
        log.warn({ reason }, 'Agent entered degraded mode');
      } else {
        log.info('Agent exited degraded mode');
      }
    },
  });

  // Handle degraded connection notifications
  unifiedClient.onDegradedConnection((info) => {
    handleDegradedConnection(info);
  });

  // Handle reprovision available notifications
  unifiedClient.onReprovisionAvailable((expiresAt) => {
    handleReprovisionAvailable(expiresAt);
  });

  // Handle certificate events
  unifiedClient.onCertificateEvent(async (event) => {
    if (isShuttingDown) {
      log.debug({ event: event.event }, 'Ignoring certificate event during shutdown');
      return;
    }

    const target = config.targets.find(t => t.certId === event.certificateId);
    if (target) {
      activeDeployments++;
      try {
        log.info({ name: target.name, event: event.event }, 'Processing certificate event');
        const result = await deployCertificate(target, true);

        if (result.success) {
          log.info({ name: target.name, fingerprint: result.fingerprint }, 'Certificate deployed');

          // Dispatch plugin event - await with error handling
          if (pluginLoader) {
            const certEvent: CertificateDeployedEvent = {
              certId: target.certId,
              name: target.name,
              paths: target.outputs,
              fingerprint: result.fingerprint || '',
              expiresAt: '', // Would need cert parsing for this
              commonName: '', // Would need cert parsing for this
              isUpdate: true,
            };
            try {
              await pluginLoader.dispatchEvent('certificateDeployed', certEvent);
            } catch (pluginErr) {
              log.error({ err: pluginErr, certId: target.certId }, 'Plugin failed to handle certificateDeployed event');
            }
          }

          // Restart child process if configured
          if (childManager && options.exec?.restartOnChange) {
            await childManager.restart('certificate rotated');
          }
        } else {
          log.error({ name: target.name, error: result.message }, 'Certificate deployment failed');
        }
      } finally {
        activeDeployments--;
      }
    } else {
      log.debug({ certId: event.certificateId }, 'Received event for untracked certificate');
    }
  });

  // Handle secret events
  unifiedClient.onSecretEvent(async (event) => {
    if (isShuttingDown) {
      log.debug({ event: event.event }, 'Ignoring secret event during shutdown');
      return;
    }

    let deployedSecretTarget = false;
    let isExecSecret = false;

    // Check if this is a secret target (file deployment)
    const target = findSecretTarget(event.secretId) || findSecretTarget(event.alias);
    if (target) {
      activeDeployments++;
      try {
        log.info({ name: target.name, event: event.event, version: event.version }, 'Processing secret event');
        const result = await deploySecret(target, true);

        if (result.success) {
          log.info({ name: target.name, version: result.version }, 'Secret deployed');
          deployedSecretTarget = true;

          // Dispatch plugin event - await with error handling
          if (pluginLoader) {
            const secretEvent: SecretDeployedEvent = {
              secretId: target.secretId,
              alias: event.alias,
              name: target.name,
              path: target.output,
              format: target.format,
              version: result.version || event.version,
              isUpdate: true,
            };
            try {
              await pluginLoader.dispatchEvent('secretDeployed', secretEvent);
            } catch (pluginErr) {
              log.error({ err: pluginErr, secretId: target.secretId }, 'Plugin failed to handle secretDeployed event');
            }
          }
        } else {
          log.error({ name: target.name, error: result.message }, 'Secret deployment failed');
        }
      } finally {
        activeDeployments--;
      }
    }

    // Check if this is an exec secret (for child process)
    if (execSecretIds.includes(event.secretId) || execSecretIds.includes(event.alias)) {
      isExecSecret = true;
    }

    // Restart child process if:
    // 1. A secret target was deployed and restartOnChange is true, OR
    // 2. An exec secret was updated
    if (childManager && options.exec?.restartOnChange) {
      if (deployedSecretTarget || isExecSecret) {
        const reason = isExecSecret ? 'exec secret updated' : 'secret file updated';
        await childManager.restart(reason);
      }
    }

    if (!target && !isExecSecret) {
      log.debug({ secretId: event.secretId, alias: event.alias }, 'Received event for untracked secret');
    }
  });

  // Handle update events
  unifiedClient.onUpdateEvent((event) => {
    log.info({ version: event.version, channel: event.channel }, 'Update available');
    // Auto-update handling is done by auto-update service
  });

  // Handle API key rotation events
  unifiedClient.onApiKeyRotationEvent(async (event) => {
    if (isShuttingDown) {
      log.debug({ event: event.event }, 'Ignoring API key rotation event during shutdown');
      return;
    }

    // Check if this key is one we're using
    if (!execManagedKeyNames.includes(event.apiKeyName)) {
      log.debug({ keyName: event.apiKeyName }, 'Received rotation event for untracked managed key');
      return;
    }

    log.info({
      keyName: event.apiKeyName,
      newPrefix: event.newPrefix,
      graceExpiresAt: event.graceExpiresAt,
      reason: event.reason,
    }, 'Processing managed API key rotation event');

    activeDeployments++;
    try {
      // Fetch the new key via bind
      const bindResponse = await bindManagedApiKey(event.apiKeyName);
      const newKey = bindResponse.key;

      log.info({
        keyName: event.apiKeyName,
        keyPrefix: newKey.substring(0, 8),
      }, 'Fetched new API key value');

      // Dispatch plugin event - CRITICAL: await with error handling
      // Previously this was fire-and-forget which could cause silent failures
      if (pluginLoader) {
        const keyEvent: KeyRotatedEvent = {
          keyName: event.apiKeyName,
          newPrefix: event.newPrefix,
          graceExpiresAt: event.graceExpiresAt,
          nextRotationAt: bindResponse.nextRotationAt,
          rotationMode: event.rotationMode,
        };
        try {
          await pluginLoader.dispatchEvent('keyRotated', keyEvent);
          log.debug({ keyName: event.apiKeyName }, 'Plugin keyRotated event dispatched successfully');
        } catch (pluginErr) {
          log.error({
            err: pluginErr,
            keyName: event.apiKeyName,
          }, 'Plugin failed to handle keyRotated event');
          // Continue processing - plugin failure should not block key rotation
        }
      }

      // Update env file if using output file mode
      if (execOutputFile) {
        // Find which env var(s) map to this API key
        const envVars = findEnvVarsForApiKey(execSecretMappings, event.apiKeyName);

        for (const envVar of envVars) {
          try {
            await updateEnvFile(execOutputFile, envVar, newKey);
            log.info({
              keyName: event.apiKeyName,
              envVar,
              filePath: execOutputFile,
            }, 'Updated env file with rotated API key');
          } catch (err) {
            log.error({
              err,
              keyName: event.apiKeyName,
              envVar,
              filePath: execOutputFile,
            }, 'Failed to update env file with rotated API key');
          }
        }
      }

      // Restart child process if configured to restart on changes
      if (childManager && options.exec?.restartOnChange) {
        await childManager.restart(`managed API key '${event.apiKeyName}' rotated`);
      }
    } catch (err) {
      log.error({
        err,
        keyName: event.apiKeyName,
      }, 'Failed to process API key rotation event');
    } finally {
      activeDeployments--;
    }
  });

  unifiedClient.onConnect((agentId) => {
    log.info({ agentId }, 'Connected to vault');
    // Store agent ID for degraded mode handling
    setAgentId(agentId);
  });

  unifiedClient.onDisconnect((reason) => {
    log.warn({ reason }, 'Disconnected from vault');
  });

  unifiedClient.onError((err) => {
    log.error({ err }, 'WebSocket error');
  });

  // Start API key renewal service (managed or standard)
  if (isManagedKeyMode()) {
    log.info('Using managed API key mode');

    // Set up callback for when managed key changes
    onManagedKeyChanged((newKey) => {
      log.info({ newKeyPrefix: newKey.substring(0, 8) }, 'Managed key changed, reconnecting WebSocket');
      // Reconnect WebSocket with new key
      unifiedClient.disconnect();
      // Small delay to allow config to be saved
      setTimeout(() => {
        if (!isShuttingDown) {
          unifiedClient.connect();
        }
      }, 500);
    });

    // Start managed key renewal service and AWAIT initial bind
    // This ensures the key is rotated BEFORE we connect WebSocket or start child process
    try {
      await startManagedKeyRenewal();
    } catch (err) {
      log.error({ err }, 'Failed to start managed key renewal service');
    }
  } else {
    // Use standard API key renewal
    startApiKeyRenewal();
  }

  // Connect unified WebSocket
  unifiedClient.connect();

  // Start plugins (after WebSocket is connecting but before initial sync)
  if (pluginLoader) {
    try {
      await pluginLoader.startPlugins();
      log.info({ plugins: pluginLoader.getAllPluginStatuses() }, 'Plugins started');
    } catch (err) {
      log.error({ err }, 'Failed to start plugins');
    }
  }

  // Initial sync - certificates
  if (config.targets.length > 0) {
    log.info('Performing initial certificate sync');
    const certResults = await deployAllCertificates(false);
    const certSuccess = certResults.filter(r => r.success).length;
    const certErrors = certResults.filter(r => !r.success).length;
    updateCertStatus(certSuccess, certErrors);
    log.info({ total: certResults.length, success: certSuccess, errors: certErrors }, 'Certificate sync complete');
  }

  // Initial sync - secrets
  if (secretTargets.length > 0) {
    log.info('Performing initial secret sync');
    const secretResults = await deployAllSecrets(false);
    const secretSuccess = secretResults.filter(r => r.success).length;
    const secretErrors = secretResults.filter(r => !r.success).length;
    updateSecretStatus(secretSuccess, secretErrors);
    log.info({ total: secretResults.length, success: secretSuccess, errors: secretErrors }, 'Secret sync complete');
  }

  // Start child process after initial sync (if exec mode)
  if (childManager) {
    log.info('Starting child process');
    try {
      await childManager.start();
    } catch (err) {
      log.error({ err }, 'Failed to start child process');
      // Continue running daemon even if child fails to start
    }
  }

  // Set up polling interval as fallback
  const pollInterval = (config.pollInterval || 3600) * 1000;

  const poll = async () => {
    if (isShuttingDown) return;

    log.debug('Starting periodic poll');

    // Poll certificates
    for (const target of config.targets) {
      if (isShuttingDown) break;

      try {
        const result = await deployCertificate(target, false);
        if (result.fingerprint !== target.lastFingerprint) {
          log.info({ name: target.name, message: result.message }, 'Certificate updated during poll');
        }
      } catch (err) {
        log.error({ name: target.name, err }, 'Error polling certificate');
      }
    }

    // Poll secrets
    for (const target of secretTargets) {
      if (isShuttingDown) break;

      try {
        const result = await deploySecret(target, false);
        if (result.version !== target.lastVersion) {
          log.info({ name: target.name, message: result.message }, 'Secret updated during poll');
        }
      } catch (err) {
        log.error({ name: target.name, err }, 'Error polling secret');
      }
    }
  };

  const pollTimer = setInterval(poll, pollInterval);

  // Periodic managed key file sync check (every 60 seconds)
  // This catches cases where the file is overwritten/corrupted mid-run
  let keySyncTimer: NodeJS.Timeout | null = null;
  if (config.managedKey?.filePath) {
    const KEY_SYNC_INTERVAL = 60_000; // 60 seconds

    keySyncTimer = setInterval(() => {
      if (isShuttingDown) return;

      const syncResult = syncManagedKeyFile();
      if (syncResult.wasOutOfSync) {
        if (syncResult.synced) {
          log.warn({
            filePath: config.managedKey!.filePath,
          }, 'Periodic check: Managed key file was out of sync - auto-fixed');
        } else {
          log.error({
            filePath: config.managedKey!.filePath,
            error: syncResult.error,
          }, 'Periodic check: CRITICAL - Managed key file sync failed');
        }
      }
      // Don't log on success - too noisy
    }, KEY_SYNC_INTERVAL);

    log.info({ intervalMs: KEY_SYNC_INTERVAL }, 'Periodic managed key file sync check enabled');
  }

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    if (isShuttingDown) {
      log.warn('Shutdown already in progress');
      return;
    }

    isShuttingDown = true;
    log.info({ signal }, 'Shutting down');

    // Stop accepting new events
    clearInterval(pollTimer);
    if (keySyncTimer) clearInterval(keySyncTimer);
    unifiedClient.disconnect();

    // Stop API key renewal service (managed or standard)
    if (isManagedKeyMode()) {
      stopManagedKeyRenewal();
    } else {
      stopApiKeyRenewal();
    }

    // Cleanup degraded mode handler
    cleanupDegradedModeHandler();

    // Stop plugins
    if (pluginLoader) {
      try {
        await pluginLoader.stopPlugins();
        clearPluginLoader();
        log.info('Plugins stopped');
      } catch (err) {
        log.warn({ err }, 'Error stopping plugins');
      }
    }

    // Stop child process first (it needs to exit before we can)
    if (childManager) {
      log.info('Stopping child process');
      try {
        await childManager.stop();
        log.info('Child process stopped');
      } catch (err) {
        log.error({ err }, 'Error stopping child process');
      }
    }

    // Wait for active deployments to complete (max 30 seconds)
    const startTime = Date.now();
    while (activeDeployments > 0 && Date.now() - startTime < 30000) {
      log.info({ active: activeDeployments }, 'Waiting for active deployments');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (activeDeployments > 0) {
      log.warn({ active: activeDeployments }, 'Forcing shutdown with active deployments');
    }

    // Stop health server
    await stopHealthServer();

    // Flush logs
    await flushLogs();

    log.info('Shutdown complete');
    process.exit(0);
  };

  // Handle shutdown signals
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log.info({ pollInterval: config.pollInterval || 3600 }, 'Agent running. Press Ctrl+C to stop.');
}
