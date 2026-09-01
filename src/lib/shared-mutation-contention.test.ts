// Path: src/lib/shared-mutation-contention.test.ts

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CertTarget, SecretTarget } from './config.js';
import { deployCertificate } from './deployer.js';
import { deploySecret } from './secret-deployer.js';
import { syncSecretTarget } from '../commands/secrets.js';

describe('Payara mutation lock contention', () => {
  let testDirectory: string;
  let lockPath: string;
  let reloadMarker: string;

  beforeEach(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), 'znvault-payara-contention-'));
    lockPath = path.join(testDirectory, 'znvault-deploy.lock');
    reloadMarker = path.join(testDirectory, 'reload-ran');
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      started: Date.now(),
      deploymentId: 'payara-deploy-in-progress',
      step: 'deploy',
      ownerToken: 'payara-owner-token',
    }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDirectory, { recursive: true, force: true });
  });

  it('blocks certificate write and reload while Payara holds the lock', async () => {
    const certificatePath = path.join(testDirectory, 'certificate.pem');
    await writeFile(certificatePath, 'original-certificate');
    const target: CertTarget = {
      certId: 'certificate-id',
      name: 'payara-certificate',
      outputs: { cert: certificatePath },
      reloadCmd: `touch ${reloadMarker}`,
    };

    const result = await deployCertificate(target, true, lockPath);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SHARED_MUTATION_LOCK_CONTENDED');
    expect(result.message).toContain('already held');
    expect(await readFile(certificatePath, 'utf8')).toBe('original-certificate');
    await expect(readFile(reloadMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks daemon/WebSocket secret write and reload while Payara holds the lock', async () => {
    const secretPath = path.join(testDirectory, 'secret.env');
    await writeFile(secretPath, 'ORIGINAL=true\n');
    const target: SecretTarget = {
      secretId: 'alias:example/secret',
      name: 'payara-secret',
      format: 'env',
      output: secretPath,
      reloadCmd: `touch ${reloadMarker}`,
    };

    const result = await deploySecret(target, true, lockPath);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SHARED_MUTATION_LOCK_CONTENDED');
    expect(result.message).toContain('already held');
    expect(await readFile(secretPath, 'utf8')).toBe('ORIGINAL=true\n');
    await expect(readFile(reloadMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks CLI secret write and reload while Payara holds the lock', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secretPath = path.join(testDirectory, 'cli-secret.env');
    await writeFile(secretPath, 'ORIGINAL=cli\n');
    const target: SecretTarget = {
      secretId: 'alias:example/cli-secret',
      name: 'payara-cli-secret',
      format: 'env',
      output: secretPath,
      reloadCmd: `touch ${reloadMarker}`,
    };

    const success = await syncSecretTarget(target, lockPath);

    expect(success).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to sync'),
      expect.stringContaining('already held')
    );
    expect(await readFile(secretPath, 'utf8')).toBe('ORIGINAL=cli\n');
    await expect(readFile(reloadMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
