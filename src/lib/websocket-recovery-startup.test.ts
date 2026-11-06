import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolvePayaraRecoveryStartup,
  createPostUpdateAuthorityRecovery,
  startRecoveryControlPlaneTransaction,
} from './websocket.js';

function updaterWithPendingWork(): {
  service: { disablePeriodicPolling(): void; stop(): void };
  state: { monitorActive: boolean; restartScheduled: boolean; periodicEnabled: boolean };
} {
  const state = {
    monitorActive: true,
    restartScheduled: true,
    periodicEnabled: true,
  };
  return {
    state,
    service: {
      disablePeriodicPolling(): void {
        state.periodicEnabled = false;
      },
      stop(): void {
        state.monitorActive = false;
        state.restartScheduled = false;
        state.periodicEnabled = false;
      },
    },
  };
}

describe('Payara recovery listener rollback', () => {
  it('fails with no listener and aborts the receipt monitor and queued restart', async () => {
    const updater = updaterWithPendingWork();
    const npmUpdater = { stop: vi.fn() };
    const stopHttp = vi.fn(async () => undefined);
    const stopHttps = vi.fn(async () => undefined);

    await expect(startRecoveryControlPlaneTransaction({
      pluginVersion: '2.9.0',
      pluginAutoUpdateService: updater.service,
      npmAutoUpdateService: npmUpdater,
      stopHttp,
      stopHttps,
    })).rejects.toThrow('no configured control-plane listener');

    expect(updater.state).toEqual({
      monitorActive: false,
      restartScheduled: false,
      periodicEnabled: false,
    });
    expect(npmUpdater.stop).toHaveBeenCalled();
    expect(stopHttps).toHaveBeenCalledOnce();
    expect(stopHttp).toHaveBeenCalledOnce();
  });

  it('rolls back an HTTP listener when HTTPS startup fails and aborts pending updater work', async () => {
    const updater = updaterWithPendingWork();
    const npmUpdater = { stop: vi.fn() };
    const startHttp = vi.fn(async () => undefined);
    const tlsFailure = new Error('synthetic TLS bind failure');
    const startHttps = vi.fn(async () => { throw tlsFailure; });
    const stopHttp = vi.fn(async () => undefined);
    const stopHttps = vi.fn(async () => undefined);

    await expect(startRecoveryControlPlaneTransaction({
      pluginVersion: '2.9.0',
      pluginAutoUpdateService: updater.service,
      npmAutoUpdateService: npmUpdater,
      startHttp,
      startHttps,
      stopHttp,
      stopHttps,
    })).rejects.toBe(tlsFailure);

    expect(startHttp).toHaveBeenCalledOnce();
    expect(startHttps).toHaveBeenCalledOnce();
    expect(stopHttps).toHaveBeenCalledOnce();
    expect(stopHttp).toHaveBeenCalledOnce();
    expect(updater.state.monitorActive).toBe(false);
    expect(updater.state.restartScheduled).toBe(false);
    expect(npmUpdater.stop).toHaveBeenCalled();
  });
});

describe('Payara recovery phase validation', () => {
  it('accepts the exact installed major 3 only for post-update confirmation', () => {
    expect(resolvePayaraRecoveryStartup({
      configured: true,
      recoveryRequired: false,
      version: '3.0.0',
    }, undefined, '3.0.0')).toEqual({ phase: 'post-update', version: '3.0.0' });
  });

  it('keeps exact major 2 on the legacy recovery path', () => {
    expect(resolvePayaraRecoveryStartup({
      configured: true,
      recoveryRequired: true,
      version: '2.9.0',
    }, '2.9.0')).toEqual({ phase: 'legacy', version: '2.9.0' });
  });

  it.each([
    { configured: false, recoveryRequired: false },
    { configured: true, recoveryRequired: true, version: '2.9.0' },
    { configured: true, recoveryRequired: false, version: '3.0.1' },
  ])('rejects a manifest that does not match the post-update target', (manifest) => {
    expect(() => resolvePayaraRecoveryStartup(manifest, undefined, '3.0.0')).toThrow(
      'post-update manifest changed'
    );
  });

  it('rejects conflicting legacy and post-update expectations', () => {
    expect(() => resolvePayaraRecoveryStartup({
      configured: true,
      recoveryRequired: false,
      version: '3.0.0',
    }, '2.9.0', '3.0.0')).toThrow('Conflicting Payara recovery startup modes');
  });
});

describe('Payara post-update explicit authority recovery', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('never probes authority from elapsed time and restarts only after an explicit successful action', async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const requestRestart = vi.fn();
    const recovery = createPostUpdateAuthorityRecovery({ probe, requestRestart });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(probe).not.toHaveBeenCalled();
    await expect(recovery.synchronize()).rejects.toThrow('unavailable');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(probe).toHaveBeenCalledTimes(1);
    await recovery.synchronize();
    await recovery.synchronize();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(requestRestart).toHaveBeenCalledOnce();
  });
  it('does not request a restart after shutdown wins an in-flight authority read', async () => {
    let resolve!: (ready: boolean) => void;
    const probe = () => new Promise<boolean>(done => { resolve = done; });
    const requestRestart = vi.fn();
    const recovery = createPostUpdateAuthorityRecovery({ probe, requestRestart });
    const task = recovery.synchronize();
    recovery.stop();
    resolve(true);
    await expect(task).rejects.toThrow('stopped');
    expect(requestRestart).not.toHaveBeenCalled();
  });
});
