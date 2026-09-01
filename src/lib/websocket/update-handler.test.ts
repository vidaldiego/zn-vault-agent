// Path: src/lib/websocket/update-handler.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleUpdateEvent } from './update-handler.js';
import type { AgentUpdateEvent } from './types.js';
import type { NpmAutoUpdateService } from '../../services/npm-auto-update.js';

// The handler only touches the logger and the NpmAutoUpdateService.requestUpdate
// method, so we mock the logger and pass a stub service.
const logInfo = vi.fn();
const logWarn = vi.fn();
const logError = vi.fn();

vi.mock('../logger.js', () => ({
  wsLogger: {
    info: (...args: unknown[]): void => { logInfo(...args); },
    debug: vi.fn(),
    warn: (...args: unknown[]): void => { logWarn(...args); },
    error: (...args: unknown[]): void => { logError(...args); },
  },
}));

function makeEvent(overrides: Partial<AgentUpdateEvent> = {}): AgentUpdateEvent {
  return {
    event: 'update.available',
    channel: 'stable',
    version: '1.21.0',
    force: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build a stub NpmAutoUpdateService exposing only requestUpdate, which is the
 * single method the handler calls.
 */
function makeService(
  trigger: NpmAutoUpdateService['requestUpdate']
): NpmAutoUpdateService {
  return {
    requestUpdate: trigger,
    getCurrentVersion: () => '1.20.17',
  } as unknown as NpmAutoUpdateService;
}

describe('handleUpdateEvent', () => {
  beforeEach(() => {
    logInfo.mockClear();
    logWarn.mockClear();
    logError.mockClear();
  });

  it('requests a durable pending update when the npm auto-update service is present', async () => {
    const requestUpdate = vi.fn().mockResolvedValue({
      status: 'pending',
      requestId: '33333333-3333-4333-8333-333333333333',
      package: '@zincapp/zn-vault-agent',
      previousVersion: '1.20.17',
      targetVersion: '1.21.0',
      pollPath: '/agent/update/33333333-3333-4333-8333-333333333333',
    });
    const service = makeService(requestUpdate);

    await handleUpdateEvent(makeEvent(), service);

    expect(requestUpdate).toHaveBeenCalledTimes(1);
    // Result is logged at info level
    expect(logInfo).toHaveBeenCalled();
  });

  it('threads the event force flag into triggerUpdate', async () => {
    const requestUpdate = vi.fn().mockResolvedValue({ status: 'pending' });
    const service = makeService(requestUpdate);

    await handleUpdateEvent(makeEvent({ force: true }), service);

    expect(requestUpdate).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedCurrentVersion: '1.20.17',
      targetVersion: '1.21.0',
      force: true,
    });
  });

  it('passes force:false through when the event does not force', async () => {
    const requestUpdate = vi.fn().mockResolvedValue({ status: 'pending' });
    const service = makeService(requestUpdate);

    await handleUpdateEvent(makeEvent({ force: false }), service);

    expect(requestUpdate).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedCurrentVersion: '1.20.17',
      targetVersion: '1.21.0',
      force: false,
    });
  });

  it('does not throw and warns when no update service is wired', async () => {
    await expect(handleUpdateEvent(makeEvent(), null)).resolves.toBeUndefined();
    await expect(handleUpdateEvent(makeEvent(), undefined)).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalled();
  });

  it('logs the error and does not throw when triggerUpdate rejects', async () => {
    const requestUpdate = vi.fn().mockRejectedValue(new Error('npm registry unreachable'));
    const service = makeService(requestUpdate);

    await expect(handleUpdateEvent(makeEvent(), service)).resolves.toBeUndefined();
    expect(requestUpdate).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalled();
  });

  it('logs receipt with version, channel and force', async () => {
    const requestUpdate = vi.fn().mockResolvedValue({ status: 'pending' });
    const service = makeService(requestUpdate);

    await handleUpdateEvent(
      makeEvent({ version: '2.0.0', channel: 'beta', force: true }),
      service
    );

    // First info log is the receipt, carrying version/channel/force.
    const receipt = logInfo.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(receipt).toMatchObject({ version: '2.0.0', channel: 'beta', force: true });
  });
});
