// Path: src/lib/health.ts
// HTTP and HTTPS health and metrics endpoint for zn-vault-agent using Fastify

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unwatchFile,
  watchFile,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Server as HttpsServer } from 'node:https';
import semver from 'semver';
import { healthLogger as log } from './logger.js';
import { exportMetrics } from './metrics.js';
import { loadConfig, getTargets, isConfigured } from './config.js';
import type { ChildProcessManager, ChildProcessState } from '../services/child-process-manager.js';
import type { PluginLoader } from '../plugins/loader.js';
import type { PluginHealthStatus } from '../plugins/types.js';
import {
  PluginAutoUpdateService,
} from '../services/plugin-auto-update.js';
import type { PluginUpdateRequest } from '../services/plugin-auto-update.js';
import { PluginUpdateRailError } from '../services/plugin-update-rail.js';
import {
  SelfUpdateRailError,
  type NpmAutoUpdateService,
} from '../services/npm-auto-update.js';
import { addSchedulerRoutes } from './scheduler-routes.js';
import {
  loadControlPlaneAuthenticator,
  type ControlPlaneAuthenticator,
} from './control-plane-auth.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Get agent version from package.json at module load time
let agentVersion = '1.0.0';
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Navigate up from dist/lib to find package.json
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
  agentVersion = pkg.version ?? '1.0.0';
} catch {
  // Fallback to env var or default
  agentVersion = process.env.npm_package_version ?? '1.0.0';
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  code?: 'UPDATE_REQUIRED' | 'STARTUP_CONFIRMATION_PENDING';
  recovery?: {
    package: '@zincapp/znvault-plugin-payara';
    currentVersion: string;
    channel: 'dr-m4';
  };
  websocket: {
    certificates: { connected: boolean; lastEvent?: string };
    secrets: { connected: boolean; lastEvent?: string };
  };
  vault: {
    url: string;
    reachable: boolean;
  };
  certificates: {
    total: number;
    synced: number;
    errors: number;
  };
  secrets: {
    total: number;
    synced: number;
    errors: number;
  };
  pendingMutations: {
    certificates: number;
    secrets: number;
    total: number;
  };
  childProcess?: ChildProcessState;
  plugins?: PluginHealthStatus[];
}

// Track health state
let certWsConnected = false;
let lastCertWsEvent: Date | null = null;
let secretWsConnected = false;
let lastSecretWsEvent: Date | null = null;
let vaultReachable = false;
let syncedCerts = 0;
let certErrors = 0;
let syncedSecrets = 0;
let secretErrors = 0;
let pendingCertificateMutations = 0;
let pendingSecretMutations = 0;
let fastifyServer: FastifyInstance | null = null;
let httpsServer: FastifyInstance | null = null;
let tlsCertPath: string | null = null;
let tlsKeyPath: string | null = null;
let childProcessManager: ChildProcessManager | null = null;
let pluginLoader: PluginLoader | null = null;
let pluginAutoUpdateService: PluginAutoUpdateService | null = null;
let npmAutoUpdateService: NpmAutoUpdateService | null = null;
let pluginRecoveryRequired: HealthStatus['recovery'] | null = null;
let pluginRecoveryCode: HealthStatus['code'] | null = null;

/**
 * Update WebSocket connection status for certificates
 */
export function setWebSocketStatus(connected: boolean, eventTime?: Date): void {
  certWsConnected = connected;
  if (eventTime) {
    lastCertWsEvent = eventTime;
  }
}

/**
 * Update WebSocket connection status for secrets
 */
export function setSecretWebSocketStatus(connected: boolean, eventTime?: Date): void {
  secretWsConnected = connected;
  if (eventTime) {
    lastSecretWsEvent = eventTime;
  }
}

/**
 * Update vault reachability status
 */
export function setVaultReachable(reachable: boolean): void {
  vaultReachable = reachable;
}

/**
 * Update certificate sync status
 */
export function updateCertStatus(synced: number, errors: number): void {
  syncedCerts = synced;
  certErrors = errors;
}

/**
 * Update secret sync status
 */
export function updateSecretStatus(synced: number, errors: number): void {
  syncedSecrets = synced;
  secretErrors = errors;
}

/** Mark unapplied contended WebSocket generations as fail-closed health. */
export function setPendingMutationRetries(
  kind: 'certificate' | 'secret',
  count: number
): void {
  const normalizedCount = Math.max(0, Math.trunc(count));
  if (kind === 'certificate') {
    pendingCertificateMutations = normalizedCount;
  } else {
    pendingSecretMutations = normalizedCount;
  }
}

/**
 * Set child process manager for health status reporting
 */
export function setChildProcessManager(manager: ChildProcessManager | null): void {
  childProcessManager = manager;
}

/**
 * Set plugin loader for health status aggregation and route registration
 */
export function setPluginLoader(loader: PluginLoader | null): void {
  pluginLoader = loader;
}

/**
 * Set plugin auto-update service for version checking and updates via HTTP
 */
export function setPluginAutoUpdateService(service: PluginAutoUpdateService | null): void {
  pluginAutoUpdateService = service;
}

/**
 * Set npm auto-update service for agent version checking and updates via HTTP
 */
export function setNpmAutoUpdateService(service: NpmAutoUpdateService | null): void {
  npmAutoUpdateService = service;
}

export function setPluginRecoveryRequired(
  currentVersion: string | null,
  code: NonNullable<HealthStatus['code']> = 'UPDATE_REQUIRED'
): void {
  pluginRecoveryRequired = currentVersion === null ? null : {
    package: '@zincapp/znvault-plugin-payara',
    currentVersion,
    channel: 'dr-m4',
  };
  pluginRecoveryCode = currentVersion === null ? null : code;
}

/**
 * Get current health status
 */
export async function getHealthStatus(): Promise<HealthStatus> {
  const config = loadConfig();
  const targets = getTargets();
  const secretTargets = config.secretTargets ?? [];

  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

  // Determine overall status
  const hasTargets = targets.length > 0 || secretTargets.length > 0;
  const wsConnected = (targets.length === 0 || certWsConnected) &&
                      (secretTargets.length === 0 || secretWsConnected);

  if (hasTargets && (!wsConnected || !vaultReachable)) {
    status = 'degraded';
  }
  if (certErrors > 0 || secretErrors > 0) {
    status = 'degraded';
  }
  if (!isConfigured()) {
    status = 'unhealthy';
  }
  if (pendingCertificateMutations > 0 || pendingSecretMutations > 0) {
    status = 'unhealthy';
  }
  if (pluginRecoveryRequired) status = 'unhealthy';

  // Child process status affects overall health
  let childProcessState: ChildProcessState | undefined;
  if (childProcessManager) {
    childProcessState = childProcessManager.getState();

    // Degraded while the child is transitioning or crash recovery is pending.
    if (childProcessManager.isDegraded() && status === 'healthy') {
      status = 'degraded';
    }

    // A configured consumer that is absent or cannot recover is unhealthy.
    // Never let historical start metadata turn stale consumer state green.
    if (childProcessState.status === 'crashed'
        || childProcessState.status === 'max_restarts_exceeded'
        || childProcessState.status === 'stopped') {
      status = 'unhealthy';
    }
  }

  // Collect plugin health status
  let pluginStatuses: PluginHealthStatus[] | undefined;
  if (pluginLoader?.hasPlugins()) {
    pluginStatuses = await pluginLoader.collectHealthStatus();

    // Plugin status affects overall health
    for (const ps of pluginStatuses) {
      if (ps.status === 'unhealthy') {
        // A configured plugin can own the application lifecycle. Its explicit
        // unhealthy state (for example a stopped/quarantined Payara domain)
        // must make both /health and /ready fail closed.
        status = 'unhealthy';
      }
      if (ps.status === 'degraded' && status === 'healthy') {
        status = 'degraded';
      }
    }
  }

  const result: HealthStatus = {
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: agentVersion,
    websocket: {
      certificates: {
        connected: certWsConnected,
        lastEvent: lastCertWsEvent?.toISOString(),
      },
      secrets: {
        connected: secretWsConnected,
        lastEvent: lastSecretWsEvent?.toISOString(),
      },
    },
    vault: {
      url: config.vaultUrl || 'not configured',
      reachable: vaultReachable,
    },
    certificates: {
      total: targets.length,
      synced: syncedCerts,
      errors: certErrors,
    },
    secrets: {
      total: secretTargets.length,
      synced: syncedSecrets,
      errors: secretErrors,
    },
    pendingMutations: {
      certificates: pendingCertificateMutations,
      secrets: pendingSecretMutations,
      total: pendingCertificateMutations + pendingSecretMutations,
    },
  };

  if (pluginRecoveryRequired) {
    result.code = pluginRecoveryCode ?? 'UPDATE_REQUIRED';
    result.recovery = pluginRecoveryRequired;
    result.plugins = [{
      name: 'payara',
      version: pluginRecoveryRequired.currentVersion,
      status: 'unhealthy',
      message: result.code,
    }];
  }

  // Only include childProcess if we have exec mode configured
  if (childProcessState) {
    result.childProcess = childProcessState;
  }

  // Include plugin statuses if any plugins are loaded
  if (!pluginRecoveryRequired && pluginStatuses && pluginStatuses.length > 0) {
    result.plugins = pluginStatuses;
  }

  return result;
}

/** Readiness preserves the connection gate and also fails closed on health. */
export async function getReadinessStatus(): Promise<boolean> {
  if (pluginRecoveryRequired) return false;
  if (!isConfigured() || (!certWsConnected && !secretWsConnected)) {
    return false;
  }
  const health = await getHealthStatus();
  return health.status !== 'unhealthy';
}

/**
 * Add health routes to a Fastify instance
 */
const PUBLIC_MONITORING_PATHS = new Set(['/health', '/ready', '/live', '/metrics']);

/** Install the root guard inherited by core and plugin route scopes. */
export function addControlPlaneGuard(
  fastify: FastifyInstance,
  controlPlaneAuth: ControlPlaneAuthenticator
): void {
  fastify.addHook('onRequest', async (request, reply) => {
    // CORS support for monitoring tools. Bearer credentials are explicit
    // headers (not ambient cookies), and OPTIONS carries no resource action.
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }

    const pathname = request.url.split('?', 1)[0] ?? request.url;
    if (!PUBLIC_MONITORING_PATHS.has(pathname)
      && !controlPlaneAuth.authenticate(request.headers.authorization)
    ) {
      reply.header('WWW-Authenticate', 'Bearer realm="zn-vault-agent-control"');
      return reply.code(401).send({
        error: 'CONTROL_PLANE_AUTH_REQUIRED',
        message: 'A valid local control-plane credential is required',
      });
    }
  });
}

function addHealthRoutes(
  fastify: FastifyInstance,
  controlPlaneAuth: ControlPlaneAuthenticator,
  recoveryOnly: boolean = false
): void {
  addControlPlaneGuard(fastify, controlPlaneAuth);

  // Health endpoint
  fastify.get('/health', async (_request, reply) => {
    const health = await getHealthStatus();
    const statusCode = health.status === 'unhealthy' ? 503 : 200;
    reply.code(statusCode).send(health);
  });

  // Readiness probe
  fastify.get('/ready', async (_request, reply) => {
    const ready = await getReadinessStatus();
    const statusCode = ready ? 200 : 503;
    reply.code(statusCode).send({ ready, timestamp: new Date().toISOString() });
  });

  // Liveness probe
  fastify.get('/live', async (_request, reply) => {
    reply.send({ alive: true, timestamp: new Date().toISOString() });
  });

  // Prometheus metrics
  fastify.get('/metrics', async (_request, reply) => {
    reply.type('text/plain; version=0.0.4; charset=utf-8').send(exportMetrics());
  });

  // Plugin version check endpoint
  fastify.get('/plugins/versions', async (_request, reply) => {
    if (!pluginAutoUpdateService) {
      return await reply.code(503).send({
        error: 'Plugin auto-update service not available',
        versions: [],
      });
    }

    try {
      const versions = await pluginAutoUpdateService.checkForUpdates();
      const hasUpdates = versions.some((v) => v.updateAvailable);
      reply.send({
        hasUpdates,
        versions,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      log.error({ err }, 'Failed to check plugin versions');
      reply.code(500).send({
        error: 'Failed to check plugin versions',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const sendPluginUpdateStatus = async (
    reply: FastifyReply,
    status: Awaited<ReturnType<PluginAutoUpdateService['getUpdateStatus']>>
  ): Promise<unknown> => {
    const statusCode = status.status === 'pending'
      ? 202
      : status.status === 'succeeded' ? 200 : 502;
    return await reply.code(statusCode).send({
      ...status,
      timestamp: status.finishedAt ?? new Date().toISOString(),
    });
  };

  const pluginUpdateErrorStatus = (err: PluginUpdateRailError): number => {
    if (err.code === 'PLUGIN_UPDATE_NOT_FOUND') return 404;
    if (
      err.code.startsWith('INVALID_')
      || err.code === 'PLUGIN_NOT_ALLOWLISTED'
    ) return 400;
    if (
      err.code === 'REQUEST_ID_CONFLICT'
      || err.code === 'PLUGIN_UPDATE_IN_PROGRESS'
      || err.code === 'CURRENT_VERSION_MISMATCH'
      || err.code === 'TARGET_VERSION_MISMATCH'
      || err.code === 'PLUGIN_DOWNGRADE_REFUSED'
    ) return 409;
    if (
      err.code === 'PAYARA_PLUGIN_NOT_CONFIGURED'
      || err.code === 'PLUGIN_UPDATER_RAIL_UNAVAILABLE'
      || err.code === 'INSTALLED_VERSION_UNAVAILABLE'
    ) return 503;
    return 500;
  };

  // Exact, recoverable Payara update trigger endpoint.
  fastify.post<{ Body: unknown }>('/plugins/update', async (request, reply) => {
    if (!pluginAutoUpdateService) {
      return await reply.code(503).send({
        error: 'Plugin auto-update service not available',
        code: 'PLUGIN_UPDATER_UNAVAILABLE',
      });
    }

    const updateRequest = request.body;
    const exactKeys = ['expectedCurrentVersion', 'expectedVersion', 'package', 'requestId'];
    if (
      typeof updateRequest !== 'object'
      || updateRequest === null
      || Array.isArray(updateRequest)
      || Object.keys(updateRequest).sort().join(',') !== exactKeys.join(',')
      || typeof (updateRequest as { requestId?: unknown }).requestId !== 'string'
      || typeof (updateRequest as { package?: unknown }).package !== 'string'
      || typeof (updateRequest as { expectedCurrentVersion?: unknown }).expectedCurrentVersion !== 'string'
      || typeof (updateRequest as { expectedVersion?: unknown }).expectedVersion !== 'string'
    ) {
      return await reply.code(400).send({
        error: 'Exact requestId, package, expectedCurrentVersion and expectedVersion are required',
        code: 'INVALID_PLUGIN_UPDATE_REQUEST',
      });
    }

    try {
      const exactRequest = updateRequest as PluginUpdateRequest;
      log.info({ requestId: exactRequest.requestId }, 'Exact Payara plugin update requested');
      const status = await pluginAutoUpdateService.beginUpdate(exactRequest);
      // POST is always an operation acknowledgement. Even an idempotent
      // terminal replay/no-op is retrieved through the durable GET contract.
      return await reply.code(202).send({
        ...status,
        status: 'pending',
        updated: 0,
        willRestart: false,
        restartScheduled: status.restartScheduled,
        code: 'POLL_REQUIRED',
        message: 'Plugin update request accepted; poll the durable operation status',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const statusCode = err instanceof PluginUpdateRailError
        ? pluginUpdateErrorStatus(err)
        : 500;
      log.error({ err }, 'Exact Payara plugin update request failed');
      return await reply.code(statusCode).send({
        error: err instanceof Error ? err.message : String(err),
        code: err instanceof PluginUpdateRailError ? err.code : 'PLUGIN_UPDATE_FAILED',
        status: 'failed',
        requestId: (updateRequest as PluginUpdateRequest).requestId,
        package: (updateRequest as PluginUpdateRequest).package,
        previousVersion: (updateRequest as PluginUpdateRequest).expectedCurrentVersion,
        targetVersion: (updateRequest as PluginUpdateRequest).expectedVersion,
        newVersion: (updateRequest as PluginUpdateRequest).expectedCurrentVersion,
        installedVersion: (updateRequest as PluginUpdateRequest).expectedCurrentVersion,
        updated: 0,
        willRestart: false,
      });
    }
  });

  fastify.get<{ Params: { requestId: string } }>(
    '/plugins/update/:requestId',
    async (request, reply) => {
      if (!pluginAutoUpdateService) {
        return await reply.code(503).send({
          error: 'Plugin updater service not available',
          code: 'PLUGIN_UPDATER_UNAVAILABLE',
        });
      }
      try {
        const status = await pluginAutoUpdateService.getUpdateStatus(request.params.requestId);
        return await sendPluginUpdateStatus(reply, status);
      } catch (err) {
        const statusCode = err instanceof PluginUpdateRailError
          ? pluginUpdateErrorStatus(err)
          : 500;
        return await reply.code(statusCode).send({
          error: err instanceof Error ? err.message : String(err),
          code: err instanceof PluginUpdateRailError ? err.code : 'PLUGIN_UPDATE_STATUS_FAILED',
        });
      }
    }
  );

  // Legacy Payara recovery exposes only monitoring plus the authenticated
  // exact updater surface. Agent/scheduler/plugin mutation routes stay absent.
  if (recoveryOnly) return;

  // Agent version check endpoint
  fastify.get('/agent/version', async (_request, reply) => {
    if (!npmAutoUpdateService) {
      // Auto-update service not available, return current version only
      reply.send({
        current: agentVersion,
        latest: agentVersion,
        updateAvailable: false,
        autoUpdateEnabled: false,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      const versionInfo = await npmAutoUpdateService.checkForUpdates();
      reply.send({
        current: versionInfo.current,
        latest: versionInfo.latest,
        updateAvailable: versionInfo.updateAvailable,
        autoUpdateEnabled: true,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      log.error({ err }, 'Failed to check agent version');
      reply.code(500).send({
        error: 'Failed to check agent version',
        message: err instanceof Error ? err.message : String(err),
        current: agentVersion,
      });
    }
  });

  // New Agent update admission is asynchronous (202). An exact idempotent
  // replay may return an already trusted terminal receipt (200/502); callers
  // can always recover the same state with GET by requestId.
  fastify.post<{ Body: unknown }>('/agent/update', async (request, reply) => {
    const body = request.body;
    if (
      body === undefined
      || body === null
      || typeof body !== 'object'
      || Array.isArray(body)
      || Object.keys(body).some((key) => ![
        'requestId', 'expectedCurrentVersion', 'targetVersion', 'force',
      ].includes(key))
      || typeof (body as { requestId?: unknown }).requestId !== 'string'
      || typeof (body as { expectedCurrentVersion?: unknown }).expectedCurrentVersion !== 'string'
      || typeof (body as { targetVersion?: unknown }).targetVersion !== 'string'
      || ('force' in body && typeof (body as { force?: unknown }).force !== 'boolean')
    ) {
      return await reply.code(400).send({
        error: 'Invalid Agent update request',
        code: 'INVALID_SELF_UPDATE_REQUEST',
        status: 'failed',
      });
    }

    if (!npmAutoUpdateService) {
      return await reply.code(503).send({
        error: 'Agent auto-update service not available',
        status: 'failed',
      });
    }

    const updateRequest = body as {
      requestId: string;
      expectedCurrentVersion: string;
      targetVersion: string;
      force?: boolean;
    };
    if (
      !UUID_V4_RE.test(updateRequest.requestId)
      || semver.valid(updateRequest.expectedCurrentVersion) !== updateRequest.expectedCurrentVersion
      || semver.valid(updateRequest.targetVersion) !== updateRequest.targetVersion
    ) {
      return await reply.code(400).send({
        error: 'Invalid Agent update request',
        code: 'INVALID_SELF_UPDATE_REQUEST',
        status: 'failed',
      });
    }

    try {
      log.info(
        { requestId: updateRequest.requestId, force: updateRequest.force ?? false },
        'Agent update triggered via HTTP'
      );
      const status = await npmAutoUpdateService.requestUpdate(updateRequest);
      const statusCode = status.status === 'pending'
        ? 202
        : status.status === 'succeeded' ? 200 : 502;
      return await reply.code(statusCode).send(status);
    } catch (err) {
      log.error({ err }, 'Failed to update agent');
      const statusCode = err instanceof SelfUpdateRailError ? err.httpStatus : 500;
      return await reply.code(statusCode).send({
        error: 'Failed to update agent',
        message: err instanceof Error ? err.message : String(err),
        code: err instanceof SelfUpdateRailError ? err.code : 'SELF_UPDATE_REQUEST_FAILED',
        status: 'failed',
      });
    }
  });

  fastify.get<{ Params: { requestId: string } }>(
    '/agent/update/:requestId',
    async (request, reply) => {
      if (!npmAutoUpdateService) {
        return await reply.code(503).send({
          error: 'Agent auto-update service not available',
          status: 'failed',
        });
      }
      try {
        const status = npmAutoUpdateService.getUpdateStatus(request.params.requestId);
        if (!status) {
          return await reply.code(404).send({
            error: 'Agent update operation not found',
            code: 'SELF_UPDATE_NOT_FOUND',
          });
        }
        const statusCode = status.status === 'pending'
          ? 202
          : status.status === 'succeeded' ? 200 : 502;
        return await reply.code(statusCode).send(status);
      } catch (err) {
        const statusCode = err instanceof SelfUpdateRailError ? err.httpStatus : 500;
        return await reply.code(statusCode).send({
          error: err instanceof Error ? err.message : String(err),
          code: err instanceof SelfUpdateRailError ? err.code : 'SELF_UPDATE_STATUS_FAILED',
        });
      }
    }
  );

  // Scheduler passthrough routes (/scheduler/quiesce, /scheduler/status, /scheduler/resume)
  // These forward to znapi's /internal/scheduler/* endpoints. No deploy secret —
  // znapi authorizes on loopback (the agent posts to 127.0.0.1).
  const config = loadConfig();
  addSchedulerRoutes(fastify, {
    znapiBaseUrl: config.znapiBaseUrl,
  });
}

/**
 * Create Fastify instance with core routes
 */
function createFastifyInstance(
  controlPlaneAuth: ControlPlaneAuthenticator,
  recoveryOnly: boolean = false
): FastifyInstance {
  const fastify = Fastify({
    logger: false, // We use our own pino logger
    trustProxy: true,
    bodyLimit: 500 * 1024 * 1024, // 500MB for WAR file uploads
  });

  addHealthRoutes(fastify, controlPlaneAuth, recoveryOnly);

  return fastify;
}

/**
 * Start the health HTTP server
 */
export async function startHealthServer(
  port: number = 9100,
  loader?: PluginLoader,
  host: string = '127.0.0.1',
  controlPlaneAuth: ControlPlaneAuthenticator = loadControlPlaneAuthenticator(),
  recoveryOnly: boolean = false
): Promise<FastifyInstance> {
  if (fastifyServer) {
    log.warn('Health server already running');
    return fastifyServer;
  }

  // Set plugin loader if provided
  if (loader) {
    pluginLoader = loader;
  }

  // Keep the candidate local until it has completed every startup phase. A
  // failed listen still owns Fastify resources which must be closed before a
  // caller can safely retry startup on the same port.
  const candidate = createFastifyInstance(controlPlaneAuth, recoveryOnly);
  fastifyServer = candidate;

  try {
    // Register plugin routes if loader provided
    if (pluginLoader) {
      await pluginLoader.registerRoutes(candidate);
    }

    // Default bind: 127.0.0.1. Binding to all interfaces intentionally exposes
    // the four public monitoring routes to the host network; every control and
    // plugin route still requires the local Bearer credential above.
    await candidate.listen({ port, host });
    log.info({ port, host }, 'Health server started');
    return candidate;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'EADDRINUSE') {
      log.error({ port }, 'Health server port already in use');
    } else {
      log.error({ err: error }, 'Health server error');
    }
    if (fastifyServer === candidate) {
      fastifyServer = null;
    }
    try {
      await candidate.close();
    } catch (closeError) {
      log.warn({ err: closeError }, 'Error closing failed health server candidate');
    }
    throw error;
  }
}

/**
 * Start the HTTPS health server with TLS
 */
export async function startHTTPSHealthServer(
  port: number = 9443,
  certPath: string,
  keyPath: string,
  loader?: PluginLoader,
  host: string = '127.0.0.1',
  controlPlaneAuth: ControlPlaneAuthenticator = loadControlPlaneAuthenticator(),
  recoveryOnly: boolean = false
): Promise<FastifyInstance> {
  if (httpsServer) {
    log.warn('HTTPS server already running');
    return httpsServer;
  }

  // Verify certificate files exist
  if (!existsSync(certPath)) {
    throw new Error(`TLS certificate file not found: ${certPath}`);
  }
  if (!existsSync(keyPath)) {
    throw new Error(`TLS key file not found: ${keyPath}`);
  }

  // Set plugin loader if provided
  if (loader) {
    pluginLoader = loader;
  }

  // Read TLS files
  let cert: string;
  let key: string;
  try {
    cert = recoveryOnly ? readTrustedRecoveryTlsFile(certPath) : readFileSync(certPath, 'utf-8');
    key = recoveryOnly ? readTrustedRecoveryTlsFile(keyPath) : readFileSync(keyPath, 'utf-8');
  } catch (err) {
    log.error({ err, certPath, keyPath }, 'Failed to read TLS certificate files');
    if (recoveryOnly && err instanceof Error) throw err;
    throw new Error('Failed to read TLS certificate files', { cause: err });
  }

  let candidate: FastifyInstance | null = null;

  try {
    // Create Fastify instance with HTTPS
    candidate = Fastify({
      logger: false,
      trustProxy: true,
      bodyLimit: 500 * 1024 * 1024,
      https: {
        key,
        cert,
      },
    });
    httpsServer = candidate;

    // Add same routes as HTTP server
    addHealthRoutes(candidate, controlPlaneAuth, recoveryOnly);

    // Register plugin routes if loader provided
    if (pluginLoader) {
      await pluginLoader.registerRoutes(candidate);
    }

    // See startHealthServer() for rationale on the localhost default.
    await candidate.listen({ port, host });
    log.info({ port, host }, 'HTTPS health server started');

    // Set up certificate file watching for hot-reload
    tlsCertPath = certPath;
    tlsKeyPath = keyPath;
    if (!recoveryOnly) setupCertificateWatcher(certPath, keyPath);

    return candidate;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'EADDRINUSE') {
      log.error({ port }, 'HTTPS health server port already in use');
    } else {
      log.error({ err: error }, 'HTTPS health server error');
    }
    if (httpsServer === candidate) {
      httpsServer = null;
    }
    tlsCertPath = null;
    tlsKeyPath = null;
    if (candidate) {
      try {
        await candidate.close();
      } catch (closeError) {
        log.warn({ err: closeError }, 'Error closing failed HTTPS server candidate');
      }
    }
    throw error;
  }
}

function readTrustedRecoveryTlsFile(filePath: string): string {
  const before = lstatSync(filePath);
  const currentUid = process.getuid?.() ?? before.uid;
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || (before.uid !== 0 && before.uid !== currentUid)
    || (before.mode & 0o022) !== 0
    || before.nlink !== 1
    || before.size < 1
    || before.size > 4 * 1024 * 1024
    || !fsConstants.O_NOFOLLOW
  ) {
    throw new Error(`Untrusted recovery TLS file: ${filePath}`);
  }
  const fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.uid !== before.uid
      || opened.mode !== before.mode
      || opened.nlink !== 1
      || opened.size !== before.size
    ) {
      throw new Error(`Recovery TLS file changed while opening: ${filePath}`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Set up file watchers for certificate hot-reload
 */
function setupCertificateWatcher(certPath: string, keyPath: string): void {
  const reloadCertificate = async () => {
    if (!httpsServer) return;

    log.info('Certificate file changed, reloading HTTPS server');

    try {
      // Read new certificate files
      const cert = readFileSync(certPath, 'utf-8');
      const key = readFileSync(keyPath, 'utf-8');

      // Get the underlying Node.js HTTPS server
      const server = httpsServer.server as HttpsServer;

      // Update the TLS context with new certificate
      server.setSecureContext({ cert, key });

      log.info('HTTPS server certificate reloaded successfully');
    } catch (err) {
      log.error({ err }, 'Failed to reload HTTPS certificate');
    }
  };

  // Watch both cert and key files
  watchFile(certPath, { interval: 1000 }, reloadCertificate);
  watchFile(keyPath, { interval: 1000 }, reloadCertificate);

  log.debug({ certPath, keyPath }, 'Certificate file watchers set up');
}

/**
 * Hot-reload HTTPS server certificate (called by TLS certificate manager)
 */
export async function reloadHTTPSCertificate(certPath: string, keyPath: string): Promise<boolean> {
  if (!httpsServer) {
    log.warn('HTTPS server not running, cannot reload certificate');
    return false;
  }

  try {
    const cert = readFileSync(certPath, 'utf-8');
    const key = readFileSync(keyPath, 'utf-8');

    const server = httpsServer.server as HttpsServer;
    server.setSecureContext({ cert, key });

    log.info('HTTPS server certificate hot-reloaded via callback');
    return true;
  } catch (err) {
    log.error({ err }, 'Failed to hot-reload HTTPS certificate');
    return false;
  }
}

/**
 * Stop the health HTTP server
 */
export async function stopHealthServer(): Promise<void> {
  if (!fastifyServer) {
    return;
  }

  try {
    await fastifyServer.close();
    log.info('Health server stopped');
  } catch (err) {
    log.warn({ err }, 'Error closing health server');
  } finally {
    fastifyServer = null;
  }
}

/**
 * Stop the HTTPS health server
 */
export async function stopHTTPSHealthServer(): Promise<void> {
  // Clean up file watchers
  if (tlsCertPath) {
    unwatchFile(tlsCertPath);
  }
  if (tlsKeyPath) {
    unwatchFile(tlsKeyPath);
  }

  const server = httpsServer;
  httpsServer = null;
  tlsCertPath = null;
  tlsKeyPath = null;

  if (!server) return;

  try {
    await server.close();
    log.info('HTTPS health server stopped');
  } catch (err) {
    log.warn({ err }, 'Error closing HTTPS health server');
  }
}

/**
 * Check if health server is running
 */
export function isHealthServerRunning(): boolean {
  return fastifyServer !== null;
}

/**
 * Check if HTTPS health server is running
 */
export function isHTTPSHealthServerRunning(): boolean {
  return httpsServer !== null;
}

/**
 * Get the Fastify instance (for testing or advanced use)
 */
export function getFastifyInstance(): FastifyInstance | null {
  return fastifyServer;
}

/**
 * Get the HTTPS Fastify instance
 */
export function getHTTPSFastifyInstance(): FastifyInstance | null {
  return httpsServer;
}
