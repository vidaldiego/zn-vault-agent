import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from './types.js';
vi.mock('./loader.js', () => ({ loadConfig: vi.fn() }));
vi.mock('./saver.js', () => ({ saveConfig: vi.fn() }));
import { loadConfig } from './loader.js';
import { updateSecretTargetVersion } from './targets.js';

describe('secret target version receipts', () => {
  it('commits only the successful named target when one secret feeds several files', () => {
    const config = { secretTargets: [
      { secretId: 'alias:synthetic/pfx', name: 'server', lastVersion: 1 },
      { secretId: 'alias:synthetic/pfx', name: 'bridge', lastVersion: 1 },
    ] } as AgentConfig;
    vi.mocked(loadConfig).mockReturnValue(config);
    // The previous ID-only lookup committed the first file for every target.
    (updateSecretTargetVersion as (id: string, version: number, name: string) => void)('alias:synthetic/pfx', 2, 'bridge');
    expect(config.secretTargets?.map(t => t.lastVersion)).toEqual([1, 2]);
  });
});
