import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NpmAutoUpdateService } from './npm-auto-update.js';

const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const REQUESTED_AT = '2026-09-01T03:00:00.000Z';
const STARTED_AT = '2026-09-01T03:00:01.000Z';
const FINISHED_AT = '2026-09-01T03:00:02.000Z';
const roots: string[] = [];

function fixture(): {
  service: NpmAutoUpdateService;
  trigger: string;
  active: string;
  receipt: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'znvault-self-status-'));
  roots.push(root);
  const data = join(root, 'data');
  const state = join(root, 'state');
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  chmodSync(data, 0o700);
  chmodSync(state, 0o700);
  const uid = process.getuid?.() ?? 0;
  return {
    service: new NpmAutoUpdateService(
      { enabled: false, channel: 'dr-m4' },
      { triggerFile: join(data, '.update-trigger'), stateDir: state, agentUid: uid, rootUid: uid }
    ),
    trigger: join(data, '.update-trigger'),
    active: join(state, 'active.state'),
    receipt: join(state, `${REQUEST_ID}.receipt`),
  };
}

function requestRecord(): string {
  return `v1 ${REQUEST_ID} 2.0.0 2.0.1 dr-m4 ${REQUESTED_AT}\n`;
}

function otherRequestRecord(): string {
  return `v1 ${OTHER_REQUEST_ID} 2.0.1 2.0.2 dr-m4 ${REQUESTED_AT}\n`;
}

function receiptRecord(status: 'success' | 'failure' = 'success'): string {
  const installed = status === 'success' ? '2.0.1' : '2.0.0';
  const reason = status === 'success' ? 'installed' : 'npm_install_failed';
  return `v1 ${REQUEST_ID} @zincapp/zn-vault-agent dr-m4 2.0.0 2.0.1 ${installed} ${status} ${REQUESTED_AT} ${STARTED_AT} ${FINISHED_AT} ${reason}\n`;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable self-update status', () => {
  it('stays pending while the Agent trigger exists', () => {
    const { service, trigger } = fixture();
    writeFileSync(trigger, requestRecord(), { mode: 0o600 });
    chmodSync(trigger, 0o600);

    expect(service.getUpdateStatus(REQUEST_ID)).toEqual({
      status: 'pending',
      requestId: REQUEST_ID,
      package: '@zincapp/zn-vault-agent',
      channel: 'dr-m4',
      previousVersion: '2.0.0',
      targetVersion: '2.0.1',
      requestedAt: REQUESTED_AT,
      pollPath: `/agent/update/${REQUEST_ID}`,
    });
  });

  it('treats a root receipt with nlink=2 as pending and never repairs it', () => {
    const { service, receipt } = fixture();
    const temp = `${receipt}.tmp.4321.11111111-1111-4111-8111-111111111111`;
    writeFileSync(receipt, receiptRecord(), { mode: 0o644 });
    chmodSync(receipt, 0o644);
    linkSync(receipt, temp);

    expect(service.getUpdateStatus(REQUEST_ID)?.status).toBe('pending');
    expect(existsSync(receipt)).toBe(true);
    expect(existsSync(temp)).toBe(true);
  });

  it('keeps receipt failure pending through active cleanup, then exposes terminal failure', () => {
    const { service, active, receipt } = fixture();
    writeFileSync(active, requestRecord(), { mode: 0o644 });
    chmodSync(active, 0o644);
    writeFileSync(receipt, receiptRecord('failure'), { mode: 0o644 });
    chmodSync(receipt, 0o644);

    expect(service.getUpdateStatus(REQUEST_ID)?.status).toBe('pending');
    unlinkSync(active);
    expect(service.getUpdateStatus(REQUEST_ID)).toMatchObject({
      status: 'failed',
      requestId: REQUEST_ID,
      channel: 'dr-m4',
      previousVersion: '2.0.0',
      targetVersion: '2.0.1',
      installedVersion: '2.0.0',
      reason: 'npm_install_failed',
      requestedAt: REQUESTED_AT,
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
    });
  });

  it('exposes success only from an exact receipt after trigger and active are absent', () => {
    const { service, receipt } = fixture();
    writeFileSync(receipt, receiptRecord(), { mode: 0o644 });
    chmodSync(receipt, 0o644);

    expect(service.getUpdateStatus(REQUEST_ID)).toMatchObject({
      status: 'succeeded',
      requestId: REQUEST_ID,
      installedVersion: '2.0.1',
      reason: 'installed',
    });
  });

  it('returns not-found for UUID A while only request B evidence exists', () => {
    const { service, trigger } = fixture();
    writeFileSync(trigger, otherRequestRecord(), { mode: 0o600 });
    chmodSync(trigger, 0o600);

    expect(service.getUpdateStatus(REQUEST_ID)).toBeNull();
    expect(service.getUpdateStatus(OTHER_REQUEST_ID)).toMatchObject({
      status: 'pending',
      requestId: OTHER_REQUEST_ID,
      previousVersion: '2.0.1',
      targetVersion: '2.0.2',
      channel: 'dr-m4',
      requestedAt: REQUESTED_AT,
    });
  });

  it('does not reopen terminal receipt A while unrelated request B is active', () => {
    const { service, trigger, receipt } = fixture();
    writeFileSync(receipt, receiptRecord(), { mode: 0o644 });
    chmodSync(receipt, 0o644);
    writeFileSync(trigger, otherRequestRecord(), { mode: 0o600 });
    chmodSync(trigger, 0o600);

    expect(service.getUpdateStatus(REQUEST_ID)?.status).toBe('succeeded');
    expect(service.getUpdateStatus(OTHER_REQUEST_ID)?.status).toBe('pending');
  });

  it('replays caller UUID with the same identity and rejects conflicting reuse', async () => {
    const { service, trigger } = fixture();
    vi.spyOn(service, 'checkForUpdates').mockResolvedValue({
      current: '2.0.0',
      latest: '2.0.1',
      updateAvailable: true,
    });
    const internals = service as unknown as {
      isUpdaterPathUnitActive(): Promise<boolean>;
      acquireLock(): boolean;
      releaseLock(): void;
    };
    vi.spyOn(internals, 'isUpdaterPathUnitActive').mockResolvedValue(true);
    vi.spyOn(internals, 'acquireLock').mockReturnValue(true);
    vi.spyOn(internals, 'releaseLock').mockImplementation(() => undefined);
    const request = {
      requestId: REQUEST_ID,
      expectedCurrentVersion: '2.0.0',
      targetVersion: '2.0.1',
    };

    const admitted = await service.requestUpdate(request);
    const replay = await service.requestUpdate(request);

    expect(replay).toEqual(admitted);
    expect(service.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(readFileSync(trigger, 'utf8')).toBe(
      `v1 ${REQUEST_ID} 2.0.0 2.0.1 dr-m4 ${admitted.requestedAt}\n`
    );
    await expect(service.requestUpdate({ ...request, targetVersion: '2.0.2' }))
      .rejects.toMatchObject({ code: 'SELF_UPDATE_REQUEST_ID_CONFLICT', httpStatus: 409 });
    expect(service.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('returns an exact trusted terminal replay without registry, path, or trigger work', async () => {
    const { service, receipt, trigger } = fixture();
    writeFileSync(receipt, receiptRecord(), { mode: 0o644 });
    chmodSync(receipt, 0o644);
    const checkSpy = vi.spyOn(service, 'checkForUpdates');
    const internals = service as unknown as { isUpdaterPathUnitActive(): Promise<boolean> };
    const pathSpy = vi.spyOn(internals, 'isUpdaterPathUnitActive');

    const replay = await service.requestUpdate({
      requestId: REQUEST_ID,
      expectedCurrentVersion: '2.0.0',
      targetVersion: '2.0.1',
    });

    expect(replay).toMatchObject({
      status: 'succeeded',
      requestId: REQUEST_ID,
      previousVersion: '2.0.0',
      targetVersion: '2.0.1',
      installedVersion: '2.0.1',
    });
    expect(checkSpy).not.toHaveBeenCalled();
    expect(pathSpy).not.toHaveBeenCalled();
    expect(existsSync(trigger)).toBe(false);
  });

  it('rejects requestId replay from a different configured channel', async () => {
    const { service, receipt } = fixture();
    writeFileSync(receipt, receiptRecord().replace(' dr-m4 ', ' latest '), { mode: 0o644 });
    chmodSync(receipt, 0o644);
    const checkSpy = vi.spyOn(service, 'checkForUpdates');

    await expect(service.requestUpdate({
      requestId: REQUEST_ID,
      expectedCurrentVersion: '2.0.0',
      targetVersion: '2.0.1',
    })).rejects.toMatchObject({
      code: 'SELF_UPDATE_REQUEST_ID_CONFLICT',
      httpStatus: 409,
    });
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it('rechecks the same request identity under lock and never publishes twice', async () => {
    const { service, trigger } = fixture();
    const pending = {
      status: 'pending' as const,
      requestId: REQUEST_ID,
      package: '@zincapp/zn-vault-agent' as const,
      channel: 'dr-m4',
      previousVersion: '2.0.0',
      targetVersion: '2.0.1',
      requestedAt: REQUESTED_AT,
      pollPath: `/agent/update/${REQUEST_ID}`,
    };
    vi.spyOn(service, 'getUpdateStatus')
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(pending);
    vi.spyOn(service, 'checkForUpdates').mockResolvedValue({
      current: '2.0.0',
      latest: '2.0.1',
      updateAvailable: true,
    });
    const internals = service as unknown as {
      isUpdaterPathUnitActive(): Promise<boolean>;
      acquireLock(): boolean;
      releaseLock(): void;
    };
    const pathSpy = vi.spyOn(internals, 'isUpdaterPathUnitActive');
    vi.spyOn(internals, 'acquireLock').mockReturnValue(true);
    vi.spyOn(internals, 'releaseLock').mockImplementation(() => undefined);

    await expect(service.requestUpdate({
      requestId: REQUEST_ID,
      expectedCurrentVersion: '2.0.0',
      targetVersion: '2.0.1',
    })).resolves.toEqual(pending);

    expect(service.getUpdateStatus).toHaveBeenCalledTimes(2);
    expect(pathSpy).not.toHaveBeenCalled();
    expect(existsSync(trigger)).toBe(false);
  });
});
