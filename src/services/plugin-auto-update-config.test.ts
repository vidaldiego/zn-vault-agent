import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPluginUpdateConfig } from './plugin-auto-update.js';

describe('loadPluginUpdateConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PLUGIN_AUTO_UPDATE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('keeps plugin auto-update disabled by default', () => {
    expect(loadPluginUpdateConfig().enabled).toBe(false);
  });

  it.each(['true', '1'])('enables plugin auto-update when PLUGIN_AUTO_UPDATE=%s', (value) => {
    process.env.PLUGIN_AUTO_UPDATE = value;

    expect(loadPluginUpdateConfig().enabled).toBe(true);
  });

  it.each(['false', '0'])('keeps plugin auto-update disabled when PLUGIN_AUTO_UPDATE=%s', (value) => {
    process.env.PLUGIN_AUTO_UPDATE = value;

    expect(loadPluginUpdateConfig().enabled).toBe(false);
  });
});
