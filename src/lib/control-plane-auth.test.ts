// Path: src/lib/control-plane-auth.test.ts

import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadControlPlaneAuthenticator } from './control-plane-auth.js';
import { addControlPlaneGuard } from './health.js';

describe('control-plane authentication', () => {
  const directories: string[] = [];

  function tempDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'znvault-control-auth-'));
    directories.push(directory);
    return directory;
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('loads a private token and compares the complete Bearer value', () => {
    const directory = tempDirectory();
    const token = randomBytes(32).toString('base64url');
    const tokenFile = join(directory, 'token');
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });

    const auth = loadControlPlaneAuthenticator(tokenFile);

    expect(auth.authenticate(`Bearer ${token}`)).toBe(true);
    for (const rejected of [
      `Bearer ${token.slice(0, -1)}x`,
      `Bearer ${token.slice(0, -1)}`,
      `Bearer ${token}x`,
      `bearer ${token}`,
      `Bearer  ${token}`,
      `Bearer ${token}\n`,
      undefined,
    ]) {
      expect(auth.authenticate(rejected)).toBe(false);
    }
  });

  it('rejects symlinks, hard links, permissive modes, and malformed values', () => {
    const directory = tempDirectory();
    const token = randomBytes(32).toString('base64url');
    const tokenFile = join(directory, 'token');
    expect(() => loadControlPlaneAuthenticator(join(directory, 'missing'))).toThrow();
    writeFileSync(tokenFile, token, { mode: 0o600 });

    const symlink = join(directory, 'token-link');
    symlinkSync(tokenFile, symlink);
    expect(() => loadControlPlaneAuthenticator(symlink)).toThrow();

    const hardlink = join(directory, 'token-hardlink');
    linkSync(tokenFile, hardlink);
    expect(() => loadControlPlaneAuthenticator(tokenFile)).toThrow(
      'one regular, non-linked file'
    );
    rmSync(hardlink);

    chmodSync(tokenFile, 0o640);
    expect(() => loadControlPlaneAuthenticator(tokenFile)).toThrow(
      'must not grant group or other access'
    );

    chmodSync(tokenFile, 0o600);
    writeFileSync(tokenFile, 'predictable-short-token', { mode: 0o600 });
    expect(() => loadControlPlaneAuthenticator(tokenFile)).toThrow(
      '32 random base64url bytes'
    );
  });

  it('guards core and inherited plugin routes before body parsing', async () => {
    const directory = tempDirectory();
    const token = randomBytes(32).toString('base64url');
    const tokenFile = join(directory, 'token');
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    const auth = loadControlPlaneAuthenticator(tokenFile);
    const authorization = `Bearer ${token}`;
    const app = Fastify();
    let childGuardCalls = 0;
    let bodyParserCalls = 0;
    let handlerCalls = 0;

    addControlPlaneGuard(app, auth);

    for (const path of ['/health', '/ready', '/live', '/metrics']) {
      app.get(path, async () => ({ public: true }));
    }
    const protectedRoutes = [
      { method: 'GET' as const, path: '/agent/version' },
      { method: 'POST' as const, path: '/agent/update' },
      { method: 'GET' as const, path: '/plugins/versions' },
      { method: 'POST' as const, path: '/plugins/update' },
      { method: 'POST' as const, path: '/scheduler/quiesce' },
      { method: 'GET' as const, path: '/scheduler/status' },
      { method: 'POST' as const, path: '/scheduler/resume' },
    ];
    for (const route of protectedRoutes) {
      app.route({
        method: route.method,
        url: route.path,
        handler: async () => ({ protected: true }),
      });
    }

    await app.register(async (instance) => {
      instance.addHook('onRequest', async (request, reply) => {
        childGuardCalls++;
        if (!auth.authenticate(request.headers.authorization)) {
          return reply.code(401).send({ error: 'PLUGIN_AUTH_REQUIRED' });
        }
      });
      instance.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer' },
        (_request, body, done) => {
          bodyParserCalls++;
          done(null, body);
        }
      );
      instance.post('/mutate', async () => {
        handlerCalls++;
        return { mutated: true };
      });
    }, { prefix: '/plugins/payara' });

    await app.ready();
    try {
      for (const path of ['/health', '/ready', '/live', '/metrics']) {
        const response = await app.inject({ method: 'GET', url: `${path}?probe=1` });
        expect(response.statusCode, path).toBe(200);
      }

      for (const route of protectedRoutes) {
        const response = await app.inject({ method: route.method, url: route.path });
        expect(response.statusCode, route.path).toBe(401);
        expect(response.headers['www-authenticate']).toBe(
          'Bearer realm="zn-vault-agent-control"'
        );
      }

      for (const path of ['/health/', '/unregistered']) {
        const response = await app.inject({ method: 'GET', url: path });
        expect(response.statusCode, path).toBe(401);
      }

      const rejectedBeforeParsing = await app.inject({
        method: 'POST',
        url: '/plugins/payara/mutate',
        headers: { 'content-type': 'application/octet-stream' },
        payload: Buffer.from('must-not-be-parsed'),
      });
      expect(rejectedBeforeParsing.statusCode).toBe(401);
      expect(childGuardCalls).toBe(0);
      expect(bodyParserCalls).toBe(0);
      expect(handlerCalls).toBe(0);

      const acceptedByBothGuards = await app.inject({
        method: 'POST',
        url: '/plugins/payara/mutate',
        headers: {
          authorization,
          'content-type': 'application/octet-stream',
        },
        payload: Buffer.from('authorized-body'),
      });
      expect(acceptedByBothGuards.statusCode).toBe(200);
      expect(childGuardCalls).toBe(1);
      expect(bodyParserCalls).toBe(1);
      expect(handlerCalls).toBe(1);

      const options = await app.inject({
        method: 'OPTIONS',
        url: '/plugins/payara/mutate',
      });
      expect(options.statusCode).toBe(204);
      expect(childGuardCalls).toBe(1);
      expect(bodyParserCalls).toBe(1);
      expect(handlerCalls).toBe(1);
    } finally {
      await app.close();
    }
  });
});
