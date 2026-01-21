// Path: zn-vault-agent/src/services/dynamic-secrets/config-store.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  storeConfig,
  getConfig,
  getRoleConfig,
  getConfigCount,
  getAllConfigIds,
  clearAllConfigs,
  getStoreStats,
  removeConfig,
} from './config-store.js';
import type { DynamicSecretsConfig } from './types.js';

describe('Dynamic Secrets Config Store', () => {
  const mockConfig: DynamicSecretsConfig = {
    connectionId: 'conn-123',
    configVersion: 1,
    connectionType: 'POSTGRESQL',
    connectionString: 'postgresql://admin:pass@localhost:5432/db',
    connectionTimeoutSeconds: 30,
    maxOpenConnections: 5,
    roles: [
      {
        roleId: 'role-1',
        roleName: 'readonly',
        usernameTemplate: 'v_{{role}}_{{random:8}}',
        creationStatements: ['CREATE USER "{{username}}"'],
        revocationStatements: ['DROP USER IF EXISTS "{{username}}"'],
        renewStatements: [],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 86400,
      },
      {
        roleId: 'role-2',
        roleName: 'readwrite',
        usernameTemplate: 'v_{{role}}_{{random:8}}',
        creationStatements: ['CREATE USER "{{username}}"'],
        revocationStatements: ['DROP USER IF EXISTS "{{username}}"'],
        renewStatements: ['ALTER USER "{{username}}" VALID UNTIL \'{{expiration}}\''],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 86400,
      },
    ],
  };

  beforeEach(() => {
    clearAllConfigs();
  });

  afterEach(() => {
    clearAllConfigs();
  });

  describe('storeConfig', () => {
    it('should store a config', () => {
      storeConfig(mockConfig);

      expect(getConfigCount()).toBe(1);
      expect(getConfig('conn-123')).toEqual(mockConfig);
    });

    it('should update config with higher version', () => {
      const updatedConfig: DynamicSecretsConfig = {
        ...mockConfig,
        configVersion: 2,
        connectionTimeoutSeconds: 60,
      };

      storeConfig(mockConfig);
      storeConfig(updatedConfig);

      expect(getConfig('conn-123')?.connectionTimeoutSeconds).toBe(60);
    });

    it('should skip config with same or lower version', () => {
      const updatedConfig: DynamicSecretsConfig = {
        ...mockConfig,
        configVersion: 1, // Same version
        connectionTimeoutSeconds: 60,
      };

      const configV2: DynamicSecretsConfig = {
        ...mockConfig,
        configVersion: 2,
      };

      storeConfig(configV2); // Version 2
      storeConfig(updatedConfig); // Version 1 - should be skipped

      // Should still have version 2 config
      expect(getConfig('conn-123')?.configVersion).toBe(2);
      expect(getConfig('conn-123')?.connectionTimeoutSeconds).toBe(30);
    });
  });

  describe('getConfig', () => {
    it('should return undefined for non-existent config', () => {
      expect(getConfig('non-existent')).toBeUndefined();
    });

    it('should return stored config', () => {
      storeConfig(mockConfig);
      expect(getConfig('conn-123')).toEqual(mockConfig);
    });
  });

  describe('getRoleConfig', () => {
    beforeEach(() => {
      storeConfig(mockConfig);
    });

    it('should return role config by role ID', () => {
      const roleConfig = getRoleConfig('conn-123', 'role-1');
      expect(roleConfig).toBeDefined();
      expect(roleConfig?.roleName).toBe('readonly');
    });

    it('should return undefined for non-existent role', () => {
      expect(getRoleConfig('conn-123', 'non-existent')).toBeUndefined();
    });

    it('should return undefined for non-existent connection', () => {
      expect(getRoleConfig('non-existent', 'role-1')).toBeUndefined();
    });
  });

  describe('removeConfig', () => {
    it('should remove a config and return true', () => {
      storeConfig(mockConfig);
      expect(getConfigCount()).toBe(1);

      const removed = removeConfig('conn-123');
      expect(removed).toBe(true);
      expect(getConfigCount()).toBe(0);
      expect(getConfig('conn-123')).toBeUndefined();
    });

    it('should return false when removing non-existent config', () => {
      const removed = removeConfig('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('clearAllConfigs', () => {
    it('should clear all configs', () => {
      storeConfig(mockConfig);
      storeConfig({ ...mockConfig, connectionId: 'conn-2' });
      expect(getConfigCount()).toBe(2);

      clearAllConfigs();
      expect(getConfigCount()).toBe(0);
    });
  });

  describe('getAllConfigIds', () => {
    it('should return all config IDs', () => {
      storeConfig(mockConfig);
      storeConfig({ ...mockConfig, connectionId: 'conn-2' });

      const ids = getAllConfigIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain('conn-123');
      expect(ids).toContain('conn-2');
    });

    it('should return empty array when no configs', () => {
      expect(getAllConfigIds()).toEqual([]);
    });
  });

  describe('getStoreStats', () => {
    it('should return store statistics', () => {
      storeConfig(mockConfig);

      const stats = getStoreStats();
      expect(stats.configCount).toBe(1);
      expect(stats.connectionIds).toContain('conn-123');
      expect(stats.versions['conn-123']).toBe(1);
    });

    it('should return empty stats when no configs', () => {
      const stats = getStoreStats();
      expect(stats.configCount).toBe(0);
      expect(stats.connectionIds).toEqual([]);
      expect(stats.versions).toEqual({});
    });
  });
});
