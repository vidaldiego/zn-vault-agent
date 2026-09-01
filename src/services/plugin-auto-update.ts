/**
 * Exact Payara plugin updater.
 *
 * ProtectSystem=strict prevents the Agent from mutating global npm state. The
 * Agent validates an exact control-plane request, publishes a durable trigger
 * for a root-owned helper, verifies its receipt and independently reads the
 * installed version before it may schedule one restart.
 */
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import semver from 'semver';
import { logger } from '../lib/logger.js';
import type { PluginConfig, PluginVersionInfo } from '../plugins/types.js';
import type { UpdateChannel } from '../types/update.js';
import {
  PAYARA_PLUGIN_CHANNEL,
  PAYARA_PLUGIN_PACKAGE,
  PluginUpdateRail,
  PluginUpdateRailError,
  type PluginUpdateActiveOperation,
  type PluginUpdateLocalTerminal,
  type PluginUpdateReceipt,
  type PluginUpdateRequest,
  validatePluginUpdateRequest,
} from './plugin-update-rail.js';

const execFileAsync = promisify(execFile);
const UPDATE_RESTART_DELAY_MS = 2_000;

export type { PluginUpdateRequest } from './plugin-update-rail.js';

interface PackageJson { version?: string }
interface NpmListOutput { dependencies?: Record<string, { version?: string }> }

export interface PluginUpdateResult {
  package: string;
  previousVersion: string;
  newVersion: string;
  success: boolean;
  error?: string;
}

export type PluginUpdateOperationState = 'pending' | 'succeeded' | 'failed';

export interface PluginUpdateOperationStatus {
  requestId: string;
  package: typeof PAYARA_PLUGIN_PACKAGE;
  channel: typeof PAYARA_PLUGIN_CHANNEL;
  previousVersion: string;
  targetVersion: string;
  newVersion: string;
  installedVersion?: string;
  status: PluginUpdateOperationState;
  updated: 0 | 1;
  willRestart: boolean;
  restartScheduled: boolean;
  code: string;
  message: string;
  pollPath: string;
  requestedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export type PluginUpdateChannel = UpdateChannel | typeof PAYARA_PLUGIN_CHANNEL;

export interface PluginAutoUpdateServiceConfig {
  /** Enables periodic checks. Manual exact updates remain available. */
  enabled: boolean;
  checkIntervalMs: number;
  /** Compatibility field only; Payara is always fixed to dr-m4. */
  defaultChannel: PluginUpdateChannel;
  stagedRolloutMaxDelayMs: number;
}

export const DEFAULT_PLUGIN_UPDATE_CONFIG: PluginAutoUpdateServiceConfig = {
  enabled: false,
  checkIntervalMs: 5 * 60 * 1000,
  defaultChannel: PAYARA_PLUGIN_CHANNEL,
  stagedRolloutMaxDelayMs: 30 * 60 * 1000,
};

function sameRequest(request: PluginUpdateRequest, operation: PluginUpdateActiveOperation): boolean {
  return request.requestId === operation.requestId
    && request.package === operation.package
    && request.expectedCurrentVersion === operation.expectedCurrentVersion
    && request.expectedVersion === operation.expectedVersion;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class PluginAutoUpdateService {
  private checkInterval: NodeJS.Timeout | null = null;
  private initialCheckTimeout: NodeJS.Timeout | null = null;
  private stagedRolloutTimeout: NodeJS.Timeout | null = null;
  private readonly config: PluginAutoUpdateServiceConfig;
  private readonly plugins: PluginConfig[];
  private readonly installedVersions = new Map<string, string>();
  private readonly monitoring = new Set<string>();
  private readonly monitorControllers = new Map<string, AbortController>();
  private readonly restartTimeouts = new Set<NodeJS.Timeout>();
  private stopped = false;

  constructor(
    plugins: PluginConfig[],
    config: Partial<PluginAutoUpdateServiceConfig> = {},
    private readonly rail: PluginUpdateRail = new PluginUpdateRail()
  ) {
    this.config = { ...DEFAULT_PLUGIN_UPDATE_CONFIG, ...config };
    this.plugins = plugins.filter(
      (plugin) => plugin.package === PAYARA_PLUGIN_PACKAGE && plugin.enabled !== false
    );
  }

  /** Recovery and manual endpoints are independent of periodic polling. */
  start(): void {
    this.stopped = false;
    if (this.plugins.length === 0) {
      logger.debug('Payara plugin updater unavailable: configured plugin is absent or disabled');
      return;
    }
    void this.resumeActiveOperation().catch((err: unknown) => {
      logger.error({ err }, 'Failed to resume durable Payara plugin update operation');
    });
    if (!this.periodicUpdatesEnabled()) {
      logger.info(
        { package: PAYARA_PLUGIN_PACKAGE, channel: PAYARA_PLUGIN_CHANNEL },
        'Periodic Payara plugin updates disabled; manual exact updater remains available'
      );
      return;
    }
    logger.info(
      {
        intervalSeconds: this.config.checkIntervalMs / 1000,
        package: PAYARA_PLUGIN_PACKAGE,
        channel: PAYARA_PLUGIN_CHANNEL,
      },
      'Starting exact Payara plugin update polling'
    );
    this.initialCheckTimeout = setTimeout(() => {
      void this.checkAndUpdatePayara().catch((err: unknown) => {
        logger.error({ err }, 'Initial Payara plugin update check failed');
      });
    }, 2 * 60_000);
    this.checkInterval = setInterval(() => {
      void this.checkAndUpdatePayara().catch((err: unknown) => {
        logger.error({ err }, 'Payara plugin update check failed');
      });
    }, this.config.checkIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.monitorControllers.values()) controller.abort();
    for (const timeout of this.restartTimeouts) clearTimeout(timeout);
    this.restartTimeouts.clear();
    this.monitorControllers.clear();
    this.monitoring.clear();
    this.disablePeriodicPolling();
    logger.debug('Payara plugin update service stopped');
  }

  /** Disable only automatic polling; manual/recovery operations stay live. */
  disablePeriodicPolling(): void {
    if (this.initialCheckTimeout) clearTimeout(this.initialCheckTimeout);
    if (this.checkInterval) clearInterval(this.checkInterval);
    if (this.stagedRolloutTimeout) clearTimeout(this.stagedRolloutTimeout);
    this.initialCheckTimeout = null;
    this.checkInterval = null;
    this.stagedRolloutTimeout = null;
  }

  /** Always report only configured Payara, even when polling is disabled. */
  async checkForUpdates(): Promise<PluginVersionInfo[]> {
    this.requireConfiguredPayara();
    const current = this.getInstalledPayaraVersion();
    const latest = await this.getLatestVersion(PAYARA_PLUGIN_PACKAGE, PAYARA_PLUGIN_CHANNEL);
    return [{
      package: PAYARA_PLUGIN_PACKAGE,
      channel: PAYARA_PLUGIN_CHANNEL,
      current,
      latest,
      targetVersion: latest,
      updateAvailable: semver.gt(latest, current),
      updaterReady: await this.rail.isActive(),
    }];
  }

  async beginUpdate(request: PluginUpdateRequest): Promise<PluginUpdateOperationStatus> {
    validatePluginUpdateRequest(request);
    this.requireConfiguredPayara();

    // Terminal UUIDs are checked before active/trigger publication. A UUID can
    // never be reused to mutate npm with a different from/target tuple.
    const terminal = await this.readTerminalStatus(request.requestId, request);
    if (terminal) return terminal;

    const active = this.rail.readActive();
    if (active) {
      if (active.requestId === request.requestId && !sameRequest(request, active)) {
        throw new PluginUpdateRailError(
          'REQUEST_ID_CONFLICT',
          'requestId was already used for a different update request'
        );
      }
      if (!sameRequest(request, active)) {
        throw new PluginUpdateRailError('PLUGIN_UPDATE_IN_PROGRESS', 'Another plugin update is active');
      }
      this.monitor(active);
      return this.pendingStatus(active);
    }

    const current = this.getInstalledPayaraVersion();
    if (current !== request.expectedCurrentVersion) {
      throw new PluginUpdateRailError(
        'CURRENT_VERSION_MISMATCH',
        'Installed Payara plugin version does not match expectedCurrentVersion'
      );
    }
    const advertised = await this.getLatestVersion(PAYARA_PLUGIN_PACKAGE, PAYARA_PLUGIN_CHANNEL);
    if (advertised !== request.expectedVersion) {
      throw new PluginUpdateRailError(
        'TARGET_VERSION_MISMATCH',
        `The ${PAYARA_PLUGIN_CHANNEL} channel does not resolve to expectedVersion`
      );
    }

    if (current === request.expectedVersion) {
      const now = new Date().toISOString();
      const noOp: PluginUpdateLocalTerminal = {
        requestId: request.requestId,
        package: PAYARA_PLUGIN_PACKAGE,
        channel: PAYARA_PLUGIN_CHANNEL,
        previousVersion: current,
        targetVersion: current,
        installedVersion: current,
        success: true,
        requestedAt: now,
        startedAt: now,
        finishedAt: now,
        code: 'ALREADY_INSTALLED',
      };
      this.rail.writeLocalTerminal(noOp);
      return this.localTerminalStatus(noOp);
    }
    if (!semver.gt(request.expectedVersion, current)) {
      throw new PluginUpdateRailError('PLUGIN_DOWNGRADE_REFUSED', 'Payara plugin downgrade refused');
    }
    if (!(await this.rail.isActive())) {
      throw new PluginUpdateRailError(
        'PLUGIN_UPDATER_RAIL_UNAVAILABLE',
        'Root-owned Payara plugin updater path unit is not active'
      );
    }

    const begun = this.rail.begin(request);
    if (begun.kind === 'terminal') {
      const replay = await this.readTerminalStatus(request.requestId, request);
      if (!replay) {
        throw new PluginUpdateRailError('TERMINAL_REPLAY_LOST', 'Durable terminal replay disappeared');
      }
      return replay;
    }
    this.monitor(begun.operation);
    return this.pendingStatus(begun.operation);
  }

  async getUpdateStatus(requestId: string): Promise<PluginUpdateOperationStatus> {
    const terminal = await this.readTerminalStatus(requestId);
    if (terminal) return terminal;
    const active = this.rail.readActive();
    if (active?.requestId === requestId) {
      this.monitor(active);
      return this.pendingStatus(active);
    }
    throw new PluginUpdateRailError('PLUGIN_UPDATE_NOT_FOUND', 'Plugin update operation not found');
  }

  /**
   * Called only after the new daemon has completed Payara's startup hook. A
   * root receipt and a restart marker are necessary but not sufficient for a
   * 200 response: the target manifest must be running in this new process.
   */
  confirmPluginStartup(version: string, running: boolean): void {
    const active = this.rail.readActive();
    if (!active) return;
    const receipt = this.rail.readReceipt(active.requestId);
    if (!receipt?.success || receipt.targetVersion !== active.expectedVersion) return;
    if (!this.rail.hasRestartMarker(active.requestId, active.expectedVersion)) return;

    const installed = this.readInstalledPayaraVersion() ?? active.expectedCurrentVersion;
    const exactRunning = running
      && version === active.expectedVersion
      && installed === active.expectedVersion;
    const terminal: PluginUpdateLocalTerminal = {
      requestId: active.requestId,
      package: PAYARA_PLUGIN_PACKAGE,
      channel: PAYARA_PLUGIN_CHANNEL,
      previousVersion: active.expectedCurrentVersion,
      targetVersion: active.expectedVersion,
      installedVersion: installed,
      success: exactRunning,
      requestedAt: receipt.requestedAt,
      startedAt: receipt.startedAt,
      finishedAt: new Date().toISOString(),
      code: exactRunning ? 'STARTUP_CONFIRMED' : 'PLUGIN_STARTUP_FAILED',
    };
    this.rail.writeLocalTerminal(terminal);
    this.rail.clearActive(active);
  }

  /** Compatibility facade for old callers; new HTTP clients poll by UUID. */
  async triggerUpdates(request: PluginUpdateRequest): Promise<PluginUpdateResult[]> {
    let status = await this.beginUpdate(request);
    if (status.status === 'pending') {
      try {
        await this.rail.waitForReceipt(request);
      } catch (err) {
        if (err instanceof PluginUpdateRailError && err.code === 'PLUGIN_UPDATE_TIMEOUT') {
          this.observeReceiptTimeout(request);
        } else {
          throw err;
        }
      }
      status = await this.getUpdateStatus(request.requestId);
    }
    return [{
      package: status.package,
      previousVersion: status.previousVersion,
      newVersion: status.installedVersion ?? status.targetVersion,
      success: status.status === 'succeeded',
      ...(status.status === 'failed' ? { error: status.message } : {}),
    }];
  }

  private requireConfiguredPayara(): void {
    if (this.plugins.length !== 1) {
      throw new PluginUpdateRailError(
        'PAYARA_PLUGIN_NOT_CONFIGURED',
        'The Payara plugin is not configured and enabled on this agent'
      );
    }
  }

  private periodicUpdatesEnabled(): boolean {
    return this.config.enabled && this.plugins[0]?.autoUpdate?.enabled !== false;
  }

  private async resumeActiveOperation(): Promise<void> {
    let active = this.rail.readActive();
    if (!active) {
      // Trigger publication deliberately precedes active publication. If the
      // Agent died in that narrow window, startup (not a second HTTP mutation)
      // must finish the exact durable pair so the root helper can proceed.
      // PluginUpdateRail.begin() checks immutable terminal UUIDs/conflicts
      // first and only writes the missing active twin for this exact trigger.
      const prepared = this.rail.readTrigger();
      if (prepared) {
        const resumed = this.rail.begin({
          requestId: prepared.requestId,
          package: prepared.package,
          expectedCurrentVersion: prepared.expectedCurrentVersion,
          expectedVersion: prepared.expectedVersion,
        });
        if (resumed.kind === 'terminal') {
          throw new PluginUpdateRailError(
            'ORPHANED_TRIGGER_TERMINAL_CONFLICT',
            'Prepared trigger conflicts with an immutable terminal operation'
          );
        }
        active = resumed.operation;
      }
    }
    if (!active) return;
    const local = this.rail.readLocalTerminal(active.requestId);
    if (local) {
      this.rail.clearActive(active);
      return;
    }
    const receipt = this.rail.readReceipt(active.requestId);
    if (receipt && !receipt.success) {
      await this.receiptStatus(receipt, active);
      return;
    }
    this.monitor(active);
  }

  private monitor(operation: PluginUpdateActiveOperation): void {
    if (this.stopped || this.monitoring.has(operation.requestId)) return;
    this.monitoring.add(operation.requestId);
    const controller = new AbortController();
    this.monitorControllers.set(operation.requestId, controller);
    void this.rail.waitForReceipt(operation, controller.signal)
      .then(async () => {
        if (this.stopped || controller.signal.aborted) return;
        await this.getUpdateStatus(operation.requestId);
      })
      .catch((err: unknown) => {
        if (
          this.stopped
          || controller.signal.aborted
          || (err instanceof PluginUpdateRailError && err.code === 'PLUGIN_UPDATE_CANCELLED')
        ) return;
        if (err instanceof PluginUpdateRailError && err.code === 'PLUGIN_UPDATE_TIMEOUT') {
          this.observeReceiptTimeout(operation);
          logger.error(
            { requestId: operation.requestId },
            'Root Payara plugin updater observation timed out; operation remains durably pending'
          );
          return;
        }
        logger.error(
          { err, requestId: operation.requestId },
          'Failed to verify root Payara plugin updater receipt; restart is forbidden'
        );
      })
      .finally(() => {
        if (this.monitorControllers.get(operation.requestId) === controller) {
          this.monitorControllers.delete(operation.requestId);
          this.monitoring.delete(operation.requestId);
        }
      });
  }

  private observeReceiptTimeout(request: PluginUpdateRequest): void {
    const active = this.rail.readActive();
    if (!active || !sameRequest(request, active)) return;
    // The Agent's polling deadline is not evidence that the root helper has
    // stopped. It may still own the kernel lock or be killed/retried by the
    // five-minute oneshot. Keep both durable records and GET=202; only an exact
    // root receipt may close the operation. This prevents a late successful
    // install from contradicting a locally fabricated terminal failure.
    logger.warn(
      { requestId: request.requestId },
      'Exact Payara update still pending after receipt observation deadline'
    );
  }

  private async readTerminalStatus(
    requestId: string,
    expectedRequest?: PluginUpdateRequest
  ): Promise<PluginUpdateOperationStatus | null> {
    const local = this.rail.readLocalTerminal(requestId);
    if (local) {
      if (
        expectedRequest
        && (
          local.package !== expectedRequest.package
          || local.previousVersion !== expectedRequest.expectedCurrentVersion
          || local.targetVersion !== expectedRequest.expectedVersion
        )
      ) {
        throw new PluginUpdateRailError('REQUEST_ID_CONFLICT', 'requestId terminal request mismatch');
      }
      return this.localTerminalStatus(local);
    }

    const receipt = this.rail.readReceipt(requestId);
    if (!receipt) return null;
    if (
      expectedRequest
      && (
        receipt.package !== expectedRequest.package
        || receipt.previousVersion !== expectedRequest.expectedCurrentVersion
        || receipt.targetVersion !== expectedRequest.expectedVersion
      )
    ) {
      throw new PluginUpdateRailError('REQUEST_ID_CONFLICT', 'requestId receipt request mismatch');
    }
    const active = this.rail.readActive();
    return await this.receiptStatus(
      receipt,
      active?.requestId === receipt.requestId ? active : undefined
    );
  }

  private async receiptStatus(
    receipt: PluginUpdateReceipt,
    active?: PluginUpdateActiveOperation
  ): Promise<PluginUpdateOperationStatus> {
    if (
      active
      && (
        receipt.requestId !== active.requestId
        || receipt.package !== active.package
        || receipt.channel !== active.channel
        || receipt.previousVersion !== active.expectedCurrentVersion
        || receipt.targetVersion !== active.expectedVersion
        || receipt.requestedAt !== active.requestedAt
      )
    ) {
      throw new PluginUpdateRailError('RECEIPT_MISMATCH', 'Root receipt does not match active request');
    }

    if (!receipt.success) {
      const failure: PluginUpdateLocalTerminal = {
        requestId: receipt.requestId,
        package: PAYARA_PLUGIN_PACKAGE,
        channel: PAYARA_PLUGIN_CHANNEL,
        previousVersion: receipt.previousVersion,
        targetVersion: receipt.targetVersion,
        installedVersion: receipt.installedVersion ?? receipt.previousVersion,
        success: false,
        requestedAt: receipt.requestedAt,
        startedAt: receipt.startedAt,
        finishedAt: receipt.finishedAt,
        code: `ROOT_${receipt.reason.toUpperCase()}`,
      };
      this.rail.writeLocalTerminal(failure);
      if (active) this.rail.clearActive(active);
      return this.localTerminalStatus(failure);
    }

    if (receipt.installedVersion !== receipt.targetVersion) {
      return this.readbackFailure(receipt, active, receipt.installedVersion ?? receipt.previousVersion);
    }
    const installed = this.readInstalledPayaraVersion();
    if (installed !== receipt.targetVersion) {
      return this.readbackFailure(receipt, active, installed ?? receipt.previousVersion);
    }

    let scheduleNow = false;
    try {
      scheduleNow = this.rail.markRestartScheduled(receipt.requestId, receipt.targetVersion);
    } catch (err) {
      throw new PluginUpdateRailError(
        'RESTART_MARKER_FAILED',
        `Could not persist restart marker: ${asMessage(err)}`
      );
    }
    if (scheduleNow) {
      const timeout = setTimeout(() => {
        this.restartTimeouts.delete(timeout);
        if (this.stopped) return;
        try {
          this.requestRestart();
        } catch (err) {
          logger.error(
            { err, requestId: receipt.requestId },
            'Agent restart request failed; update remains pending startup confirmation'
          );
        }
      }, UPDATE_RESTART_DELAY_MS);
      this.restartTimeouts.add(timeout);
    }
    return {
      requestId: receipt.requestId,
      package: PAYARA_PLUGIN_PACKAGE,
      channel: PAYARA_PLUGIN_CHANNEL,
      previousVersion: receipt.previousVersion,
      targetVersion: receipt.targetVersion,
      newVersion: installed,
      installedVersion: installed,
      status: 'pending',
      updated: 1,
      willRestart: scheduleNow,
      restartScheduled: true,
      code: 'RESTART_PENDING',
      message: scheduleNow
        ? 'Exact artifact verified; awaiting restart and Payara startup confirmation'
        : 'Awaiting target Payara startup confirmation after the scheduled restart',
      pollPath: this.pollPath(receipt.requestId),
      requestedAt: receipt.requestedAt,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
    };
  }

  private readbackFailure(
    receipt: PluginUpdateReceipt,
    active: PluginUpdateActiveOperation | undefined,
    installedVersion: string
  ): PluginUpdateOperationStatus {
    const failure: PluginUpdateLocalTerminal = {
      requestId: receipt.requestId,
      package: PAYARA_PLUGIN_PACKAGE,
      channel: PAYARA_PLUGIN_CHANNEL,
      previousVersion: receipt.previousVersion,
      targetVersion: receipt.targetVersion,
      installedVersion,
      success: false,
      requestedAt: receipt.requestedAt,
      startedAt: receipt.startedAt,
      finishedAt: new Date().toISOString(),
      code: 'AGENT_READBACK_MISMATCH',
    };
    this.rail.writeLocalTerminal(failure);
    if (active) this.rail.clearActive(active);
    return this.localTerminalStatus(failure);
  }

  private localTerminalStatus(terminal: PluginUpdateLocalTerminal): PluginUpdateOperationStatus {
    const noOp = terminal.success && terminal.code === 'ALREADY_INSTALLED';
    const restartScheduled = terminal.success
      && !noOp
      && this.rail.hasRestartMarker(terminal.requestId, terminal.targetVersion);
    const completedUpdate = terminal.success && terminal.code === 'STARTUP_CONFIRMED';
    return {
      requestId: terminal.requestId,
      package: PAYARA_PLUGIN_PACKAGE,
      channel: PAYARA_PLUGIN_CHANNEL,
      previousVersion: terminal.previousVersion,
      targetVersion: terminal.targetVersion,
      newVersion: terminal.installedVersion,
      installedVersion: terminal.installedVersion,
      status: terminal.success ? 'succeeded' : 'failed',
      updated: terminal.success && !noOp ? 1 : 0,
      willRestart: completedUpdate,
      restartScheduled,
      code: terminal.code,
      message: terminal.success
        ? (noOp
            ? 'Requested Payara plugin artifact is already installed'
            : 'Target Payara plugin startup was confirmed after restart')
        : 'Exact Payara plugin update failed; restart is forbidden',
      pollPath: this.pollPath(terminal.requestId),
      requestedAt: terminal.requestedAt,
      startedAt: terminal.startedAt,
      finishedAt: terminal.finishedAt,
    };
  }

  private pendingStatus(operation: PluginUpdateActiveOperation): PluginUpdateOperationStatus {
    return {
      requestId: operation.requestId,
      package: PAYARA_PLUGIN_PACKAGE,
      channel: PAYARA_PLUGIN_CHANNEL,
      previousVersion: operation.expectedCurrentVersion,
      targetVersion: operation.expectedVersion,
      newVersion: operation.expectedVersion,
      status: 'pending',
      updated: 0,
      willRestart: false,
      restartScheduled: false,
      code: 'PENDING',
      message: 'Exact Payara plugin update is pending root receipt verification',
      pollPath: this.pollPath(operation.requestId),
      requestedAt: operation.requestedAt,
    };
  }

  private pollPath(requestId: string): string {
    return `/plugins/update/${requestId}`;
  }

  private async checkAndUpdatePayara(): Promise<void> {
    let info = (await this.checkForUpdates())[0];
    if (!info?.updateAvailable) return;
    if (this.config.stagedRolloutMaxDelayMs > 0) {
      const delay = Math.floor(Math.random() * this.config.stagedRolloutMaxDelayMs);
      await new Promise<void>((resolve) => {
        this.stagedRolloutTimeout = setTimeout(resolve, delay);
      });
      info = (await this.checkForUpdates())[0];
      if (!info?.updateAvailable) return;
    }

    const request: PluginUpdateRequest = {
      requestId: randomUUID(),
      package: PAYARA_PLUGIN_PACKAGE,
      expectedCurrentVersion: info.current,
      expectedVersion: info.latest,
    };
    const status = await this.beginUpdate(request);
    logger.info(
      { requestId: request.requestId, status: status.status, targetVersion: request.expectedVersion },
      'Periodic Payara plugin update delegated to exact root rail'
    );
  }

  private getInstalledPayaraVersion(): string {
    const version = this.readInstalledPayaraVersion();
    if (!version) {
      throw new PluginUpdateRailError(
        'INSTALLED_VERSION_UNAVAILABLE',
        'Could not read an exact installed Payara plugin version'
      );
    }
    return version;
  }

  private readInstalledPayaraVersion(): string | null {
    this.detectInstalledVersions();
    return this.installedVersions.get(PAYARA_PLUGIN_PACKAGE) ?? null;
  }

  /** Exact readback from global npm state; no request value reaches argv. */
  private detectInstalledVersions(): void {
    this.installedVersions.delete(PAYARA_PLUGIN_PACKAGE);
    try {
      const output = execFileSync(
        'npm',
        ['list', '-g', '--json', '--depth=0'],
        { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const parsed = JSON.parse(output) as NpmListOutput;
      const version = parsed.dependencies?.[PAYARA_PLUGIN_PACKAGE]?.version;
      if (typeof version === 'string' && semver.valid(version) === version) {
        this.installedVersions.set(PAYARA_PLUGIN_PACKAGE, version);
        return;
      }
    } catch (err) {
      logger.debug({ err }, 'npm list could not provide exact installed Payara plugin version');
    }

    try {
      const globalRoot = execFileSync(
        'npm',
        ['root', '-g'],
        { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim();
      if (!globalRoot.startsWith('/') || globalRoot.includes('\n') || globalRoot.includes('\r')) return;
      const packageJsonPath = `${globalRoot}/${PAYARA_PLUGIN_PACKAGE}/package.json`;
      if (!existsSync(packageJsonPath)) return;
      const state = lstatSync(packageJsonPath);
      if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1 || state.size > 1024 * 1024) return;
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageJson;
      if (typeof parsed.version === 'string' && semver.valid(parsed.version) === parsed.version) {
        this.installedVersions.set(PAYARA_PLUGIN_PACKAGE, parsed.version);
      }
    } catch (err) {
      logger.debug({ err }, 'Direct global package readback failed for Payara plugin');
    }
  }

  private async getLatestVersion(
    packageName: string,
    channel: PluginUpdateChannel
  ): Promise<string> {
    if (packageName !== PAYARA_PLUGIN_PACKAGE || channel !== PAYARA_PLUGIN_CHANNEL) {
      throw new PluginUpdateRailError(
        'PLUGIN_UPDATE_SCOPE_INVALID',
        'Payara updater registry lookup is fixed to the dr-m4 allowlist'
      );
    }
    const { stdout } = await execFileAsync(
      'npm',
      ['view', `${PAYARA_PLUGIN_PACKAGE}@${PAYARA_PLUGIN_CHANNEL}`, 'version'],
      { timeout: 30_000, encoding: 'utf8' }
    );
    const target = stdout.trim();
    if (semver.valid(target) !== target || semver.major(target) !== 3) {
      throw new PluginUpdateRailError(
        'CHANNEL_TARGET_INVALID',
        'The Payara dr-m4 channel did not resolve to one exact 3.x semver'
      );
    }
    return target;
  }

  private requestRestart(): void {
    logger.info('Sending SIGTERM to self after exact Payara plugin verification');
    process.kill(process.pid, 'SIGTERM');
  }
}

export function loadPluginUpdateConfig(): PluginAutoUpdateServiceConfig {
  const config: PluginAutoUpdateServiceConfig = { ...DEFAULT_PLUGIN_UPDATE_CONFIG };
  const enabled = process.env.PLUGIN_AUTO_UPDATE?.trim().toLowerCase();
  if (enabled === 'true' || enabled === '1') config.enabled = true;
  if (enabled === 'false' || enabled === '0') config.enabled = false;

  const intervalText = process.env.PLUGIN_AUTO_UPDATE_INTERVAL;
  if (intervalText) {
    const interval = Number.parseInt(intervalText, 10);
    if (Number.isFinite(interval) && interval > 0) config.checkIntervalMs = interval * 1000;
  }
  const channel = process.env.PLUGIN_AUTO_UPDATE_CHANNEL?.trim().toLowerCase();
  if (channel === 'latest' || channel === 'beta' || channel === 'next' || channel === 'dr-m4') {
    config.defaultChannel = channel;
  }
  const delayText = process.env.PLUGIN_AUTO_UPDATE_STAGED_DELAY;
  if (delayText) {
    const delay = Number.parseInt(delayText, 10);
    if (Number.isFinite(delay) && delay >= 0) config.stagedRolloutMaxDelayMs = delay * 1000;
  }
  return config;
}
