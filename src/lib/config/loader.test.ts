// Path: src/lib/config/loader.test.ts

/**
 * Config loader shadowing-warning tests.
 *
 * Regression coverage for INC-2026-06-12-01: a root-owned, read-only system
 * config was read with precedence while runtime saves (rotated keys) landed
 * in the user config - silently running on stale credentials. The loader
 * must emit a prominent warning when this split-brain is detected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  systemConfigPath: '',
  userConfigPath: '',
  userStore: {} as Record<string, unknown>,
}));

vi.mock('./storage.js', () => ({
  getConfigDir: () => hoisted.systemConfigPath.replace(/\/[^/]*$/, ''),
  getConfigFile: () => hoisted.systemConfigPath,
  userConfig: {
    get path() { return hoisted.userConfigPath; },
    get store() { return hoisted.userStore; },
    set store(value: Record<string, unknown>) { hoisted.userStore = value; },
  },
}));

vi.mock('../logger.js', () => ({
  configLogger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { configLogger } from '../logger.js';
import {
  clearConfigInMemory,
  getConfigPath,
  isConfigInMemory,
  isConfigured,
  loadConfig,
  loadPersistedConfig,
  resetShadowWarningForTesting,
  setConfigInMemory,
} from './loader.js';

const realAccessSync = fs.accessSync.bind(fs);

const ENV_VARS = [
  'ZNVAULT_AGENT_CONFIG_DIR',
  'ZNVAULT_URL',
  'ZNVAULT_TENANT_ID',
  'ZNVAULT_API_KEY',
  'ZNVAULT_USERNAME',
  'ZNVAULT_PASSWORD',
  'ZNVAULT_INSECURE',
  'ZNVAULT_CA_CERT_PATH',
  'ZNVAULT_TLS_ENABLED',
  'ZNVAULT_TLS_CERT_PATH',
  'ZNVAULT_TLS_KEY_PATH',
  'ZNVAULT_TLS_HTTPS_PORT',
  'ZNVAULT_TLS_KEEP_HTTP',
] as const;

describe('loadConfig system-config shadowing warning', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function writeSystemConfig(config: Record<string, unknown>, options?: { readOnly?: boolean }): void {
    fs.writeFileSync(hoisted.systemConfigPath, JSON.stringify(config, null, 2), { mode: 0o644 });
    if (options?.readOnly) {
      fs.chmodSync(hoisted.systemConfigPath, 0o444);
    }
  }

  function setUserConfig(store: Record<string, unknown>): void {
    fs.writeFileSync(hoisted.userConfigPath, JSON.stringify(store, null, 2));
    hoisted.userStore = store;
  }

  function shadowWarnings(): unknown[][] {
    return vi.mocked(configLogger.warn).mock.calls.filter(
      (call) => typeof call[1] === 'string' && call[1].includes('SHADOWING')
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetShadowWarningForTesting();
    clearConfigInMemory();

    for (const key of ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-vault-agent-loader-test-'));
    hoisted.systemConfigPath = path.join(tmpDir, 'system', 'config.json');
    hoisted.userConfigPath = path.join(tmpDir, 'user', 'config.json');
    fs.mkdirSync(path.dirname(hoisted.systemConfigPath), { recursive: true });
    fs.mkdirSync(path.dirname(hoisted.userConfigPath), { recursive: true });
    hoisted.userStore = {};

    // Model the non-root service user's permission check even when the test
    // runner itself is root (for example inside a Docker release gate).
    vi.spyOn(fs, 'accessSync').mockImplementation((target, mode) => {
      if (
        String(target) === hoisted.systemConfigPath
        && mode === fs.constants.W_OK
        && (fs.statSync(hoisted.systemConfigPath).mode & 0o222) === 0
      ) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return realAccessSync(target, mode);
    });
  });

  afterEach(() => {
    clearConfigInMemory();
    for (const key of ENV_VARS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    // Make everything writable again so cleanup succeeds
    try { fs.chmodSync(hoisted.systemConfigPath, 0o644); } catch { /* may not exist */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('test_should_warn_when_readonly_system_config_differs_from_user_config', () => {
    writeSystemConfig(
      { vaultUrl: 'https://vault.test', tenantId: 't', auth: { apiKey: 'znv_stale_key' } },
      { readOnly: true }
    );
    setUserConfig({ vaultUrl: 'https://vault.test', tenantId: 't', auth: { apiKey: 'znv_fresh_key' } });

    const config = loadConfig();

    // System config still wins on load (documented precedence)...
    expect(config.auth.apiKey).toBe('znv_stale_key');
    // ...but the split-brain is loudly reported with both paths
    const warnings = shadowWarnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0][0]).toMatchObject({
      systemConfigPath: hoisted.systemConfigPath,
      userConfigPath: hoisted.userConfigPath,
    });
  });

  it('test_should_warn_only_once_across_repeated_loads', () => {
    writeSystemConfig(
      { vaultUrl: 'https://vault.test', tenantId: 't', auth: { apiKey: 'znv_stale_key' } },
      { readOnly: true }
    );
    setUserConfig({ vaultUrl: 'https://vault.test', tenantId: 't', auth: { apiKey: 'znv_fresh_key' } });

    loadConfig();
    loadConfig();
    loadConfig();

    expect(shadowWarnings().length).toBe(1);
  });

  it('test_should_not_warn_when_system_config_is_writable', () => {
    writeSystemConfig(
      { vaultUrl: 'https://vault.test', tenantId: 't', auth: { apiKey: 'znv_stale_key' } }
      // writable (0o644)
    );
    setUserConfig({ vaultUrl: 'https://vault.test', tenantId: 't', auth: { apiKey: 'znv_fresh_key' } });

    loadConfig();

    expect(shadowWarnings().length).toBe(0);
  });

  it('test_should_not_warn_when_configs_match', () => {
    const shared = { vaultUrl: 'https://vault.test', tenantId: 't', auth: { apiKey: 'znv_same_key' } };
    writeSystemConfig(shared, { readOnly: true });
    setUserConfig(shared);

    loadConfig();

    expect(shadowWarnings().length).toBe(0);
  });

  it('test_should_not_warn_when_user_config_is_absent_or_empty', () => {
    writeSystemConfig(
      { vaultUrl: 'https://vault.test', tenantId: 't', auth: { apiKey: 'znv_stale_key' } },
      { readOnly: true }
    );
    // No user config file at all
    loadConfig();
    expect(shadowWarnings().length).toBe(0);

    // User config file exists but holds no meaningful content (defaults)
    resetShadowWarningForTesting();
    setUserConfig({ vaultUrl: '', tenantId: '', auth: {} });
    loadConfig();
    expect(shadowWarnings().length).toBe(0);
  });

  it('test_should_allow_api_key_to_discover_tenant_on_first_request', () => {
    writeSystemConfig({
      vaultUrl: 'https://vault.test',
      tenantId: '',
      auth: { apiKey: 'znv_test_key' },
    });

    expect(isConfigured()).toBe(true);
  });

  it('test_should_allow_bootstrap_token_to_obtain_tenant_during_registration', () => {
    writeSystemConfig({
      vaultUrl: 'https://vault.test',
      tenantId: '',
      auth: { bootstrapToken: `zrt_${'a'.repeat(64)}` },
    });

    expect(isConfigured()).toBe(true);
  });

  it('test_should_still_require_tenant_for_password_auth', () => {
    writeSystemConfig({
      vaultUrl: 'https://vault.test',
      tenantId: '',
      auth: { username: 'operator', password: 'test-only' },
    });

    expect(isConfigured()).toBe(false);
  });

  it('test_should_reject_incomplete_password_auth_even_with_tenant', () => {
    writeSystemConfig({
      vaultUrl: 'https://vault.test',
      tenantId: 'tenant',
      auth: { username: 'operator' },
    });

    expect(isConfigured()).toBe(false);
  });

  it('test_should_accept_complete_password_auth_with_tenant', () => {
    writeSystemConfig({
      vaultUrl: 'https://vault.test',
      tenantId: 'tenant',
      auth: { username: 'operator', password: 'test-only' },
    });

    expect(isConfigured()).toBe(true);
  });

  it('test_should_report_explicit_config_path_even_before_file_exists', () => {
    process.env.ZNVAULT_AGENT_CONFIG_DIR = path.dirname(hoisted.systemConfigPath);

    expect(fs.existsSync(hoisted.systemConfigPath)).toBe(false);
    expect(getConfigPath()).toBe(hoisted.systemConfigPath);
  });

  it('reads repaired persisted auth without replacing the active runtime config', () => {
    writeSystemConfig({
      vaultUrl: 'https://vault.persisted.test',
      tenantId: 'persisted-tenant',
      auth: { apiKey: 'persisted-test-key' },
    });
    setConfigInMemory({
      vaultUrl: 'https://vault.runtime.test',
      tenantId: 'runtime-tenant',
      auth: { apiKey: 'runtime-test-key' },
      targets: [],
      secretTargets: [],
      configFromVault: true,
    });

    expect(loadPersistedConfig()).toMatchObject({
      vaultUrl: 'https://vault.persisted.test',
      auth: { apiKey: 'persisted-test-key' },
    });
    expect(isConfigInMemory()).toBe(true);
    expect(loadConfig()).toMatchObject({
      vaultUrl: 'https://vault.runtime.test',
      auth: { apiKey: 'runtime-test-key' },
    });
  });
});
