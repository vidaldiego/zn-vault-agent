// Path: src/lib/scheduler-routes.ts
// /scheduler/* passthrough routes — forward requests to znapi's internal scheduler endpoints.
// The agent reads a dedicated deploy secret from a local file and sends it with each request
// so znapi's InternalSchedulerFilter can authenticate the call.

import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { healthLogger as log } from './logger.js';

/** Non-fatal response shape returned when znapi doesn't yet have the
 *  /internal/scheduler/* endpoint (e.g. running an older version).
 *  HTTP 200 so the plugin can treat it as a "capability missing" signal
 *  rather than an error that halts the deploy. */
const ZNAPI_NOT_FOUND_RESPONSE = {
  available: false,
  reason: 'znapi-internal-scheduler-not-found',
} as const;

/** Default path for the deploy secret file (written during agent provisioning). */
const DEFAULT_SECRET_FILE = '/etc/zincapi/scheduler-deploy-secret';

/** Default base URL for the local znapi instance. */
const DEFAULT_ZNAPI_BASE_URL = 'http://127.0.0.1:8080';

export interface SchedulerRoutesConfig {
  /**
   * Base URL of the local znapi instance.
   * @default "http://127.0.0.1:8080"
   */
  znapiBaseUrl?: string;
  /**
   * Path to the dedicated deploy secret file.
   * @default "/etc/zincapi/scheduler-deploy-secret"
   */
  internalSecretFile?: string;
}

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

interface ZnapiResult {
  statusCode: number;
  body: unknown;
}

/**
 * Make a plain HTTP/HTTPS request to znapi with the deploy auth headers.
 * Returns { statusCode, body } — never throws for HTTP-level errors.
 */
function callZnapi(
  method: 'GET' | 'POST',
  znapiBaseUrl: string,
  urlPath: string,
  secret: string,
): Promise<ZnapiResult> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(znapiBaseUrl);
    } catch {
      reject(new Error(`Invalid znapiBaseUrl: ${znapiBaseUrl}`));
      return;
    }

    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port !== '' ? parseInt(parsedUrl.port, 10) : (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: urlPath,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Internal-Origin': 'deploy',
        'X-Internal-Secret': secret,
        // Deliberately NO X-Forwarded-For or proxy headers
      },
      timeout: 15000,
    };

    // Select http or https client based on the target URL protocol
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer | string) => { data += String(chunk); });
      res.on('end', () => {
        let parsed: unknown;
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch {
          parsed = data;
        }
        resolve({ statusCode: res.statusCode ?? 0, body: parsed });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request to znapi timed out'));
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register /scheduler/* passthrough routes on the provided Fastify instance.
 * Call this inside `addHealthRoutes()`.
 */
export function addSchedulerRoutes(
  fastify: FastifyInstance,
  config: SchedulerRoutesConfig,
): void {
  const znapiBaseUrl = config.znapiBaseUrl ?? DEFAULT_ZNAPI_BASE_URL;
  const secretFile = config.internalSecretFile ?? DEFAULT_SECRET_FILE;

  /**
   * Read the deploy secret from the configured file.
   * Returns the trimmed contents on success, null if the file is missing or unreadable.
   */
  function readSecret(): string | null {
    try {
      if (!existsSync(secretFile)) return null;
      return readFileSync(secretFile, 'utf-8').trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Forward a request to znapi's internal scheduler endpoint and send back
   * the response. Handles:
   * - Missing secret file → 500 { error: 'deploy secret unreadable' }
   * - znapi 404 → 200 { available: false, reason: '...' } (non-fatal)
   * - All other znapi statuses → proxied through as-is
   */
  async function proxyToScheduler(
    method: 'GET' | 'POST',
    znapiPath: string,
    reply: import('fastify').FastifyReply,
  ): Promise<void> {
    const secret = readSecret();
    if (secret === null) {
      log.warn({ secretFile }, 'Deploy secret file not readable — /scheduler/* will return 500');
      await reply.code(500).send({ error: 'deploy secret unreadable' });
      return;
    }

    let result: ZnapiResult;
    try {
      result = await callZnapi(method, znapiBaseUrl, znapiPath, secret);
    } catch (err) {
      log.error({ err, znapiPath }, 'Failed to connect to znapi internal scheduler');
      await reply.code(502).send({ error: 'failed to reach znapi', message: err instanceof Error ? err.message : String(err) });
      return;
    }

    // 404 from znapi = old version without this endpoint → non-fatal capability-missing signal
    if (result.statusCode === 404) {
      log.debug({ znapiPath }, 'znapi returned 404 for internal scheduler endpoint — treating as unavailable');
      await reply.code(200).send(ZNAPI_NOT_FOUND_RESPONSE);
      return;
    }

    if (result.statusCode >= 400) {
      log.warn({ znapiPath, statusCode: result.statusCode }, 'znapi returned error status for internal scheduler endpoint');
    }

    await reply.code(result.statusCode).send(result.body);
  }

  // POST /scheduler/quiesce
  fastify.post('/scheduler/quiesce', async (_request, reply) => {
    await proxyToScheduler('POST', '/internal/scheduler/quiesce', reply);
  });

  // GET /scheduler/status
  fastify.get('/scheduler/status', async (_request, reply) => {
    await proxyToScheduler('GET', '/internal/scheduler/status', reply);
  });

  // POST /scheduler/resume
  fastify.post('/scheduler/resume', async (_request, reply) => {
    await proxyToScheduler('POST', '/internal/scheduler/resume', reply);
  });

  log.debug({ znapiBaseUrl, secretFile }, 'Registered /scheduler/* passthrough routes');
}
