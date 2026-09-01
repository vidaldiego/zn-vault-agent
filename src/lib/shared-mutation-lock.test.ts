// Path: src/lib/shared-mutation-lock.test.ts

import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SHARED_MUTATION_LOCK_PATH,
  SharedMutationLock,
  SharedMutationLockError,
  getSharedMutationLockPath,
  withSharedMutationLock,
} from './shared-mutation-lock.js';

describe('getSharedMutationLockPath', () => {
  it('keeps the stable host-wide production path by default', () => {
    expect(getSharedMutationLockPath({})).toBe(DEFAULT_SHARED_MUTATION_LOCK_PATH);
  });

  it('honors an explicit isolated cross-process path', () => {
    expect(getSharedMutationLockPath({
      ZNVAULT_TEST_DEPLOY_LOCK_PATH: '  /tmp/runner/znvault-deploy.lock  ',
    })).toBe('/tmp/runner/znvault-deploy.lock');
  });

  it('does not replace the production default with an empty override', () => {
    expect(getSharedMutationLockPath({ ZNVAULT_TEST_DEPLOY_LOCK_PATH: '  ' }))
      .toBe(DEFAULT_SHARED_MUTATION_LOCK_PATH);
  });

  it('fails closed when the isolated override is relative', () => {
    expect(() => getSharedMutationLockPath({
      ZNVAULT_TEST_DEPLOY_LOCK_PATH: 'runner/znvault-deploy.lock',
    })).toThrow('ZNVAULT_TEST_DEPLOY_LOCK_PATH must be an absolute path');
  });
});

describe('SharedMutationLock', () => {
  let testDirectory: string;
  let lockPath: string;

  beforeEach(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), 'znvault-shared-lock-'));
    lockPath = path.join(testDirectory, 'znvault-deploy.lock');
  });

  afterEach(async () => {
    await rm(testDirectory, { recursive: true, force: true });
  });

  it('writes the schema consumed by the Payara deployment lock', async () => {
    const lock = new SharedMutationLock(lockPath);
    await lock.acquire('certificate');

    const data = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
    expect(data).toMatchObject({
      pid: process.pid,
      step: 'init',
    });
    expect(data.started).toEqual(expect.any(Number));
    expect(data.deploymentId).toMatch(/^agent-certificate-/);
    expect(data.ownerToken).toMatch(/^[0-9a-f-]{36}$/);

    await lock.release();
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is exclusive across independent lock instances', async () => {
    const first = new SharedMutationLock(lockPath);
    const second = new SharedMutationLock(lockPath);
    await first.acquire('certificate');

    await expect(second.acquire('secret')).rejects.toMatchObject({
      code: 'SHARED_MUTATION_LOCK_CONTENDED',
    });

    await first.release();
    await second.acquire('secret');
    await second.release();
  });

  it('never reaps a stale Payara lock automatically', async () => {
    const staleData = JSON.stringify({
      pid: 2_147_483_647,
      started: 1,
      deploymentId: 'payara-stale-test',
      step: 'deploy',
      ownerToken: 'payara-stale-owner',
    });
    await writeFile(lockPath, staleData);

    const lock = new SharedMutationLock(lockPath);
    await expect(lock.acquire('certificate')).rejects.toMatchObject({
      code: 'SHARED_MUTATION_LOCK_CONTENDED',
    });
    expect(await readFile(lockPath, 'utf8')).toBe(staleData);
  });

  it('fails closed on an unreadable or malformed existing lock', async () => {
    await writeFile(lockPath, 'not-json');

    const lock = new SharedMutationLock(lockPath);
    await expect(lock.acquire('secret')).rejects.toBeInstanceOf(SharedMutationLockError);
    expect(await readFile(lockPath, 'utf8')).toBe('not-json');
  });

  it('does not unlink a replacement lock during release', async () => {
    const lock = new SharedMutationLock(lockPath);
    await lock.acquire('certificate');

    const displacedPath = path.join(testDirectory, 'original-lock');
    await rename(lockPath, displacedPath);
    const replacementData = JSON.stringify({
      pid: process.pid,
      started: Date.now(),
      deploymentId: 'payara-replacement-test',
      step: 'deploy',
      ownerToken: 'payara-replacement-owner',
    });
    await writeFile(lockPath, replacementData);

    await expect(lock.release()).rejects.toMatchObject({
      code: 'SHARED_MUTATION_LOCK_LOST',
    });
    expect(await readFile(lockPath, 'utf8')).toBe(replacementData);
    expect(await readFile(displacedPath, 'utf8')).toContain('agent-certificate-');
  });

  it('releases its lock when the protected callback fails', async () => {
    await expect(
      withSharedMutationLock(
        'secret',
        async () => {
          throw new Error('expected callback failure');
        },
        lockPath
      )
    ).rejects.toThrow('expected callback failure');

    const successor = new SharedMutationLock(lockPath);
    await successor.acquire('certificate');
    await successor.release();
  });
});
