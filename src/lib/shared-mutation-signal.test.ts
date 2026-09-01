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
import * as configModule from './config.js';
import { deployAllCertificates, deployCertificate } from './deployer.js';
import { deploySecret } from './secret-deployer.js';
import { withActiveDeployment } from './websocket.js';
import { syncSecretTarget } from '../commands/secrets.js';
import {
  getDeferredShutdownSequence,
  SHARED_MUTATION_SIGNAL_COORDINATOR_KEY,
} from './shared-mutation-lock.js';

const testPrivateKeyLabel = ['PRIVATE', 'KEY'].join(' ');

describe('shutdown signal deferral across mutation callers', () => {
  let testDirectory: string;
  let lockPath: string;
  let reloadMarker: string;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Reflect.deleteProperty(globalThis, SHARED_MUTATION_SIGNAL_COORDINATOR_KEY);
    testDirectory = await mkdtemp(path.join(tmpdir(), 'znvault-mutation-signal-'));
    lockPath = path.join(testDirectory, 'znvault-deploy.lock');
    reloadMarker = path.join(testDirectory, 'reload-ran');
    const nativeKill = process.kill.bind(process);
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid, signal) => {
      // Capture only SharedMutationLock's replay. The reload runner depends on
      // real negative-PGID probes/signals to know when its process group ended.
      if (
        pid === process.pid
        && (signal === 'SIGTERM' || signal === 'SIGINT')
      ) {
        return true;
      }
      return nativeKill(pid, signal);
    }) as typeof process.kill);
    vi.mocked(api.ackDelivery).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(testDirectory, { recursive: true, force: true });
  });

  async function expectReleasedAfterMutation(outputPath: string): Promise<void> {
    expect(await readFile(outputPath, 'utf8')).not.toHaveLength(0);
    await expect(readFile(reloadMarker, 'utf8')).resolves.toBe('');
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(killSpy.mock.calls.filter((call: unknown[]) => call[0] === process.pid)).toHaveLength(0);
    await vi.runAllTimersAsync();
    expect(killSpy.mock.calls.filter((call: unknown[]) => call[0] === process.pid)).toHaveLength(1);
  }

  it('finishes a WebSocket certificate event write+reload before replaying SIGTERM', async () => {
    const outputPath = path.join(testDirectory, 'certificate.pem');
    const target: CertTarget = {
      certId: 'certificate-id',
      name: 'payara-certificate',
      outputs: { cert: outputPath },
      reloadCmd: `kill -TERM "$PPID"; touch "${reloadMarker}"`,
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
    const pem = [
      '-----BEGIN CERTIFICATE-----',
      'TEST',
      '-----END CERTIFICATE-----',
      `-----BEGIN ${testPrivateKeyLabel}-----`,
      'KEY',
      `-----END ${testPrivateKeyLabel}-----`,
    ].join('\n');
    vi.mocked(api.decryptCertificate).mockResolvedValue({
      id: target.certId,
      certificateData: Buffer.from(pem).toString('base64'),
      certificateType: 'PEM',
      fingerprintSha256: 'fingerprint-v2',
    });

    const result = await deployCertificate(target, true, lockPath);

    expect(result.success).toBe(true);
    await expectReleasedAfterMutation(outputPath);
  });

  it('accounts a periodic poll and finishes secret write+reload before SIGINT replay', async () => {
    const outputPath = path.join(testDirectory, 'poll-secret.env');
    const target: SecretTarget = {
      secretId: 'alias:example/poll',
      name: 'payara-poll-secret',
      format: 'env',
      output: outputPath,
      reloadCmd: `kill -INT "$PPID"; touch "${reloadMarker}"`,
    };
    vi.mocked(api.getSecret).mockResolvedValue({
        id: target.secretId,
        alias: 'example/poll',
        type: 'generic',
        version: 4,
        data: { ready: true },
    });

    const result = await withActiveDeployment(
      async () => deploySecret(target, true, lockPath)
    );

    expect(result.success).toBe(true);
    await expectReleasedAfterMutation(outputPath);
  });

  it('finishes CLI secret write+reload and removes the lock before replaying SIGTERM', async () => {
    const outputPath = path.join(testDirectory, 'cli-secret.env');
    const target: SecretTarget = {
      secretId: 'alias:example/cli',
      name: 'payara-cli-secret',
      format: 'env',
      output: outputPath,
      reloadCmd: `kill -TERM "$PPID"; touch "${reloadMarker}"`,
    };
    vi.mocked(api.getSecret).mockResolvedValue({
        id: target.secretId,
        alias: 'example/cli',
        type: 'generic',
        version: 5,
        data: { ready: true },
    });

    expect(await syncSecretTarget(target, lockPath)).toBe(true);
    await expectReleasedAfterMutation(outputPath);
  });

  it('does not begin a second startup target after SIGTERM during the first', async () => {
    const firstOutput = path.join(testDirectory, 'first.pem');
    const secondOutput = path.join(testDirectory, 'second.pem');
    const targets: CertTarget[] = [
      { certId: 'first', name: 'first', outputs: { cert: firstOutput } },
      { certId: 'second', name: 'second', outputs: { cert: secondOutput } },
    ];
    vi.mocked(configModule.loadConfig).mockReturnValue({
      targets,
      secretTargets: [],
    } as unknown as ReturnType<typeof configModule.loadConfig>);
    vi.mocked(api.getCertificate).mockImplementation(async (certId) => {
      if (certId === 'first') process.emit('SIGTERM', 'SIGTERM');
      return {
        id: certId,
        tenantId: 'tenant',
        clientId: 'client',
        kind: 'tls',
        alias: certId,
        certificateType: 'PEM',
        fingerprintSha256: `fingerprint-${certId}`,
        subjectCn: `${certId}.test`,
        issuerCn: 'issuer.test',
        notBefore: '2026-01-01T00:00:00Z',
        notAfter: '2027-01-01T00:00:00Z',
        status: 'active',
        version: 2,
        daysUntilExpiry: 120,
      };
    });
    const pem = [
      '-----BEGIN CERTIFICATE-----',
      'TEST',
      '-----END CERTIFICATE-----',
      `-----BEGIN ${testPrivateKeyLabel}-----`,
      'KEY',
      `-----END ${testPrivateKeyLabel}-----`,
    ].join('\n');
    vi.mocked(api.decryptCertificate).mockImplementation(async (certId) => ({
      id: certId,
      certificateData: Buffer.from(pem).toString('base64'),
      certificateType: 'PEM',
      fingerprintSha256: `fingerprint-${certId}`,
    }));
    const baseline = getDeferredShutdownSequence();

    const results = await deployAllCertificates(
      true,
      () => getDeferredShutdownSequence() === baseline,
      lockPath
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.certId).toBe('first');
    expect(api.getCertificate).toHaveBeenCalledTimes(1);
    await expect(readFile(secondOutput, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
