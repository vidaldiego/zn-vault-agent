import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CertTarget, SecretTarget } from './config.js';

vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api.js')>();
  return {
    ...actual,
    getCertificate: vi.fn(),
    decryptCertificate: vi.fn(),
    ackDelivery: vi.fn(),
    getSecret: vi.fn(),
  };
});

vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({ targets: [], secretTargets: [] })),
    updateTargetFingerprint: vi.fn(),
    updateSecretTargetVersion: vi.fn(),
  };
});

import * as api from './api.js';
import * as config from './config.js';
import { deployCertificate } from './deployer.js';
import { deploySecret } from './secret-deployer.js';
import { syncSecretTarget } from '../commands/secrets.js';

describe('reload failure is terminal failure for every mutation caller', () => {
  let directory: string;
  let lockPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(path.join(tmpdir(), 'znvault-reload-failure-'));
    lockPath = path.join(directory, 'znvault-deploy.lock');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  async function expectLockReleased(): Promise<void> {
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }

  it('fails and does not acknowledge a certificate whose reload exits non-zero', async () => {
    const target: CertTarget = {
      certId: 'certificate-id',
      name: 'payara-certificate',
      outputs: { cert: path.join(directory, 'certificate.pem') },
      reloadCmd: 'exit 7',
    };
    vi.mocked(api.getCertificate).mockResolvedValue({
      id: target.certId,
      tenantId: 'tenant',
      clientId: 'client',
      kind: 'tls',
      alias: 'payara',
      certificateType: 'PEM',
      fingerprintSha256: 'fingerprint-v2',
      subjectCn: 'payara.test',
      issuerCn: 'issuer.test',
      notBefore: '2026-01-01T00:00:00Z',
      notAfter: '2027-01-01T00:00:00Z',
      status: 'active',
      version: 2,
      daysUntilExpiry: 120,
    });
    vi.mocked(api.decryptCertificate).mockResolvedValue({
      id: target.certId,
      certificateData: Buffer.from([
        '-----BEGIN CERTIFICATE-----',
        'TEST',
        '-----END CERTIFICATE-----',
      ].join('\n')).toString('base64'),
      certificateType: 'PEM',
      fingerprintSha256: 'fingerprint-v2',
    });

    const result = await deployCertificate(target, true, lockPath);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(config.updateTargetFingerprint).not.toHaveBeenCalled();
    expect(api.ackDelivery).not.toHaveBeenCalled();
    await expectLockReleased();
  });

  it('fails daemon secret deployment without committing the version', async () => {
    const target: SecretTarget = {
      secretId: 'alias:example/daemon',
      name: 'payara-daemon-secret',
      format: 'env',
      output: path.join(directory, 'daemon.env'),
      reloadCmd: 'exit 7',
    };
    vi.mocked(api.getSecret).mockResolvedValue({
      id: target.secretId,
      alias: 'example/daemon',
      type: 'generic',
      version: 7,
      data: { ready: true },
    });

    const result = await deploySecret(target, true, lockPath);

    expect(result.success).toBe(false);
    expect(config.updateSecretTargetVersion).not.toHaveBeenCalled();
    await expectLockReleased();
  });

  it('fails CLI secret sync without committing the version', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const target: SecretTarget = {
      secretId: 'alias:example/cli',
      name: 'payara-cli-secret',
      format: 'env',
      output: path.join(directory, 'cli.env'),
      reloadCmd: 'exit 7',
    };
    vi.mocked(api.getSecret).mockResolvedValue({
      id: target.secretId,
      alias: 'payara/cli',
      type: 'generic',
      version: 8,
      data: { ready: true },
    });

    await expect(syncSecretTarget(target, lockPath)).resolves.toBe(false);
    expect(config.updateSecretTargetVersion).not.toHaveBeenCalled();
    await expectLockReleased();
  });
});
