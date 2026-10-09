import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretTarget } from './config.js';

vi.mock('./api.js', async (original) => ({
  ...await original<typeof import('./api.js')>(), getSecret: vi.fn(),
}));
vi.mock('./config.js', async (original) => ({
  ...await original<typeof import('./config.js')>(), updateSecretTargetVersion: vi.fn(), getSecretTargets: vi.fn(),
}));
import { getSecret } from './api.js';
import { updateSecretTargetVersion, getSecretTargets } from './config.js';
import { deploySecret, findSecretTargets } from './secret-deployer.js';
import { syncSecretTarget } from '../commands/secrets.js';
import { acknowledgeSecretMutation, admitSecretEventToRetryQueue, type SecretRetryItem, type SecretMutationEvidence } from './websocket.js';
import { RestartRequiredMutationQueue } from './coalescing-retry-queue.js';

// Empty synthetic PKCS#12 PFX (version 3, empty AuthenticatedSafe), no key/certificate.
const pfx = Buffer.from('3016020103301106092a864886f70d010701a00404023000', 'hex');

describe('native Base64 binary targets', () => {
  let directory: string;
  let lockPath: string;
  let target: SecretTarget;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateSecretTargetVersion).mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'znvault-binary-'));
    lockPath = path.join(directory, 'mutation.lock');
    target = {
      secretId: 'alias:synthetic/pfx', name: 'synthetic.p12', format: 'raw',
      encoding: 'base64', key: 'p12', output: path.join(directory, 'synthetic.p12'), mode: '0640',
    } as SecretTarget;
    vi.mocked(getSecret).mockResolvedValue({
      id: 'synthetic', alias: 'synthetic/pfx', type: 'generic', version: 2,
      data: { p12: pfx.toString('base64') },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  for (const caller of ['daemon', 'cli'] as const) {
    it(`${caller} atomically writes exact PFX bytes and permissions before committing under the shared lock`, async () => {
      fs.writeFileSync(target.output as string, 'old');
      vi.mocked(updateSecretTargetVersion).mockImplementation(() => {
        expect(fs.readFileSync(target.output as string)).toEqual(pfx);
        expect(fs.statSync(target.output as string).mode & 0o777).toBe(0o640);
        expect(fs.statSync(target.output as string).uid).toBe(process.getuid?.());
        expect(fs.existsSync(lockPath)).toBe(true);
      });
      const success = caller === 'daemon'
        ? (await deploySecret(target, true, lockPath)).success
        : await syncSecretTarget(target, lockPath);
      expect(success).toBe(true);
      expect(updateSecretTargetVersion).toHaveBeenCalledWith(target.secretId, 2, target.name);
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.readdirSync(directory)).toEqual(['synthetic.p12']);
    });

    it.each([undefined, null, 42, '', '%%%private-payload', 'AA A=', 'AA', 'AA===', 'AB==', 'AAA_', 'AAAA\n'])(`${caller} rejects invalid input %j without overwriting the consumer or committing`, async (value) => {
      fs.writeFileSync(target.output as string, pfx, { mode: 0o640 });
      vi.mocked(getSecret).mockResolvedValue({
        id: 'synthetic', alias: 'synthetic/pfx', type: 'generic', version: 3, data: { p12: value },
      });
      const result = caller === 'daemon' ? await deploySecret(target, true, lockPath) : await syncSecretTarget(target, lockPath);
      expect(typeof result === 'boolean' ? result : result.success).toBe(false);
      if (typeof result !== 'boolean' && typeof value === 'string' && value.length > 0) {
        expect(result.message).not.toContain(value);
      }
      expect(fs.readFileSync(target.output as string)).toEqual(pfx);
      expect(updateSecretTargetVersion).not.toHaveBeenCalled();
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.readdirSync(directory)).toEqual(['synthetic.p12']);
    });
  }

  it('recovers a missing output at the same version and writes subsequent rotations', async () => {
    target.lastVersion = 2;
    expect((await deploySecret(target, false, lockPath)).success).toBe(true);
    expect(fs.readFileSync(target.output as string)).toEqual(pfx);
    vi.mocked(getSecret).mockResolvedValue({
      id: 'synthetic', alias: 'synthetic/pfx', type: 'generic', version: 3,
      data: { p12: 'AP+A' },
    });
    expect((await deploySecret(target, false, lockPath)).success).toBe(true);
    expect(fs.readFileSync(target.output as string)).toEqual(Buffer.from([0, 255, 128]));
  });

  it('preserves existing raw text behavior when no encoding is selected', async () => {
    delete (target as SecretTarget & { encoding?: string }).encoding;
    expect((await deploySecret(target, true, lockPath)).success).toBe(true);
    expect(fs.readFileSync(target.output as string, 'utf8')).toBe(pfx.toString('base64'));
  });

  it('blocks binary writes while Payara owns the shared mutation lock', async () => {
    fs.writeFileSync(target.output as string, pfx);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: Date.now(), deploymentId: 'payara', step: 'deploy', ownerToken: 'test' }));
    const result = await deploySecret(target, true, lockPath);
    expect(result.errorCode).toBe('SHARED_MUTATION_LOCK_CONTENDED');
    expect(fs.readFileSync(target.output as string)).toEqual(pfx);
    expect(updateSecretTargetVersion).not.toHaveBeenCalled();
  });

  it('retains existing bytes and version if requested ownership cannot be applied', async () => {
    target.owner = 'znvault-nonexistent-test-account';
    fs.writeFileSync(target.output as string, pfx);
    expect((await deploySecret(target, true, lockPath)).success).toBe(false);
    expect(fs.readFileSync(target.output as string)).toEqual(pfx);
    expect(updateSecretTargetVersion).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual(['synthetic.p12']);
  });

  it('fails closed without deleting a pre-existing temporary file', async () => {
    const temporary = `${target.output}.tmp.${process.pid}`;
    fs.writeFileSync(temporary, 'existing unrelated data');
    expect((await deploySecret(target, true, lockPath)).success).toBe(false);
    expect(fs.readFileSync(temporary, 'utf8')).toBe('existing unrelated data');
    expect(fs.existsSync(target.output as string)).toBe(false);
    expect(updateSecretTargetVersion).not.toHaveBeenCalled();
  });

  it('fans out shared-secret rotations with independent retry and replay watermarks', async () => {
    const targets = ['server', 'bridge', 'trust'].map(name => ({
      ...target, name, output: path.join(directory, `${name}.p12`), lastVersion: 1,
      key: name === 'bridge' ? 'missing' : 'p12',
    }));
    for (const t of targets) fs.writeFileSync(t.output, 'old');
    const state = {
      consumedSecretVersions: new Map<string, number>(),
      consumedExecSecretVersions: new Map<string, number>(),
      execSecretIdentityByReference: new Map<string, string>(),
    };
    vi.mocked(getSecretTargets).mockReturnValue(targets);
    const queue = new RestartRequiredMutationQueue<SecretRetryItem, SecretMutationEvidence>({
      prepare: async item => {
        const result = await deploySecret(item.target as SecretTarget, true, lockPath);
        return result.success ? { decision: 'resolved', evidence: { version: result.version as number } } : { decision: 'failed' };
      },
      restart: async () => undefined,
      acknowledge: (item, evidence) => { acknowledgeSecretMutation(item, evidence, state); },
      retryDelayMs: 60_000,
    });
    const event = { event: 'secret.rotated' as const, secretId: 'synthetic', alias: 'synthetic/pfx', version: 2, timestamp: new Date().toISOString(), tenantId: 'synthetic' };
    const handle = () => admitSecretEventToRetryQueue({
      event, ...state, execSecretReferences: new Set<string>(), queue,
      findTarget: reference => findSecretTargets(reference)[0], findTargets: findSecretTargets,
    } as Parameters<typeof admitSecretEventToRetryQueue>[0]);
    await handle();
    expect(fs.readFileSync(targets[0].output)).toEqual(pfx);
    expect(fs.readFileSync(targets[1].output, 'utf8')).toBe('old');
    expect(fs.readFileSync(targets[2].output)).toEqual(pfx);
    expect(state.consumedSecretVersions).toEqual(new Map([
      ['["alias:synthetic/pfx","server"]', 2], ['["alias:synthetic/pfx","trust"]', 2],
    ]));
    vi.mocked(getSecret).mockResolvedValue({
      id: 'synthetic', alias: 'synthetic/pfx', type: 'generic', version: 2,
      data: { p12: pfx.toString('base64'), missing: pfx.toString('base64') },
    });
    await handle();
    // Duplicate delivery leaves the bounded pending retry intact; polling or
    // the existing retry timer resolves just this failed consumer.
    expect(queue.pendingCount).toBe(1);
    await queue.retryNow('["alias:synthetic/pfx","bridge"]');
    expect(fs.readFileSync(targets[1].output)).toEqual(pfx);
    expect(state.consumedSecretVersions.get('["alias:synthetic/pfx","bridge"]')).toBe(2);
    expect(queue.pendingCount).toBe(0);
    const times = targets.map(t => fs.statSync(t.output).mtimeMs);
    await handle();
    expect(targets.map(t => fs.statSync(t.output).mtimeMs)).toEqual(times);
    queue.stop();
  });
});
