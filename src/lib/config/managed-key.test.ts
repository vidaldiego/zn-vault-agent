// Path: src/lib/config/managed-key.test.ts

/**
 * syncManagedKeyFile verification tests.
 *
 * Regression coverage for INC-2026-06-12-01: a stale config value (e.g. from
 * a read-only system config) must NOT clobber a valid, freshly rotated key
 * file. The config value is probed against the vault before auto-fixing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./loader.js', () => ({
  loadConfig: vi.fn(),
  isConfigInMemory: vi.fn(() => false),
}));

vi.mock('./saver.js', () => ({
  saveConfig: vi.fn(),
}));

vi.mock('./storage.js', () => ({
  getConfigDir: () => '/etc/zn-vault-agent',
  getConfigFile: () => '/etc/zn-vault-agent/config.json',
  userConfig: { path: '/home/test/.config/zn-vault-agent/config.json', store: {} },
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

vi.mock('../../utils/shell.js', () => ({
  chownSafe: vi.fn(),
}));

vi.mock('../../utils/path.js', () => ({
  validateOutputPath: vi.fn(), // allow temp dirs in tests
}));

import { loadConfig } from './loader.js';
import { syncManagedKeyFile, type ManagedKeyProbeResult } from './managed-key.js';

const CONFIG_KEY = 'znv_config_key_aaaaaaaaaaaaaaaa';
const DISK_KEY = 'znv_disk_key_bbbbbbbbbbbbbbbbbb';

describe('syncManagedKeyFile probe-before-auto-fix', () => {
  let tmpDir: string;
  let keyFilePath: string;

  function mockConfigWithKey(apiKey: string | undefined): void {
    vi.mocked(loadConfig).mockReturnValue({
      vaultUrl: 'https://vault.test',
      tenantId: 'test',
      auth: { apiKey },
      targets: [],
      secretTargets: [],
      managedKey: {
        name: 'test-managed-key',
        filePath: keyFilePath,
      },
    } as unknown as ReturnType<typeof loadConfig>);
  }

  function probeReturning(result: ManagedKeyProbeResult) {
    return vi.fn(async (_key: string) => result);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-vault-agent-mk-test-'));
    keyFilePath = path.join(tmpDir, 'api-key');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_should_not_probe_when_file_already_in_sync', async () => {
    mockConfigWithKey(CONFIG_KEY);
    fs.writeFileSync(keyFilePath, CONFIG_KEY);
    const probe = probeReturning('invalid');

    const result = await syncManagedKeyFile({ probeKey: probe });

    expect(result).toEqual({ synced: true, wasOutOfSync: false });
    expect(probe).not.toHaveBeenCalled();
    expect(fs.readFileSync(keyFilePath, 'utf-8')).toBe(CONFIG_KEY);
  });

  it('test_should_keep_existing_file_when_config_key_fails_auth', async () => {
    mockConfigWithKey(CONFIG_KEY);
    fs.writeFileSync(keyFilePath, DISK_KEY); // valid-looking, freshly rotated key
    const probe = probeReturning('invalid');

    const result = await syncManagedKeyFile({ probeKey: probe });

    expect(probe).toHaveBeenCalledWith(CONFIG_KEY);
    expect(result.synced).toBe(true);
    expect(result.wasOutOfSync).toBe(true);
    expect(result.keptExistingFile).toBe(true);
    expect(result.staleConfigValue).toBe(true);
    // CRITICAL: the on-disk key was NOT clobbered by the stale config value
    expect(fs.readFileSync(keyFilePath, 'utf-8')).toBe(DISK_KEY);
  });

  it('test_should_auto_fix_file_when_config_key_is_valid', async () => {
    mockConfigWithKey(CONFIG_KEY);
    fs.writeFileSync(keyFilePath, DISK_KEY);
    const probe = probeReturning('valid');

    const result = await syncManagedKeyFile({ probeKey: probe });

    expect(probe).toHaveBeenCalledWith(CONFIG_KEY);
    expect(result.synced).toBe(true);
    expect(result.wasOutOfSync).toBe(true);
    expect(result.keptExistingFile).toBeUndefined();
    expect(fs.readFileSync(keyFilePath, 'utf-8')).toBe(CONFIG_KEY);
    // The previous (valid-looking) key was preserved as a backup
    expect(fs.readFileSync(`${keyFilePath}.backup`, 'utf-8')).toBe(DISK_KEY);
  });

  it('test_should_auto_fix_file_when_probe_is_inconclusive', async () => {
    // Vault unreachable: preserve the pre-incident auto-fix behaviour so a
    // transient outage doesn't block legitimate repairs.
    mockConfigWithKey(CONFIG_KEY);
    fs.writeFileSync(keyFilePath, DISK_KEY);
    const probe = probeReturning('unknown');

    const result = await syncManagedKeyFile({ probeKey: probe });

    expect(result.synced).toBe(true);
    expect(result.wasOutOfSync).toBe(true);
    expect(fs.readFileSync(keyFilePath, 'utf-8')).toBe(CONFIG_KEY);
  });

  it('test_should_write_without_probing_when_file_is_missing', async () => {
    // Nothing to protect: an absent file is simply created from config.
    mockConfigWithKey(CONFIG_KEY);
    const probe = probeReturning('invalid');

    const result = await syncManagedKeyFile({ probeKey: probe });

    expect(probe).not.toHaveBeenCalled();
    expect(result.synced).toBe(true);
    expect(result.wasOutOfSync).toBe(true);
    expect(fs.readFileSync(keyFilePath, 'utf-8')).toBe(CONFIG_KEY);
  });

  it('test_should_write_without_probing_when_file_is_corrupted', async () => {
    // Corrupted (non znv_) content is not a valid key - nothing to protect.
    mockConfigWithKey(CONFIG_KEY);
    fs.writeFileSync(keyFilePath, 'garbage-not-a-key');
    const probe = probeReturning('invalid');

    const result = await syncManagedKeyFile({ probeKey: probe });

    expect(probe).not.toHaveBeenCalled();
    expect(result.synced).toBe(true);
    expect(fs.readFileSync(keyFilePath, 'utf-8')).toBe(CONFIG_KEY);
  });

  it('test_should_fail_when_no_api_key_in_config', async () => {
    mockConfigWithKey(undefined);
    fs.writeFileSync(keyFilePath, DISK_KEY);

    const result = await syncManagedKeyFile({ probeKey: probeReturning('valid') });

    expect(result.synced).toBe(false);
    expect(result.error).toBe('No API key in config');
    expect(fs.readFileSync(keyFilePath, 'utf-8')).toBe(DISK_KEY);
  });
});
