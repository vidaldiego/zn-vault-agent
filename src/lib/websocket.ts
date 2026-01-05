// Path: zn-vault-agent/src/lib/websocket.ts
// WebSocket client for real-time certificate and secret updates (unified mode)

import WebSocket from 'ws';
import { loadConfig } from './config.js';
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
} from './health.js';
import { flushLogs, setupLogRotation } from './logger.js';
import { startApiKeyRenewal, stopApiKeyRenewal } from '../services/api-key-renewal.js';

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

/**
 * Unified agent event (from /v1/ws/agent)
 */
export interface UnifiedAgentEvent {
  type: 'pong' | 'event' | 'subscribed' | 'registered' | 'error';
  topic?: 'certificates' | 'secrets' | 'updates';
  data?: CertificateEvent | SecretEvent | AgentUpdateEvent;
  subscriptions?: { certificates: string[]; secrets: string[]; updates: string | null };
  agentId?: string;
  message?: string;
  timestamp?: string;
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
  onConnect(handler: (agentId: string) => void): void;
  onDisconnect(handler: (reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
  updateSubscriptions(subs: { certIds?: string[]; secretIds?: string[]; updateChannel?: string }): void;
}

/**
 * Create unified WebSocket client for /v1/ws/agent
 *
 * This client connects to a single endpoint and subscribes to topics:
 * - certificates: certificate rotation events
 * - secrets: secret update events
 * - updates: agent update availability events
 */
export function createUnifiedWebSocketClient(): UnifiedWebSocketClient {
  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let shouldReconnect = true;
  let registeredAgentId: string | null = null;

  const certEventHandlers: ((event: CertificateEvent) => void)[] = [];
  const secretEventHandlers: ((event: SecretEvent) => void)[] = [];
  const updateEventHandlers: ((event: AgentUpdateEvent) => void)[] = [];
  const connectHandlers: ((agentId: string) => void)[] = [];
  const disconnectHandlers: ((reason: string) => void)[] = [];
  const errorHandlers: ((error: Error) => void)[] = [];

  const MAX_RECONNECT_DELAY = 60000;
  const HEARTBEAT_INTERVAL = 30000;

  function getReconnectDelay(): number {
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    return delay + Math.random() * 1000;
  }

  function buildWebSocketUrl(): string {
    const config = loadConfig();
    const url = new URL(config.vaultUrl);

    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/v1/ws/agent';

    // Build initial subscription query params
    const certIds = config.targets.map(t => t.certId);
    const secretTargets = config.secretTargets || [];
    const secretIds = secretTargets.map(t => t.secretId);

    if (certIds.length > 0) {
      url.searchParams.set('certIds', certIds.join(','));
    }
    if (secretIds.length > 0) {
      url.searchParams.set('secretIds', secretIds.join(','));
    }
    // Subscribe to stable update channel by default
    url.searchParams.set('updateChannel', 'stable');

    // Authentication
    if (config.auth.apiKey) {
      url.searchParams.set('apiKey', config.auth.apiKey);
    }

    // Hostname for registration
    const hostname = process.env.HOSTNAME || require('os').hostname();
    url.searchParams.set('hostname', hostname);
    url.searchParams.set('version', require('../../package.json').version || 'unknown');
    url.searchParams.set('platform', process.platform);

    return url.toString();
  }

  function startHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);

    heartbeatTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        // Use protocol ping message
        ws.send(JSON.stringify({ type: 'ping' }));
        log.trace({ ws: 'unified' }, 'Sending heartbeat ping');
      }
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (!shouldReconnect || isShuttingDown) return;

    if (reconnectTimer) clearTimeout(reconnectTimer);

    const delay = getReconnectDelay();
    reconnectAttempts++;
    metrics.wsReconnect();

    log.info({ ws: 'unified', attempt: reconnectAttempts, delay }, 'Scheduling reconnect');

    reconnectTimer = setTimeout(() => {
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
        log.trace('Received heartbeat pong');
        break;

      case 'event':
        if (message.topic === 'certificates' && message.data) {
          const event = message.data as CertificateEvent;
          log.info({ event: event.event, certId: event.certificateId }, 'Received certificate event');
          setWebSocketStatus(true, new Date());
          certEventHandlers.forEach(h => h(event));
        } else if (message.topic === 'secrets' && message.data) {
          const event = message.data as SecretEvent;
          log.info({ event: event.event, secretId: event.secretId }, 'Received secret event');
          setSecretWebSocketStatus(true, new Date());
          secretEventHandlers.forEach(h => h(event));
        } else if (message.topic === 'updates' && message.data) {
          const event = message.data as AgentUpdateEvent;
          log.info({ version: event.version, channel: event.channel }, 'Received update event');
          updateEventHandlers.forEach(h => h(event));
        }
        break;

      case 'error':
        log.error({ message: message.message }, 'Server error');
        break;
    }
  }

  function connect(): void {
    if (isShuttingDown) {
      log.debug({ ws: 'unified' }, 'Shutdown in progress, not connecting');
      return;
    }

    const config = loadConfig();

    if (!config.vaultUrl) {
      const err = new Error('Vault URL not configured');
      log.error({ ws: 'unified' }, 'Cannot connect');
      errorHandlers.forEach(h => h(err));
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
        reconnectAttempts = 0;
        startHeartbeat();
        setWebSocketStatus(true, new Date());
        setSecretWebSocketStatus(true, new Date());
        metrics.wsConnected();
        log.info({ ws: 'unified' }, 'Unified WebSocket connected');
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as UnifiedAgentEvent;
          handleMessage(message);

          // Fire connect handlers when we get registered
          if (message.type === 'registered' && registeredAgentId) {
            connectHandlers.forEach(h => h(registeredAgentId!));
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
        disconnectHandlers.forEach(h => h(reasonStr));
        scheduleReconnect();
      });

      ws.on('error', (err) => {
        log.error({ ws: 'unified', err }, 'WebSocket error');
        errorHandlers.forEach(h => h(err));
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ ws: 'unified', err: error }, 'Failed to create WebSocket');
      errorHandlers.forEach(h => h(error));
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
  }

  function updateSubscriptions(subs: { certIds?: string[]; secretIds?: string[]; updateChannel?: string }): void {
    if (ws?.readyState !== WebSocket.OPEN) {
      log.warn('Cannot update subscriptions: not connected');
      return;
    }

    const message = {
      type: 'subscribe',
      topics: [] as string[],
      certIds: subs.certIds,
      secretIds: subs.secretIds,
      channel: subs.updateChannel,
    };

    if (subs.certIds?.length) message.topics.push('certificates');
    if (subs.secretIds?.length) message.topics.push('secrets');
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
} = {}): Promise<void> {
  const config = loadConfig();
  const secretTargets = config.secretTargets || [];

  // Initialize metrics
  initializeMetrics();

  // Setup log rotation handler
  setupLogRotation();

  log.info({
    vault: config.vaultUrl,
    certTargets: config.targets.length,
    secretTargets: secretTargets.length,
  }, 'Starting ZN-Vault Agent');

  // Start health server if port specified
  if (options.healthPort) {
    try {
      await startHealthServer(options.healthPort);
    } catch (err) {
      log.error({ err }, 'Failed to start health server');
    }
  }

  // Update tracked metrics
  metrics.setCertsTracked(config.targets.length);

  // Create unified WebSocket client
  const unifiedClient = createUnifiedWebSocketClient();

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

    const target = findSecretTarget(event.secretId) || findSecretTarget(event.alias);
    if (target) {
      activeDeployments++;
      try {
        log.info({ name: target.name, event: event.event, version: event.version }, 'Processing secret event');
        const result = await deploySecret(target, true);

        if (result.success) {
          log.info({ name: target.name, version: result.version }, 'Secret deployed');
        } else {
          log.error({ name: target.name, error: result.message }, 'Secret deployment failed');
        }
      } finally {
        activeDeployments--;
      }
    } else {
      log.debug({ secretId: event.secretId, alias: event.alias }, 'Received event for untracked secret');
    }
  });

  // Handle update events
  unifiedClient.onUpdateEvent((event) => {
    log.info({ version: event.version, channel: event.channel }, 'Update available');
    // Auto-update handling is done by auto-update service
  });

  unifiedClient.onConnect((agentId) => {
    log.info({ agentId }, 'Connected to vault');
  });

  unifiedClient.onDisconnect((reason) => {
    log.warn({ reason }, 'Disconnected from vault');
  });

  unifiedClient.onError((err) => {
    log.error({ err }, 'WebSocket error');
  });

  // Start API key renewal service
  startApiKeyRenewal();

  // Connect unified WebSocket
  unifiedClient.connect();

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
    unifiedClient.disconnect();
    stopApiKeyRenewal();

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
