import { describe, expect, it, vi } from 'vitest';
import { InitialChildStartBarrier } from './websocket.js';
import { createKeyRotationPropagator, prepareKeyObservation } from './key-rotation-propagation.js';
import { TrackedKeySynchronizer } from '../services/managed-key/tracked-keys.js';
import type { AgentConfig } from './config.js';

describe('initial key preparation and child acknowledgement', () => {
  it('accepts a successful recovery restart receipt after the original initial child failed', async () => {
    const barrier = new InitialChildStartBarrier();
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve; });
    let recoveryRestarts = 0;
    const propagator = createKeyRotationPropagator({
      config: { vaultUrl: 'https://vault.test', auth: { apiKey: 'old-key' }, managedKey: { name: 'agent-auth' }, targets: [] } as AgentConfig,
      getPluginLoader: () => null, persistManagedKey: vi.fn(),
      bindManagedKey: async name => ({ id: 'synthetic', name, key: 'new-key', prefix: '[REDACTED]', expiresAt: '2030-01-01T00:00:00.000Z', gracePeriod: '5m', permissions: [], rotationMode: 'scheduled' }),
      prepareChildRestart: async () => {
        const receipt = barrier.initialStartReceiptIfUnadmitted();
        if (receipt) return { consumerReady: receipt };
        await barrier.beforeRestart();
        recoveryRestarts++;
        await recoveryGate;
      },
    });
    try {
      const initial = prepareKeyObservation(onStaged => propagator.bindAndPropagate('agent-auth', 'scheduled', { persist: true, onStaged }));
      await initial.prepared;
      barrier.open();
      barrier.fail(new Error('first child start failed'));
      expect((await initial.completed).propagation.errors).toHaveLength(1);
      let recovered = false;
      const recovery = propagator.bindAndPropagate('agent-auth', 'manual', { persist: true }).then(result => { recovered = true; return result; });
      for (let step = 0; step < 30; step++) await Promise.resolve();
      expect(recoveryRestarts).toBe(1);
      expect(recovered).toBe(false);
      releaseRecovery();
      expect((await recovery).propagation.errors).toEqual([]);
      expect(recovered).toBe(true);
    } finally { releaseRecovery(); propagator.stop(); }
  });

  it.each(['own', 'secondary', 'secondary-with-early-push'])('starts with the latest %s key before acknowledging propagation', async mode => {
    const name = mode === 'own' ? 'agent-auth' : 'secondary';
    const barrier = new InitialChildStartBarrier();
    let releaseChild!: () => void;
    const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
    let stagedKey = 'old-key';
    let childKey = '';
    let childStarts = 0;
    let acknowledged = false;
    const config = { vaultUrl: 'https://vault.test', auth: { apiKey: 'old-key' }, managedKey: { name: 'agent-auth' }, targets: [], secretTargets: [] } as AgentConfig;
    const propagator = createKeyRotationPropagator({
      config, getPluginLoader: () => null,
      bindManagedKey: async keyName => ({ id: 'synthetic', name: keyName, key: 'latest-key', prefix: '[REDACTED]', expiresAt: '2030-01-01T00:00:00.000Z', gracePeriod: '5m', permissions: [], rotationMode: 'scheduled' }),
      persistManagedKey: vi.fn(), execOutputFile: '/synthetic/env',
      execSecretMappings: [{ envVar: 'KEY', secretId: '', apiKeyName: name }],
      updateEnvFileFn: (_path, _name, value) => { stagedKey = value; return { updated: true, added: false }; },
      restartChild: async () => { await barrier.beforeRestart(); },
      prepareChildRestart: async () => {
        const initialReceipt = barrier.initialStartReceiptIfUnadmitted();
        if (initialReceipt) return { consumerReady: initialReceipt };
        await barrier.beforeRestart();
      },
    });
    const earlyPush = mode === 'secondary-with-early-push'
      ? propagator.bindAndPropagate(name, 'ws_event', { persist: true })
      : Promise.resolve();
    void earlyPush.catch(() => undefined);
    const keys = new TrackedKeySynchronizer({
      keyNames: [name],
      observeKey: (keyName, isCancelled, onStaged) => propagator.bindAndPropagate(keyName, 'manual', { persist: true, isCancelled, onStaged }),
    });
    const initial = mode === 'own'
      ? prepareKeyObservation(onStaged => propagator.bindAndPropagate(name, 'scheduled', { persist: true, onStaged }))
      : keys.prepareInitial();
    const completion = initial.completed.then(() => { acknowledged = true; });
    void completion.catch(() => undefined);
    const start = (async () => {
      await initial.prepared;
      barrier.open();
      childStarts++;
      childKey = stagedKey;
      await childGate;
      barrier.complete();
    })();
    try {
      for (let step = 0; step < 100; step++) await Promise.resolve();
      expect(childStarts).toBe(1);
      expect(childKey).toBe('latest-key');
      expect(acknowledged).toBe(false);
      releaseChild();
      await Promise.all([start, completion, earlyPush]);
      expect(acknowledged).toBe(true);
      expect(config.auth.apiKey).toBe(mode === 'own' ? 'latest-key' : 'old-key');
    } finally {
      releaseChild(); barrier.open(); barrier.complete();
      await Promise.allSettled([start, completion, earlyPush]);
      keys.stop(); propagator.stop();
    }
  });
});
