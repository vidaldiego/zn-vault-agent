import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStartupCleanup } from './websocket.js';
import { SharedMutationLock } from './shared-mutation-lock.js';

describe('startup cleanup shared mutation fence', () => {
  let directory: string;
  let lockPath: string;
  let orphanPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'znvault-startup-cleanup-'));
    lockPath = path.join(directory, 'znvault-deploy.lock');
    orphanPath = path.join(directory, '.certificate.pem.12345.tmp');
    await writeFile(orphanPath, 'orphan');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('does not delete anything when a second daemon finds the lock contended', async () => {
    const firstDaemon = new SharedMutationLock(lockPath);
    await firstDaemon.acquire('certificate');

    await expect(runStartupCleanup([directory], lockPath)).rejects.toMatchObject({
      code: 'SHARED_MUTATION_LOCK_CONTENDED',
    });
    await expect(readFile(orphanPath, 'utf8')).resolves.toBe('orphan');

    await firstDaemon.release();
    await expect(runStartupCleanup([directory], lockPath)).resolves.toMatchObject({
      tempFilesRemoved: 1,
      errors: 0,
    });
    await expect(readFile(orphanPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
