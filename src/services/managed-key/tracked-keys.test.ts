// Path: src/services/managed-key/tracked-keys.test.ts

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TrackedKeySynchronizer } from './tracked-keys.js';
import type { ManagedApiKeyBindResponse } from '../../lib/api.js';
import { createKeyRotationPropagator } from '../../lib/key-rotation-propagation.js';
import type { AgentConfig } from '../../lib/config.js';

const KEY_1 = 'plugin-key-one';
const KEY_2 = 'exec-key-two';

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

function observerFor(
  bindKey: (name: string) => Promise<ManagedApiKeyBindResponse>,
  writeConsumer: (path: string, name: string, value: string) => { updated: boolean; added: boolean }
) {
  const propagator = createKeyRotationPropagator({
    config: { vaultUrl: 'https://vault.test', auth: {}, targets: [], secretTargets: [] } as AgentConfig,
    bindManagedKey: bindKey, getPluginLoader: () => null,
    execOutputFile: '/synthetic/env',
    execSecretMappings: [KEY_1, KEY_2].map(apiKeyName => ({ envVar: apiKeyName, secretId: '', apiKeyName })),
    updateEnvFileFn: writeConsumer,
  });
  return (name: string, isCancelled: () => boolean) => propagator.bindAndPropagate(name, 'manual', { isCancelled });
}

describe('TrackedKeySynchronizer', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('synchronizes each unique tracked key initially and never repeats from elapsed time', async () => {
    vi.useFakeTimers();
    const bindKey = vi.fn(async (name: string) => makeBindResponse(name, 'synthetic-key', new Date(Date.now() + 120_000).toISOString()));
    const writeConsumer = vi.fn().mockReturnValue({ updated: true, added: false });
    const keys = new TrackedKeySynchronizer({ keyNames: [KEY_1, KEY_1, KEY_2], observeKey: observerFor(bindKey, writeConsumer) });
    await keys.synchronize();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(bindKey.mock.calls.map(([name]) => name)).toEqual([KEY_1, KEY_2]);
    expect(writeConsumer).toHaveBeenCalledWith('/synthetic/env', KEY_1, 'synthetic-key');
    await keys.synchronize();
    expect(bindKey).toHaveBeenCalledTimes(4);
  });

  it('keeps a failed bind visible without scheduled retries and permits explicit recovery', async () => {
    vi.useFakeTimers();
    const bindKey = vi.fn().mockRejectedValueOnce(new Error('synthetic outage')).mockResolvedValue(makeBindResponse(KEY_1, 'synthetic-key'));
    const writeConsumer = vi.fn().mockReturnValue({ updated: true, added: false });
    const keys = new TrackedKeySynchronizer({ keyNames: [KEY_1], observeKey: observerFor(bindKey, writeConsumer) });
    await expect(keys.synchronize()).rejects.toThrow('incomplete');
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(bindKey).toHaveBeenCalledTimes(1);
    await keys.synchronize();
    expect(writeConsumer).toHaveBeenCalledOnce();
  });

  it('suppresses consumer updates if shutdown begins while a bind is running', async () => {
    let resolve!: (value: ManagedApiKeyBindResponse) => void;
    const bindKey = () => new Promise<ManagedApiKeyBindResponse>(done => { resolve = done; });
    const writeConsumer = vi.fn();
    const keys = new TrackedKeySynchronizer({ keyNames: [KEY_1], observeKey: observerFor(bindKey, writeConsumer) });
    const task = keys.synchronize();
    keys.stop();
    resolve(makeBindResponse(KEY_1, 'synthetic-key'));
    await expect(task).rejects.toThrow('incomplete');
    expect(writeConsumer).not.toHaveBeenCalled();
  });

  it.each(['own', 'secondary'])('rejects a delayed old %s bind after a newer push and preserves its pending retry', async kind => {
    vi.useFakeTimers();
    const name = kind === 'own' ? 'agent-auth' : 'secondary-consumer';
    let completeOld!: (response: ManagedApiKeyBindResponse) => void;
    const oldResponse = new Promise<ManagedApiKeyBindResponse>(resolve => { completeOld = resolve; });
    const bindKey = vi.fn().mockImplementationOnce(async () => oldResponse).mockResolvedValue(makeBindResponse(name, 'new-key'));
    const config = {
      vaultUrl: 'https://vault.test', auth: { apiKey: 'initial-auth' },
      managedKey: { name: 'agent-auth' }, targets: [], secretTargets: [],
    } as AgentConfig;
    let persistedAuth = 'initial-auth';
    const persistedWrites: string[] = [];
    const consumerWrites: string[] = [];
    let consumerKey = 'initial-consumer';
    const dispatchEvent = vi.fn()
      .mockResolvedValueOnce({ handlersInvoked: 1, handlersSucceeded: 0, handlersFailed: 1, handlersSkipped: 0 })
      .mockResolvedValue({ handlersInvoked: 1, handlersSucceeded: 1, handlersFailed: 0, handlersSkipped: 0 });
    const propagator = createKeyRotationPropagator({
      config, bindManagedKey: bindKey, getPluginLoader: () => ({ dispatchEvent }), retryDelayMs: 1_000,
      execOutputFile: '/synthetic/env', execSecretMappings: [{ envVar: 'CONSUMER_KEY', secretId: '', apiKeyName: name }],
      persistManagedKey: value => { persistedAuth = value; persistedWrites.push(value); },
      updateEnvFileFn: (_path, _name, value) => { consumerKey = value; consumerWrites.push(value); return { updated: true, added: false }; },
    });
    const keys = new TrackedKeySynchronizer({ keyNames: [name], observeKey: (keyName, isCancelled) => propagator.bindAndPropagate(keyName, 'manual', { persist: true, isCancelled }) });
    const synchronization = keys.synchronize();
    await Promise.resolve();
    await propagator.bindAndPropagate(name, 'ws_event', { persist: true });
    await vi.advanceTimersByTimeAsync(1);
    completeOld(makeBindResponse(name, 'old-key'));
    await synchronization.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(consumerKey).toBe('new-key');
    expect(consumerWrites).not.toContain('old-key');
    expect(persistedWrites).not.toContain('old-key');
    expect(config.auth.apiKey).toBe(kind === 'own' ? 'new-key' : 'initial-auth');
    expect(persistedAuth).toBe(kind === 'own' ? 'new-key' : 'initial-auth');
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    propagator.stop();
  });
});
