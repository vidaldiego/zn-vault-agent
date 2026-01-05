// Path: src/services/managed-key-renewal.test.ts

/**
 * Managed Key Renewal Service Unit Tests
 *
 * Tests the scheduling and refresh logic for managed API keys.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
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
} from './managed-key-renewal.js';

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
      expect(status.currentKeyPrefix).toBe('znv_new_...');
    });
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

      expect(callback).toHaveBeenCalledWith('znv_rotated_key_99999');
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

  describe('refresh scheduling', () => {
    it('should schedule refresh based on nextRotationAt', async () => {
      // Set rotation time to 1 hour from now
      const nextRotation = new Date(Date.now() + 3600000);
      vi.mocked(loadConfig).mockReturnValue({
        ...mockConfig,
        managedKey: {
          ...mockConfig.managedKey!,
          nextRotationAt: nextRotation.toISOString(),
        },
      } as ReturnType<typeof loadConfig>);

      await startManagedKeyRenewal();

      // Clear the initial bind call
      vi.mocked(bindManagedApiKey).mockClear();

      // Advance time to just before refresh (30 seconds before rotation)
      // Refresh should happen 30 seconds before rotation by default
      vi.advanceTimersByTime(3600000 - 30000 - 1000); // 1 second before refresh

      expect(bindManagedApiKey).not.toHaveBeenCalled();

      // Advance past refresh time
      vi.advanceTimersByTime(2000);

      // Should have refreshed
      expect(bindManagedApiKey).toHaveBeenCalled();
    });

    it('should use fallback interval when no rotation time available', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        ...mockConfig,
        managedKey: {
          name: 'test-managed-key',
          // No nextRotationAt or graceExpiresAt
        },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(bindManagedApiKey).mockResolvedValue({
        ...mockBindResponse,
        nextRotationAt: undefined,
        graceExpiresAt: undefined,
      });

      await startManagedKeyRenewal();

      // Clear initial bind
      vi.mocked(bindManagedApiKey).mockClear();

      // Fallback interval is 5 minutes (300000ms)
      vi.advanceTimersByTime(300000 - 1000);

      expect(bindManagedApiKey).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2000);

      expect(bindManagedApiKey).toHaveBeenCalled();
    });
  });
});
