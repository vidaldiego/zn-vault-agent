// Path: src/lib/websocket/dispatcher.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageDispatcher } from './dispatcher.js';
import type { AgentUpdateEvent, ApiKeyRotationEvent, UnifiedAgentEvent } from './types.js';

// Mocks: the dispatcher pulls in agent infrastructure (logger, health, plugins,
// managed-key-renewal, dynamic-secrets) that we don't want to exercise here.
vi.mock('../logger.js', () => ({
  wsLogger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../health.js', () => ({
  setWebSocketStatus: vi.fn(),
  setSecretWebSocketStatus: vi.fn(),
}));
vi.mock('../../services/managed-key-renewal.js', () => ({
  onWebSocketRotationEvent: vi.fn(),
}));
vi.mock('../../services/dynamic-secrets/index.js', () => ({
  isDynamicSecretsEnabled: () => false,
  getDynamicSecretsMetadata: () => ({ publicKey: undefined }),
  getDynamicSecretsCapabilities: () => [],
  handleIncomingMessage: vi.fn(),
  handleVaultPublicKey: vi.fn(),
}));
vi.mock('./connection.js', () => ({
  getHostname: () => 'test-host',
  getAgentVersion: () => 'test',
}));
vi.mock('../../plugins/loader.js', () => ({
  getPluginLoader: () => null,
}));

function makeApiKeyMessage(deliveryId: string | undefined): UnifiedAgentEvent {
  const event: ApiKeyRotationEvent & { deliveryId?: string } = {
    event: 'apikey.rotated',
    apiKeyId: 'k-1',
    apiKeyName: 'test-key',
    tenantId: 't-1',
    newPrefix: 'znv_test',
    graceExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    rotationMode: 'scheduled',
    rotationCount: 1,
    reason: 'scheduled',
    timestamp: new Date().toISOString(),
    deliveryId,
  };
  return {
    type: 'event',
    topic: 'apikeys',
    data: event,
  };
}

describe('MessageDispatcher apikey deliveryId dedup', () => {
  let dispatcher: MessageDispatcher;
  let handlerCalls: ApiKeyRotationEvent[];

  beforeEach(() => {
    dispatcher = new MessageDispatcher({
      managedKeyNames: ['test-key'],
      onPongReceived: () => {},
    });
    handlerCalls = [];
    dispatcher.onApiKeyRotationEvent((event) => {
      handlerCalls.push(event);
    });
  });

  afterEach(() => {
    dispatcher.resetDedupForTesting();
  });

  it('runs the apikey handler exactly once for a given deliveryId across rapid duplicates', () => {
    const message = makeApiKeyMessage('apikeys-apikey.rotated-123-abc');

    // Simulate the same broadcast arriving 5 times back-to-back, as observed
    // during the 2026-05-03 incident.
    for (let i = 0; i < 5; i++) {
      dispatcher.handleMessage(null, message);
    }

    expect(handlerCalls).toHaveLength(1);
  });

  it('runs the handler for distinct deliveryIds even when other fields match', () => {
    dispatcher.handleMessage(null, makeApiKeyMessage('id-1'));
    dispatcher.handleMessage(null, makeApiKeyMessage('id-2'));
    dispatcher.handleMessage(null, makeApiKeyMessage('id-1')); // duplicate of first
    dispatcher.handleMessage(null, makeApiKeyMessage('id-3'));

    expect(handlerCalls).toHaveLength(3);
  });

  it('falls back to no-dedup behaviour when the server omits deliveryId', () => {
    // Older server versions or tests may not include a deliveryId — we must
    // not silently swallow such events.
    const message = makeApiKeyMessage(undefined);

    dispatcher.handleMessage(null, message);
    dispatcher.handleMessage(null, message);

    expect(handlerCalls).toHaveLength(2);
  });
});

describe('MessageDispatcher update-available', () => {
  let dispatcher: MessageDispatcher;
  let updateCalls: AgentUpdateEvent[];

  beforeEach(() => {
    dispatcher = new MessageDispatcher({
      managedKeyNames: [],
      onPongReceived: () => {},
    });
    updateCalls = [];
    dispatcher.onUpdateEvent((event) => {
      updateCalls.push(event);
    });
  });

  it('dispatches a top-level update-available message to update handlers with version/channel/force', () => {
    // The vault server sends update triggers as a TOP-LEVEL message
    // ({type:'update-available', version, channel, force, timestamp}),
    // NOT wrapped under {type:'event', topic:'updates', data}.
    const message: UnifiedAgentEvent = {
      type: 'update-available',
      version: '1.2.3',
      channel: 'stable',
      force: true,
    };

    dispatcher.handleMessage(null, message);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].event).toBe('update.available');
    expect(updateCalls[0].version).toBe('1.2.3');
    expect(updateCalls[0].channel).toBe('stable');
    expect(updateCalls[0].force).toBe(true);
  });

  it('still dispatches the legacy topic:updates event path for back-compat', () => {
    const event: AgentUpdateEvent = {
      event: 'update.available',
      channel: 'beta',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
    };
    const message: UnifiedAgentEvent = {
      type: 'event',
      topic: 'updates',
      data: event,
    };

    dispatcher.handleMessage(null, message);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].version).toBe('2.0.0');
    expect(updateCalls[0].channel).toBe('beta');
  });
});
