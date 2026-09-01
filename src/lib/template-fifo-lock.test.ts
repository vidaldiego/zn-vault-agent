import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretTarget } from './config.js';

vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>();
  return {
    ...actual,
    getSecret: vi.fn(),
  };
});

vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    updateSecretTargetVersion: vi.fn(),
  };
});

import * as api from './api.js';
import { deploySecret } from './secret-deployer.js';
import { syncSecretTarget } from '../commands/secrets.js';

describe('non-blocking template reads under the shared mutation lock', () => {
  let directory: string;
  let fifoPath: string;
  let lockPath: string;
  let target: SecretTarget;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'znvault-template-fifo-'));
    fifoPath = path.join(directory, 'template.fifo');
    lockPath = path.join(directory, 'znvault-deploy.lock');
    execFileSync('mkfifo', [fifoPath]);
    target = {
      secretId: 'alias:example/template',
      name: 'payara-template',
      format: 'template',
      templatePath: fifoPath,
      output: path.join(directory, 'rendered.conf'),
    };
    vi.mocked(api.getSecret).mockResolvedValue({
      id: target.secretId,
      alias: 'example/template',
      type: 'generic',
      version: 3,
      data: { value: 'secret' },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  async function expectLockReleasedQuickly(operation: () => Promise<unknown>): Promise<void> {
    const startedAt = performance.now();
    await operation();
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }

  it('rejects a FIFO in the daemon secret deployer without blocking or leaking the lock', async () => {
    await expectLockReleasedQuickly(async () => {
      const result = await deploySecret(target, true, lockPath);
      expect(result.success).toBe(false);
      expect(result.message).toContain('not a regular file');
    });
  });

  it('rejects a FIFO in CLI secret sync without blocking or leaking the lock', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expectLockReleasedQuickly(async () => {
      await expect(syncSecretTarget(target, lockPath)).resolves.toBe(false);
    });
  });
});
