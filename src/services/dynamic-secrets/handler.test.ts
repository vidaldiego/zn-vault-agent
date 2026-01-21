// Path: zn-vault-agent/src/services/dynamic-secrets/handler.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  handleDynamicSecretsMessage,
  setVaultPublicKey,
  getVaultPublicKey,
} from './handler.js';
import * as configStore from './config-store.js';
import * as dbClients from './db-clients/index.js';
import * as keypair from './keypair.js';
import type {
  DynamicSecretsConfigPush,
  DynamicSecretsConfigRevoke,
  DynamicSecretsGenerateRequest,
  DynamicSecretsRevokeRequest,
  DynamicSecretsRenewRequest,
  DynamicSecretsAgentMessage,
} from './types.js';

// Mock the dependencies
vi.mock('./config-store.js', () => ({
  decryptAndStoreConfig: vi.fn(),
  removeConfig: vi.fn(),
  getConfig: vi.fn(),
  getRoleConfig: vi.fn(),
}));

vi.mock('./db-clients/index.js', () => ({
  getOrCreateClient: vi.fn(),
  closeClient: vi.fn(),
  generateUsername: vi.fn(),
  generatePassword: vi.fn(),
}));

vi.mock('./keypair.js', () => ({
  encryptPassword: vi.fn(),
}));

describe('Dynamic Secrets Handler', () => {
  let sentMessages: DynamicSecretsAgentMessage[];
  const mockSend = vi.fn((msg: DynamicSecretsAgentMessage) => {
    sentMessages.push(msg);
  });

  beforeEach(() => {
    sentMessages = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Vault Public Key', () => {
    it('should set and get vault public key', () => {
      const publicKey = 'test-public-key-base64';
      setVaultPublicKey(publicKey);
      expect(getVaultPublicKey()).toBe(publicKey);
    });
  });

  describe('Config Push Handler', () => {
    it('should handle successful config push', async () => {
      vi.mocked(configStore.decryptAndStoreConfig).mockReturnValue({
        success: true,
      });

      const message: DynamicSecretsConfigPush = {
        event: 'dynamic-secrets.config-push',
        connectionId: 'conn-123',
        configVersion: 1,
        encryptedConfig: 'encrypted-config-base64',
        roleIds: ['role-1', 'role-2'],
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(configStore.decryptAndStoreConfig).toHaveBeenCalledWith(
        'conn-123',
        1,
        'encrypted-config-base64'
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.config-ack',
        connectionId: 'conn-123',
        configVersion: 1,
        status: 'loaded',
      });
    });

    it('should handle failed config push', async () => {
      vi.mocked(configStore.decryptAndStoreConfig).mockReturnValue({
        success: false,
        error: 'Decryption failed',
      });

      const message: DynamicSecretsConfigPush = {
        event: 'dynamic-secrets.config-push',
        connectionId: 'conn-123',
        configVersion: 1,
        encryptedConfig: 'bad-encrypted-config',
        roleIds: ['role-1'],
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.config-ack',
        connectionId: 'conn-123',
        configVersion: 1,
        status: 'failed',
        error: 'Decryption failed',
      });
    });
  });

  describe('Config Revoke Handler', () => {
    it('should handle config revoke', async () => {
      const message: DynamicSecretsConfigRevoke = {
        event: 'dynamic-secrets.config-revoke',
        connectionId: 'conn-123',
        reason: 'Connection deleted',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(dbClients.closeClient).toHaveBeenCalledWith('conn-123');
      expect(configStore.removeConfig).toHaveBeenCalledWith('conn-123');
      // No response sent for config revoke
      expect(sentMessages).toHaveLength(0);
    });
  });

  describe('Generate Credentials Handler', () => {
    const mockConfig = {
      connectionId: 'conn-123',
      configVersion: 1,
      connectionType: 'POSTGRESQL' as const,
      connectionString: 'postgresql://admin:pass@localhost:5432/db',
      connectionTimeoutSeconds: 30,
      maxOpenConnections: 5,
      roles: [
        {
          roleId: 'role-123',
          roleName: 'readonly',
          usernameTemplate: 'v_{{role}}_{{random:8}}',
          creationStatements: ['CREATE USER "{{username}}" WITH PASSWORD \'{{password}}\''],
          revocationStatements: ['DROP USER IF EXISTS "{{username}}"'],
          renewStatements: [],
          defaultTtlSeconds: 3600,
          maxTtlSeconds: 86400,
        },
      ],
    };

    const mockDbClient = {
      testConnection: vi.fn(),
      createCredential: vi.fn(),
      revokeCredential: vi.fn(),
      renewCredential: vi.fn(),
      close: vi.fn(),
    };

    beforeEach(() => {
      setVaultPublicKey('vault-public-key');
      vi.mocked(configStore.getConfig).mockReturnValue(mockConfig);
      vi.mocked(configStore.getRoleConfig).mockReturnValue(mockConfig.roles[0]);
      vi.mocked(dbClients.getOrCreateClient).mockReturnValue(mockDbClient);
      vi.mocked(dbClients.generateUsername).mockReturnValue('v_readonly_abc12345');
      vi.mocked(dbClients.generatePassword).mockReturnValue('securepassword123');
      vi.mocked(keypair.encryptPassword).mockReturnValue('encrypted-password');
    });

    it('should generate credentials successfully', async () => {
      mockDbClient.createCredential.mockResolvedValue(undefined);

      const message: DynamicSecretsGenerateRequest = {
        event: 'dynamic-secrets.generate',
        requestId: 'req-123',
        connectionId: 'conn-123',
        roleId: 'role-123',
        ttlSeconds: 3600,
        maxTtlSeconds: 86400,
        usernameTemplate: 'v_{{role}}_{{random:8}}',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        vaultPublicKey: 'vault-public-key',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(mockDbClient.createCredential).toHaveBeenCalledWith(
        mockConfig.roles[0].creationStatements,
        'v_readonly_abc12345',
        'securepassword123',
        message.expiresAt
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.generated',
        requestId: 'req-123',
        username: 'v_readonly_abc12345',
        encryptedPassword: 'encrypted-password',
      });
      expect(sentMessages[0]).toHaveProperty('leaseId');
    });

    it('should return error if config not found', async () => {
      vi.mocked(configStore.getConfig).mockReturnValue(undefined);

      const message: DynamicSecretsGenerateRequest = {
        event: 'dynamic-secrets.generate',
        requestId: 'req-123',
        connectionId: 'conn-unknown',
        roleId: 'role-123',
        ttlSeconds: 3600,
        maxTtlSeconds: 86400,
        usernameTemplate: 'v_{{role}}_{{random:8}}',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        vaultPublicKey: 'vault-public-key',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.error',
        requestId: 'req-123',
        code: 'CONFIG_NOT_FOUND',
      });
    });

    it('should return error if role not found', async () => {
      vi.mocked(configStore.getRoleConfig).mockReturnValue(undefined);

      const message: DynamicSecretsGenerateRequest = {
        event: 'dynamic-secrets.generate',
        requestId: 'req-123',
        connectionId: 'conn-123',
        roleId: 'role-unknown',
        ttlSeconds: 3600,
        maxTtlSeconds: 86400,
        usernameTemplate: 'v_{{role}}_{{random:8}}',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        vaultPublicKey: 'vault-public-key',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.error',
        requestId: 'req-123',
        code: 'CONFIG_NOT_FOUND',
      });
    });

    it('should return error if vault public key not set', async () => {
      setVaultPublicKey(null as any);

      const message: DynamicSecretsGenerateRequest = {
        event: 'dynamic-secrets.generate',
        requestId: 'req-123',
        connectionId: 'conn-123',
        roleId: 'role-123',
        ttlSeconds: 3600,
        maxTtlSeconds: 86400,
        usernameTemplate: 'v_{{role}}_{{random:8}}',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.error',
        requestId: 'req-123',
        code: 'DECRYPTION_FAILED',
      });
    });

    it('should handle database connection error', async () => {
      mockDbClient.createCredential.mockRejectedValue(
        new Error('connection refused')
      );

      const message: DynamicSecretsGenerateRequest = {
        event: 'dynamic-secrets.generate',
        requestId: 'req-123',
        connectionId: 'conn-123',
        roleId: 'role-123',
        ttlSeconds: 3600,
        maxTtlSeconds: 86400,
        usernameTemplate: 'v_{{role}}_{{random:8}}',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        vaultPublicKey: 'vault-public-key',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.error',
        requestId: 'req-123',
        code: 'DB_CONNECTION_FAILED',
      });
    });
  });

  describe('Revoke Credentials Handler', () => {
    const mockConfig = {
      connectionId: 'conn-123',
      configVersion: 1,
      connectionType: 'POSTGRESQL' as const,
      connectionString: 'postgresql://admin:pass@localhost:5432/db',
      connectionTimeoutSeconds: 30,
      maxOpenConnections: 5,
      roles: [
        {
          roleId: 'role-123',
          roleName: 'readonly',
          usernameTemplate: 'v_{{role}}_{{random:8}}',
          creationStatements: ['CREATE USER "{{username}}" WITH PASSWORD \'{{password}}\''],
          revocationStatements: ['DROP USER IF EXISTS "{{username}}"'],
          renewStatements: [],
          defaultTtlSeconds: 3600,
          maxTtlSeconds: 86400,
        },
      ],
    };

    const mockDbClient = {
      testConnection: vi.fn(),
      createCredential: vi.fn(),
      revokeCredential: vi.fn(),
      renewCredential: vi.fn(),
      close: vi.fn(),
    };

    beforeEach(() => {
      vi.mocked(configStore.getConfig).mockReturnValue(mockConfig);
      vi.mocked(dbClients.getOrCreateClient).mockReturnValue(mockDbClient);
    });

    it('should revoke credentials successfully', async () => {
      mockDbClient.revokeCredential.mockResolvedValue(undefined);

      const message: DynamicSecretsRevokeRequest = {
        event: 'dynamic-secrets.revoke',
        requestId: 'req-123',
        connectionId: 'conn-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        reason: 'User requested',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(mockDbClient.revokeCredential).toHaveBeenCalledWith(
        mockConfig.roles[0].revocationStatements,
        'v_readonly_abc12345'
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.revoked',
        requestId: 'req-123',
        leaseId: 'lease-123',
        success: true,
      });
    });

    it('should report success if config not found (already cleaned up)', async () => {
      vi.mocked(configStore.getConfig).mockReturnValue(undefined);

      const message: DynamicSecretsRevokeRequest = {
        event: 'dynamic-secrets.revoke',
        requestId: 'req-123',
        connectionId: 'conn-unknown',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.revoked',
        requestId: 'req-123',
        leaseId: 'lease-123',
        success: true,
      });
    });

    it('should report failure but still respond on revocation error', async () => {
      mockDbClient.revokeCredential.mockRejectedValue(
        new Error('User not found')
      );

      const message: DynamicSecretsRevokeRequest = {
        event: 'dynamic-secrets.revoke',
        requestId: 'req-123',
        connectionId: 'conn-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.revoked',
        requestId: 'req-123',
        leaseId: 'lease-123',
        success: false,
      });
    });
  });

  describe('Renew Credentials Handler', () => {
    const mockConfig = {
      connectionId: 'conn-123',
      configVersion: 1,
      connectionType: 'POSTGRESQL' as const,
      connectionString: 'postgresql://admin:pass@localhost:5432/db',
      connectionTimeoutSeconds: 30,
      maxOpenConnections: 5,
      roles: [
        {
          roleId: 'role-123',
          roleName: 'readonly',
          usernameTemplate: 'v_{{role}}_{{random:8}}',
          creationStatements: ['CREATE USER "{{username}}" WITH PASSWORD \'{{password}}\''],
          revocationStatements: ['DROP USER IF EXISTS "{{username}}"'],
          renewStatements: ['ALTER USER "{{username}}" VALID UNTIL \'{{expiration}}\''],
          defaultTtlSeconds: 3600,
          maxTtlSeconds: 86400,
        },
      ],
    };

    const mockDbClient = {
      testConnection: vi.fn(),
      createCredential: vi.fn(),
      revokeCredential: vi.fn(),
      renewCredential: vi.fn(),
      close: vi.fn(),
    };

    beforeEach(() => {
      vi.mocked(configStore.getConfig).mockReturnValue(mockConfig);
      vi.mocked(configStore.getRoleConfig).mockReturnValue(mockConfig.roles[0]);
      vi.mocked(dbClients.getOrCreateClient).mockReturnValue(mockDbClient);
    });

    it('should renew credentials successfully', async () => {
      mockDbClient.renewCredential.mockResolvedValue(undefined);
      const newExpiresAt = new Date(Date.now() + 7200000).toISOString();

      const message: DynamicSecretsRenewRequest = {
        event: 'dynamic-secrets.renew',
        requestId: 'req-123',
        connectionId: 'conn-123',
        roleId: 'role-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        newExpiresAt,
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(mockDbClient.renewCredential).toHaveBeenCalledWith(
        mockConfig.roles[0].renewStatements,
        'v_readonly_abc12345',
        newExpiresAt
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.renewed',
        requestId: 'req-123',
        leaseId: 'lease-123',
        success: true,
        newExpiresAt,
      });
    });

    it('should skip renewal if no renewal statements configured', async () => {
      const configWithoutRenew = {
        ...mockConfig,
        roles: [{
          ...mockConfig.roles[0],
          renewStatements: [],
        }],
      };
      vi.mocked(configStore.getConfig).mockReturnValue(configWithoutRenew);
      vi.mocked(configStore.getRoleConfig).mockReturnValue(configWithoutRenew.roles[0]);

      const newExpiresAt = new Date(Date.now() + 7200000).toISOString();

      const message: DynamicSecretsRenewRequest = {
        event: 'dynamic-secrets.renew',
        requestId: 'req-123',
        connectionId: 'conn-123',
        roleId: 'role-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        newExpiresAt,
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      // Should NOT call renewCredential
      expect(mockDbClient.renewCredential).not.toHaveBeenCalled();

      // But should still respond with success
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.renewed',
        requestId: 'req-123',
        success: true,
      });
    });
  });

  describe('Unknown Event Handler', () => {
    it('should ignore unknown events', async () => {
      const message = {
        event: 'dynamic-secrets.unknown',
        timestamp: new Date().toISOString(),
      } as any;

      await handleDynamicSecretsMessage(message, mockSend);

      // No messages sent for unknown events
      expect(sentMessages).toHaveLength(0);
    });
  });
});
