// Path: src/lib/health.ts
// HTTP health and metrics endpoint for zn-vault-agent

import http from 'node:http';
import { healthLogger as log } from './logger.js';
import { exportMetrics } from './metrics.js';
import { loadConfig, getTargets, isConfigured } from './config.js';

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
let server: http.Server | null = null;

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
 * Get current health status
 */
export function getHealthStatus(): HealthStatus {
  const config = loadConfig();
  const targets = getTargets();
  const secretTargets = config.secretTargets || [];

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

  return {
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
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
}

/**
 * Handle HTTP requests
 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url || '/';

  log.debug({ method: req.method, url }, 'Health endpoint request');

  // CORS headers for monitoring tools
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  switch (url) {
    case '/health':
    case '/health/': {
      const health = getHealthStatus();
      const statusCode = health.status === 'unhealthy' ? 503 : 200;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));
      break;
    }

    case '/ready':
    case '/ready/': {
      // Readiness probe - are we configured and at least one WebSocket connected?
      const ready = isConfigured() && (certWsConnected || secretWsConnected);
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready, timestamp: new Date().toISOString() }));
      break;
    }

    case '/live':
    case '/live/': {
      // Liveness probe - is the process running?
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alive: true, timestamp: new Date().toISOString() }));
      break;
    }

    case '/metrics':
    case '/metrics/': {
      // Prometheus metrics
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(exportMetrics());
      break;
    }

    default:
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
  }
}

/**
 * Start the health HTTP server
 */
export function startHealthServer(port: number = 9100): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    if (server) {
      log.warn('Health server already running');
      resolve(server);
      return;
    }

    server = http.createServer(handleRequest);

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.error({ port }, 'Health server port already in use');
      } else {
        log.error({ err }, 'Health server error');
      }
      reject(err);
    });

    server.listen(port, '0.0.0.0', () => {
      log.info({ port }, 'Health server started');
      resolve(server!);
    });
  });
}

/**
 * Stop the health HTTP server
 */
export function stopHealthServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }

    server.close((err) => {
      if (err) {
        log.warn({ err }, 'Error closing health server');
      } else {
        log.info('Health server stopped');
      }
      server = null;
      resolve();
    });
  });
}

/**
 * Check if health server is running
 */
export function isHealthServerRunning(): boolean {
  return server !== null && server.listening;
}
