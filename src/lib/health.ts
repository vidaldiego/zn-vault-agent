// Path: src/lib/health.ts
// HTTP health and metrics endpoint for zn-vault-agent using Fastify

import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { healthLogger as log } from './logger.js';
import { exportMetrics } from './metrics.js';
import { loadConfig, getTargets, isConfigured } from './config.js';
import type { ChildProcessManager, ChildProcessState } from '../services/child-process-manager.js';
import type { PluginLoader } from '../plugins/loader.js';
import type { PluginHealthStatus } from '../plugins/types.js';
import type { PluginAutoUpdateService } from '../services/plugin-auto-update.js';

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
let fastifyServer: FastifyInstance | null = null;
let childProcessManager: ChildProcessManager | null = null;
let pluginLoader: PluginLoader | null = null;
let pluginAutoUpdateService: PluginAutoUpdateService | null = null;

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

  // Child process status affects overall health
  let childProcessState: ChildProcessState | undefined;
  if (childProcessManager) {
    childProcessState = childProcessManager.getState();

    // Degraded if child is restarting or max restarts exceeded
    if (childProcessManager.isDegraded()) {
      status = 'degraded';
    }

    // Unhealthy if child process failed to start and never ran
    if (childProcessState.status === 'crashed' && childProcessState.lastStartTime === null) {
      status = 'unhealthy';
    }
  }

  // Collect plugin health status
  let pluginStatuses: PluginHealthStatus[] | undefined;
  if (pluginLoader?.hasPlugins()) {
    pluginStatuses = await pluginLoader.collectHealthStatus();

    // Plugin status affects overall health
    for (const ps of pluginStatuses) {
      if (ps.status === 'unhealthy' && status !== 'unhealthy') {
        status = 'degraded';
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
  };

  // Only include childProcess if we have exec mode configured
  if (childProcessState) {
    result.childProcess = childProcessState;
  }

  // Include plugin statuses if any plugins are loaded
  if (pluginStatuses && pluginStatuses.length > 0) {
    result.plugins = pluginStatuses;
  }

  return result;
}

/**
 * Create Fastify instance with core routes
 */
function createFastifyInstance(): FastifyInstance {
  const fastify = Fastify({
    logger: false, // We use our own pino logger
    trustProxy: true,
    bodyLimit: 500 * 1024 * 1024, // 500MB for WAR file uploads
  });

  // CORS support for monitoring tools
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (request.method === 'OPTIONS') {
      reply.code(204).send();
    }
  });

  // Health endpoint
  fastify.get('/health', async (_request, reply) => {
    const health = await getHealthStatus();
    const statusCode = health.status === 'unhealthy' ? 503 : 200;
    reply.code(statusCode).send(health);
  });

  // Readiness probe
  fastify.get('/ready', async (_request, reply) => {
    const ready = isConfigured() && (certWsConnected || secretWsConnected);
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

  // Plugin update trigger endpoint
  fastify.post('/plugins/update', async (_request, reply) => {
    if (!pluginAutoUpdateService) {
      return await reply.code(503).send({
        error: 'Plugin auto-update service not available',
        results: [],
      });
    }

    try {
      log.info('Plugin update triggered via HTTP');
      const results = await pluginAutoUpdateService.triggerUpdates();
      const successful = results.filter((r) => r.success);
      const willRestart = successful.length > 0;

      reply.send({
        updated: successful.length,
        results,
        willRestart,
        message: willRestart
          ? 'Updates installed, agent will restart in 2 seconds'
          : results.length === 0
            ? 'No updates available'
            : 'Some updates failed',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      log.error({ err }, 'Failed to update plugins');
      reply.code(500).send({
        error: 'Failed to update plugins',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return fastify;
}

/**
 * Start the health HTTP server
 */
export async function startHealthServer(
  port: number = 9100,
  loader?: PluginLoader
): Promise<FastifyInstance> {
  if (fastifyServer) {
    log.warn('Health server already running');
    return fastifyServer;
  }

  // Set plugin loader if provided
  if (loader) {
    pluginLoader = loader;
  }

  // Create Fastify instance
  fastifyServer = createFastifyInstance();

  // Register plugin routes if loader provided
  if (pluginLoader) {
    await pluginLoader.registerRoutes(fastifyServer);
  }

  try {
    await fastifyServer.listen({ port, host: '0.0.0.0' });
    log.info({ port }, 'Health server started');
    return fastifyServer;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'EADDRINUSE') {
      log.error({ port }, 'Health server port already in use');
    } else {
      log.error({ err: error }, 'Health server error');
    }
    fastifyServer = null;
    throw error;
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
 * Check if health server is running
 */
export function isHealthServerRunning(): boolean {
  return fastifyServer !== null;
}

/**
 * Get the Fastify instance (for testing or advanced use)
 */
export function getFastifyInstance(): FastifyInstance | null {
  return fastifyServer;
}
