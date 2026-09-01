import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  loadConfig: () => ({ vaultUrl: 'https://vault.test', secretTargets: [] }),
  getTargets: () => [],
  isConfigured: () => true,
}));

import {
  getHealthStatus,
  getReadinessStatus,
  setChildProcessManager,
  setPendingMutationRetries,
  setPluginLoader,
  setWebSocketStatus,
} from './health.js';
import { CoalescingRetryQueue } from './coalescing-retry-queue.js';
import type { ChildProcessManager } from '../services/child-process-manager.js';
import type { PluginLoader } from '../plugins/loader.js';

afterEach(() => {
  setPendingMutationRetries('certificate', 0);
  setPendingMutationRetries('secret', 0);
  setChildProcessManager(null);
  setPluginLoader(null);
  setWebSocketStatus(false);
});

describe('pending mutation health', () => {
  it('is unhealthy while a contended generation remains unapplied', async () => {
    setWebSocketStatus(true);
    setPendingMutationRetries('certificate', 1);
    setPendingMutationRetries('secret', 2);

    const status = await getHealthStatus();

    expect(status.status).toBe('unhealthy');
    expect(status.pendingMutations).toEqual({
      certificates: 1,
      secrets: 2,
      total: 3,
    });
    await expect(getReadinessStatus()).resolves.toBe(false);
  });

  it('stays unhealthy after file convergence until the required restart succeeds', async () => {
    let restartSucceeds = false;
    const queue = new CoalescingRetryQueue<string>({
      retryDelayMs: 60_000,
      process: async () => restartSucceeds ? 'resolved' : 'failed',
      onPendingChange: count => setPendingMutationRetries('secret', count),
    });
    queue.enqueue('secret-target', 4, 'v4');

    await expect(queue.retryNow('secret-target')).resolves.toBe(false);

    const failedRestart = await getHealthStatus();
    expect(failedRestart.status).toBe('unhealthy');
    expect(failedRestart.pendingMutations.secrets).toBe(1);

    restartSucceeds = true;
    await expect(queue.retryNow('secret-target')).resolves.toBe(true);

    const successfulRestart = await getHealthStatus();
    expect(successfulRestart.status).toBe('healthy');
    expect(successfulRestart.pendingMutations.secrets).toBe(0);
    queue.stop();
  });

  it.each(['crashed', 'stopped', 'max_restarts_exceeded'] as const)(
    'is unhealthy and not ready when the configured child is %s',
    async (childStatus) => {
      setWebSocketStatus(true);
      const manager = {
        getState: () => ({
          status: childStatus,
          pid: null,
          restartCount: 1,
          lastExitCode: 1,
          lastExitSignal: null,
          lastExitTime: '2026-08-31T20:00:01.000Z',
          lastStartTime: '2026-08-31T20:00:00.000Z',
        }),
        isDegraded: () => childStatus !== 'stopped',
      } as unknown as ChildProcessManager;
      setChildProcessManager(manager);

      const status = await getHealthStatus();

      expect(status.status).toBe('unhealthy');
      expect(status.childProcess?.status).toBe(childStatus);
      await expect(getReadinessStatus()).resolves.toBe(false);
    }
  );

  it('propagates a lifecycle-owning plugin unhealthy state to health and readiness', async () => {
    setWebSocketStatus(true);
    setPluginLoader({
      hasPlugins: () => true,
      collectHealthStatus: async () => [{
        name: 'payara',
        status: 'unhealthy',
        message: 'Deployment fence is blocked',
      }],
    } as unknown as PluginLoader);

    const status = await getHealthStatus();

    expect(status.status).toBe('unhealthy');
    expect(status.plugins).toEqual([expect.objectContaining({
      name: 'payara',
      status: 'unhealthy',
    })]);
    await expect(getReadinessStatus()).resolves.toBe(false);
  });
});
