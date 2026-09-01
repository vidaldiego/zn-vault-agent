import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlPlaneAuthenticator } from './control-plane-auth.js';
import {
  isHealthServerRunning,
  isHTTPSHealthServerRunning,
  setPluginLoader,
  setPluginRecoveryRequired,
  startHealthServer,
  startHTTPSHealthServer,
  stopHealthServer,
  stopHTTPSHealthServer,
} from './health.js';

vi.mock('./config.js', () => ({
  loadConfig: () => ({ vaultUrl: 'https://vault.test', secretTargets: [] }),
  getTargets: () => [],
  isConfigured: () => true,
}));

const TEST_AUTH: ControlPlaneAuthenticator = {
  authenticate: () => true,
};

const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBfTCCASOgAwIBAgIUcuSbde+TNLvgTfqz3Q3PFZXvxIAwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDgzMTIzMjc0NVoXDTM2MDgyODIz
Mjc0NVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEyfoJoZBiULtCSzXEngaFxEKiM4KxfpS3RunkcPFYAGXmyFrx7uCpr6H5
hgaQdIEvKU5AFit0JqYRrBM+zhUb/aNTMFEwHQYDVR0OBBYEFKxn0t985WeCw0Gq
Hr2VQdvXEeDRMB8GA1UdIwQYMBaAFKxn0t985WeCw0GqHr2VQdvXEeDRMA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhAKLaRb39NHObxL1oE07OaS24
2oYmLKbFPJvZZ10RTlECAiBRAv2OFI35JnzieiN4S+slH7MswueKvtfqhXbz/X+J
Zg==
-----END CERTIFICATE-----
`;

// Synthetic test-only key paired with TEST_CERTIFICATE for temp TLS listeners.
const TEST_PRIVATE_KEY = /* gitleaks:allow reason=static test TLS key fixture, never used outside isolated tests */ `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtfn/Zz7P1m2SchDX
eUwimUiRrN0zP2gAzChLwYiT+COhRANCAATJ+gmhkGJQu0JLNcSeBoXEQqIzgrF+
lLdG6eRw8VgAZebIWvHu4KmvofmGBpB0gS8pTkAWK3QmphGsEz7OFRv9
-----END PRIVATE KEY-----
`;

async function listenOnEphemeralPort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test listener did not expose a TCP port');
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

describe('control-plane listener startup', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await stopHTTPSHealthServer();
    await stopHealthServer();
    setPluginLoader(null);
    setPluginRecoveryRequired(null);
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on an occupied HTTP port and releases the failed candidate for retry', async () => {
    const blocker = createServer();
    const port = await listenOnEphemeralPort(blocker);

    try {
      await expect(
        startHealthServer(port, undefined, '127.0.0.1', TEST_AUTH)
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(isHealthServerRunning()).toBe(false);
    } finally {
      await closeServer(blocker);
    }

    const server = await startHealthServer(port, undefined, '127.0.0.1', TEST_AUTH);
    expect(server.server.listening).toBe(true);
    expect(isHealthServerRunning()).toBe(true);

    await stopHealthServer();
    expect(isHealthServerRunning()).toBe(false);
  });

  it('fails closed when requested TLS material is absent', async () => {
    await expect(
      startHTTPSHealthServer(
        0,
        '/definitely-missing/znvault-agent-cert.pem',
        '/definitely-missing/znvault-agent-key.pem',
        undefined,
        '127.0.0.1',
        TEST_AUTH
      )
    ).rejects.toThrow('TLS certificate file not found');
    expect(isHTTPSHealthServerRunning()).toBe(false);
  });

  it('fails closed on an occupied HTTPS port and closes the failed candidate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'znvault-health-tls-'));
    tempDirectories.push(directory);
    const certPath = join(directory, 'cert.pem');
    const keyPath = join(directory, 'key.pem');
    writeFileSync(certPath, TEST_CERTIFICATE, { mode: 0o600 });
    writeFileSync(keyPath, TEST_PRIVATE_KEY, { mode: 0o600 });

    const blocker = createServer();
    const port = await listenOnEphemeralPort(blocker);
    try {
      await expect(
        startHTTPSHealthServer(
          port,
          certPath,
          keyPath,
          undefined,
          '127.0.0.1',
          TEST_AUTH
        )
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(isHTTPSHealthServerRunning()).toBe(false);
    } finally {
      await closeServer(blocker);
    }

    const server = await startHTTPSHealthServer(
      port,
      certPath,
      keyPath,
      undefined,
      '127.0.0.1',
      TEST_AUTH
    );
    expect(server.server.listening).toBe(true);
    expect(isHTTPSHealthServerRunning()).toBe(true);

    await stopHTTPSHealthServer();
    expect(isHTTPSHealthServerRunning()).toBe(false);
  });

  it('serves HTTPS-only recovery from existing trusted files without mutation routes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'znvault-recovery-tls-'));
    tempDirectories.push(directory);
    const certPath = join(directory, 'cert.pem');
    const keyPath = join(directory, 'key.pem');
    writeFileSync(certPath, TEST_CERTIFICATE, { mode: 0o600 });
    writeFileSync(keyPath, TEST_PRIVATE_KEY, { mode: 0o600 });
    setPluginRecoveryRequired('2.9.0');

    const server = await startHTTPSHealthServer(
      0,
      certPath,
      keyPath,
      undefined,
      '127.0.0.1',
      TEST_AUTH,
      true
    );
    expect(isHTTPSHealthServerRunning()).toBe(true);
    expect(isHealthServerRunning()).toBe(false);
    const health = await server.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toMatchObject({
      code: 'UPDATE_REQUIRED',
      plugins: [{ name: 'payara', version: '2.9.0', status: 'unhealthy' }],
    });
    expect((await server.inject({ method: 'POST', url: '/agent/update' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/scheduler/quiesce' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/plugins/payara/deploy' })).statusCode).toBe(404);
  });

  it('distinguishes installed Payara awaiting startup confirmation from legacy recovery', async () => {
    setPluginRecoveryRequired('3.0.0', 'STARTUP_CONFIRMATION_PENDING');
    const server = await startHealthServer(
      0,
      undefined,
      '127.0.0.1',
      TEST_AUTH,
      true
    );

    const health = await server.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toMatchObject({
      code: 'STARTUP_CONFIRMATION_PENDING',
      plugins: [{
        name: 'payara',
        version: '3.0.0',
        status: 'unhealthy',
        message: 'STARTUP_CONFIRMATION_PENDING',
      }],
    });
  });

  it('supports dual recovery listeners when HTTP is explicitly retained', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'znvault-recovery-dual-'));
    tempDirectories.push(directory);
    const certPath = join(directory, 'cert.pem');
    const keyPath = join(directory, 'key.pem');
    writeFileSync(certPath, TEST_CERTIFICATE, { mode: 0o600 });
    writeFileSync(keyPath, TEST_PRIVATE_KEY, { mode: 0o600 });

    await startHealthServer(0, undefined, '127.0.0.1', TEST_AUTH, true);
    await startHTTPSHealthServer(0, certPath, keyPath, undefined, '127.0.0.1', TEST_AUTH, true);
    expect(isHealthServerRunning()).toBe(true);
    expect(isHTTPSHealthServerRunning()).toBe(true);
  });

  it('rejects a symlink TLS file in recovery mode', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'znvault-recovery-untrusted-'));
    tempDirectories.push(directory);
    const realCert = join(directory, 'real-cert.pem');
    const certPath = join(directory, 'cert.pem');
    const keyPath = join(directory, 'key.pem');
    writeFileSync(realCert, TEST_CERTIFICATE, { mode: 0o600 });
    writeFileSync(keyPath, TEST_PRIVATE_KEY, { mode: 0o600 });
    const { symlinkSync } = await import('node:fs');
    symlinkSync(realCert, certPath);

    await expect(startHTTPSHealthServer(
      0,
      certPath,
      keyPath,
      undefined,
      '127.0.0.1',
      TEST_AUTH,
      true
    )).rejects.toThrow(/Untrusted recovery TLS file/);
    expect(isHTTPSHealthServerRunning()).toBe(false);
  });
});
