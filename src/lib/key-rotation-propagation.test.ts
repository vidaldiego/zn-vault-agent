// Path: src/lib/key-rotation-propagation.test.ts

/**
 * Key rotation propagation tests.
 *
 * Regression coverage for the 2026-07-05 incident: a managed-key rotation
 * detected by the renewal service's polling rails (scheduled / grace_poll /
 * heartbeat / reconnect) updated the agent's own credentials but was never
 * propagated to consumers — no plugin `keyRotated` dispatch, no exec env-file
 * update, and (in disk-config mode) no mutation of the live config object
 * plugins read via ctx.config. Deployed API key files stayed stale until the
 * agent was restarted, while sync logs reported success.
 *
 * The propagator is the single path both the WebSocket rotation event handler
 * and the renewal-service rails must go through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from './config.js';
import {
  createKeyRotationPropagator,
  type KeyRotationPropagatorDeps,
} from './key-rotation-propagation.js';

const KEY_A = 'znv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'znv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const KEY_C = 'znv_cccccccccccccccccccccccccccccccc';
const KEY_NAME = 'zincapi-staging';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeConfig(): AgentConfig {
  return {
    vaultUrl: 'https://vault.test',
    tenantId: 'test',
    auth: { apiKey: KEY_A },
    managedKey: { name: KEY_NAME, rotationMode: 'scheduled' },
    targets: [],
    secretTargets: [],
  } as unknown as AgentConfig;
}

interface TestContext {
  config: AgentConfig;
  dispatchEvent: ReturnType<typeof vi.fn>;
  persistManagedKey: ReturnType<typeof vi.fn>;
  updateEnvFileFn: ReturnType<typeof vi.fn>;
  restartChild: ReturnType<typeof vi.fn>;
  logger: ReturnType<typeof makeLogger>;
}

function makeDeps(overrides?: Partial<KeyRotationPropagatorDeps>): { deps: KeyRotationPropagatorDeps; ctx: TestContext } {
  const config = makeConfig();
  const dispatchEvent = vi.fn().mockResolvedValue({
    handlersInvoked: 1,
    handlersSucceeded: 1,
    handlersFailed: 0,
    handlersSkipped: 0,
  });
  const persistManagedKey = vi.fn();
  const updateEnvFileFn = vi.fn().mockReturnValue({ updated: true, added: false });
  const restartChild = vi.fn().mockResolvedValue(undefined);
  const logger = makeLogger();

  const deps: KeyRotationPropagatorDeps = {
    config,
    getPluginLoader: () => ({ dispatchEvent }),
    persistManagedKey,
    updateEnvFileFn,
    logger: logger as unknown as KeyRotationPropagatorDeps['logger'],
    ...overrides,
  };

  return { deps, ctx: { config, dispatchEvent, persistManagedKey, updateEnvFileFn, restartChild, logger } };
}

const META = {
  keyName: KEY_NAME,
  newPrefix: 'znv_bbbb',
  nextRotationAt: '2026-07-06T11:57:00.000Z',
  graceExpiresAt: '2026-07-05T15:57:00.000Z',
  rotationMode: 'scheduled' as const,
  source: 'reconnect' as const,
};

describe('createKeyRotationPropagator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should dispatch keyRotated to plugins when rotation detected via rails (the 2026-07-05 bug)', async () => {
    const { deps, ctx } = makeDeps();
    const propagator = createKeyRotationPropagator(deps);

    const result = await propagator.propagate(KEY_B, META);

    expect(result.propagated).toBe(true);
    expect(result.pluginsNotified).toBe(1);
    expect(ctx.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(ctx.dispatchEvent).toHaveBeenCalledWith('keyRotated', expect.objectContaining({
      keyName: KEY_NAME,
      newPrefix: 'znv_bbbb',
      nextRotationAt: META.nextRotationAt,
      graceExpiresAt: META.graceExpiresAt,
      rotationMode: 'scheduled',
    }));
  });

  it('should mutate the LIVE config object so plugins reading ctx.config see the new key', async () => {
    const { deps, ctx } = makeDeps();
    const propagator = createKeyRotationPropagator(deps);

    await propagator.propagate(KEY_B, META);

    // Same object identity — plugins hold a reference to config.auth
    expect(ctx.config.auth.apiKey).toBe(KEY_B);
    expect(ctx.config.managedKey?.nextRotationAt).toBe(META.nextRotationAt);
    expect(ctx.config.managedKey?.graceExpiresAt).toBe(META.graceExpiresAt);
  });

  it('should persist the key via persistManagedKey only when persist option is set', async () => {
    const { deps, ctx } = makeDeps();
    const propagator = createKeyRotationPropagator(deps);

    await propagator.propagate(KEY_B, META, { persist: true });
    expect(ctx.persistManagedKey).toHaveBeenCalledWith(KEY_B, {
      nextRotationAt: META.nextRotationAt,
      graceExpiresAt: META.graceExpiresAt,
      rotationMode: 'scheduled',
    });
  });

  it('should NOT persist when the renewal service already persisted (persist omitted)', async () => {
    const { deps, ctx } = makeDeps();
    const propagator = createKeyRotationPropagator(deps);

    await propagator.propagate(KEY_B, META);
    expect(ctx.persistManagedKey).not.toHaveBeenCalled();
  });

  it('should update exec env-file vars mapped to the rotated key', async () => {
    const { ctx, deps } = makeDeps();
    deps.execOutputFile = '/tmp/agent.env';
    deps.execSecretMappings = [
      { envVar: 'VAULT_KEY', secretId: '', apiKeyName: KEY_NAME },
      { envVar: 'OTHER', secretId: 'alias:foo' },
    ];
    const propagator = createKeyRotationPropagator(deps);

    await propagator.propagate(KEY_B, META);

    expect(ctx.updateEnvFileFn).toHaveBeenCalledTimes(1);
    expect(ctx.updateEnvFileFn).toHaveBeenCalledWith('/tmp/agent.env', 'VAULT_KEY', KEY_B);
  });

  it('should restart the child process when a restartChild hook is provided', async () => {
    const { ctx, deps } = makeDeps();
    deps.restartChild = ctx.restartChild as unknown as (reason: string) => Promise<void>;
    const propagator = createKeyRotationPropagator(deps);

    await propagator.propagate(KEY_B, META);

    expect(ctx.restartChild).toHaveBeenCalledWith(expect.stringContaining(KEY_NAME));
  });

  it('should skip duplicate propagation of the same key value (ws event + rail both fire)', async () => {
    const { deps, ctx } = makeDeps();
    const propagator = createKeyRotationPropagator(deps);

    const first = await propagator.propagate(KEY_B, META);
    const second = await propagator.propagate(KEY_B, { ...META, source: 'ws_event' });

    expect(first.propagated).toBe(true);
    expect(second.propagated).toBe(false);
    expect(second.skipped).toBe('duplicate');
    expect(ctx.dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('should not treat the startup key as already-propagated blocker for a real rotation', async () => {
    const { deps, ctx } = makeDeps();
    const propagator = createKeyRotationPropagator(deps);

    // Startup value is KEY_A (seeded); rotating to KEY_B must propagate.
    const result = await propagator.propagate(KEY_B, META);
    expect(result.propagated).toBe(true);
    expect(ctx.dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('should skip propagation when the key value has not actually changed since startup', async () => {
    const { deps, ctx } = makeDeps();
    const propagator = createKeyRotationPropagator(deps);

    // Same value the agent booted with (config.auth.apiKey === KEY_A)
    const result = await propagator.propagate(KEY_A, META);

    expect(result.propagated).toBe(false);
    expect(result.skipped).toBe('duplicate');
    expect(ctx.dispatchEvent).not.toHaveBeenCalled();
  });

  it('should retry plugin dispatch on next detection if the previous dispatch failed', async () => {
    const { deps, ctx } = makeDeps();
    ctx.dispatchEvent.mockRejectedValueOnce(new Error('plugin exploded'));
    deps.retryDelayMs = 60_000; // keep the auto-retry out of this test's way
    const propagator = createKeyRotationPropagator(deps);

    const first = await propagator.propagate(KEY_B, META);
    expect(first.propagated).toBe(true); // config was still updated
    expect(first.errors.length).toBeGreaterThan(0);

    // A later detection of the same key must NOT be deduped away,
    // because the previous propagation did not fully succeed.
    const second = await propagator.propagate(KEY_B, META);
    expect(second.propagated).toBe(true);
    expect(ctx.dispatchEvent).toHaveBeenCalledTimes(2);

    propagator.stop();
  });

  it('should retry when the loader reports a failed plugin handler', async () => {
    const { deps, ctx } = makeDeps();
    ctx.dispatchEvent
      .mockResolvedValueOnce({
        handlersInvoked: 1,
        handlersSucceeded: 0,
        handlersFailed: 1,
        handlersSkipped: 0,
      })
      .mockResolvedValueOnce({
        handlersInvoked: 1,
        handlersSucceeded: 1,
        handlersFailed: 0,
        handlersSkipped: 0,
      });
    deps.retryDelayMs = 60_000;
    const propagator = createKeyRotationPropagator(deps);

    const first = await propagator.propagate(KEY_B, META);
    expect(first.pluginsNotified).toBe(1);
    expect(first.errors).toContain('plugin dispatch failed for 1 handler(s)');

    const second = await propagator.propagate(KEY_B, META);
    expect(second.propagated).toBe(true);
    expect(second.errors).toEqual([]);
    expect(ctx.dispatchEvent).toHaveBeenCalledTimes(2);

    propagator.stop();
  });

  it('should retry when the loader skips a plugin handler', async () => {
    const { deps, ctx } = makeDeps();
    ctx.dispatchEvent
      .mockResolvedValueOnce({
        handlersInvoked: 0,
        handlersSucceeded: 0,
        handlersFailed: 0,
        handlersSkipped: 1,
      })
      .mockResolvedValueOnce({
        handlersInvoked: 1,
        handlersSucceeded: 1,
        handlersFailed: 0,
        handlersSkipped: 0,
      });
    deps.retryDelayMs = 60_000;
    const propagator = createKeyRotationPropagator(deps);

    const first = await propagator.propagate(KEY_B, META);
    expect(first.pluginsNotified).toBe(0);
    expect(first.errors).toContain('plugin dispatch skipped 1 handler(s)');

    const second = await propagator.propagate(KEY_B, META);
    expect(second.propagated).toBe(true);
    expect(second.pluginsNotified).toBe(1);
    expect(second.errors).toEqual([]);

    propagator.stop();
  });

  it('should auto-retry a partially-failed propagation (no detection channel re-fires for it)', async () => {
    const { deps, ctx } = makeDeps();
    ctx.dispatchEvent.mockRejectedValueOnce(new Error('transient plugin error'));
    deps.retryDelayMs = 20;
    const propagator = createKeyRotationPropagator(deps);

    const first = await propagator.propagate(KEY_B, META);
    expect(first.errors.length).toBeGreaterThan(0);

    // The renewal service's currentKey has already advanced, so no rail will
    // re-detect this rotation — the propagator must retry on its own.
    await sleep(120);
    expect(ctx.dispatchEvent).toHaveBeenCalledTimes(2);

    // After the successful retry, the value is recorded — no further attempts.
    const third = await propagator.propagate(KEY_B, META);
    expect(third.skipped).toBe('duplicate');

    propagator.stop();
  });

  it('should serialize concurrent propagations of the same rotation into one dispatch', async () => {
    const { deps, ctx } = makeDeps();
    const propagator = createKeyRotationPropagator(deps);

    // Both detection channels fire near-simultaneously for the same rotation
    // (dispatcher notifies the renewal service AND runs the WS handler).
    const [first, second] = await Promise.all([
      propagator.propagate(KEY_B, META),
      propagator.propagate(KEY_B, { ...META, source: 'ws_event' }),
    ]);

    expect(ctx.dispatchEvent).toHaveBeenCalledTimes(1);
    const skipped = [first, second].filter((r) => r.skipped === 'duplicate');
    expect(skipped).toHaveLength(1);
  });

  it('should keep duplicate suppression independent per key name', async () => {
    const { deps, ctx } = makeDeps();
    const propagator = createKeyRotationPropagator(deps);

    await propagator.propagate(KEY_B, META);
    await propagator.propagate(KEY_C, { ...META, keyName: 'other-plugin-key' });

    // A repeat for the FIRST key must still be recognized as a duplicate even
    // though another key propagated in between (regression: single scalar slot).
    const repeat = await propagator.propagate(KEY_B, META);
    expect(repeat.skipped).toBe('duplicate');
    expect(ctx.dispatchEvent).toHaveBeenCalledTimes(2);
  });

  it('should discard a stale detection so an old bind response cannot revert a newer key', async () => {
    const { deps, ctx } = makeDeps();
    const propagator = createKeyRotationPropagator(deps);

    await propagator.propagate(KEY_C, META, { detectedAt: 2000 });
    const stale = await propagator.propagate(KEY_B, META, { detectedAt: 1000 });

    expect(stale.skipped).toBe('stale');
    expect(ctx.config.auth.apiKey).toBe(KEY_C);
    expect(ctx.dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('should skip propagation entirely during shutdown', async () => {
    const { deps, ctx } = makeDeps({ isShuttingDown: () => true });
    const propagator = createKeyRotationPropagator(deps);

    const result = await propagator.propagate(KEY_B, META);

    expect(result.propagated).toBe(false);
    expect(result.skipped).toBe('shutting_down');
    expect(ctx.dispatchEvent).not.toHaveBeenCalled();
    expect(ctx.config.auth.apiKey).toBe(KEY_A);
  });

  it('should log rotation pickup without any credential-derived fragment', async () => {
    const { deps, ctx } = makeDeps();
    const propagator = createKeyRotationPropagator(deps);

    await propagator.propagate(KEY_B, META);

    const infoCalls = ctx.logger.info.mock.calls;
    const pickupCall = infoCalls.find(([, msg]) => typeof msg === 'string' && msg.includes('propagated'));
    expect(pickupCall).toBeDefined();
    expect(pickupCall?.[0]).toMatchObject({
      keyName: KEY_NAME,
      source: 'reconnect',
    });
    const serializedLogs = JSON.stringify(infoCalls);
    expect(serializedLogs).not.toContain(KEY_A);
    expect(serializedLogs).not.toContain(KEY_B);
    expect(serializedLogs).not.toContain(KEY_A.substring(0, 8));
    expect(serializedLogs).not.toContain(KEY_B.substring(0, 8));
    expect(serializedLogs).not.toContain(META.newPrefix);
  });

  it('should work without a plugin loader (no plugins configured)', async () => {
    const { deps } = makeDeps({ getPluginLoader: () => null });
    const propagator = createKeyRotationPropagator(deps);

    const result = await propagator.propagate(KEY_B, META);
    expect(result.propagated).toBe(true);
    expect(result.pluginsNotified).toBe(0);
  });

  it('should not update managedKey metadata for a different key than the agent`s own', async () => {
    const { deps, ctx } = makeDeps();
    const propagator = createKeyRotationPropagator(deps);

    await propagator.propagate(KEY_B, { ...META, keyName: 'some-other-key' });

    // Plugin dispatch still happens (plugins may consume other keys)...
    expect(ctx.dispatchEvent).toHaveBeenCalled();
    // ...but the agent's own auth/managedKey metadata must be untouched.
    expect(ctx.config.auth.apiKey).toBe(KEY_A);
    expect(ctx.config.managedKey?.nextRotationAt).toBeUndefined();
  });
});
