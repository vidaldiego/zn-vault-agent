import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginAutoUpdateService } from './plugin-auto-update.js';
import {
  resolvePayaraRecoveryStartup,
  startPostUpdateAuthorityRetry,
} from '../lib/websocket.js';
import {
  PAYARA_PLUGIN_CHANNEL,
  PAYARA_PLUGIN_PACKAGE,
  PluginUpdateRail,
  PluginUpdateRailError,
  inspectPayaraPostUpdateRecoveryEvidence,
  type PluginUpdateRequest,
} from './plugin-update-rail.js';

const REQUEST: PluginUpdateRequest = {
  requestId: '11111111-1111-4111-8111-111111111111',
  package: PAYARA_PLUGIN_PACKAGE,
  expectedCurrentVersion: '2.9.0',
  expectedVersion: '3.0.1',
};

interface Internals {
  installedVersions: Map<string, string>;
  detectInstalledVersions(): void;
  getLatestVersion(packageName: string, channel: string): Promise<string>;
  requestRestart(): void;
  checkAndUpdatePayara(): Promise<void>;
}

const roots: string[] = [];
const services: PluginAutoUpdateService[] = [];

function createService(): { service: PluginAutoUpdateService; rail: PluginUpdateRail; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'znvault-plugin-rail-'));
  roots.push(root);
  const data = join(root, 'data');
  const receipts = join(root, 'receipts');
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(receipts, { mode: 0o700 });
  chmodSync(data, 0o700);
  chmodSync(receipts, 0o700);
  const uid = process.getuid?.() ?? 0;
  const rail = new PluginUpdateRail({
    triggerFile: join(data, '.plugin-update-trigger'),
    activeFile: join(data, '.plugin-update-active'),
    receiptDir: receipts,
    receiptOwnerUid: uid,
    agentOwnerUid: uid,
    receiptTimeoutMs: 50,
    receiptPollMs: 5,
    execFileRunner: async () => ({ stdout: '', stderr: '' }),
  });
  const service = new PluginAutoUpdateService([
    { package: PAYARA_PLUGIN_PACKAGE, enabled: true, autoUpdate: { enabled: false } },
    { package: '@scope/unrelated', enabled: true, autoUpdate: { enabled: true } },
  ], { enabled: false, stagedRolloutMaxDelayMs: 0 }, rail);
  services.push(service);
  const internal = service as unknown as Internals;
  internal.installedVersions.set(PAYARA_PLUGIN_PACKAGE, REQUEST.expectedCurrentVersion);
  vi.spyOn(internal, 'detectInstalledVersions').mockImplementation(() => undefined);
  vi.spyOn(internal, 'getLatestVersion').mockResolvedValue(REQUEST.expectedVersion);
  return { service, rail, root };
}

function publishReceipt(
  rail: PluginUpdateRail,
  operation: ReturnType<PluginUpdateRail['readActive']>,
  options: { success?: boolean; target?: string; installed?: string } = {}
): void {
  if (!operation) throw new Error('active operation missing');
  const startedAt = new Date(Date.parse(operation.requestedAt) + 1).toISOString();
  const finishedAt = new Date(Date.parse(startedAt) + 1).toISOString();
  const target = options.target ?? operation.expectedVersion;
  const installed = options.installed ?? target;
  const success = options.success ?? true;
  const content = `v1 ${operation.requestId} ${PAYARA_PLUGIN_PACKAGE} ${PAYARA_PLUGIN_CHANNEL} ${operation.expectedCurrentVersion} ${target} ${installed} ${success ? 'success' : 'failure'} ${operation.requestedAt} ${startedAt} ${finishedAt} ${success ? 'installed' : 'version_mismatch'}\n`;
  writeFileSync(rail.getReceiptPath(operation.requestId), content, { mode: 0o644 });
  chmodSync(rail.getReceiptPath(operation.requestId), 0o644);
}

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PluginAutoUpdateService exact durable operation', () => {
  it('recovers committed nlink=2 boundaries for every Agent-owned rail record', async () => {
    const { service, rail } = createService();
    await service.beginUpdate(REQUEST);
    const suffix = `tmp.123.${REQUEST.requestId}`;

    const triggerTemp = `${rail.triggerFile}.${suffix}`;
    linkSync(rail.triggerFile, triggerTemp);
    expect(lstatSync(rail.triggerFile).nlink).toBe(2);
    expect(rail.readTrigger()?.requestId).toBe(REQUEST.requestId);
    expect(existsSync(triggerTemp)).toBe(false);
    expect(lstatSync(rail.triggerFile).nlink).toBe(1);

    const activeTemp = `${rail.activeFile}.${suffix}`;
    linkSync(rail.activeFile, activeTemp);
    expect(rail.readActive()?.requestId).toBe(REQUEST.requestId);
    expect(existsSync(activeTemp)).toBe(false);

    const active = rail.readActive();
    publishReceipt(rail, active);
    const receiptPath = rail.getReceiptPath(REQUEST.requestId);
    const receiptTemp = `${receiptPath}.${suffix}`;
    linkSync(receiptPath, receiptTemp);
    expect(rail.readReceipt(REQUEST.requestId)?.success).toBe(true);
    expect(existsSync(receiptTemp)).toBe(false);

    const requestedAt = active?.requestedAt ?? new Date().toISOString();
    rail.writeLocalTerminal({
      requestId: REQUEST.requestId,
      package: PAYARA_PLUGIN_PACKAGE,
      channel: PAYARA_PLUGIN_CHANNEL,
      previousVersion: REQUEST.expectedCurrentVersion,
      targetVersion: REQUEST.expectedVersion,
      installedVersion: REQUEST.expectedVersion,
      success: true,
      requestedAt,
      startedAt: requestedAt,
      finishedAt: requestedAt,
      code: 'PLUGIN_UPDATE_SUCCEEDED',
    });
    const terminalPath = rail.localTerminalPath(REQUEST.requestId);
    const terminalTemp = `${terminalPath}.${suffix}`;
    linkSync(terminalPath, terminalTemp);
    expect(rail.readLocalTerminal(REQUEST.requestId)?.success).toBe(true);
    expect(existsSync(terminalTemp)).toBe(false);

    expect(rail.markRestartScheduled(REQUEST.requestId, REQUEST.expectedVersion)).toBe(true);
    const markerPath = rail.restartMarkerPath(REQUEST.requestId);
    const markerTemp = `${markerPath}.${suffix}`;
    linkSync(markerPath, markerTemp);
    expect(rail.hasRestartMarker(REQUEST.requestId, REQUEST.expectedVersion)).toBe(true);
    expect(existsSync(markerTemp)).toBe(false);
  });

  it('ignores an uncommitted partial temp and still publishes one complete operation', async () => {
    const { service, rail } = createService();
    const partial = `${rail.triggerFile}.tmp.987.${REQUEST.requestId}`;
    writeFileSync(partial, 'v1 partial', { mode: 0o600 });
    chmodSync(partial, 0o600);

    await expect(service.beginUpdate(REQUEST)).resolves.toMatchObject({ status: 'pending' });
    expect(rail.readTrigger()?.requestId).toBe(REQUEST.requestId);
    expect(rail.readActive()?.requestId).toBe(REQUEST.requestId);
    expect(readFileSync(partial, 'utf8')).toBe('v1 partial');
  });

  it('fails closed on nlink=2 without the exact publication temp sibling', async () => {
    const { service, rail, root } = createService();
    await service.beginUpdate(REQUEST);
    linkSync(rail.triggerFile, join(root, 'unexpected-hardlink'));

    expect(() => rail.readTrigger()).toThrow(expect.objectContaining({
      code: 'AMBIGUOUS_PUBLICATION',
    }));
  });

  it('publishes only fixed dr-m4 trigger metadata and delegates while periodic is off', async () => {
    const { service, rail } = createService();
    const status = await service.beginUpdate(REQUEST);

    expect(status).toMatchObject({ status: 'pending', channel: 'dr-m4', updated: 0 });
    expect(readFileSync(rail.triggerFile, 'utf8')).toBe(readFileSync(rail.activeFile, 'utf8'));
    expect(readFileSync(rail.triggerFile, 'utf8')).not.toContain('@scope/unrelated');
  });

  it('reconciles a crash after trigger publication on startup without a second POST or npm lookup', async () => {
    vi.useFakeTimers();
    const { service, rail } = createService();
    const internal = service as unknown as Internals;
    const latest = vi.mocked(internal.getLatestVersion);
    const requestedAt = '2026-01-01T00:00:00.000Z';
    const prepared = `v1 ${REQUEST.requestId} ${REQUEST.expectedCurrentVersion} ${REQUEST.expectedVersion} ${requestedAt}\n`;
    writeFileSync(rail.triggerFile, prepared, { mode: 0o600 });
    chmodSync(rail.triggerFile, 0o600);

    // This service instance represents the restarted Agent. start() performs
    // synchronous durable reconciliation before its first asynchronous wait.
    service.start();
    expect(readFileSync(rail.activeFile, 'utf8')).toBe(prepared);
    await expect(service.getUpdateStatus(REQUEST.requestId)).resolves.toMatchObject({
      status: 'pending',
      requestId: REQUEST.requestId,
      requestedAt,
    });
    expect(latest).not.toHaveBeenCalled();

    publishReceipt(rail, rail.readActive());
    internal.installedVersions.set(PAYARA_PLUGIN_PACKAGE, REQUEST.expectedVersion);
    await expect(service.getUpdateStatus(REQUEST.requestId)).resolves.toMatchObject({
      status: 'pending',
      code: 'RESTART_PENDING',
    });
    service.confirmPluginStartup(REQUEST.expectedVersion, true);
    await expect(service.getUpdateStatus(REQUEST.requestId)).resolves.toMatchObject({
      status: 'succeeded',
      updated: 1,
      willRestart: true,
    });
    expect(latest).not.toHaveBeenCalled();
  });

  it('never re-promotes an orphan trigger after a durable timeout terminal', async () => {
    const { service, rail } = createService();
    const internal = service as unknown as Internals;
    const latest = vi.mocked(internal.getLatestVersion);
    const requestedAt = '2026-01-01T00:00:00.000Z';
    const finishedAt = '2026-01-01T00:00:01.000Z';
    writeFileSync(
      rail.triggerFile,
      `v1 ${REQUEST.requestId} ${REQUEST.expectedCurrentVersion} ${REQUEST.expectedVersion} ${requestedAt}\n`,
      { mode: 0o600 }
    );
    chmodSync(rail.triggerFile, 0o600);
    rail.writeLocalTerminal({
      requestId: REQUEST.requestId,
      package: PAYARA_PLUGIN_PACKAGE,
      channel: PAYARA_PLUGIN_CHANNEL,
      previousVersion: REQUEST.expectedCurrentVersion,
      targetVersion: REQUEST.expectedVersion,
      installedVersion: REQUEST.expectedCurrentVersion,
      success: false,
      requestedAt,
      startedAt: requestedAt,
      finishedAt,
      code: 'PLUGIN_UPDATE_TIMEOUT',
    });

    service.start();
    expect(existsSync(rail.activeFile)).toBe(false);
    expect(existsSync(rail.triggerFile)).toBe(true);
    await expect(service.getUpdateStatus(REQUEST.requestId)).resolves.toMatchObject({
      status: 'failed',
      code: 'PLUGIN_UPDATE_TIMEOUT',
      willRestart: false,
    });
    expect(latest).not.toHaveBeenCalled();
  });

  it('keeps timeout non-terminal across restart and accepts only the later root receipt', async () => {
    const { service, rail } = createService();
    const internal = service as unknown as Internals;

    const [compatibilityResult] = await service.triggerUpdates(REQUEST);
    expect(compatibilityResult.success).toBe(false);
    expect(existsSync(rail.triggerFile)).toBe(true);
    expect(existsSync(rail.activeFile)).toBe(true);
    await expect(service.getUpdateStatus(REQUEST.requestId)).resolves.toMatchObject({
      status: 'pending',
      code: 'PENDING',
      willRestart: false,
    });

    // Simulate process restart: durable active+trigger resume without becoming
    // a local failure or publishing another mutation request.
    service.stop();
    service.start();
    await expect(service.getUpdateStatus(REQUEST.requestId)).resolves.toMatchObject({
      status: 'pending',
      requestId: REQUEST.requestId,
    });

    const active = rail.readActive();
    internal.installedVersions.set(PAYARA_PLUGIN_PACKAGE, REQUEST.expectedVersion);
    publishReceipt(rail, active);
    rmSync(rail.triggerFile);
    await expect(service.getUpdateStatus(REQUEST.requestId)).resolves.toMatchObject({
      status: 'pending',
      code: 'RESTART_PENDING',
    });
    service.confirmPluginStartup(REQUEST.expectedVersion, true);
    await expect(service.getUpdateStatus(REQUEST.requestId)).resolves.toMatchObject({
      status: 'succeeded',
      updated: 1,
    });

    // Once the exact receipt is terminal and active is cleared, an unrelated
    // UUID can start normally; the observation timeout left no stale blocker.
    const nextRequest: PluginUpdateRequest = {
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      package: PAYARA_PLUGIN_PACKAGE,
      expectedCurrentVersion: REQUEST.expectedVersion,
      expectedVersion: '3.0.2',
    };
    vi.mocked(internal.getLatestVersion).mockResolvedValue(nextRequest.expectedVersion);
    await expect(service.beginUpdate(nextRequest)).resolves.toMatchObject({
      status: 'pending',
      requestId: nextRequest.requestId,
    });
  });

  it('keeps GET pending through install, Vault outage, and authority recovery until target startup', async () => {
    vi.useFakeTimers();
    const { service, rail } = createService();
    const internal = service as unknown as Internals;
    const restart = vi.spyOn(internal, 'requestRestart').mockImplementation(() => undefined);
    await service.beginUpdate(REQUEST);
    const active = rail.readActive();
    publishReceipt(rail, active);
    internal.installedVersions.set(PAYARA_PLUGIN_PACKAGE, REQUEST.expectedVersion);

    await expect(service.getUpdateStatus(REQUEST.requestId)).resolves.toMatchObject({
      status: 'pending',
      code: 'RESTART_PENDING',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(restart).toHaveBeenCalledOnce();
    expect(inspectPayaraPostUpdateRecoveryEvidence(rail)).toEqual({
      requestId: REQUEST.requestId,
      previousVersion: REQUEST.expectedCurrentVersion,
      targetVersion: REQUEST.expectedVersion,
    });
    expect(resolvePayaraRecoveryStartup({
      configured: true,
      recoveryRequired: false,
      version: REQUEST.expectedVersion,
    }, undefined, REQUEST.expectedVersion)).toEqual({
      phase: 'post-update',
      version: REQUEST.expectedVersion,
    });

    const authorityProbe = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const authorityRestart = vi.fn();
    const stopAuthorityRetry = startPostUpdateAuthorityRetry({
      probe: authorityProbe,
      requestRestart: authorityRestart,
      retryMs: 30_000,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(service.getUpdateStatus(REQUEST.requestId)).resolves.toMatchObject({
      status: 'pending',
      code: 'RESTART_PENDING',
    });
    expect(authorityRestart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(authorityRestart).toHaveBeenCalledOnce();

    service.confirmPluginStartup(REQUEST.expectedVersion, true);
    await expect(service.getUpdateStatus(REQUEST.requestId)).resolves.toMatchObject({
      status: 'succeeded',
      newVersion: REQUEST.expectedVersion,
      updated: 1,
      willRestart: true,
    });
    expect(existsSync(rail.activeFile)).toBe(false);
    expect(inspectPayaraPostUpdateRecoveryEvidence(rail)).toBeNull();
    stopAuthorityRetry();
  });

  it('rejects a receipt/request mismatch and never schedules restart', async () => {
    vi.useFakeTimers();
    const { service, rail } = createService();
    const internal = service as unknown as Internals;
    const restart = vi.spyOn(internal, 'requestRestart').mockImplementation(() => undefined);
    await service.beginUpdate(REQUEST);
    publishReceipt(rail, rail.readActive(), { target: '3.0.2', installed: '3.0.2' });

    await expect(service.getUpdateStatus(REQUEST.requestId)).rejects.toMatchObject({
      code: 'RECEIPT_MISMATCH',
    });
    await vi.runAllTimersAsync();
    expect(restart).not.toHaveBeenCalled();
  });

  it('rejects same UUID with a different identity before a second trigger', async () => {
    const { service, rail } = createService();
    await service.beginUpdate(REQUEST);
    const trigger = readFileSync(rail.triggerFile, 'utf8');

    await expect(service.beginUpdate({ ...REQUEST, expectedVersion: '3.0.2' }))
      .rejects.toEqual(expect.objectContaining<Partial<PluginUpdateRailError>>({
        code: 'REQUEST_ID_CONFLICT',
      }));
    expect(readFileSync(rail.triggerFile, 'utf8')).toBe(trigger);
  });

  it('periodic polling delegates to beginUpdate and has no direct npm install path', async () => {
    const { service } = createService();
    const internal = service as unknown as Internals;
    vi.spyOn(service, 'checkForUpdates').mockResolvedValue([{
      package: PAYARA_PLUGIN_PACKAGE,
      channel: PAYARA_PLUGIN_CHANNEL,
      current: REQUEST.expectedCurrentVersion,
      latest: REQUEST.expectedVersion,
      targetVersion: REQUEST.expectedVersion,
      updateAvailable: true,
      updaterReady: true,
    }]);
    const begin = vi.spyOn(service, 'beginUpdate').mockResolvedValue({
      requestId: REQUEST.requestId,
      package: PAYARA_PLUGIN_PACKAGE,
      channel: PAYARA_PLUGIN_CHANNEL,
      previousVersion: REQUEST.expectedCurrentVersion,
      targetVersion: REQUEST.expectedVersion,
      newVersion: REQUEST.expectedVersion,
      status: 'pending',
      updated: 0,
      willRestart: false,
      restartScheduled: false,
      code: 'PENDING',
      message: 'pending',
      pollPath: `/plugins/update/${REQUEST.requestId}`,
    });

    await internal.checkAndUpdatePayara();
    expect(begin).toHaveBeenCalledOnce();
    expect(JSON.stringify(begin.mock.calls)).toContain(PAYARA_PLUGIN_PACKAGE);
  });
});
