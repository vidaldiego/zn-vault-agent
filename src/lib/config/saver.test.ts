import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  systemConfigPath: '',
  userConfigPath: '',
  userStore: {} as Record<string, unknown>,
}));

vi.mock('./storage.js', () => ({
  getConfigDir: () => path.dirname(hoisted.systemConfigPath),
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

import { saveConfig } from './saver.js';

const realAccessSync = fs.accessSync.bind(fs);

describe('saveConfig system installation ownership', () => {
  let root: string;
  const originalOverride = process.env.ZNVAULT_AGENT_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.ZNVAULT_AGENT_CONFIG_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'znvault-saver-'));
    hoisted.systemConfigPath = path.join(root, 'system', 'config.json');
    hoisted.userConfigPath = path.join(root, 'user', 'config.json');
    fs.mkdirSync(path.dirname(hoisted.systemConfigPath), { recursive: true });
    fs.mkdirSync(path.dirname(hoisted.userConfigPath), { recursive: true });
    hoisted.userStore = {};

    vi.spyOn(process, 'getuid').mockReturnValue(1000);
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
    if (originalOverride === undefined) {
      delete process.env.ZNVAULT_AGENT_CONFIG_DIR;
    } else {
      process.env.ZNVAULT_AGENT_CONFIG_DIR = originalOverride;
    }
    try { fs.chmodSync(hoisted.systemConfigPath, 0o600); } catch { /* absent */ }
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('fails closed instead of saving to a shadow user config', () => {
    fs.writeFileSync(hoisted.systemConfigPath, '{}\n', { mode: 0o400 });

    expect(() => saveConfig({ vaultUrl: 'https://vault.test' } as never))
      .toThrow(/service user/);
    expect(hoisted.userStore).toEqual({});
    expect(fs.readFileSync(hoisted.systemConfigPath, 'utf8')).toBe('{}\n');
  });

  it('updates the writable system config in place', () => {
    fs.writeFileSync(hoisted.systemConfigPath, '{}\n', { mode: 0o600 });

    saveConfig({ vaultUrl: 'https://vault.test' } as never);

    expect(JSON.parse(fs.readFileSync(hoisted.systemConfigPath, 'utf8')))
      .toMatchObject({ vaultUrl: 'https://vault.test' });
    expect(hoisted.userStore).toEqual({});
  });

  it('retains per-user configuration when no system install exists', () => {
    saveConfig({ vaultUrl: 'https://vault.test' } as never);

    expect(hoisted.userStore).toMatchObject({ vaultUrl: 'https://vault.test' });
    expect(fs.existsSync(hoisted.systemConfigPath)).toBe(false);
  });
});
