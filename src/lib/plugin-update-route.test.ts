import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlPlaneAuthenticator } from './control-plane-auth.js';
import type {
  PluginAutoUpdateService,
  PluginUpdateOperationStatus,
} from '../services/plugin-auto-update.js';
import { PluginUpdateRailError } from '../services/plugin-update-rail.js';
import { triggerPluginUpdate } from '@zincapp/znvault-deploy-core';
import {
  setPluginAutoUpdateService,
  startHealthServer,
  stopHealthServer,
} from './health.js';

vi.mock('./config.js', () => ({
  loadConfig: () => ({ vaultUrl: 'https://vault.test', targets: [], secretTargets: [] }),
  getTargets: () => [],
  isConfigured: () => true,
}));

const TEST_AUTH: ControlPlaneAuthenticator = { authenticate: () => true };
const REQUEST = {
  requestId: '33333333-3333-4333-8333-333333333333',
  package: '@zincapp/znvault-plugin-payara',
  expectedCurrentVersion: '2.9.0',
  expectedVersion: '3.0.1',
} as const;
const REQUESTED_AT = '2026-09-01T10:00:00.000Z';
const STARTED_AT = '2026-09-01T10:00:01.000Z';
const FINISHED_AT = '2026-09-01T10:00:02.000Z';

function operation(status: PluginUpdateOperationStatus['status']): PluginUpdateOperationStatus {
  return {
    requestId: REQUEST.requestId,
    package: REQUEST.package,
    channel: 'dr-m4',
    previousVersion: REQUEST.expectedCurrentVersion,
    targetVersion: REQUEST.expectedVersion,
    newVersion: status === 'succeeded' ? REQUEST.expectedVersion : REQUEST.expectedCurrentVersion,
    installedVersion: status === 'succeeded' ? REQUEST.expectedVersion : REQUEST.expectedCurrentVersion,
    status,
    updated: status === 'succeeded' ? 1 : 0,
    willRestart: status === 'succeeded',
    restartScheduled: status !== 'failed',
    code: status === 'pending' ? 'PENDING' : status === 'succeeded' ? 'STARTUP_CONFIRMED' : 'ROOT_INSTALL_FAILED',
    message: status,
    pollPath: `/plugins/update/${REQUEST.requestId}`,
    requestedAt: REQUESTED_AT,
    ...(status !== 'pending' ? {
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
    } : {}),
  };
}

describe('exact recoverable plugin update HTTP contract', () => {
  afterEach(async () => {
    setPluginAutoUpdateService(null);
    await stopHealthServer();
    vi.restoreAllMocks();
  });

  it('rejects non-exact bodies before invoking the service', async () => {
    const beginUpdate = vi.fn();
    setPluginAutoUpdateService({ beginUpdate } as unknown as PluginAutoUpdateService);
    const server = await startHealthServer(0, undefined, '127.0.0.1', TEST_AUTH);

    const response = await server.inject({
      method: 'POST',
      url: '/plugins/update',
      payload: { ...REQUEST, channel: 'latest' },
    });
    expect(response.statusCode).toBe(400);
    expect(beginUpdate).not.toHaveBeenCalled();
  });

  it('always acknowledges POST as 202 and requires durable GET, including terminal replay', async () => {
    const beginUpdate = vi.fn().mockResolvedValue(operation('succeeded'));
    setPluginAutoUpdateService({ beginUpdate } as unknown as PluginAutoUpdateService);
    const server = await startHealthServer(0, undefined, '127.0.0.1', TEST_AUTH);

    const response = await server.inject({ method: 'POST', url: '/plugins/update', payload: REQUEST });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      requestId: REQUEST.requestId,
      status: 'pending',
      pollPath: `/plugins/update/${REQUEST.requestId}`,
      updated: 0,
      willRestart: false,
    });
    expect(beginUpdate).toHaveBeenCalledWith(REQUEST);
  });

  it('returns 409 with exact correlation on requestId conflict', async () => {
    const beginUpdate = vi.fn().mockRejectedValue(
      new PluginUpdateRailError('REQUEST_ID_CONFLICT', 'conflict')
    );
    setPluginAutoUpdateService({ beginUpdate } as unknown as PluginAutoUpdateService);
    const server = await startHealthServer(0, undefined, '127.0.0.1', TEST_AUTH);

    const response = await server.inject({ method: 'POST', url: '/plugins/update', payload: REQUEST });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      status: 'failed',
      requestId: REQUEST.requestId,
      package: REQUEST.package,
      targetVersion: REQUEST.expectedVersion,
      updated: 0,
      willRestart: false,
    });
  });

  it('returns GET 202 until startup confirmation', async () => {
    const getUpdateStatus = vi.fn().mockResolvedValue(operation('pending'));
    setPluginAutoUpdateService({ getUpdateStatus } as unknown as PluginAutoUpdateService);
    const server = await startHealthServer(0, undefined, '127.0.0.1', TEST_AUTH);
    const response = await server.inject({ method: 'GET', url: `/plugins/update/${REQUEST.requestId}` });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'pending', willRestart: false });
  });

  it('returns exact terminal GET 200 with timestamp equal to finishedAt', async () => {
    const getUpdateStatus = vi.fn().mockResolvedValue(operation('succeeded'));
    setPluginAutoUpdateService({ getUpdateStatus } as unknown as PluginAutoUpdateService);
    const server = await startHealthServer(0, undefined, '127.0.0.1', TEST_AUTH);
    const response = await server.inject({ method: 'GET', url: `/plugins/update/${REQUEST.requestId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'succeeded',
      requestId: REQUEST.requestId,
      previousVersion: REQUEST.expectedCurrentVersion,
      targetVersion: REQUEST.expectedVersion,
      newVersion: REQUEST.expectedVersion,
      installedVersion: REQUEST.expectedVersion,
      updated: 1,
      willRestart: true,
      requestedAt: REQUESTED_AT,
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      timestamp: FINISHED_AT,
    });
  });

  it('returns terminal failure as 502 with no restart', async () => {
    const getUpdateStatus = vi.fn().mockResolvedValue(operation('failed'));
    setPluginAutoUpdateService({ getUpdateStatus } as unknown as PluginAutoUpdateService);
    const server = await startHealthServer(0, undefined, '127.0.0.1', TEST_AUTH);
    const response = await server.inject({ method: 'GET', url: `/plugins/update/${REQUEST.requestId}` });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ status: 'failed', updated: 0, willRestart: false });
  });

  it('is accepted end-to-end by packed deploy-core 0.2.4 POST-to-GET polling', async () => {
    const beginUpdate = vi.fn().mockResolvedValue(operation('pending'));
    const getUpdateStatus = vi.fn().mockResolvedValue(operation('succeeded'));
    setPluginAutoUpdateService({
      beginUpdate,
      getUpdateStatus,
    } as unknown as PluginAutoUpdateService);
    const server = await startHealthServer(0, undefined, '127.0.0.1', TEST_AUTH);
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('missing test listener address');

    const result = await triggerPluginUpdate(
      '127.0.0.1',
      address.port,
      false,
      'payara',
      REQUEST
    );
    expect(result).toMatchObject({
      success: true,
      response: {
        requestId: REQUEST.requestId,
        updated: 1,
        willRestart: true,
        timestamp: FINISHED_AT,
      },
    });
    expect(beginUpdate).toHaveBeenCalledOnce();
    expect(getUpdateStatus).toHaveBeenCalledWith(REQUEST.requestId);
  });
});
