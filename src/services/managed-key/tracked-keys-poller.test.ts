// Path: src/services/managed-key/tracked-keys-poller.test.ts

/**
 * TrackedKeyPoller tests.
 *
 * Follow-up to the 2026-07-05 incident fix: the renewal service's polling
 * rails cover only the agent's OWN managed key. Managed keys tracked for
 * exec/plugin `api-key:` mappings previously had the WebSocket rotation event
 * as their single runtime refresh path. The TrackedKeyPoller periodically
 * binds every tracked non-own key and feeds the result through the rotation
 * propagator, whose per-key dedup makes unchanged polls no-ops.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TrackedKeyPoller } from './tracked-keys-poller.js';
import type { ManagedApiKeyBindResponse } from '../../lib/api.js';

const KEY_1 = 'plugin-key-one';
const KEY_2 = 'exec-key-two';

function makeLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeBindResponse(name: string, key: string, nextRotationAt?: string): ManagedApiKeyBindResponse {
  return {
    id: `id-${name}`,
    key,
    prefix: key.substring(0, 8),
    name,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    gracePeriod: '5m',
    rotationMode: 'scheduled',
    permissions: [],
    nextRotationAt,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('TrackedKeyPoller', () => {
  let poller: TrackedKeyPoller | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    poller?.stop();
    poller = null;
  });

  it('should poll every configured key on start and propagate the bind result', async () => {
    const bindKey = vi.fn().mockImplementation((name: string) =>
      Promise.resolve(makeBindResponse(name, `znv_${name}_value_1`))
    );
    const propagate = vi.fn().mockResolvedValue({ propagated: true, pluginsNotified: false, envVarsUpdated: [], errors: [] });

    poller = new TrackedKeyPoller({
      keyNames: [KEY_1, KEY_2],
      bindKey,
      propagate,
      fallbackIntervalMs: 60_000,
      minIntervalMs: 60_000,
      logger: makeLogger() as never,
    });
    poller.start();

    await sleep(50);

    expect(bindKey).toHaveBeenCalledWith(KEY_1);
    expect(bindKey).toHaveBeenCalledWith(KEY_2);
    expect(propagate).toHaveBeenCalledWith(
      `znv_${KEY_1}_value_1`,
      expect.objectContaining({ keyName: KEY_1, source: 'scheduled' }),
      expect.objectContaining({ detectedAt: expect.any(Number) })
    );
    expect(propagate).toHaveBeenCalledWith(
      `znv_${KEY_2}_value_1`,
      expect.objectContaining({ keyName: KEY_2 }),
      expect.anything()
    );
  });

  it('should keep polling on the schedule derived from nextRotationAt (min interval clamp)', async () => {
    const bindKey = vi.fn().mockImplementation((name: string) =>
      // nextRotationAt in the near future → clamped to minIntervalMs
      Promise.resolve(makeBindResponse(name, 'znv_same_value', new Date(Date.now() + 10).toISOString()))
    );
    const propagate = vi.fn().mockResolvedValue({ propagated: false, skipped: 'duplicate', pluginsNotified: false, envVarsUpdated: [], errors: [] });

    poller = new TrackedKeyPoller({
      keyNames: [KEY_1],
      bindKey,
      propagate,
      minIntervalMs: 20,
      fallbackIntervalMs: 20,
      logger: makeLogger() as never,
    });
    poller.start();

    await sleep(120);

    expect(bindKey.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('should fall back to the fallback interval and keep polling after a bind failure', async () => {
    const bindKey = vi.fn()
      .mockRejectedValueOnce(new Error('vault unreachable'))
      .mockResolvedValue(makeBindResponse(KEY_1, 'znv_recovered'));
    const propagate = vi.fn().mockResolvedValue({ propagated: true, pluginsNotified: false, envVarsUpdated: [], errors: [] });

    poller = new TrackedKeyPoller({
      keyNames: [KEY_1],
      bindKey,
      propagate,
      minIntervalMs: 20,
      fallbackIntervalMs: 20,
      logger: makeLogger() as never,
    });
    poller.start();

    await sleep(120);

    // First bind failed, later ones succeed and propagate.
    expect(bindKey.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(propagate).toHaveBeenCalledWith('znv_recovered', expect.anything(), expect.anything());
  });

  it('should stop polling after stop()', async () => {
    const bindKey = vi.fn().mockImplementation(() =>
      Promise.resolve(makeBindResponse(KEY_1, 'znv_value'))
    );
    const propagate = vi.fn().mockResolvedValue({ propagated: true, pluginsNotified: false, envVarsUpdated: [], errors: [] });

    poller = new TrackedKeyPoller({
      keyNames: [KEY_1],
      bindKey,
      propagate,
      minIntervalMs: 20,
      fallbackIntervalMs: 20,
      logger: makeLogger() as never,
    });
    poller.start();
    await sleep(30);
    poller.stop();
    const callsAtStop = bindKey.mock.calls.length;

    await sleep(80);
    expect(bindKey.mock.calls.length).toBe(callsAtStop);
  });

  it('should do nothing when no keys are configured', async () => {
    const bindKey = vi.fn();
    const propagate = vi.fn();

    poller = new TrackedKeyPoller({
      keyNames: [],
      bindKey,
      propagate,
      logger: makeLogger() as never,
    });
    poller.start();

    await sleep(30);
    expect(bindKey).not.toHaveBeenCalled();
  });

  it('should suppress polls during shutdown', async () => {
    const bindKey = vi.fn().mockImplementation(() =>
      Promise.resolve(makeBindResponse(KEY_1, 'znv_value'))
    );
    const propagate = vi.fn().mockResolvedValue({ propagated: true, pluginsNotified: false, envVarsUpdated: [], errors: [] });

    poller = new TrackedKeyPoller({
      keyNames: [KEY_1],
      bindKey,
      propagate,
      isShuttingDown: () => true,
      minIntervalMs: 20,
      fallbackIntervalMs: 20,
      logger: makeLogger() as never,
    });
    poller.start();

    await sleep(60);
    expect(bindKey).not.toHaveBeenCalled();
  });

  it('should survive a rejecting propagate without killing the poll loop', async () => {
    const bindKey = vi.fn().mockImplementation(() =>
      Promise.resolve(makeBindResponse(KEY_1, 'znv_value'))
    );
    const propagate = vi.fn().mockRejectedValue(new Error('unexpected'));

    poller = new TrackedKeyPoller({
      keyNames: [KEY_1],
      bindKey,
      propagate,
      minIntervalMs: 20,
      fallbackIntervalMs: 20,
      logger: makeLogger() as never,
    });
    poller.start();

    await sleep(100);
    expect(bindKey.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
