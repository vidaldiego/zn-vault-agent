// Path: src/lib/scheduler-routes.test.ts
// Unit tests for /scheduler/* passthrough routes

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addSchedulerRoutes } from './scheduler-routes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start a local HTTP stub server that calls `handler` for each request.
 *  Binds to an ephemeral port on 127.0.0.1. */
function startStubServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Write a temp file containing `contents` and return its path. */
function writeTempSecret(contents: string): string {
  const dir = os.tmpdir();
  const p = path.join(dir, `test-deploy-secret-${Date.now()}-${Math.random()}.txt`);
  fs.writeFileSync(p, contents, 'utf-8');
  return p;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/scheduler/* passthrough routes', () => {
  let app: FastifyInstance;
  let znapi: http.Server;
  let znapiUrl: string;
  let secretFile: string;

  // Captured request info from stub server
  let capturedMethod: string | undefined;
  let capturedPath: string | undefined;
  let capturedHeaders: http.IncomingHttpHeaders | undefined;

  beforeEach(() => {
    app = Fastify({ logger: false });
    capturedMethod = undefined;
    capturedPath = undefined;
    capturedHeaders = undefined;
  });

  afterEach(async () => {
    await app.close().catch(() => undefined);
    if (znapi) await stopServer(znapi);
    if (secretFile && fs.existsSync(secretFile)) fs.unlinkSync(secretFile);
  });

  // -------------------------------------------------------------------------
  // POST /scheduler/quiesce — happy path
  // -------------------------------------------------------------------------
  it('POST /scheduler/quiesce — sends correct headers and returns znapi JSON', async () => {
    const secret = 'super-secret-value-123';
    secretFile = writeTempSecret(`${secret}\n`); // trailing newline should be trimmed

    const znapiResponseBody = JSON.stringify({ quiesced: true, inFlightUnits: 0 });

    const { server, url } = await startStubServer((req, res) => {
      capturedMethod = req.method;
      capturedPath = req.url;
      capturedHeaders = { ...req.headers };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(znapiResponseBody);
    });
    znapi = server;
    znapiUrl = url;

    addSchedulerRoutes(app, { znapiBaseUrl: znapiUrl, internalSecretFile: secretFile });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/scheduler/quiesce' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ quiesced: true, inFlightUnits: 0 });

    // Verify headers sent to znapi
    expect(capturedMethod).toBe('POST');
    expect(capturedPath).toBe('/internal/scheduler/quiesce');
    expect(capturedHeaders?.['x-internal-origin']).toBe('deploy');
    expect(capturedHeaders?.['x-internal-secret']).toBe(secret); // trimmed
  });

  it('POST /scheduler/quiesce — does NOT send X-Forwarded-For to znapi', async () => {
    secretFile = writeTempSecret('s3cr3t');

    const { server, url } = await startStubServer((req, res) => {
      capturedHeaders = { ...req.headers };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ quiesced: true, inFlightUnits: 0 }));
    });
    znapi = server;
    znapiUrl = url;

    addSchedulerRoutes(app, { znapiBaseUrl: znapiUrl, internalSecretFile: secretFile });
    await app.ready();

    // Inject with X-Forwarded-For — it must NOT be forwarded to znapi
    const response = await app.inject({
      method: 'POST',
      url: '/scheduler/quiesce',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedHeaders?.['x-forwarded-for']).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 404 non-fatal: znapi returns 404 (old version without scheduler endpoint)
  // -------------------------------------------------------------------------
  it('POST /scheduler/quiesce — znapi 404 → non-fatal 200 with available:false', async () => {
    secretFile = writeTempSecret('s3cr3t');

    const { server, url } = await startStubServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    znapi = server;
    znapiUrl = url;

    addSchedulerRoutes(app, { znapiBaseUrl: znapiUrl, internalSecretFile: secretFile });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/scheduler/quiesce' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      available: false,
      reason: 'znapi-internal-scheduler-not-found',
    });
  });

  // -------------------------------------------------------------------------
  // Missing secret file → 500
  // -------------------------------------------------------------------------
  it('POST /scheduler/quiesce — missing secret file → 500 with error message', async () => {
    const nonExistentFile = '/tmp/no-such-secret-file-xyz-999.txt';
    if (fs.existsSync(nonExistentFile)) fs.unlinkSync(nonExistentFile);

    // znapi stub (won't be reached, but needed to build the route config)
    const { server, url } = await startStubServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    znapi = server;
    znapiUrl = url;

    addSchedulerRoutes(app, { znapiBaseUrl: znapiUrl, internalSecretFile: nonExistentFile });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/scheduler/quiesce' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'deploy secret unreadable' });
  });

  // -------------------------------------------------------------------------
  // Fix 1: whitespace-only secret file → treated as unreadable → 500
  // -------------------------------------------------------------------------
  it('POST /scheduler/quiesce — whitespace-only secret file → 500, znapi NOT called', async () => {
    secretFile = writeTempSecret('   \n\t  \n'); // whitespace only — must be treated as unreadable

    let znapiCalled = false;
    const { server, url } = await startStubServer((_req, res) => {
      znapiCalled = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ quiesced: true, inFlightUnits: 0 }));
    });
    znapi = server;
    znapiUrl = url;

    addSchedulerRoutes(app, { znapiBaseUrl: znapiUrl, internalSecretFile: secretFile });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/scheduler/quiesce' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'deploy secret unreadable' });
    expect(znapiCalled).toBe(false); // znapi must NOT have been contacted
  });

  // -------------------------------------------------------------------------
  // Fix 2: non-2xx znapi response → proxied through AND warn log fires
  // -------------------------------------------------------------------------
  it('POST /scheduler/quiesce — znapi returns 403 → proxied 403 AND warn logged', async () => {
    secretFile = writeTempSecret('s3cr3t');

    const { server, url } = await startStubServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
    });
    znapi = server;
    znapiUrl = url;

    // Spy on the module-level log object (healthLogger, imported as `log` in the
    // routes module) by monkey-patching its .warn method on the live object.
    const { healthLogger } = await import('./logger.js');
    const warnCalls: unknown[] = [];
    const originalWarn = healthLogger.warn.bind(healthLogger);
    healthLogger.warn = (...args: unknown[]) => {
      warnCalls.push(args);
      return originalWarn(...(args as Parameters<typeof originalWarn>));
    };

    addSchedulerRoutes(app, { znapiBaseUrl: url, internalSecretFile: secretFile });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/scheduler/quiesce' });

    // Restore original warn
    healthLogger.warn = originalWarn;

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'forbidden' });

    // At least one warn call must have statusCode === 403 in its first arg
    const has403Warn = warnCalls.some((call) => {
      const [obj] = call as [Record<string, unknown>, ...unknown[]];
      return typeof obj === 'object' && obj !== null && obj['statusCode'] === 403;
    });
    expect(has403Warn).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Unreachable znapi → 502
  // NOTE: An https integration test is intentionally omitted — setting up a
  // local TLS stub in unit tests adds significant complexity with self-signed
  // certs. The https branch in callZnapi is covered by the production path;
  // a separate integration test suite would be the right venue for it.
  // -------------------------------------------------------------------------
  it('POST /scheduler/quiesce — znapi unreachable → 502 with error body', async () => {
    secretFile = writeTempSecret('s3cr3t');

    // Start a server then immediately close it so we have a definitely-closed port
    const { server, url } = await startStubServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await stopServer(server);
    // server is now stopped — port is closed; route will get ECONNREFUSED

    addSchedulerRoutes(app, { znapiBaseUrl: url, internalSecretFile: secretFile });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/scheduler/quiesce' });

    expect(response.statusCode).toBe(502);
    const body = response.json<{ error: string; message: string }>();
    expect(body.error).toBe('failed to reach znapi');
    expect(typeof body.message).toBe('string');
  });

  // -------------------------------------------------------------------------
  // GET /scheduler/status — happy path
  // -------------------------------------------------------------------------
  it('GET /scheduler/status — reads secret + GETs znapi and returns its JSON', async () => {
    secretFile = writeTempSecret('status-secret');

    const { server, url } = await startStubServer((req, res) => {
      capturedMethod = req.method;
      capturedPath = req.url;
      capturedHeaders = { ...req.headers };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ quiesced: false, inFlightUnits: 3 }));
    });
    znapi = server;
    znapiUrl = url;

    addSchedulerRoutes(app, { znapiBaseUrl: znapiUrl, internalSecretFile: secretFile });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/scheduler/status' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ quiesced: false, inFlightUnits: 3 });
    expect(capturedMethod).toBe('GET');
    expect(capturedPath).toBe('/internal/scheduler/status');
    expect(capturedHeaders?.['x-internal-origin']).toBe('deploy');
    expect(capturedHeaders?.['x-internal-secret']).toBe('status-secret');
  });

  it('GET /scheduler/status — znapi 404 → non-fatal 200 with available:false', async () => {
    secretFile = writeTempSecret('s3cr3t');

    const { server, url } = await startStubServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    znapi = server;
    znapiUrl = url;

    addSchedulerRoutes(app, { znapiBaseUrl: znapiUrl, internalSecretFile: secretFile });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/scheduler/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, reason: 'znapi-internal-scheduler-not-found' });
  });

  // -------------------------------------------------------------------------
  // POST /scheduler/resume — happy path
  // -------------------------------------------------------------------------
  it('POST /scheduler/resume — reads secret + POSTs znapi and returns its JSON', async () => {
    secretFile = writeTempSecret('resume-secret');

    const { server, url } = await startStubServer((req, res) => {
      capturedMethod = req.method;
      capturedPath = req.url;
      capturedHeaders = { ...req.headers };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ quiesced: false }));
    });
    znapi = server;
    znapiUrl = url;

    addSchedulerRoutes(app, { znapiBaseUrl: znapiUrl, internalSecretFile: secretFile });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/scheduler/resume' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ quiesced: false });
    expect(capturedMethod).toBe('POST');
    expect(capturedPath).toBe('/internal/scheduler/resume');
    expect(capturedHeaders?.['x-internal-origin']).toBe('deploy');
    expect(capturedHeaders?.['x-internal-secret']).toBe('resume-secret');
  });

  it('POST /scheduler/resume — znapi 404 → non-fatal 200 with available:false', async () => {
    secretFile = writeTempSecret('s3cr3t');

    const { server, url } = await startStubServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    znapi = server;
    znapiUrl = url;

    addSchedulerRoutes(app, { znapiBaseUrl: znapiUrl, internalSecretFile: secretFile });
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/scheduler/resume' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, reason: 'znapi-internal-scheduler-not-found' });
  });

  // -------------------------------------------------------------------------
  // Default values
  // -------------------------------------------------------------------------
  it('uses defaults when config options are omitted — returns 500 (secret file missing)', async () => {
    // Default secret path (/etc/zincapi/scheduler-deploy-secret) won't exist in test env
    addSchedulerRoutes(app, {});
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/scheduler/quiesce' });
    // Default secret file absent → 500
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'deploy secret unreadable' });
  });
});
