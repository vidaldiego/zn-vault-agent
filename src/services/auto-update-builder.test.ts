// Path: src/services/auto-update-builder.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger to avoid real log output during tests
vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  flushLogs: vi.fn().mockResolvedValue(undefined),
}));

import { NpmAutoUpdateService } from './npm-auto-update.js';
import { buildAutoUpdateService } from './auto-update-builder.js';

describe('buildAutoUpdateService', () => {
  let startSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on start so we can assert whether the periodic checker was kicked off,
    // without actually scheduling timers.
    startSpy = vi.spyOn(NpmAutoUpdateService.prototype, 'start').mockImplementation(() => {});
  });

  afterEach(() => {
    startSpy.mockRestore();
  });

  it('should construct the service but NOT start it when enabled=false', () => {
    const { service, started } = buildAutoUpdateService({ enabled: true }, false);

    // The service is always constructed so the manual trigger (POST /agent/update
    // and the WS update-available trigger) has a non-null service to call.
    expect(service).toBeInstanceOf(NpmAutoUpdateService);
    // The periodic checker must NOT be started when auto-update is disabled.
    expect(started).toBe(false);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('should construct AND start the service when enabled=true', () => {
    const { service, started } = buildAutoUpdateService({ enabled: true }, true);

    expect(service).toBeInstanceOf(NpmAutoUpdateService);
    expect(started).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('should always return a non-null service regardless of the enabled flag', () => {
    const off = buildAutoUpdateService({ enabled: false }, false);
    const on = buildAutoUpdateService({ enabled: false }, true);

    expect(off.service).toBeInstanceOf(NpmAutoUpdateService);
    expect(on.service).toBeInstanceOf(NpmAutoUpdateService);
  });

  it('never starts the Agent updater in Payara recovery-only mode', () => {
    const { service, started } = buildAutoUpdateService({ enabled: true }, true, true);

    expect(service).toBeInstanceOf(NpmAutoUpdateService);
    expect(started).toBe(false);
    expect(startSpy).not.toHaveBeenCalled();
  });
});
