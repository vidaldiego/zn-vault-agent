// Path: src/services/managed-key-renewal.test.ts

/**
 * Managed Key Renewal Service Unit Tests
 *
 * Tests the scheduling and refresh logic for managed API keys.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock the dependencies before importing the module
vi.mock('../lib/config.js', () => ({
  loadConfig: vi.fn(),
  updateManagedKey: vi.fn(),
  isManagedKeyMode: vi.fn(),
}));

vi.mock('../lib/api.js', () => ({
  bindManagedApiKey: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  createLogger: vi.fn(() => loggerSpies),
}));

// Import mocked modules
import { loadConfig, updateManagedKey, isManagedKeyMode } from '../lib/config.js';
import { bindManagedApiKey } from '../lib/api.js';
import type { ManagedApiKeyBindResponse } from '../lib/api.js';

// Import the module under test after mocks
import {
  startManagedKeyRenewal,
  stopManagedKeyRenewal,
  forceRefresh,
  getManagedKeyStatus,
  onKeyChanged,
  onWebSocketReconnect,
  onWebSocketRotationEvent,
  onWebSocketAuthFailure,
  setManagedKeyBinder,
} from './managed-key-renewal.js';
import { createKeyRotationPropagator } from '../lib/key-rotation-propagation.js';

describe('Managed Key Renewal Service', () => {
  const mockConfig = {
    vaultUrl: 'https://vault.example.com',
    tenantId: 'test-tenant',
    auth: { apiKey: 'znv_test_key_12345' },
    managedKey: {
      name: 'test-managed-key',
      rotationMode: 'scheduled' as const,
      nextRotationAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
      graceExpiresAt: new Date(Date.now() + 3900000).toISOString(), // 1h 5m from now
    },
  };

  const mockBindResponse: ManagedApiKeyBindResponse = {
    id: 'key-id-123',
    key: 'znv_new_key_67890',
    prefix: 'znv_new_',
    name: 'test-managed-key',
    expiresAt: new Date(Date.now() + 86400000).toISOString(), // 24h from now
    gracePeriod: '5m',
    graceExpiresAt: new Date(Date.now() + 3900000).toISOString(),
    rotationMode: 'scheduled',
    permissions: ['certificate:read:metadata', 'certificate:read:value'],
    nextRotationAt: new Date(Date.now() + 3600000).toISOString(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Reset service state
    stopManagedKeyRenewal();

    // Default mock implementations
    vi.mocked(loadConfig).mockReturnValue(mockConfig as ReturnType<typeof loadConfig>);
    vi.mocked(isManagedKeyMode).mockReturnValue(true);
    vi.mocked(bindManagedApiKey).mockResolvedValue(mockBindResponse);
    vi.mocked(updateManagedKey).mockImplementation(() => {});
  });

  afterEach(() => {
    stopManagedKeyRenewal();
    vi.useRealTimers();
  });

  describe('startManagedKeyRenewal', () => {
    it('should not start if not in managed key mode', async () => {
      vi.mocked(isManagedKeyMode).mockReturnValue(false);

      const result = await startManagedKeyRenewal();

      expect(result).toBeNull();
      expect(bindManagedApiKey).not.toHaveBeenCalled();
    });

    it('should perform initial bind on start', async () => {
      await startManagedKeyRenewal();

      expect(bindManagedApiKey).toHaveBeenCalledWith('test-managed-key');
      expect(updateManagedKey).toHaveBeenCalledWith(
        'znv_new_key_67890',
        expect.objectContaining({
          nextRotationAt: expect.any(String),
          rotationMode: 'scheduled',
        })
      );
    });

    it('should return bind response on successful start', async () => {
      const result = await startManagedKeyRenewal();

      expect(result).toEqual(mockBindResponse);
    });

    it('should handle bind failure gracefully', async () => {
      vi.mocked(bindManagedApiKey).mockRejectedValue(new Error('Network error'));

      const result = await startManagedKeyRenewal();

      // Should still return null but not throw
      expect(result).toBeNull();
    });

    it('should not start twice', async () => {
      await startManagedKeyRenewal();
      await startManagedKeyRenewal();

      // Should only bind once
      expect(bindManagedApiKey).toHaveBeenCalledTimes(1);
    });
  });

  describe('stopManagedKeyRenewal', () => {
    it('should stop the service and clear timers', async () => {
      await startManagedKeyRenewal();

      stopManagedKeyRenewal();

      const status = getManagedKeyStatus();
      expect(status.isRunning).toBe(false);
    });
  });

  describe('forceRefresh', () => {
    it('should return null if not in managed key mode', async () => {
      vi.mocked(isManagedKeyMode).mockReturnValue(false);

      const result = await forceRefresh();

      expect(result).toBeNull();
      expect(bindManagedApiKey).not.toHaveBeenCalled();
    });

    it('should perform bind and return response', async () => {
      vi.mocked(isManagedKeyMode).mockReturnValue(true);

      const result = await forceRefresh();

      expect(bindManagedApiKey).toHaveBeenCalled();
      expect(result).toEqual(mockBindResponse);
    });
  });

  describe('getManagedKeyStatus', () => {
    it('should return status before starting', () => {
      const status = getManagedKeyStatus();

      expect(status.isRunning).toBe(false);
      expect(status.isManagedMode).toBe(true);
      expect(status.managedKeyName).toBe('test-managed-key');
    });

    it('should return running status after start', async () => {
      await startManagedKeyRenewal();

      const status = getManagedKeyStatus();

      expect(status.isRunning).toBe(true);
      expect(status.isManagedMode).toBe(true);
      expect(status).not.toHaveProperty('currentKeyPrefix');
    });
  });

  it('never writes credential values or server prefixes to logs', async () => {
    await startManagedKeyRenewal();

    vi.mocked(bindManagedApiKey).mockResolvedValue({
      ...mockBindResponse,
      key: 'znv_rotated_key_99999',
      prefix: 'znv_rot',
    });
    await forceRefresh();

    const serializedLogs = JSON.stringify(
      Object.values(loggerSpies).map((spy) => spy.mock.calls)
    );
    for (const fragment of [
      mockConfig.auth.apiKey,
      mockBindResponse.key,
      mockBindResponse.prefix,
      'znv_rotated_key_99999',
      'znv_rot',
    ]) {
      expect(serializedLogs).not.toContain(fragment);
    }
  });

  describe('onKeyChanged callback', () => {
    it('should call callback when key changes', async () => {
      const callback = vi.fn();
      onKeyChanged(callback);

      // Start service to get initial key
      await startManagedKeyRenewal();

      // Simulate key rotation by having bind return different key
      const newKeyResponse = {
        ...mockBindResponse,
        key: 'znv_rotated_key_99999',
      };
      vi.mocked(bindManagedApiKey).mockResolvedValue(newKeyResponse);

      // Force refresh to trigger key change
      await forceRefresh();

      // Callback receives rotation metadata so the daemon can propagate the
      // new key to plugins/env files (2026-07-05 incident fix).
      expect(callback).toHaveBeenCalledWith('znv_rotated_key_99999', expect.objectContaining({
        keyName: 'test-managed-key',
        newPrefix: 'znv_new_',
        rotationMode: 'scheduled',
        source: 'manual',
      }));
    });

    it('should not call callback when key stays the same', async () => {
      const callback = vi.fn();
      onKeyChanged(callback);

      // Start service
      await startManagedKeyRenewal();

      // Clear the callback tracking
      callback.mockClear();

      // Force refresh with same key
      await forceRefresh();

      // Callback should not be called since key didn't change
      expect(callback).not.toHaveBeenCalled();
    });
  });

  it('does not turn repeated authentication rejections into bind polling', async () => {
    await startManagedKeyRenewal();
    vi.mocked(bindManagedApiKey).mockClear();
    vi.mocked(bindManagedApiKey).mockRejectedValue(new Error('Unauthorized'));
    await expect(onWebSocketAuthFailure()).resolves.toBe(false);
    await expect(onWebSocketAuthFailure()).resolves.toBe(false);
    expect(bindManagedApiKey).toHaveBeenCalledTimes(1);
  });

  it('does not persist credentials from a bind that completed after shutdown', async () => {
    let complete!: (response: ManagedApiKeyBindResponse) => void;
    vi.mocked(bindManagedApiKey).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const startup = startManagedKeyRenewal();
    stopManagedKeyRenewal();
    complete(mockBindResponse);
    await expect(startup).resolves.toBeNull();
    expect(updateManagedKey).not.toHaveBeenCalled();
  });

  it('delegates managed-event persistence to the shared observer and rejects an older manual response', async () => {
    const config = { ...mockConfig, auth: { ...mockConfig.auth }, managedKey: { ...mockConfig.managedKey } };
    vi.mocked(loadConfig).mockReturnValue(config as ReturnType<typeof loadConfig>);
    let completeOld!: (response: ManagedApiKeyBindResponse) => void;
    const oldResponse = new Promise<ManagedApiKeyBindResponse>(resolve => { completeOld = resolve; });
    const bind = vi.fn()
      .mockResolvedValueOnce({ ...mockBindResponse, key: config.auth.apiKey })
      .mockImplementationOnce(async () => oldResponse)
      .mockResolvedValue({ ...mockBindResponse, key: 'newer-event-key' });
    const writes: string[] = [];
    const observer = createKeyRotationPropagator({
      config: config as ReturnType<typeof loadConfig>, bindManagedKey: bind,
      getPluginLoader: () => null, persistManagedKey: value => { writes.push(value); },
    });
    setManagedKeyBinder(async (name, source, isCancelled) => (await observer.bindAndPropagate(name, source, { persist: true, isCancelled })).response);
    await startManagedKeyRenewal();
    writes.length = 0;
    const manual = observer.bindAndPropagate(config.managedKey.name, 'manual', { persist: true });
    await onWebSocketRotationEvent(config.managedKey.name);
    completeOld({ ...mockBindResponse, key: 'older-manual-key' });
    expect((await manual).response).toBeNull();
    expect(config.auth.apiKey).toBe('newer-event-key');
    expect(writes).toEqual(['newer-event-key']);
    expect(updateManagedKey).not.toHaveBeenCalled();
    expect(bindManagedApiKey).not.toHaveBeenCalled();
    observer.stop();
  });

  describe('event-only refresh', () => {
    it('never discovers keys from elapsed rotation/grace/heartbeat deadlines or reconnect', async () => {
      await startManagedKeyRenewal();
      vi.mocked(bindManagedApiKey).mockClear();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      const reconnect = onWebSocketReconnect();
      await vi.advanceTimersByTimeAsync(10_000);
      await reconnect;
      expect(bindManagedApiKey).not.toHaveBeenCalled();
    });

    it('still binds a matching real server rotation event exactly once', async () => {
      await startManagedKeyRenewal();
      vi.mocked(bindManagedApiKey).mockClear();
      await onWebSocketRotationEvent('test-managed-key');
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(bindManagedApiKey).toHaveBeenCalledTimes(1);
    });
  });
});
