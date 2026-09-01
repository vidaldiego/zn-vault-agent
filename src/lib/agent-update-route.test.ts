import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlPlaneAuthenticator } from './control-plane-auth.js';
import type { NpmAutoUpdateService } from '../services/npm-auto-update.js';
import {
  setNpmAutoUpdateService,
  startHealthServer,
  stopHealthServer,
} from './health.js';

vi.mock('./config.js', () => ({
  loadConfig: () => ({ vaultUrl: 'https://vault.test', secretTargets: [] }),
  getTargets: () => [],
  isConfigured: () => true,
}));

const AUTH: ControlPlaneAuthenticator = { authenticate: () => true };
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const PENDING = {
  status: 'pending' as const,
  requestId: REQUEST_ID,
  package: '@zincapp/zn-vault-agent' as const,
  channel: 'dr-m4',
  previousVersion: '2.0.0',
  targetVersion: '2.0.1',
  requestedAt: '2026-09-01T03:00:00.000Z',
  pollPath: `/agent/update/${REQUEST_ID}`,
};
const TERMINAL = {
  status: 'succeeded' as const,
  requestId: REQUEST_ID,
  package: '@zincapp/zn-vault-agent' as const,
  channel: 'dr-m4',
  previousVersion: '2.0.0',
  targetVersion: '2.0.1',
  installedVersion: '2.0.1',
  requestedAt: '2026-09-01T03:00:00.000Z',
  startedAt: '2026-09-01T03:00:01.000Z',
  finishedAt: '2026-09-01T03:00:02.000Z',
  reason: 'installed',
};

function service(status: unknown = PENDING, requestResult: unknown = PENDING): NpmAutoUpdateService {
  return {
    requestUpdate: vi.fn().mockResolvedValue(requestResult),
    getUpdateStatus: vi.fn().mockReturnValue(status),
  } as unknown as NpmAutoUpdateService;
}

afterEach(async () => {
  setNpmAutoUpdateService(null);
  await stopHealthServer();
});

describe('durable Agent update HTTP contract', () => {
  it('POST returns only 202 pending admission and a poll URL', async () => {
    const updater = service();
    setNpmAutoUpdateService(updater);
    const server = await startHealthServer(0, undefined, '127.0.0.1', AUTH);

    const response = await server.inject({
      method: 'POST',
      url: '/agent/update',
      payload: {
        requestId: REQUEST_ID,
        expectedCurrentVersion: '2.0.0',
        targetVersion: '2.0.1',
        force: true,
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(PENDING);
    expect(response.json()).not.toHaveProperty('success');
    expect(response.json()).not.toHaveProperty('willRestart');
    expect(updater.requestUpdate).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      expectedCurrentVersion: '2.0.0',
      targetVersion: '2.0.1',
      force: true,
    });
  });

  it('GET maps pending, success, failure, and unknown to distinct statuses', async () => {
    const updater = service();
    setNpmAutoUpdateService(updater);
    const server = await startHealthServer(0, undefined, '127.0.0.1', AUTH);

    expect((await server.inject({ method: 'GET', url: PENDING.pollPath })).statusCode).toBe(202);
    vi.mocked(updater.getUpdateStatus).mockReturnValue(TERMINAL);
    expect((await server.inject({ method: 'GET', url: PENDING.pollPath })).statusCode).toBe(200);
    vi.mocked(updater.getUpdateStatus).mockReturnValue({ ...TERMINAL, status: 'failed' });
    expect((await server.inject({ method: 'GET', url: PENDING.pollPath })).statusCode).toBe(502);
    vi.mocked(updater.getUpdateStatus).mockReturnValue(null);
    expect((await server.inject({ method: 'GET', url: PENDING.pollPath })).statusCode).toBe(404);
  });

  it.each([
    { result: TERMINAL, expectedStatus: 200 },
    { result: { ...TERMINAL, status: 'failed' as const }, expectedStatus: 502 },
  ])('POST exact replay returns trusted terminal status with HTTP $expectedStatus', async ({ result, expectedStatus }) => {
    const updater = service(PENDING, result);
    setNpmAutoUpdateService(updater);
    const server = await startHealthServer(0, undefined, '127.0.0.1', AUTH);

    const response = await server.inject({
      method: 'POST',
      url: '/agent/update',
      payload: {
        requestId: REQUEST_ID,
        expectedCurrentVersion: '2.0.0',
        targetVersion: '2.0.1',
      },
    });

    expect(response.statusCode).toBe(expectedStatus);
    expect(response.json()).toEqual(result);
  });

  it.each([
    { raw: 'null', label: 'null' },
    { raw: '{}', label: 'missing identity' },
    { raw: '[]', label: 'array' },
    { raw: '"false"', label: 'string' },
    { raw: `{"requestId":"${REQUEST_ID}","expectedCurrentVersion":"2.0.0","targetVersion":"2.0.1","force":"false"}`, label: 'string force' },
    { raw: `{"requestId":"${REQUEST_ID}","expectedCurrentVersion":"2.0.0","targetVersion":"2.0.1","force":false,"extra":true}`, label: 'unknown key' },
    { raw: '{"requestId":"not-a-uuid","expectedCurrentVersion":"2.0.0","targetVersion":"2.0.1"}', label: 'invalid UUID' },
    { raw: `{"requestId":"${REQUEST_ID}","expectedCurrentVersion":"v2.0.0","targetVersion":"2.0.1"}`, label: 'normalized current semver' },
    { raw: `{"requestId":"${REQUEST_ID}","expectedCurrentVersion":"2.0.0","targetVersion":"2.0"}`, label: 'non-exact target semver' },
  ])('rejects malformed $label body before updater side effects', async ({ raw }) => {
    const updater = service();
    setNpmAutoUpdateService(updater);
    const server = await startHealthServer(0, undefined, '127.0.0.1', AUTH);

    const response = await server.inject({
      method: 'POST',
      url: '/agent/update',
      payload: raw,
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_SELF_UPDATE_REQUEST' });
    expect(updater.requestUpdate).not.toHaveBeenCalled();
  });
});
