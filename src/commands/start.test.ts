import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {
    vaultUrl: 'https://vault.example.test',
    tenantId: '',
    auth: { bootstrapToken: 'expired-bootstrap-token' },
    targets: [],
    secretTargets: [],
    configFromVault: true,
  } as Record<string, unknown>,
  isConfigured: vi.fn(),
  loadConfig: vi.fn(),
  loadPersistedConfig: vi.fn(),
  getTargets: vi.fn(),
  getSecretTargets: vi.fn(),
  isManagedKeyMode: vi.fn(),
  setConfigInMemory: vi.fn(),
  fetchConfigFromVault: vi.fn(),
  isConfigFromVaultEnabled: vi.fn(),
  discoverAgentIdentity: vi.fn(),
  saveConfig: vi.fn(),
  validateConfig: vi.fn(),
  formatValidationResult: vi.fn(),
  startDaemon: vi.fn(),
  needsBootstrapRegistration: vi.fn(),
  exchangeBootstrapToken: vi.fn(),
  applyRegistrationResult: vi.fn(),
  loadUpdateConfig: vi.fn(),
  buildAutoUpdateService: vi.fn(),
  loadPluginUpdateConfig: vi.fn(),
  pluginConstructor: vi.fn(),
  pluginStart: vi.fn(),
  inspectConfiguredPayaraManifest: vi.fn(),
  inspectPayaraStartupPreflight: vi.fn(),
  inspectPayaraPostUpdateRecoveryEvidence: vi.fn(),
}));

vi.mock('../lib/config.js', () => ({
  isConfigured: mocks.isConfigured,
  loadConfig: mocks.loadConfig,
  loadPersistedConfig: mocks.loadPersistedConfig,
  getTargets: mocks.getTargets,
  getSecretTargets: mocks.getSecretTargets,
  isManagedKeyMode: mocks.isManagedKeyMode,
  setConfigInMemory: mocks.setConfigInMemory,
  fetchConfigFromVault: mocks.fetchConfigFromVault,
  isConfigFromVaultEnabled: mocks.isConfigFromVaultEnabled,
  discoverAgentIdentity: mocks.discoverAgentIdentity,
  saveConfig: mocks.saveConfig,
  DEFAULT_EXEC_CONFIG: {
    command: [],
    secrets: [],
    inheritEnv: true,
    restartOnChange: true,
    restartDelayMs: 5_000,
    maxRestarts: 10,
    restartWindowMs: 300_000,
  },
}));

vi.mock('../lib/validation.js', () => ({
  validateConfig: mocks.validateConfig,
  formatValidationResult: mocks.formatValidationResult,
}));

vi.mock('../lib/websocket.js', () => ({ startDaemon: mocks.startDaemon }));

vi.mock('../lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../lib/auth/bootstrap.js', () => ({
  needsBootstrapRegistration: mocks.needsBootstrapRegistration,
  exchangeBootstrapToken: mocks.exchangeBootstrapToken,
  applyRegistrationResult: mocks.applyRegistrationResult,
}));

vi.mock('../services/npm-auto-update.js', () => ({
  loadUpdateConfig: mocks.loadUpdateConfig,
}));

vi.mock('../services/auto-update-builder.js', () => ({
  buildAutoUpdateService: mocks.buildAutoUpdateService,
}));

vi.mock('../services/plugin-auto-update.js', () => ({
  PluginAutoUpdateService: class {
    start = mocks.pluginStart;

    constructor(plugins: unknown, config: unknown) {
      mocks.pluginConstructor(plugins, config, this);
    }
  },
  loadPluginUpdateConfig: mocks.loadPluginUpdateConfig,
}));

vi.mock('../plugins/loader.js', () => ({
  inspectConfiguredPayaraManifest: mocks.inspectConfiguredPayaraManifest,
  inspectPayaraStartupPreflight: mocks.inspectPayaraStartupPreflight,
}));

vi.mock('../services/plugin-update-rail.js', () => ({
  PAYARA_PLUGIN_PACKAGE: '@zincapp/znvault-plugin-payara',
  inspectPayaraPostUpdateRecoveryEvidence: mocks.inspectPayaraPostUpdateRecoveryEvidence,
}));

vi.mock('../lib/secret-env.js', () => ({
  parseSecretMapping: vi.fn(),
  isSensitiveEnvVar: vi.fn(() => false),
}));

import {
  probeFullVaultConfigurationAuthority,
  registerStartCommand,
} from './start.js';

async function runStart(): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStartCommand(program);
  await program.parseAsync(['node', 'test', 'start', '--health-port', '9100']);
}

describe('start command Payara recovery preflight', () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config = {
      vaultUrl: 'https://vault.example.test',
      tenantId: '',
      auth: { bootstrapToken: 'expired-bootstrap-token' },
      targets: [],
      secretTargets: [],
      configFromVault: true,
    };
    mocks.loadConfig.mockImplementation(() => mocks.config);
    mocks.loadPersistedConfig.mockImplementation(() => mocks.config);
    mocks.getTargets.mockReturnValue([]);
    mocks.getSecretTargets.mockReturnValue([]);
    mocks.isManagedKeyMode.mockReturnValue(false);
    mocks.isConfigFromVaultEnabled.mockImplementation(
      (config: { configFromVault?: boolean }) => config.configFromVault === true
    );
    mocks.validateConfig.mockReturnValue({ valid: true, errors: [], warnings: [] });
    mocks.formatValidationResult.mockReturnValue('valid');
    mocks.loadUpdateConfig.mockReturnValue({ enabled: true });
    mocks.loadPluginUpdateConfig.mockReturnValue({
      enabled: true,
      checkIntervalMs: 300_000,
      defaultChannel: 'dr-m4',
      stagedRolloutMaxDelayMs: 0,
    });
    mocks.buildAutoUpdateService.mockReturnValue({
      service: { stop: vi.fn() },
      started: false,
    });
    mocks.startDaemon.mockResolvedValue(undefined);
    mocks.inspectPayaraPostUpdateRecoveryEvidence.mockReturnValue(null);
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });

  it('opens exact recovery without bootstrap, identity discovery, or Vault config fetch', async () => {
    mocks.isConfigured.mockReturnValue(false);
    mocks.needsBootstrapRegistration.mockReturnValue(true);
    mocks.inspectPayaraStartupPreflight.mockReturnValue({
      configured: true,
      recoveryRequired: true,
      version: '2.9.0',
    });
    mocks.inspectConfiguredPayaraManifest.mockReturnValue({
      configured: true,
      recoveryRequired: true,
      version: '2.9.0',
    });
    mocks.exchangeBootstrapToken.mockRejectedValue(new Error('Vault unavailable'));
    mocks.discoverAgentIdentity.mockRejectedValue(new Error('Vault unavailable'));
    mocks.fetchConfigFromVault.mockRejectedValue(new Error('Vault unavailable'));

    await expect(runStart()).resolves.toBeUndefined();

    expect(mocks.isConfigured).toHaveBeenCalledOnce();
    expect(mocks.exchangeBootstrapToken).not.toHaveBeenCalled();
    expect(mocks.discoverAgentIdentity).not.toHaveBeenCalled();
    expect(mocks.fetchConfigFromVault).not.toHaveBeenCalled();
    expect(mocks.setConfigInMemory).toHaveBeenCalledOnce();
    const recoveryConfig = mocks.setConfigInMemory.mock.calls[0]?.[0];
    expect(recoveryConfig).toMatchObject({
      configFromVault: true,
      plugins: [{
        package: '@zincapp/znvault-plugin-payara',
        enabled: true,
        autoUpdate: { enabled: false },
      }],
    });
    expect(mocks.buildAutoUpdateService).toHaveBeenCalledWith(
      { enabled: true },
      false,
      true
    );
    expect(mocks.pluginConstructor).toHaveBeenCalledWith(
      recoveryConfig.plugins,
      expect.objectContaining({ enabled: false }),
      expect.anything()
    );
    expect(mocks.pluginStart).toHaveBeenCalledOnce();
    expect(mocks.startDaemon).toHaveBeenCalledWith(expect.objectContaining({
      healthPort: 9100,
      expectedPayaraRecoveryVersion: '2.9.0',
      pluginAutoUpdateService: expect.anything(),
      npmAutoUpdateService: expect.anything(),
    }));
  });

  it('keeps the normal remote-config failure path when recovery is not inferred', async () => {
    mocks.config = {
      ...mocks.config,
      auth: { apiKey: 'test-only-api-key' },
      agentId: '11111111-1111-4111-8111-111111111111',
    };
    mocks.isConfigured.mockReturnValue(true);
    mocks.needsBootstrapRegistration.mockReturnValue(false);
    mocks.inspectPayaraStartupPreflight.mockReturnValue({
      configured: false,
      recoveryRequired: false,
    });
    mocks.fetchConfigFromVault.mockRejectedValue(new Error('Vault unavailable'));

    await expect(runStart()).rejects.toThrow('Vault unavailable');

    expect(mocks.fetchConfigFromVault).toHaveBeenCalledOnce();
    expect(mocks.setConfigInMemory).not.toHaveBeenCalled();
    expect(mocks.pluginConstructor).not.toHaveBeenCalled();
    expect(mocks.startDaemon).not.toHaveBeenCalled();
  });

  it('lets a successful remote config remove stale cached Payara authority', async () => {
    mocks.config = {
      ...mocks.config,
      auth: { apiKey: 'test-only-api-key' },
      agentId: '11111111-1111-4111-8111-111111111111',
      plugins: [{ package: '@zincapp/znvault-plugin-payara', enabled: true }],
    };
    mocks.isConfigured.mockReturnValue(true);
    mocks.needsBootstrapRegistration.mockReturnValue(false);
    mocks.inspectPayaraStartupPreflight.mockReturnValue({
      configured: true,
      recoveryRequired: true,
      version: '2.9.0',
    });
    mocks.fetchConfigFromVault.mockResolvedValue({
      success: true,
      modified: true,
      version: 8,
      config: {
        vaultUrl: 'https://vault.example.test',
        tenantId: 'tenant-from-vault',
        auth: { apiKey: 'ignored-remote-copy' },
        targets: [],
        secretTargets: [],
        configFromVault: true,
        configVersion: 8,
      },
    });
    mocks.inspectConfiguredPayaraManifest.mockReturnValue({
      configured: false,
      recoveryRequired: false,
    });

    await expect(runStart()).resolves.toBeUndefined();

    expect(mocks.fetchConfigFromVault).toHaveBeenCalledOnce();
    const authoritativeConfig = mocks.inspectConfiguredPayaraManifest.mock.calls[0]?.[0];
    expect(authoritativeConfig).toMatchObject({ tenantId: 'tenant-from-vault' });
    expect(authoritativeConfig.plugins).toBeUndefined();
    expect(mocks.pluginConstructor).not.toHaveBeenCalled();
    expect(mocks.startDaemon).toHaveBeenCalledWith(expect.objectContaining({
      expectedPayaraRecoveryVersion: undefined,
      pluginAutoUpdateService: null,
    }));
  });

  it('uses exact major 2 only after the authoritative config fetch fails', async () => {
    mocks.config = {
      ...mocks.config,
      auth: { apiKey: 'test-only-api-key' },
      agentId: '11111111-1111-4111-8111-111111111111',
      targets: [{ certId: 'stale-cert', name: 'stale' }],
      secretTargets: [{ secretId: 'stale-secret', name: 'stale' }],
      exec: { command: ['stale-child'], secrets: [] },
      globalReloadCmd: 'stale-reload',
      plugins: [
        { package: '@zincapp/stale-plugin', enabled: true },
        { package: '@zincapp/znvault-plugin-payara', enabled: true },
      ],
    };
    mocks.isConfigured.mockReturnValue(true);
    mocks.needsBootstrapRegistration.mockReturnValue(false);
    mocks.inspectPayaraStartupPreflight.mockReturnValue({
      configured: true,
      recoveryRequired: true,
      version: '2.9.0',
    });
    mocks.fetchConfigFromVault.mockResolvedValue({
      success: false,
      error: 'Vault unavailable',
    });
    mocks.inspectConfiguredPayaraManifest.mockReturnValue({
      configured: true,
      recoveryRequired: true,
      version: '2.9.0',
    });

    await expect(runStart()).resolves.toBeUndefined();

    expect(mocks.fetchConfigFromVault).toHaveBeenCalledOnce();
    const recoveryConfig = mocks.setConfigInMemory.mock.calls[0]?.[0];
    expect(recoveryConfig).toMatchObject({
      targets: [],
      secretTargets: [],
      plugins: [{
        package: '@zincapp/znvault-plugin-payara',
        enabled: true,
        autoUpdate: { enabled: false },
      }],
    });
    expect(recoveryConfig.exec).toBeUndefined();
    expect(recoveryConfig.globalReloadCmd).toBeUndefined();
    expect(mocks.pluginConstructor).toHaveBeenCalledOnce();
    expect(mocks.startDaemon).toHaveBeenCalledWith(expect.objectContaining({
      expectedPayaraRecoveryVersion: '2.9.0',
    }));
  });

  it.each(['corrupt', 'future-v4'])('ignores a %s stale local plugin cache when Vault returns a healthy config', async () => {
    mocks.config = {
      ...mocks.config,
      auth: { apiKey: 'test-only-api-key' },
      agentId: '11111111-1111-4111-8111-111111111111',
      plugins: [{ package: '@zincapp/znvault-plugin-payara', enabled: true }],
    };
    mocks.isConfigured.mockReturnValue(true);
    mocks.needsBootstrapRegistration.mockReturnValue(false);
    mocks.inspectPayaraStartupPreflight.mockReturnValue({
      configured: false,
      recoveryRequired: false,
    });
    mocks.fetchConfigFromVault.mockResolvedValue({
      success: true,
      modified: true,
      version: 9,
      config: {
        vaultUrl: 'https://vault.example.test',
        tenantId: 'tenant-from-vault',
        auth: { apiKey: 'ignored-remote-copy' },
        targets: [],
        secretTargets: [],
        configFromVault: true,
        configVersion: 9,
      },
    });
    mocks.inspectConfiguredPayaraManifest.mockReturnValue({
      configured: false,
      recoveryRequired: false,
    });

    await expect(runStart()).resolves.toBeUndefined();

    expect(mocks.fetchConfigFromVault).toHaveBeenCalledOnce();
    expect(mocks.pluginConstructor).not.toHaveBeenCalled();
    expect(mocks.startDaemon).toHaveBeenCalledOnce();
  });

  it('falls back to exact recovery when bootstrap registration fails', async () => {
    mocks.isConfigured.mockReturnValue(true);
    mocks.needsBootstrapRegistration.mockReturnValue(true);
    mocks.inspectPayaraStartupPreflight.mockReturnValue({
      configured: true,
      recoveryRequired: true,
      version: '2.9.0',
    });
    mocks.inspectConfiguredPayaraManifest.mockReturnValue({
      configured: true,
      recoveryRequired: true,
      version: '2.9.0',
    });
    mocks.exchangeBootstrapToken.mockRejectedValue(new Error('Vault unavailable'));

    await expect(runStart()).resolves.toBeUndefined();

    expect(mocks.exchangeBootstrapToken).toHaveBeenCalledOnce();
    expect(mocks.fetchConfigFromVault).not.toHaveBeenCalled();
    expect(mocks.startDaemon).toHaveBeenCalledWith(expect.objectContaining({
      expectedPayaraRecoveryVersion: '2.9.0',
    }));
  });

  it('keeps root-attested Payara 3 status pending when Vault is unavailable', async () => {
    mocks.config = {
      ...mocks.config,
      auth: { apiKey: 'test-only-api-key' },
      agentId: '11111111-1111-4111-8111-111111111111',
      configVersion: 17,
      targets: [{ certId: 'stale-cert', name: 'stale' }],
      exec: { command: ['stale-child'], secrets: [] },
    };
    mocks.isConfigured.mockReturnValue(true);
    mocks.needsBootstrapRegistration.mockReturnValue(false);
    mocks.inspectPayaraStartupPreflight.mockReturnValue({
      configured: false,
      recoveryRequired: false,
    });
    mocks.inspectPayaraPostUpdateRecoveryEvidence.mockReturnValue({
      requestId: '11111111-1111-4111-8111-111111111111',
      previousVersion: '2.9.0',
      targetVersion: '3.0.0',
    });
    mocks.fetchConfigFromVault.mockResolvedValue({
      success: false,
      error: 'Vault unavailable',
    });
    mocks.inspectConfiguredPayaraManifest.mockReturnValue({
      configured: true,
      recoveryRequired: false,
      version: '3.0.0',
    });

    await expect(runStart()).resolves.toBeUndefined();

    expect(mocks.fetchConfigFromVault).toHaveBeenCalledWith(expect.objectContaining({
      configVersion: undefined,
    }));
    const recoveryConfig = mocks.setConfigInMemory.mock.calls.at(-1)?.[0];
    expect(recoveryConfig).toMatchObject({
      targets: [],
      secretTargets: [],
      plugins: [{
        package: '@zincapp/znvault-plugin-payara',
        enabled: true,
        autoUpdate: { enabled: false },
      }],
    });
    expect(recoveryConfig.exec).toBeUndefined();
    expect(mocks.startDaemon).toHaveBeenCalledWith(expect.objectContaining({
      expectedPayaraRecoveryVersion: undefined,
      expectedPayaraPostUpdateRecoveryVersion: '3.0.0',
      postUpdateAuthorityProbe: expect.any(Function),
    }));
  });

  it('requires a full 200 and does not accept a 304 during startup confirmation', async () => {
    mocks.config = {
      ...mocks.config,
      auth: { apiKey: 'test-only-api-key' },
      agentId: '11111111-1111-4111-8111-111111111111',
      configVersion: 17,
    };
    mocks.isConfigured.mockReturnValue(true);
    mocks.needsBootstrapRegistration.mockReturnValue(false);
    mocks.inspectPayaraStartupPreflight.mockReturnValue({
      configured: false,
      recoveryRequired: false,
    });
    mocks.inspectPayaraPostUpdateRecoveryEvidence.mockReturnValue({
      requestId: '11111111-1111-4111-8111-111111111111',
      previousVersion: '2.9.0',
      targetVersion: '3.0.0',
    });
    mocks.fetchConfigFromVault.mockResolvedValue({
      success: true,
      modified: false,
      version: 17,
    });
    mocks.inspectConfiguredPayaraManifest.mockReturnValue({
      configured: true,
      recoveryRequired: false,
      version: '3.0.0',
    });

    await expect(runStart()).resolves.toBeUndefined();

    expect(mocks.startDaemon).toHaveBeenCalledWith(expect.objectContaining({
      expectedPayaraPostUpdateRecoveryVersion: '3.0.0',
    }));
  });

  it('lets a healthy full remote config win over corrupt local post-update evidence', async () => {
    mocks.config = {
      ...mocks.config,
      auth: { apiKey: 'test-only-api-key' },
      agentId: '11111111-1111-4111-8111-111111111111',
      configVersion: 17,
    };
    mocks.isConfigured.mockReturnValue(true);
    mocks.needsBootstrapRegistration.mockReturnValue(false);
    mocks.inspectPayaraStartupPreflight.mockReturnValue({
      configured: false,
      recoveryRequired: false,
    });
    mocks.inspectPayaraPostUpdateRecoveryEvidence.mockImplementation(() => {
      throw new Error('corrupt local rail');
    });
    mocks.fetchConfigFromVault.mockResolvedValue({
      success: true,
      modified: true,
      version: 18,
      config: {
        vaultUrl: 'https://vault.example.test',
        tenantId: 'tenant-from-vault',
        auth: { apiKey: 'ignored-remote-copy' },
        targets: [],
        secretTargets: [],
        configFromVault: true,
        configVersion: 18,
        plugins: [{ package: '@zincapp/znvault-plugin-payara', enabled: true }],
      },
    });
    mocks.inspectConfiguredPayaraManifest.mockReturnValue({
      configured: true,
      recoveryRequired: false,
      version: '3.0.0',
    });

    await expect(runStart()).resolves.toBeUndefined();

    expect(mocks.fetchConfigFromVault).toHaveBeenCalledWith(expect.objectContaining({
      configVersion: undefined,
    }));
    expect(mocks.startDaemon).toHaveBeenCalledWith(expect.objectContaining({
      expectedPayaraRecoveryVersion: undefined,
      expectedPayaraPostUpdateRecoveryVersion: undefined,
      postUpdateAuthorityProbe: undefined,
    }));
  });

  it('fails closed on corrupt post-update evidence only after remote authority fails', async () => {
    mocks.config = {
      ...mocks.config,
      auth: { apiKey: 'test-only-api-key' },
      agentId: '11111111-1111-4111-8111-111111111111',
      configVersion: 17,
    };
    mocks.isConfigured.mockReturnValue(true);
    mocks.needsBootstrapRegistration.mockReturnValue(false);
    mocks.inspectPayaraStartupPreflight.mockReturnValue({
      configured: false,
      recoveryRequired: false,
    });
    mocks.inspectPayaraPostUpdateRecoveryEvidence.mockImplementation(() => {
      throw new Error('corrupt local rail');
    });
    mocks.fetchConfigFromVault.mockResolvedValue({
      success: false,
      error: 'Vault unavailable',
    });

    await expect(runStart()).rejects.toThrow('corrupt local rail');
    expect(mocks.fetchConfigFromVault).toHaveBeenCalledOnce();
    expect(mocks.startDaemon).not.toHaveBeenCalled();
  });

  it('re-reads repaired persisted bootstrap state before probing full authority', async () => {
    const persisted = {
      vaultUrl: 'https://vault.example.test',
      tenantId: '',
      auth: { bootstrapToken: 'test-bootstrap-token' },
      targets: [],
      secretTargets: [],
      configFromVault: true,
    };
    const registered = {
      ...persisted,
      tenantId: 'tenant-from-bootstrap',
      auth: { apiKey: 'test-only-api-key' },
      agentId: '11111111-1111-4111-8111-111111111111',
    };
    mocks.loadPersistedConfig.mockReturnValue(persisted);
    mocks.isConfigFromVaultEnabled.mockReturnValue(true);
    mocks.needsBootstrapRegistration.mockReturnValue(true);
    mocks.exchangeBootstrapToken.mockResolvedValue({
      agentId: registered.agentId,
      tenantId: registered.tenantId,
    });
    mocks.applyRegistrationResult.mockReturnValue(registered);
    mocks.fetchConfigFromVault.mockResolvedValue({
      success: true,
      modified: true,
      version: 1,
      config: registered,
    });

    await expect(probeFullVaultConfigurationAuthority()).resolves.toBe(true);

    expect(mocks.loadPersistedConfig).toHaveBeenCalledOnce();
    expect(mocks.exchangeBootstrapToken).toHaveBeenCalledWith(persisted);
    expect(mocks.saveConfig).toHaveBeenCalledWith(registered);
    expect(mocks.fetchConfigFromVault).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'test-only-api-key',
      configVersion: undefined,
    }));
  });
});
