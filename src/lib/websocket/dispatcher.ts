// Path: src/lib/websocket/dispatcher.ts
// WebSocket message routing and event dispatch

import type WebSocket from 'ws';
import {
  type CertificateEvent,
  type SecretEvent,
  type AgentUpdateEvent,
  type ApiKeyRotationEvent,
  type HostConfigEvent,
  type DegradedConnectionInfo,
  type ReprovisionEvent,
  type UnifiedAgentEvent,
  type EventHandlers,
} from './types.js';
import { wsLogger as log } from '../logger.js';
import { setWebSocketStatus, setSecretWebSocketStatus } from '../health.js';
import { onWebSocketRotationEvent as notifyManagedKeyRotationEvent } from '../../services/managed-key-renewal.js';
import {
  isDynamicSecretsEnabled,
  getDynamicSecretsMetadata,
  getDynamicSecretsCapabilities,
  handleIncomingMessage as handleDynamicSecretsIncoming,
  handleVaultPublicKey,
} from '../../services/dynamic-secrets/index.js';
import { getHostname, getAgentVersion } from './connection.js';
import { getPluginLoader } from '../../plugins/loader.js';

/**
 * Message dispatcher for handling incoming WebSocket messages.
 * Routes messages to appropriate handlers based on message type.
 */
export class MessageDispatcher {
  private readonly handlers: EventHandlers = {
    certificate: [],
    secret: [],
    update: [],
    apiKeyRotation: [],
    hostConfig: [],
    degradedConnection: [],
    reprovisionAvailable: [],
    connect: [],
    disconnect: [],
    error: [],
  };

  private registeredAgentId: string | null = null;
  private readonly managedKeyNames: string[];
  private readonly onPongReceived: () => void;

  constructor(options: {
    managedKeyNames: string[];
    onPongReceived: () => void;
  }) {
    this.managedKeyNames = options.managedKeyNames;
    this.onPongReceived = options.onPongReceived;
  }

  /**
   * Handle an incoming WebSocket message.
   */
  handleMessage(ws: WebSocket | null, message: UnifiedAgentEvent): void {
    switch (message.type) {
      case 'registered': {
        this.registeredAgentId = message.agentId ?? null;
        log.info({ agentId: this.registeredAgentId }, 'Agent registered with vault');
        // Fire connect handlers when we get registered
        const agentId = this.registeredAgentId;
        if (agentId) {
          this.handlers.connect.forEach(h => { h(agentId); });
        }
        break;
      }

      case 'subscribed':
        log.info({ subscriptions: message.subscriptions }, 'Subscriptions updated');
        break;

      case 'pong':
        this.onPongReceived();
        break;

      case 'event':
        this.handleEventMessage(message);
        break;

      case 'error':
        log.error({ message: message.message }, 'Server error');
        break;

      case 'connection_established':
        this.handleConnectionEstablished(ws, message);
        break;

      case 'degraded_connection':
        this.handleDegradedConnection(message);
        break;

      case 'reprovision_available':
        this.handleReprovisionAvailable(message);
        break;

      case 'dynamic-secrets':
        if (message.dynamicSecrets) {
          log.debug({ event: message.dynamicSecrets.event }, 'Received dynamic-secrets message');
          void handleDynamicSecretsIncoming(message.dynamicSecrets);
        }
        break;
    }

    // Handle vault public key if present (sent during registration)
    if (message.vaultPublicKey) {
      handleVaultPublicKey(message.vaultPublicKey);
    }

    // Also check for reprovision events in the event topic
    if (message.type === 'event' && message.topic === 'reprovision' && message.data) {
      const event = message.data as ReprovisionEvent;
      if (event.event === 'agent.reprovision.available' && event.expiresAt) {
        const expiresAt = event.expiresAt;
        log.info({
          agentId: event.agentId,
          expiresAt,
          reason: event.reason,
        }, 'Reprovision event received');
        this.handlers.reprovisionAvailable.forEach(h => { h(expiresAt); });
      }
    }
  }

  private handleEventMessage(message: UnifiedAgentEvent): void {
    if (message.topic === 'certificates' && message.data) {
      const event = message.data as CertificateEvent;
      log.info({ event: event.event, certId: event.certificateId }, 'Received certificate event');
      setWebSocketStatus(true, new Date());
      this.handlers.certificate.forEach(h => { h(event); });
    } else if (message.topic === 'secrets' && message.data) {
      const event = message.data as SecretEvent;
      log.info({ event: event.event, secretId: event.secretId }, 'Received secret event');
      setSecretWebSocketStatus(true, new Date());
      this.handlers.secret.forEach(h => { h(event); });
    } else if (message.topic === 'updates' && message.data) {
      const event = message.data as AgentUpdateEvent;
      log.info({ version: event.version, channel: event.channel }, 'Received update event');
      this.handlers.update.forEach(h => { h(event); });
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

      this.handlers.apiKeyRotation.forEach(h => { h(event); });
    } else if (message.topic === 'hostconfig' && message.data) {
      const event = message.data as HostConfigEvent;
      log.info({
        event: event.event,
        hostname: event.hostname,
        version: event.version,
        force: event.force,
      }, 'Received host config event');
      this.handlers.hostConfig.forEach(h => { h(event); });
    }
  }

  private handleConnectionEstablished(ws: WebSocket | null, message: UnifiedAgentEvent): void {
    // Vault sends connection_established with agentId after connection setup is complete
    this.registeredAgentId = message.agentId ?? null;
    log.info({ agentId: this.registeredAgentId }, 'Connection established with server');

    // Now that connection is fully established, send registration with capabilities/publicKey/plugins
    // This must happen AFTER connection_established to ensure vault has ws.agentId set
    if (ws && ws.readyState === ws.OPEN) {
      const dynamicSecretsMetadata = getDynamicSecretsMetadata();
      const pluginLoader = getPluginLoader();
      const plugins = pluginLoader?.getPluginInfo() ?? [];

      // Always send registration if we have plugins or dynamic secrets
      if (dynamicSecretsMetadata.publicKey || isDynamicSecretsEnabled() || plugins.length > 0) {
        const registerMessage = {
          type: 'register',
          metadata: {
            hostname: getHostname(),
            version: getAgentVersion(),
            platform: process.platform,
            capabilities: ['secrets', 'certificates', ...getDynamicSecretsCapabilities()],
            publicKey: dynamicSecretsMetadata.publicKey,
            plugins: plugins.length > 0 ? plugins : undefined,
          },
        };
        ws.send(JSON.stringify(registerMessage));
        log.debug({
          hasPublicKey: !!dynamicSecretsMetadata.publicKey,
          pluginCount: plugins.length,
        }, 'Sent registration with capabilities and plugins');
      }
    }
  }

  private handleDegradedConnection(message: UnifiedAgentEvent): void {
    if (message.data) {
      const info = message.data as DegradedConnectionInfo;
      log.warn({
        reason: info.reason,
        agentId: info.agentId,
        message: info.message,
      }, 'Agent in degraded mode');
      this.handlers.degradedConnection.forEach(h => { h(info); });
    }
  }

  private handleReprovisionAvailable(message: UnifiedAgentEvent): void {
    const expiresAt = message.expiresAt;
    if (expiresAt) {
      log.info({
        expiresAt,
      }, 'Reprovision token available');
      this.handlers.reprovisionAvailable.forEach(h => { h(expiresAt); });
    }
  }

  /**
   * Get the registered agent ID.
   */
  getAgentId(): string | null {
    return this.registeredAgentId;
  }

  /**
   * Clear the registered agent ID.
   */
  clearAgentId(): void {
    this.registeredAgentId = null;
  }

  // Handler registration methods
  onCertificateEvent(handler: (event: CertificateEvent) => void): void {
    this.handlers.certificate.push(handler);
  }

  onSecretEvent(handler: (event: SecretEvent) => void): void {
    this.handlers.secret.push(handler);
  }

  onUpdateEvent(handler: (event: AgentUpdateEvent) => void): void {
    this.handlers.update.push(handler);
  }

  onApiKeyRotationEvent(handler: (event: ApiKeyRotationEvent) => void): void {
    this.handlers.apiKeyRotation.push(handler);
  }

  onHostConfigEvent(handler: (event: HostConfigEvent) => void): void {
    this.handlers.hostConfig.push(handler);
  }

  onDegradedConnection(handler: (info: DegradedConnectionInfo) => void): void {
    this.handlers.degradedConnection.push(handler);
  }

  onReprovisionAvailable(handler: (expiresAt: string) => void): void {
    this.handlers.reprovisionAvailable.push(handler);
  }

  onConnect(handler: (agentId: string) => void): void {
    this.handlers.connect.push(handler);
  }

  onDisconnect(handler: (reason: string) => void): void {
    this.handlers.disconnect.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.handlers.error.push(handler);
  }

  // Handler removal methods (for cleanup)
  offCertificateEvent(handler: (event: CertificateEvent) => void): void {
    const idx = this.handlers.certificate.indexOf(handler);
    if (idx !== -1) this.handlers.certificate.splice(idx, 1);
  }

  offSecretEvent(handler: (event: SecretEvent) => void): void {
    const idx = this.handlers.secret.indexOf(handler);
    if (idx !== -1) this.handlers.secret.splice(idx, 1);
  }

  /**
   * Remove all handlers.
   */
  removeAllHandlers(): void {
    this.handlers.certificate = [];
    this.handlers.secret = [];
    this.handlers.update = [];
    this.handlers.apiKeyRotation = [];
    this.handlers.hostConfig = [];
    this.handlers.degradedConnection = [];
    this.handlers.reprovisionAvailable = [];
    this.handlers.connect = [];
    this.handlers.disconnect = [];
    this.handlers.error = [];
  }

  /**
   * Fire disconnect handlers.
   */
  fireDisconnect(reason: string): void {
    this.handlers.disconnect.forEach(h => { h(reason); });
  }

  /**
   * Fire error handlers.
   */
  fireError(error: Error): void {
    this.handlers.error.forEach(h => { h(error); });
  }
}
