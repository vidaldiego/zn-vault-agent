// Path: zn-vault-agent/src/services/dynamic-secrets/websocket-integration.ts
// WebSocket integration for dynamic secrets

import WebSocket from 'ws';
import { createLogger } from '../../lib/logger.js';
import {
  handleDynamicSecretsMessage,
  setVaultPublicKey,
} from './handler.js';
import { getPublicKey, initializeKeyPair } from './keypair.js';
import { closeAllClients, clearAllConfigs } from './index.js';
import type { DynamicSecretsServerMessage, DynamicSecretsAgentMessage } from './types.js';

const log = createLogger({ module: 'dynamic-secrets-ws' });

// ============================================================================
// State
// ============================================================================

let currentWs: WebSocket | null = null;
let isInitialized = false;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize dynamic secrets service
 * Call this on agent startup before connecting WebSocket
 */
export function initializeDynamicSecrets(): void {
  if (isInitialized) return;

  // Initialize RSA keypair
  initializeKeyPair();
  isInitialized = true;

  log.info('Dynamic secrets service initialized');
}

/**
 * Get the agent's public key for registration
 */
export function getAgentPublicKey(): string {
  if (!isInitialized) {
    initializeDynamicSecrets();
  }
  return getPublicKey();
}

/**
 * Check if dynamic secrets is enabled
 * Returns true by default - can be disabled with ZNVAULT_AGENT_DYNAMIC_SECRETS=false
 */
export function isDynamicSecretsEnabled(): boolean {
  // Enabled by default, can be explicitly disabled
  const envValue = process.env.ZNVAULT_AGENT_DYNAMIC_SECRETS;
  if (envValue === 'false' || envValue === '0') {
    return false;
  }
  return true;
}

// ============================================================================
// WebSocket Integration
// ============================================================================

/**
 * Set the current WebSocket connection for sending responses
 */
export function setWebSocket(ws: WebSocket | null): void {
  currentWs = ws;

  if (ws) {
    log.debug('WebSocket set for dynamic secrets');
  }
}

/**
 * Send a dynamic secrets message to the vault
 */
function sendMessage(message: DynamicSecretsAgentMessage): void {
  if (currentWs?.readyState !== WebSocket.OPEN) {
    log.warn({ event: message.event }, 'Cannot send message - WebSocket not connected');
    return;
  }

  const wrappedMessage = {
    type: 'dynamic-secrets',
    dynamicSecrets: message,
    timestamp: new Date().toISOString(),
  };

  currentWs.send(JSON.stringify(wrappedMessage));
  log.debug({ event: message.event }, 'Sent dynamic secrets message');
}

/**
 * Handle an incoming dynamic secrets message from vault
 */
export async function handleIncomingMessage(message: DynamicSecretsServerMessage): Promise<void> {
  if (!isInitialized) {
    log.warn('Dynamic secrets not initialized, ignoring message');
    return;
  }

  await handleDynamicSecretsMessage(message, sendMessage);
}

/**
 * Handle vault public key received during connection
 */
export function handleVaultPublicKey(publicKey: string): void {
  setVaultPublicKey(publicKey);
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Cleanup dynamic secrets resources
 * Call this on agent shutdown
 */
export async function cleanupDynamicSecrets(): Promise<void> {
  log.info('Cleaning up dynamic secrets');

  // Close all database clients
  await closeAllClients();

  // Clear config store
  clearAllConfigs();

  currentWs = null;
}

// ============================================================================
// Exports for WebSocket Client
// ============================================================================

/**
 * Get capabilities to advertise to vault
 */
export function getDynamicSecretsCapabilities(): string[] {
  if (!isDynamicSecretsEnabled()) {
    return [];
  }

  return ['dynamic-secrets'];
}

/**
 * Get metadata to send during registration
 */
export function getDynamicSecretsMetadata(): { publicKey?: string } {
  if (!isDynamicSecretsEnabled()) {
    return {};
  }

  if (!isInitialized) {
    initializeDynamicSecrets();
  }

  return {
    publicKey: getPublicKey(),
  };
}
