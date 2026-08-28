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
  DynamicSecretsConfigInventory,
  DynamicSecretsGenerateRequest,
  DynamicSecretsRevokeRequest,
  DynamicSecretsRenewRequest,
  DynamicSecretsAgentMessage,
} from './types.js';

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  createLogger: () => loggerSpies,
}));

// Mock the dependencies
vi.mock('./config-store.js', () => ({
  decryptAndStoreConfig: vi.fn(),
  removeConfig: vi.fn(),
  getAllConfigIds: vi.fn(),
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
      vi.mocked(configStore.decryptAndStoreConfig).mockResolvedValue({
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
        'encrypted-config-base64',
        expect.any(Function)
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
      vi.mocked(configStore.decryptAndStoreConfig).mockResolvedValue({
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

    it('evicts the stale client before loaded ACK and serializes a reconnect revoke behind it', async () => {
      let finishClose!: () => void;
      const closePending = new Promise<void>(resolve => { finishClose = resolve; });
      vi.mocked(dbClients.closeClient).mockReturnValue(closePending);
      vi.mocked(configStore.decryptAndStoreConfig).mockImplementation(async (
        _connectionId,
        _configVersion,
        _encryptedConfig,
        beforeStore
      ) => {
        await beforeStore?.({} as never);
        return {success: true, updated: true};
      });

      const role = {
        roleId: 'role-1',
        roleVersion: 1,
        templateBacked: true,
        roleName: 'readonly',
        usernameTemplate: 'v_{{role}}_{{random:8}}',
        creationStatements: ['CREATE ROLE'],
        revocationStatements: ['DROP ROLE IF EXISTS "{{username}}"'],
        renewStatements: [],
        defaultTtlSeconds: 3600,
        maxTtlSeconds: 86400,
      };
      const config = {
        connectionId: 'conn-123',
        configVersion: 2,
        targetVersion: 1,
        connectionType: 'POSTGRESQL' as const,
        connectionString: 'postgresql://new-admin:new-secret@new-db/app',
        connectionTimeoutSeconds: 30,
        maxOpenConnections: 5,
        roles: [role],
      };
      vi.mocked(configStore.getConfig).mockReturnValue(config);
      vi.mocked(configStore.getRoleConfig).mockReturnValue(role);
      const client = {
        credentialExists: vi.fn().mockResolvedValue(false),
        revokeCredential: vi.fn(),
      };
      vi.mocked(dbClients.getOrCreateClient).mockReturnValue(client as never);

      const push: DynamicSecretsConfigPush = {
        event: 'dynamic-secrets.config-push',
        connectionId: 'conn-123',
        configVersion: 2,
        encryptedConfig: 'encrypted-new-config',
        roleIds: ['role-1'],
        timestamp: new Date().toISOString(),
      };
      const revoke: DynamicSecretsRevokeRequest = {
        event: 'dynamic-secrets.revoke-v2',
        protocolVersion: 2,
        configVersion: 2,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'reconnect-revoke-1',
        connectionId: 'conn-123',
        roleId: 'role-1',
        leaseId: 'lease-1',
        username: 'v_readonly_exact',
        timestamp: new Date().toISOString(),
      };

      const pushWork = handleDynamicSecretsMessage(push, mockSend);
      await vi.waitFor(() => expect(dbClients.closeClient).toHaveBeenCalledWith('conn-123'));
      const revokeWork = handleDynamicSecretsMessage(revoke, mockSend);
      await Promise.resolve();

      expect(sentMessages).toEqual([]);
      expect(dbClients.getOrCreateClient).not.toHaveBeenCalled();

      finishClose();
      await Promise.all([pushWork, revokeWork]);

      expect(sentMessages.map(message => message.event)).toEqual([
        'dynamic-secrets.config-ack',
        'dynamic-secrets.revoked',
      ]);
      expect(sentMessages[0]).toMatchObject({status: 'loaded', configVersion: 2});
      expect(sentMessages[1]).toMatchObject({
        protocolVersion: 2,
        configVersion: 2,
        targetVersion: 1,
        roleVersion: 1,
        leaseId: 'lease-1',
        success: true,
      });
      expect(client.revokeCredential).not.toHaveBeenCalled();
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

  describe('Config Inventory Handler', () => {
    it('removes absent configs only after client eviction and ACKs authoritative counts', async () => {
      vi.mocked(configStore.getAllConfigIds)
        .mockReturnValueOnce(['conn-keep', 'conn-stale'])
        .mockReturnValueOnce(['conn-keep']);
      vi.mocked(configStore.getConfig).mockReturnValue({connectionId: 'conn-stale'} as never);
      vi.mocked(configStore.removeConfig).mockReturnValue(true);
      vi.mocked(dbClients.closeClient).mockResolvedValue(undefined);
      const message: DynamicSecretsConfigInventory = {
        event: 'dynamic-secrets.config-inventory-v2',
        protocolVersion: 2,
        requestId: 'inventory-1',
        connectionIds: ['conn-keep'],
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(dbClients.closeClient).toHaveBeenCalledWith('conn-stale');
      expect(configStore.removeConfig).toHaveBeenCalledWith('conn-stale');
      expect(dbClients.closeClient).not.toHaveBeenCalledWith('conn-keep');
      expect(sentMessages).toEqual([expect.objectContaining({
        event: 'dynamic-secrets.config-inventory-ack-v2',
        protocolVersion: 2,
        requestId: 'inventory-1',
        retainedCount: 1,
        removedCount: 1,
        success: true,
      })]);
    });
  });

  describe('Generate Credentials Handler', () => {
    const mockConfig = {
      connectionId: 'conn-123',
      configVersion: 1,
      targetVersion: 1,
      connectionType: 'POSTGRESQL' as const,
      connectionString: 'postgresql://admin:pass@localhost:5432/db',
      connectionTimeoutSeconds: 30,
      maxOpenConnections: 5,
      roles: [
        {
          roleId: 'role-123',
          roleVersion: 1,
          templateBacked: true,
          roleName: 'readonly',
          usernameTemplate: 'v_{{role}}_{{random:8}}',
          creationStatements: [
            'CREATE ROLE "{{username}}" WITH LOGIN PASSWORD \'{{password}}\' VALID UNTIL \'{{expiration}}\'',
          ],
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
      credentialExists: vi.fn(),
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
      mockDbClient.credentialExists.mockResolvedValue(true);
    });

    it('should generate credentials successfully', async () => {
      mockDbClient.createCredential.mockResolvedValue(undefined);

      const message: DynamicSecretsGenerateRequest = {
        event: 'dynamic-secrets.generate-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        leaseId: 'dbl-generate-1',
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
        event: 'dynamic-secrets.generated-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        leaseId: 'dbl-generate-1',
        connectionId: 'conn-123',
        roleId: 'role-123',
        requestId: 'req-123',
        username: 'v_readonly_abc12345',
        encryptedPassword: 'encrypted-password',
      });
      expect(sentMessages[0]).toHaveProperty('leaseId');
    });

    it('should return error if config not found', async () => {
      vi.mocked(configStore.getConfig).mockReturnValue(undefined);

      const message: DynamicSecretsGenerateRequest = {
        event: 'dynamic-secrets.generate-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        leaseId: 'dbl-config-missing',
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
        event: 'dynamic-secrets.generate-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        leaseId: 'dbl-role-missing',
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

    it('rejects a disabled recovery-only role before password generation or target access', async () => {
      vi.mocked(configStore.getRoleConfig).mockReturnValue({
        ...mockConfig.roles[0],
        generationEnabled: false,
      });
      const message: DynamicSecretsGenerateRequest = {
        event: 'dynamic-secrets.generate-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        leaseId: 'dbl-disabled-role',
        requestId: 'req-disabled-role',
        connectionId: 'conn-123',
        roleId: 'role-123',
        ttlSeconds: 3600,
        maxTtlSeconds: 86400,
        usernameTemplate: 'v_exact_name',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        vaultPublicKey: 'vault-public-key',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(dbClients.generatePassword).not.toHaveBeenCalled();
      expect(dbClients.getOrCreateClient).not.toHaveBeenCalled();
      expect(mockDbClient.createCredential).not.toHaveBeenCalled();
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.error',
        requestId: 'req-disabled-role',
        code: 'CONFIG_NOT_FOUND',
        error: 'Role is disabled for credential generation',
      });
    });

    it('should return error if vault public key not set', async () => {
      setVaultPublicKey(null as any);

      const message: DynamicSecretsGenerateRequest = {
        event: 'dynamic-secrets.generate-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        leaseId: 'dbl-no-key',
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
        Object.assign(new Error('connection refused'), {code: 'ECONNREFUSED'})
      );

      const message: DynamicSecretsGenerateRequest = {
        event: 'dynamic-secrets.generate-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        leaseId: 'dbl-db-error',
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
        error: 'Database connection failed while generating credential',
      });
    });

    it('rejects an altered literal username before password generation or target CREATE', async () => {
      vi.mocked(dbClients.generateUsername).mockReturnValue('v_exact_name_sanitized');
      const message: DynamicSecretsGenerateRequest = {
        event: 'dynamic-secrets.generate-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        leaseId: 'dbl-literal',
        requestId: 'req-literal',
        connectionId: 'conn-123',
        roleId: 'role-123',
        ttlSeconds: 3600,
        maxTtlSeconds: 86400,
        usernameTemplate: 'v_exact_name',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        vaultPublicKey: 'vault-public-key',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(dbClients.generatePassword).not.toHaveBeenCalled();
      expect(dbClients.getOrCreateClient).not.toHaveBeenCalled();
      expect(mockDbClient.createCredential).not.toHaveBeenCalled();
      expect(sentMessages).toEqual([
        expect.objectContaining({
          event: 'dynamic-secrets.error',
          requestId: 'req-literal',
          code: 'SQL_EXECUTION_FAILED',
          error: 'Generated username did not match requested literal identity',
        }),
      ]);
    });

    it('never sends or logs raw SQL/password from a generation driver error', async () => {
      const canaryPassword = 'pw-canary-never-expose';
      const canarySql = `GRANT failed IDENTIFIED BY '${canaryPassword}'`;
      vi.mocked(dbClients.generatePassword).mockReturnValue(canaryPassword);
      mockDbClient.createCredential.mockRejectedValue(
        Object.assign(new Error(canarySql), {sql: canarySql, detail: canarySql})
      );
      const message: DynamicSecretsGenerateRequest = {
        event: 'dynamic-secrets.generate-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        leaseId: 'dbl-secret-canary',
        requestId: 'req-secret-canary',
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

      const serializedBoundary = JSON.stringify({sentMessages, logs: loggerSpies.error.mock.calls});
      expect(serializedBoundary).not.toContain(canaryPassword);
      expect(serializedBoundary).not.toContain('GRANT failed');
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.error',
        code: 'SQL_EXECUTION_FAILED',
        error: 'Database credential generation failed',
      });
    });

    it('rejects non-canonical MySQL identity SQL before password generation or target CREATE', async () => {
      vi.mocked(configStore.getConfig).mockReturnValue({
        ...mockConfig,
        connectionType: 'MYSQL',
      });
      vi.mocked(configStore.getRoleConfig).mockReturnValue({
        ...mockConfig.roles[0],
        creationStatements: ["CREATE USER '{{username}}' IDENTIFIED BY '{{password}}'"],
      });
      const message: DynamicSecretsGenerateRequest = {
        event: 'dynamic-secrets.generate-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        leaseId: 'dbl-mysql-noncanonical',
        requestId: 'req-mysql-noncanonical',
        connectionId: 'conn-123',
        roleId: 'role-123',
        ttlSeconds: 3600,
        maxTtlSeconds: 86400,
        usernameTemplate: 'v_exact_name',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        vaultPublicKey: 'vault-public-key',
        timestamp: new Date().toISOString(),
      };
      vi.mocked(dbClients.generateUsername).mockReturnValue('v_exact_name');

      await handleDynamicSecretsMessage(message, mockSend);

      expect(dbClients.generatePassword).not.toHaveBeenCalled();
      expect(dbClients.getOrCreateClient).not.toHaveBeenCalled();
      expect(mockDbClient.createCredential).not.toHaveBeenCalled();
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.error',
        code: 'SQL_EXECUTION_FAILED',
        error: 'MySQL credential generation requires canonical account identity',
      });
    });
  });

  describe('Revoke Credentials Handler', () => {
    const mockConfig = {
      connectionId: 'conn-123',
      configVersion: 1,
      targetVersion: 1,
      connectionType: 'POSTGRESQL' as const,
      connectionString: 'postgresql://admin:pass@localhost:5432/db',
      connectionTimeoutSeconds: 30,
      maxOpenConnections: 5,
      roles: [
        {
          roleId: 'role-123',
          roleVersion: 1,
          templateBacked: true,
          roleName: 'readonly',
          usernameTemplate: 'v_{{role}}_{{random:8}}',
          creationStatements: ['CREATE USER "{{username}}" WITH PASSWORD \'{{password}}\''],
          revocationStatements: ['DROP USER IF EXISTS "{{username}}"'],
          renewStatements: [],
          defaultTtlSeconds: 3600,
          maxTtlSeconds: 86400,
        },
        {
          roleId: 'role-456',
          roleVersion: 1,
          templateBacked: true,
          roleName: 'writer',
          usernameTemplate: 'v_{{role}}_{{random:8}}',
          creationStatements: ['CREATE USER role-456'],
          revocationStatements: ['CALL revoke_role_456("{{username}}")'],
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
      credentialExists: vi.fn(),
      ensureCredentialAbsent: vi.fn(),
      renewCredential: vi.fn(),
      close: vi.fn(),
    };

    beforeEach(() => {
      vi.mocked(configStore.getConfig).mockReturnValue(mockConfig);
      vi.mocked(configStore.getRoleConfig).mockImplementation(
        (_connectionId, roleId) => mockConfig.roles.find(role => role.roleId === roleId)
      );
      vi.mocked(dbClients.getOrCreateClient).mockReturnValue(mockDbClient);
      mockDbClient.credentialExists.mockResolvedValue(true);
      mockDbClient.ensureCredentialAbsent.mockResolvedValue(undefined);
    });

    it('should select the exact role and return verifiable v2 proof', async () => {
      mockDbClient.revokeCredential.mockResolvedValue(undefined);
      mockDbClient.credentialExists
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const message: DynamicSecretsRevokeRequest = {
        event: 'dynamic-secrets.revoke-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-123',
        connectionId: 'conn-123',
        roleId: 'role-456',
        leaseId: 'lease-123',
        username: 'v_writer_abc12345',
        reason: 'User requested',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(configStore.getRoleConfig).toHaveBeenCalledWith('conn-123', 'role-456');
      expect(mockDbClient.revokeCredential).toHaveBeenCalledWith(
        mockConfig.roles[1].revocationStatements,
        'v_writer_abc12345'
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.revoked',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-123',
        leaseId: 'lease-123',
        roleId: 'role-456',
        username: 'v_writer_abc12345',
        success: true,
      });
    });

    it('should report failure if config is missing', async () => {
      vi.mocked(configStore.getConfig).mockReturnValue(undefined);

      const message: DynamicSecretsRevokeRequest = {
        event: 'dynamic-secrets.revoke-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-123',
        connectionId: 'conn-unknown',
        roleId: 'role-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.revoked',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-123',
        leaseId: 'lease-123',
        roleId: 'role-123',
        username: 'v_readonly_abc12345',
        success: false,
      });
      expect(mockDbClient.revokeCredential).not.toHaveBeenCalled();
    });

    it('should report failure if the exact role is missing', async () => {
      vi.mocked(configStore.getRoleConfig).mockReturnValue(undefined);

      const message: DynamicSecretsRevokeRequest = {
        event: 'dynamic-secrets.revoke-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-123',
        connectionId: 'conn-123',
        roleId: 'role-missing',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.revoked',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        leaseId: 'lease-123',
        roleId: 'role-missing',
        username: 'v_readonly_abc12345',
        success: false,
      });
      expect(mockDbClient.revokeCredential).not.toHaveBeenCalled();
    });

    it('should ignore the legacy revoke event without executing SQL', async () => {
      const legacyMessage = {
        event: 'dynamic-secrets.revoke',
        requestId: 'req-legacy',
        connectionId: 'conn-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        timestamp: new Date().toISOString(),
      } as unknown as DynamicSecretsRevokeRequest;

      await handleDynamicSecretsMessage(legacyMessage, mockSend);

      expect(mockDbClient.revokeCredential).not.toHaveBeenCalled();
      expect(sentMessages).toHaveLength(0);
    });

    it('should report failure but still respond on revocation error', async () => {
      mockDbClient.revokeCredential.mockRejectedValue(
        new Error('User not found')
      );

      const message: DynamicSecretsRevokeRequest = {
        event: 'dynamic-secrets.revoke-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-123',
        connectionId: 'conn-123',
        roleId: 'role-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.revoked',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-123',
        leaseId: 'lease-123',
        roleId: 'role-123',
        username: 'v_readonly_abc12345',
        success: false,
      });
    });

    it('treats an ACK-lost retry as exact success when the credential is already absent', async () => {
      mockDbClient.credentialExists
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);
      mockDbClient.revokeCredential.mockResolvedValue(undefined);
      const message: DynamicSecretsRevokeRequest = {
        event: 'dynamic-secrets.revoke-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-first',
        connectionId: 'conn-123',
        roleId: 'role-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);
      await handleDynamicSecretsMessage({...message, requestId: 'req-retry'}, mockSend);

      expect(mockDbClient.revokeCredential).toHaveBeenCalledTimes(1);
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1]).toMatchObject({
        event: 'dynamic-secrets.revoked',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-retry',
        leaseId: 'lease-123',
        roleId: 'role-123',
        username: 'v_readonly_abc12345',
        success: true,
      });
    });

    it('replays a remediated legacy fixed-host DROP after ACK persistence fails', async () => {
      const legacyRole = {
        ...mockConfig.roles[0],
        generationEnabled: false,
        // Historical creation identity can be non-canonical. Revocation is
        // independently safe after the operator remediation.
        creationStatements: [
          "CREATE USER '{{username}}'@'localhost' IDENTIFIED BY '{{password}}'",
        ],
        revocationStatements: [
          "DROP USER IF EXISTS '{{username}}'@'localhost'",
        ],
      };
      vi.mocked(configStore.getConfig).mockReturnValue({
        ...mockConfig,
        connectionType: 'MYSQL',
        roles: [legacyRole],
      });
      vi.mocked(configStore.getRoleConfig).mockReturnValue(legacyRole);
      mockDbClient.revokeCredential.mockResolvedValue(undefined);
      const message: DynamicSecretsRevokeRequest = {
        event: 'dynamic-secrets.revoke-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-legacy-first',
        connectionId: 'conn-123',
        roleId: 'role-123',
        leaseId: 'lease-legacy',
        username: 'v_legacy_abc12345',
        timestamp: new Date().toISOString(),
      };

      // The first exact ACK is assumed lost before vault marks its queue row
      // completed. A later drain sends the same lease-bound request again.
      await handleDynamicSecretsMessage(message, mockSend);
      await handleDynamicSecretsMessage({...message, requestId: 'req-legacy-retry'}, mockSend);

      expect(mockDbClient.credentialExists).not.toHaveBeenCalled();
      expect(mockDbClient.ensureCredentialAbsent).not.toHaveBeenCalled();
      expect(mockDbClient.revokeCredential).toHaveBeenCalledTimes(2);
      expect(mockDbClient.revokeCredential).toHaveBeenNthCalledWith(
        2,
        legacyRole.revocationStatements,
        'v_legacy_abc12345'
      );
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1]).toMatchObject({
        event: 'dynamic-secrets.revoked',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-legacy-retry',
        leaseId: 'lease-legacy',
        roleId: 'role-123',
        username: 'v_legacy_abc12345',
        success: true,
      });
    });

    it('rejects arbitrary SQL on a disabled MySQL role before client access', async () => {
      const unsafeDisabledRole = {
        ...mockConfig.roles[1],
        generationEnabled: false,
        templateBacked: false,
        creationStatements: [
          "CREATE USER '{{username}}'@'localhost' IDENTIFIED BY '{{password}}'",
        ],
        revocationStatements: ['CALL arbitrary_revoke("{{username}}")'],
      };
      vi.mocked(configStore.getConfig).mockReturnValue({
        ...mockConfig,
        connectionType: 'MYSQL',
        roles: [unsafeDisabledRole],
      });
      vi.mocked(configStore.getRoleConfig).mockReturnValue(unsafeDisabledRole);
      const message: DynamicSecretsRevokeRequest = {
        event: 'dynamic-secrets.revoke-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-unsafe-disabled',
        connectionId: 'conn-123',
        roleId: unsafeDisabledRole.roleId,
        leaseId: 'lease-unsafe-disabled',
        username: 'v_legacy_abc12345',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(dbClients.getOrCreateClient).not.toHaveBeenCalled();
      expect(mockDbClient.credentialExists).not.toHaveBeenCalled();
      expect(mockDbClient.revokeCredential).not.toHaveBeenCalled();
      expect(mockDbClient.ensureCredentialAbsent).not.toHaveBeenCalled();
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.revoked',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        roleId: unsafeDisabledRole.roleId,
        username: 'v_legacy_abc12345',
        success: false,
      });
      expect(loggerSpies.error).toHaveBeenCalledWith(
        expect.objectContaining({errorCode: 'UNSAFE_DISABLED_MYSQL_LIFECYCLE'}),
        'Disabled raw role revocation contract is not replay-safe'
      );
    });

    it('returns exact success after revoke error only when an absence recheck proves it', async () => {
      mockDbClient.credentialExists
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      mockDbClient.revokeCredential.mockRejectedValue(
        new Error("DROP USER raw-sql password='canary-secret'")
      );
      const message: DynamicSecretsRevokeRequest = {
        event: 'dynamic-secrets.revoke-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-error-absent',
        connectionId: 'conn-123',
        roleId: 'role-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.revoked',
        success: true,
      });
      expect(JSON.stringify(loggerSpies.error.mock.calls)).not.toContain('canary-secret');
      expect(JSON.stringify(loggerSpies.error.mock.calls)).not.toContain('DROP USER');
    });

    it('uses exact MySQL missing-user proof when least-privilege catalog probes are denied', async () => {
      const mysqlRole = {
        ...mockConfig.roles[0],
        creationStatements: [
          "CREATE USER '{{username}}'@'%' IDENTIFIED BY '{{password}}'",
          "GRANT SELECT ON app.* TO '{{username}}'@'%'",
        ],
        revocationStatements: ["DROP USER '{{username}}'@'%'"],
      };
      vi.mocked(configStore.getConfig).mockReturnValue({
        ...mockConfig,
        connectionType: 'MYSQL',
        roles: [mysqlRole],
      });
      vi.mocked(configStore.getRoleConfig).mockReturnValue(mysqlRole);
      mockDbClient.credentialExists.mockRejectedValue(
        new Error('SELECT command denied on mysql.user raw-canary')
      );
      mockDbClient.revokeCredential.mockRejectedValue(Object.assign(
        new Error("Operation DROP USER failed for 'v_readonly_abc12345'@'%'"),
        {code: 'ER_CANNOT_USER', errno: 1396, sql: "DROP USER raw-canary"}
      ));
      const message: DynamicSecretsRevokeRequest = {
        event: 'dynamic-secrets.revoke-v2',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        requestId: 'req-mysql-retry',
        connectionId: 'conn-123',
        roleId: 'role-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(mockDbClient.credentialExists).toHaveBeenCalledTimes(2);
      expect(mockDbClient.revokeCredential).toHaveBeenCalledTimes(1);
      expect(mockDbClient.ensureCredentialAbsent).toHaveBeenCalledWith(
        'v_readonly_abc12345'
      );
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.revoked',
        protocolVersion: 2,
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        roleId: 'role-123',
        username: 'v_readonly_abc12345',
        success: true,
      });
      const logs = JSON.stringify(loggerSpies.error.mock.calls);
      expect(logs).not.toContain('raw-canary');
      expect(logs).not.toContain('mysql.user');
    });
  });

  describe('Renew Credentials Handler', () => {
    const mockConfig = {
      connectionId: 'conn-123',
      configVersion: 1,
      targetVersion: 1,
      connectionType: 'POSTGRESQL' as const,
      connectionString: 'postgresql://admin:pass@localhost:5432/db',
      connectionTimeoutSeconds: 30,
      maxOpenConnections: 5,
      roles: [
        {
          roleId: 'role-123',
          roleVersion: 1,
          templateBacked: true,
          roleName: 'readonly',
          usernameTemplate: 'v_{{role}}_{{random:8}}',
          creationStatements: ['CREATE USER "{{username}}" WITH PASSWORD \'{{password}}\''],
          revocationStatements: ['DROP USER IF EXISTS "{{username}}"'],
          renewStatements: ['ALTER ROLE "{{username}}" VALID UNTIL \'{{expiration}}\''],
          defaultTtlSeconds: 3600,
          maxTtlSeconds: 86400,
        },
      ],
    };

    const mockDbClient = {
      testConnection: vi.fn(),
      createCredential: vi.fn(),
      revokeCredential: vi.fn(),
      credentialExists: vi.fn(),
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
        event: 'dynamic-secrets.renew-v2',
        protocolVersion: 2,
        requestId: 'req-123',
        connectionId: 'conn-123',
        roleId: 'role-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
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
        event: 'dynamic-secrets.renewed-v2',
        protocolVersion: 2,
        requestId: 'req-123',
        leaseId: 'lease-123',
        connectionId: 'conn-123',
        roleId: 'role-123',
        username: 'v_readonly_abc12345',
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        success: true,
        newExpiresAt,
      });
    });

    it('should skip renewal if no renewal statements configured', async () => {
      const configWithoutRenew = {
        ...mockConfig,
        connectionType: 'MYSQL' as const,
        roles: [{
          ...mockConfig.roles[0],
          renewStatements: [],
        }],
      };
      vi.mocked(configStore.getConfig).mockReturnValue(configWithoutRenew);
      vi.mocked(configStore.getRoleConfig).mockReturnValue(configWithoutRenew.roles[0]);

      const newExpiresAt = new Date(Date.now() + 7200000).toISOString();

      const message: DynamicSecretsRenewRequest = {
        event: 'dynamic-secrets.renew-v2',
        protocolVersion: 2,
        requestId: 'req-123',
        connectionId: 'conn-123',
        roleId: 'role-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        newExpiresAt,
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      // Should NOT call renewCredential
      expect(mockDbClient.renewCredential).not.toHaveBeenCalled();

      // But should still respond with success
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.renewed-v2',
        protocolVersion: 2,
        requestId: 'req-123',
        success: true,
      });
    });

    it('rejects identity-changing renewal SQL before acquiring a client', async () => {
      const unsafeConfig = {
        ...mockConfig,
        roles: [{
          ...mockConfig.roles[0],
          renewStatements: ['ALTER ROLE "{{username}}" RENAME TO orphan'],
        }],
      };
      vi.mocked(configStore.getConfig).mockReturnValue(unsafeConfig);
      vi.mocked(configStore.getRoleConfig).mockReturnValue(unsafeConfig.roles[0]);
      const message: DynamicSecretsRenewRequest = {
        event: 'dynamic-secrets.renew-v2',
        protocolVersion: 2,
        requestId: 'req-unsafe-renew',
        connectionId: 'conn-123',
        roleId: 'role-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        newExpiresAt: new Date(Date.now() + 7200000).toISOString(),
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(dbClients.getOrCreateClient).not.toHaveBeenCalled();
      expect(sentMessages).toEqual([expect.objectContaining({
        event: 'dynamic-secrets.renewed-v2',
        requestId: 'req-unsafe-renew',
        success: false,
      })]);
    });

    it('fails closed before client acquisition when config or role epochs mismatch', async () => {
      const message: DynamicSecretsRenewRequest = {
        event: 'dynamic-secrets.renew-v2',
        protocolVersion: 2,
        requestId: 'req-mismatch',
        connectionId: 'conn-123',
        roleId: 'role-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        configVersion: 2,
        targetVersion: 1,
        roleVersion: 1,
        newExpiresAt: new Date(Date.now() + 7200000).toISOString(),
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(dbClients.getOrCreateClient).not.toHaveBeenCalled();
      expect(mockDbClient.renewCredential).not.toHaveBeenCalled();
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.renewed-v2',
        protocolVersion: 2,
        requestId: 'req-mismatch',
        configVersion: 2,
        targetVersion: 1,
        roleVersion: 1,
        success: false,
      });
    });

    it('returns false proof and never exposes a target error when renewal SQL fails', async () => {
      const canary = 'password=renew-canary; ALTER ROLE secret';
      mockDbClient.renewCredential.mockRejectedValue(new Error(canary));
      const message: DynamicSecretsRenewRequest = {
        event: 'dynamic-secrets.renew-v2',
        protocolVersion: 2,
        requestId: 'req-failed',
        connectionId: 'conn-123',
        roleId: 'role-123',
        leaseId: 'lease-123',
        username: 'v_readonly_abc12345',
        configVersion: 1,
        targetVersion: 1,
        roleVersion: 1,
        newExpiresAt: new Date(Date.now() + 7200000).toISOString(),
        timestamp: new Date().toISOString(),
      };

      await handleDynamicSecretsMessage(message, mockSend);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatchObject({
        event: 'dynamic-secrets.renewed-v2',
        success: false,
      });
      expect(JSON.stringify({sentMessages, logs: loggerSpies.error.mock.calls}))
        .not.toContain(canary);
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
