import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginLoader } from '../plugins/loader.js';
import type { AgentConfig } from './config.js';
import * as health from './health.js';

vi.mock('./config.js', () => ({
  loadConfig: () => ({ vaultUrl: 'https://vault.test', auth: {}, targets: [], secretTargets: [] }),
  getTargets: () => [], isConfigured: () => true,
}));

const auth = { authenticate: (header: string | undefined) => header === 'Bearer test-local-credential' };
const headers = { authorization: 'Bearer test-local-credential' };

describe('explicit local recovery', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await health.stopHealthServer();
    health.setPluginLoader(null);
    health.setWebSocketStatus(false);
    health.setSecretWebSocketStatus(false);
    health.setSynchronizationHandler(null);
  });
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it('keeps startup failure observable and requires authentication for a one-shot retry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'znvault-plugin-recovery-'));
    directories.push(directory);
    const pluginPath = join(directory, 'plugin.mjs');
    writeFileSync(pluginPath, `let attempts = 0; let startupComplete = false; export default {
      name: 'payara', version: '3.1.1',
      async onStart() {
        if (++attempts === 1) throw new Error('transient failure');
        startupComplete = true;
      },
      async healthCheck() { return { status: 'healthy' }; },
      async routes(fastify) {
        fastify.addHook('preHandler', async (_request, reply) => {
          if (!startupComplete) return reply.code(503).send({ error: 'STARTUP_RECONCILIATION_NOT_COMPLETE' });
        });
        fastify.post('/start', async () => ({ status: 'domain-started' }));
      }
    };`);
    const loader = new PluginLoader({
      config: { vaultUrl: 'https://vault.test', auth: {}, targets: [] } as AgentConfig,
      childProcessManager: null,
    });
    await loader.loadPlugin({ path: pluginPath });
    await loader.initializePlugins();
    await loader.startPlugins().catch(() => undefined);
    const server = await health.startHealthServer(0, loader, '127.0.0.1', auth);

    expect((await server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(503);
    const fencedDomainStart = await server.inject({ method: 'POST', url: '/plugins/payara/start', headers });
    expect(fencedDomainStart.statusCode).toBe(503);
    expect(fencedDomainStart.json()).toMatchObject({ error: 'STARTUP_RECONCILIATION_NOT_COMPLETE' });
    expect((await server.inject({ method: 'POST', url: '/agent/plugins/payara/start' })).statusCode).toBe(401);
    expect(loader.getPluginStatus('payara')).toBe('error');
    expect((await server.inject({ method: 'POST', url: '/agent/plugins/payara/start', headers })).statusCode).toBe(200);
    expect(loader.getPluginStatus('payara')).toBe('running');
    expect((await server.inject({ method: 'POST', url: '/plugins/payara/start', headers })).json()).toEqual({ status: 'domain-started' });
    expect((await server.inject({ method: 'POST', url: '/agent/plugins/unknown/start', headers })).statusCode).toBe(404);
    await health.stopHealthServer();
    health.setPluginLoader(null);
    const recovery = await health.startHealthServer(0, undefined, '127.0.0.1', auth, true);
    expect((await recovery.inject({ method: 'POST', url: '/agent/plugins/payara/start', headers })).statusCode).toBe(404);
  });

  it('keeps a delivery gap stale after reconnect until explicit authenticated synchronization', async () => {
    const synchronize = vi.fn(async () => undefined);
    health.setSynchronizationHandler(synchronize);
    const server = await health.startHealthServer(0, undefined, '127.0.0.1', auth);
    health.setWebSocketStatus(true);
    health.setSecretWebSocketStatus(true);
    health.setWebSocketStatus(false);
    health.setSecretWebSocketStatus(false);
    health.setWebSocketStatus(true);
    health.setSecretWebSocketStatus(true);
    const stale = await health.getHealthStatus();
    expect(stale.status).toBe('degraded');
    expect(stale.delivery).toMatchObject({ stale: true, recoveryAction: 'POST /synchronize' });
    expect((await server.inject({ method: 'POST', url: '/synchronize' })).statusCode).toBe(401);
    expect(synchronize).not.toHaveBeenCalled();
    expect((await server.inject({ method: 'POST', url: '/synchronize', headers })).statusCode).toBe(200);
    expect(synchronize).toHaveBeenCalledOnce();
    expect((await health.getHealthStatus()).delivery.stale).toBe(false);
  });

  it('reports when authoritative configuration requires an explicit restart', async () => {
    health.setSynchronizationHandler(async () => {
      throw Object.assign(new Error('configuration changed'), { code: 'AGENT_RESTART_REQUIRED' });
    });
    const server = await health.startHealthServer(0, undefined, '127.0.0.1', auth);
    const response = await server.inject({ method: 'POST', url: '/synchronize', headers });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'AGENT_RESTART_REQUIRED', stale: true });
  });

  it('exposes unavailable push delivery before its first server acknowledgement', async () => {
    health.setSynchronizationHandler(async () => undefined);
    health.setWebSocketStatus(false);
    health.setSecretWebSocketStatus(false);
    expect((await health.getHealthStatus()).status).toBe('degraded');
  });

  it('shares explicit synchronization and retains a newer disconnect gap', async () => {
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const synchronize = vi.fn(async () => { started(); await gate; });
    health.setSynchronizationHandler(synchronize);
    const server = await health.startHealthServer(0, undefined, '127.0.0.1', auth);
    const first = server.inject({ method: 'POST', url: '/synchronize', headers });
    const second = server.inject({ method: 'POST', url: '/synchronize', headers });
    await begun;
    await new Promise<void>(resolve => setImmediate(resolve));
    health.markEventDeliveryStale();
    release();
    const responses = await Promise.all([first, second]);
    expect(synchronize).toHaveBeenCalledOnce();
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
    expect((await health.getHealthStatus()).delivery.stale).toBe(true);
  });
});
