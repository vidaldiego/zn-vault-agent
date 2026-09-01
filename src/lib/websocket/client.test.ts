// Path: src/lib/websocket/client.test.ts

/**
 * Unified WebSocket client reconnect behaviour tests.
 *
 * Regression coverage for INC-2026-06-12-01: a socket that opens at TCP/TLS
 * level but is closed by the server with 4001 (Unauthorized) must NOT be
 * treated as a successful connection. Previously the open handler reset the
 * attempt counter, producing a tight connect->4001->reconnect loop that
 * hammered the vault for hours and perpetually refreshed an IP quarantine.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Fake WebSocket (hoisted so the vi.mock factory can reference it)
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    readyState = 0;
    sent: string[] = [];
    private readonly listeners: Record<string, Listener[]> = {};

    constructor(public url: string, public opts: unknown) {
      state.instances.push(this);
    }

    on(event: string, fn: Listener): void {
      (this.listeners[event] ??= []).push(fn);
    }

    once(event: string, fn: Listener): void {
      const onceListener: Listener = (...args) => {
        this.off(event, onceListener);
        fn(...args);
      };
      this.on(event, onceListener);
    }

    off(event: string, fn: Listener): void {
      const arr = this.listeners[event];
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      if (this.readyState === FakeWebSocket.CONNECTING) {
        this.readyState = FakeWebSocket.CLOSING;
        queueMicrotask(() => {
          this.emit('error', new Error('WebSocket was closed before the connection was established'));
          this.readyState = FakeWebSocket.CLOSED;
          this.emit('close', 1006, Buffer.alloc(0));
        });
        return;
      }
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close', 1000, Buffer.alloc(0));
    }

    terminate(): void {
      this.readyState = FakeWebSocket.CLOSED;
    }

    emit(event: string, ...args: unknown[]): void {
      const listeners = (this.listeners[event] ?? []).slice();
      if (event === 'error' && listeners.length === 0) {
        throw args[0] instanceof Error ? args[0] : new Error(String(args[0]));
      }
      listeners.forEach((fn) => { fn(...args); });
    }

    // -- test helpers --------------------------------------------------------

    /** Simulate a successful TCP/TLS + WS handshake. */
    simulateOpen(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    }

    /** Simulate the server closing the connection with a close code. */
    simulateServerClose(code: number): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close', code, Buffer.alloc(0));
    }

    /** Simulate an incoming JSON message from the server. */
    simulateMessage(message: unknown): void {
      this.emit('message', JSON.stringify(message));
    }
  }

  const state = { instances: [] as InstanceType<typeof FakeWebSocket>[] };

  return { FakeWebSocket, state };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('ws', () => ({ default: hoisted.FakeWebSocket }));

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    vaultUrl: 'https://vault.test',
    tenantId: 'test',
    insecure: true,
    auth: { apiKey: 'znv_test_key' },
    targets: [],
    secretTargets: [],
  })),
}));

vi.mock('./connection.js', () => ({
  buildWebSocketUrl: () => 'wss://vault.test/v1/ws/agent',
  maskSensitiveUrl: (url: string) => url,
  getHostname: () => 'test-host',
  getAgentVersion: () => '0.0.0-test',
}));

vi.mock('../logger.js', () => ({
  wsLogger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../metrics.js', () => ({
  metrics: {
    wsReconnect: vi.fn(),
    wsConnected: vi.fn(),
    wsDisconnected: vi.fn(),
  },
}));

vi.mock('../health.js', () => ({
  setWebSocketStatus: vi.fn(),
  setSecretWebSocketStatus: vi.fn(),
}));

vi.mock('../../services/managed-key-renewal.js', () => ({
  onWebSocketReconnect: vi.fn(async () => undefined),
  onWebSocketAuthFailure: vi.fn(async () => false),
  onWebSocketRotationEvent: vi.fn(async () => undefined),
}));

vi.mock('../../services/dynamic-secrets/index.js', () => ({
  setWebSocket: vi.fn(),
  isDynamicSecretsEnabled: () => false,
  getDynamicSecretsMetadata: () => ({ publicKey: undefined }),
  getDynamicSecretsCapabilities: () => [],
  handleIncomingMessage: vi.fn(),
  handleVaultPublicKey: vi.fn(),
}));

vi.mock('../../plugins/loader.js', () => ({
  getPluginLoader: () => null,
}));

// Heartbeat is irrelevant to these tests and its 15s ping interval would
// otherwise fire while we advance fake timers past 30s.
vi.mock('./heartbeat.js', () => ({
  HeartbeatManager: class {
    start(): void { /* no-op */ }
    stop(): void { /* no-op */ }
    onPongReceived(): void { /* no-op */ }
  },
}));

import { createUnifiedWebSocketClient, setShuttingDown } from './client.js';
import { onWebSocketAuthFailure } from '../../services/managed-key-renewal.js';
import { WS_CONSTANTS } from './types.js';
import { setSecretWebSocketStatus, setWebSocketStatus } from '../health.js';
import { metrics } from '../metrics.js';
import { wsLogger } from '../logger.js';

const { state } = hoisted;

function lastSocket(): InstanceType<typeof hoisted.FakeWebSocket> {
  const ws = state.instances[state.instances.length - 1];
  if (!ws) throw new Error('No WebSocket instance created');
  return ws;
}

/**
 * Assert that the next reconnect happens after exactly `delay` ms
 * (jitter is mocked to 0): no new socket before, a new socket at the mark.
 */
async function expectReconnectAfter(delay: number): Promise<void> {
  const before = state.instances.length;
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(state.instances.length).toBe(before);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.instances.length).toBe(before + 1);
}

describe('Unified WebSocket client reconnect behaviour', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0); // deterministic delays
    state.instances.length = 0;
    setShuttingDown(false);
    vi.mocked(onWebSocketAuthFailure).mockClear();
    vi.mocked(onWebSocketAuthFailure).mockResolvedValue(false);
  });

  afterEach(() => {
    setShuttingDown(true); // stop any pending reconnect loops
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('test_should_not_reset_attempts_when_close_code_is_4001', async () => {
    const client = createUnifiedWebSocketClient([], []);
    client.connect();
    expect(state.instances.length).toBe(1);

    // Cycle 1: open then immediate 4001 -> attempt 1 -> 500ms delay
    lastSocket().simulateOpen();
    lastSocket().simulateServerClose(4001);
    await expectReconnectAfter(500);

    // Cycle 2: the socket OPENED in between, but that must not reset the
    // counter: delay must now be 1000ms, not 500ms again.
    lastSocket().simulateOpen();
    lastSocket().simulateServerClose(4001);
    await expectReconnectAfter(1000);

    // Cycle 3: continues growing (2000ms)
    lastSocket().simulateOpen();
    lastSocket().simulateServerClose(4001);
    await expectReconnectAfter(2000);

    client.disconnect();
  });

  it('test_should_publish_connected_health_only_after_server_ack', () => {
    const client = createUnifiedWebSocketClient([], []);
    client.connect();

    lastSocket().simulateOpen();
    expect(setWebSocketStatus).toHaveBeenLastCalledWith(false);
    expect(setSecretWebSocketStatus).toHaveBeenLastCalledWith(false);
    expect(metrics.wsConnected).not.toHaveBeenCalled();

    lastSocket().simulateMessage({
      type: 'connection_established',
      agentId: 'agent-ack',
    });
    expect(setWebSocketStatus).toHaveBeenLastCalledWith(true, expect.any(Date));
    expect(setSecretWebSocketStatus).toHaveBeenLastCalledWith(true, expect.any(Date));
    expect(metrics.wsConnected).toHaveBeenCalledOnce();

    client.disconnect();
  });

  it('does not log malformed message content or credential fragments', () => {
    const client = createUnifiedWebSocketClient([], []);
    const canary = 'registration-token-canary-DO-NOT-LOG';
    client.connect();

    lastSocket().emit('message', `{"token":"${canary}",`);

    const serializedWarnings = JSON.stringify(vi.mocked(wsLogger.warn).mock.calls);
    expect(serializedWarnings).not.toContain(canary);
    expect(serializedWarnings).not.toContain(canary.substring(0, 8));
    expect(wsLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
      ws: 'unified',
      errorType: 'SyntaxError',
      messageBytes: expect.any(Number),
    }), 'Failed to parse message');

    client.disconnect();
  });

  it('test_should_grow_delay_beyond_normal_cap_when_4001_repeats', async () => {
    const client = createUnifiedWebSocketClient([], []);
    client.connect();

    // Enough cycles that 500 * 2^n exceeds the auth cap (n >= 10).
    for (let i = 0; i < 11; i++) {
      lastSocket().simulateOpen();
      lastSocket().simulateServerClose(4001);
      await vi.advanceTimersByTimeAsync(WS_CONSTANTS.MAX_AUTH_RECONNECT_DELAY);
    }

    // Next cycle must use the auth-failure cap (5 min), which is well above
    // the normal 30s cap.
    lastSocket().simulateOpen();
    lastSocket().simulateServerClose(4001);
    await expectReconnectAfter(WS_CONSTANTS.MAX_AUTH_RECONNECT_DELAY);

    client.disconnect();
  });

  it('test_should_reset_attempts_when_connection_proves_healthy', async () => {
    const client = createUnifiedWebSocketClient([], []);
    client.connect();

    // Build up backoff with three auth failures (next delay would be 4000ms)
    for (const delay of [500, 1000, 2000]) {
      lastSocket().simulateOpen();
      lastSocket().simulateServerClose(4001);
      await expectReconnectAfter(delay);
    }

    // Healthy connection: open + server ack + survives the 30s threshold
    lastSocket().simulateOpen();
    lastSocket().simulateMessage({ type: 'registered', agentId: 'agent-1' });
    await vi.advanceTimersByTimeAsync(WS_CONSTANTS.HEALTHY_CONNECTION_THRESHOLD);

    // A subsequent (non-auth) drop now reconnects quickly again: counter reset
    lastSocket().simulateServerClose(1006);
    await expectReconnectAfter(500);

    client.disconnect();
  });

  it('test_should_not_reset_attempts_when_ack_received_but_threshold_not_elapsed', async () => {
    const client = createUnifiedWebSocketClient([], []);
    client.connect();

    // Two auth failures -> attempts = 2
    lastSocket().simulateOpen();
    lastSocket().simulateServerClose(4001);
    await expectReconnectAfter(500);
    lastSocket().simulateOpen();
    lastSocket().simulateServerClose(4001);
    await expectReconnectAfter(1000);

    // Server ack arrives but connection dies before the 30s threshold
    lastSocket().simulateOpen();
    lastSocket().simulateMessage({ type: 'registered', agentId: 'agent-1' });
    await vi.advanceTimersByTimeAsync(5000);
    lastSocket().simulateServerClose(4001);

    // Counter kept growing: third failure -> 2000ms, NOT back to 500ms
    // (the 5000ms already elapsed are unrelated; the reconnect timer starts
    // at close time)
    await expectReconnectAfter(2000);

    client.disconnect();
  });

  it('test_should_use_auth_backoff_when_managed_key_recovery_fails', async () => {
    vi.mocked(onWebSocketAuthFailure).mockResolvedValue(false);

    const client = createUnifiedWebSocketClient([], ['my-managed-key']);
    client.connect();

    lastSocket().simulateOpen();
    lastSocket().simulateServerClose(4001);
    // Flush the async recovery path before timing assertions
    await vi.advanceTimersByTimeAsync(0);
    expect(onWebSocketAuthFailure).toHaveBeenCalledTimes(1);
    await expectReconnectAfter(500);

    lastSocket().simulateOpen();
    lastSocket().simulateServerClose(4001);
    await vi.advanceTimersByTimeAsync(0);
    // Recovery failed again -> backoff keeps growing
    await expectReconnectAfter(1000);

    client.disconnect();
  });

  it('test_should_reset_attempts_when_managed_key_recovery_succeeds', async () => {
    const client = createUnifiedWebSocketClient([], ['my-managed-key']);
    client.connect();

    // Grow the counter with two failed recoveries
    vi.mocked(onWebSocketAuthFailure).mockResolvedValue(false);
    lastSocket().simulateOpen();
    lastSocket().simulateServerClose(4001);
    await vi.advanceTimersByTimeAsync(0);
    await expectReconnectAfter(500);
    lastSocket().simulateOpen();
    lastSocket().simulateServerClose(4001);
    await vi.advanceTimersByTimeAsync(0);
    await expectReconnectAfter(1000);

    // Now recovery succeeds (fresh key bound via authenticated API call):
    // a quick retry is justified, so the counter resets.
    vi.mocked(onWebSocketAuthFailure).mockResolvedValue(true);
    lastSocket().simulateOpen();
    lastSocket().simulateServerClose(4001);
    await vi.advanceTimersByTimeAsync(0);
    await expectReconnectAfter(500);

    client.disconnect();
  });

  it('test_should_use_auth_backoff_for_other_4xxx_auth_family_close_codes', async () => {
    const client = createUnifiedWebSocketClient([], []);
    client.connect();

    lastSocket().simulateOpen();
    lastSocket().simulateServerClose(4003);
    await expectReconnectAfter(500);

    lastSocket().simulateOpen();
    lastSocket().simulateServerClose(4003);
    await expectReconnectAfter(1000);

    client.disconnect();
  });

  it('safely disconnects while connecting and permits one explicit reconnect', async () => {
    const client = createUnifiedWebSocketClient([], []);
    const errorHandler = vi.fn();
    client.onError(errorHandler);

    client.connect();
    const connectingSocket = lastSocket();
    expect(connectingSocket.readyState).toBe(hoisted.FakeWebSocket.CONNECTING);

    expect(() => client.disconnect()).not.toThrow();
    client.connect();
    expect(state.instances).toHaveLength(2);

    // `ws` emits the local CONNECTING-abort error asynchronously. It must use
    // the normal error channel, while the retired socket's close must not
    // schedule a third connection or disturb the replacement.
    await vi.advanceTimersByTimeAsync(0);
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler).toHaveBeenCalledWith(expect.any(Error));
    expect(state.instances).toHaveLength(2);
    expect(lastSocket().readyState).toBe(hoisted.FakeWebSocket.CONNECTING);

    client.disconnect();
    await vi.advanceTimersByTimeAsync(0);
  });
});
