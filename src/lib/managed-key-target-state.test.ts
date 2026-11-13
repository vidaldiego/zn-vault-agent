import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
vi.mock('./config/storage.js', () => ({ getConfigDir: () => process.env.ZNVAULT_AGENT_CONFIG_DIR }));
import { loadManagedKeyTargetState, saveManagedKeyTargetState } from './managed-key-target-state.js';
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-key-state-')); vi.stubEnv('ZNVAULT_AGENT_CONFIG_DIR', directory); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });
describe('public applied revision storage', () => {
  it('persists authority deadlines and custody metadata without material from excess fields', () => {
    const target = { id: 'reader', keyId: 'key-reader', output: '/run/zn-vault-agent/secrets/reader', owner: '996:987', mode: '0640' };
    const entry = { targetId: 'reader', keyId: 'key-reader', rotationCount: 8, expiresAt: '2027-01-01T00:00:00Z', target, key: 'synthetic-must-not-persist' };
    saveManagedKeyTargetState('host', { applied: [entry] });
    const serialized = fs.readFileSync(path.join(directory, 'managed-key-targets-host.json'), 'utf8');
    expect(serialized).not.toContain('synthetic-must-not-persist');
    expect(loadManagedKeyTargetState('host')?.applied[0]).toEqual({ targetId: 'reader', keyId: 'key-reader', rotationCount: 8, expiresAt: '2027-01-01T00:00:00Z', target });
  });
  it('ignores unsafe local metadata rather than trusting its claimed revision', () => {
    saveManagedKeyTargetState('host', { applied: [] }); fs.chmodSync(path.join(directory, 'managed-key-targets-host.json'), 0o666);
    expect(loadManagedKeyTargetState('host')).toBeUndefined();
  });
});

it('persists exact server snapshots separately from enforced minima without excess material', () => {
  const snapshot = { rotationCount: 3, expiresAt: '2027-01-01T00:00:00Z', authorizedUntil: '2026-12-01T00:00:00Z', graceExpiresAt: '2026-11-20T00:00:00Z', key: 'synthetic-never-persist-snapshot' };
  const minimum = '2026-11-15T00:00:00Z';
  saveManagedKeyTargetState('host', { own: { keyId:'key-agent',rotationCount:3,expiresAt:minimum }, ownSnapshot:snapshot, applied:[{ targetId:'reader',keyId:'key-reader',rotationCount:3,expiresAt:minimum,serverSnapshot:snapshot }] });
  const serialized = fs.readFileSync(path.join(directory,'managed-key-targets-host.json'),'utf8');
  expect(serialized).not.toContain('synthetic-never-persist-snapshot');
  const restored = loadManagedKeyTargetState('host'); const { key: _key, ...publicSnapshot } = snapshot;
  expect(restored?.ownSnapshot).toEqual(publicSnapshot); expect(restored?.applied[0].serverSnapshot).toEqual(publicSnapshot);
  expect(restored?.applied[0].expiresAt).toBe(minimum); expect(restored?.own?.expiresAt).toBe(minimum);
});
