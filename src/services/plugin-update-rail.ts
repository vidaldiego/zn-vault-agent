import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import semver from 'semver';

const execFileAsync = promisify(execFile);

export const PAYARA_PLUGIN_PACKAGE = '@zincapp/znvault-plugin-payara';
export const PAYARA_PLUGIN_CHANNEL = 'dr-m4';
export const PAYARA_PLUGIN_TARGET_MAJOR = 3;
export const PLUGIN_UPDATER_PATH_UNIT = 'zn-vault-agent-plugin-updater.path';
export const PLUGIN_UPDATE_TRIGGER_FILE = '/var/lib/zn-vault-agent/.plugin-update-trigger';
export const PLUGIN_UPDATE_ACTIVE_FILE = '/var/lib/zn-vault-agent/.plugin-update-active';
export const PLUGIN_UPDATE_RECEIPT_DIR = '/var/lib/zn-vault-agent-plugin-updater';
export const PLUGIN_UPDATE_RECEIPT_TIMEOUT_MS = 6 * 60 * 1000;
export const PLUGIN_UPDATE_RECEIPT_POLL_MS = 250;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECORD_BYTES = 2048;

export interface PluginUpdateRequest {
  requestId: string;
  package: string;
  expectedCurrentVersion: string;
  expectedVersion: string;
}

export interface PluginUpdateReceipt {
  requestId: string;
  package: typeof PAYARA_PLUGIN_PACKAGE;
  channel: typeof PAYARA_PLUGIN_CHANNEL;
  previousVersion: string;
  targetVersion: string;
  installedVersion?: string;
  success: boolean;
  requestedAt: string;
  startedAt: string;
  finishedAt: string;
  reason: string;
}

export interface PluginUpdateActiveOperation extends PluginUpdateRequest {
  channel: typeof PAYARA_PLUGIN_CHANNEL;
  requestedAt: string;
}

export interface PluginUpdateLocalTerminal {
  requestId: string;
  package: typeof PAYARA_PLUGIN_PACKAGE;
  channel: typeof PAYARA_PLUGIN_CHANNEL;
  previousVersion: string;
  targetVersion: string;
  installedVersion: string;
  success: boolean;
  requestedAt: string;
  startedAt: string;
  finishedAt: string;
  code: string;
}

export interface PluginUpdateRailOptions {
  triggerFile?: string;
  activeFile?: string;
  receiptDir?: string;
  receiptOwnerUid?: number;
  agentOwnerUid?: number;
  receiptTimeoutMs?: number;
  receiptPollMs?: number;
  systemctlBin?: string;
  pathUnit?: string;
  execFileRunner?: (
    file: string,
    args: string[],
    options: { timeout: number; encoding: 'utf8' }
  ) => Promise<{ stdout: string; stderr: string }>;
}

export type PluginUpdateBeginResult =
  | { kind: 'started' | 'pending'; operation: PluginUpdateActiveOperation }
  | {
      kind: 'terminal';
      terminal:
        | { source: 'receipt'; value: PluginUpdateReceipt }
        | { source: 'local'; value: PluginUpdateLocalTerminal };
    };

export class PluginUpdateRailError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PluginUpdateRailError';
  }
}

export function isExactSemver(value: string): boolean {
  return semver.valid(value) === value;
}

export function isUuidV4(value: string): boolean {
  return UUID_V4_RE.test(value);
}

export function validatePluginUpdateRequest(request: PluginUpdateRequest): void {
  if (!isUuidV4(request.requestId)) {
    throw new PluginUpdateRailError('INVALID_REQUEST_ID', 'requestId must be a lowercase UUID v4');
  }
  if (request.package !== PAYARA_PLUGIN_PACKAGE) {
    throw new PluginUpdateRailError('PLUGIN_NOT_ALLOWLISTED', 'Only the Payara plugin may be updated');
  }
  if (!isExactSemver(request.expectedCurrentVersion)) {
    throw new PluginUpdateRailError('INVALID_CURRENT_VERSION', 'expectedCurrentVersion must be exact semver');
  }
  if (
    !isExactSemver(request.expectedVersion)
    || semver.major(request.expectedVersion) !== PAYARA_PLUGIN_TARGET_MAJOR
  ) {
    throw new PluginUpdateRailError(
      'INVALID_TARGET_VERSION',
      `expectedVersion must be exact Payara ${PAYARA_PLUGIN_TARGET_MAJOR}.x semver`
    );
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, fsConstants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertTrustedDirectory(directory: string, expectedUid: number): void {
  const before = lstatSync(directory);
  if (
    !before.isDirectory()
    || before.isSymbolicLink()
    || before.uid !== expectedUid
    || (before.mode & 0o022) !== 0
  ) {
    throw new PluginUpdateRailError('UNTRUSTED_DIRECTORY', `Untrusted updater directory: ${directory}`);
  }
  const noFollow = fsConstants.O_NOFOLLOW;
  const directoryFlag = fsConstants.O_DIRECTORY ?? 0;
  if (!noFollow) throw new PluginUpdateRailError('NO_NOFOLLOW', 'Plugin updater requires O_NOFOLLOW');
  const fd = openSync(directory, fsConstants.O_RDONLY | directoryFlag | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new PluginUpdateRailError('DIRECTORY_CHANGED', `Updater directory changed: ${directory}`);
    }
  } finally {
    closeSync(fd);
  }
}

function writeDurableExclusive(filePath: string, content: string, mode: number): void {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== 'number' || noFollow === 0) {
    throw new PluginUpdateRailError('NO_NOFOLLOW', 'Plugin updater requires O_NOFOLLOW');
  }
  let fd: number | undefined;
  try {
    fd = openSync(
      filePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
      mode
    );
    writeFileSync(fd, content, { encoding: 'utf8' });
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  fsyncDirectory(dirname(filePath));
}

function publishDurableNoReplace(filePath: string, content: string, mode: number): void {
  const tempPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeDurableExclusive(tempPath, content, mode);
    linkSync(tempPath, filePath);
    fsyncDirectory(dirname(filePath));
  } finally {
    try {
      unlinkSync(tempPath);
      fsyncDirectory(dirname(filePath));
    } catch {
      // The temp path may not exist if exclusive creation failed.
    }
  }
}

/**
 * Recover the only ambiguous hard-link publication boundary. A crash after
 * link(temp, final) but before unlink(temp) leaves the committed final inode
 * with nlink=2. Only an exact, trusted sibling temp naming the same inode may
 * be removed; unrelated/multiple links remain a fail-closed condition.
 */
function reconcileCommittedTempLink(
  filePath: string,
  before: Stats,
  expectedUid: number,
  expectedMode: number
): Stats {
  if (before.nlink === 1) return before;
  if (before.nlink !== 2) {
    throw new PluginUpdateRailError('UNTRUSTED_RECORD', `Unexpected link count: ${filePath}`);
  }

  const directory = dirname(filePath);
  const prefix = `${basename(filePath)}.tmp.`;
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const suffix = new RegExp(`^[0-9]+(?:\\.(?:[0-9]+|${uuid}))?$`);
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .filter((entry) => suffix.test(entry.name.slice(prefix.length)))
    .map((entry) => join(directory, entry.name))
    .filter((candidate) => {
      const state = lstatSync(candidate);
      return state.isFile()
        && !state.isSymbolicLink()
        && state.dev === before.dev
        && state.ino === before.ino
        && state.uid === expectedUid
        && (state.mode & 0o777) === expectedMode
        && state.nlink === 2
        && state.size === before.size;
    });
  if (candidates.length !== 1) {
    throw new PluginUpdateRailError(
      'AMBIGUOUS_PUBLICATION',
      `Could not reconcile committed updater record: ${filePath}`
    );
  }

  unlinkSync(candidates[0]);
  fsyncDirectory(directory);
  const after = lstatSync(filePath);
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.uid !== expectedUid
    || (after.mode & 0o777) !== expectedMode
    || after.nlink !== 1
    || after.size !== before.size
  ) {
    throw new PluginUpdateRailError(
      'PUBLICATION_CHANGED',
      `Updater record changed during publication recovery: ${filePath}`
    );
  }
  return after;
}

function readTrustedRegularFile(
  filePath: string,
  expectedUid: number,
  expectedMode: number,
  maxBytes: number = MAX_RECORD_BYTES
): string | null {
  try {
    assertTrustedDirectory(dirname(filePath), expectedUid);
  } catch (err) {
    // A rail that has never been installed contains no evidence. Existing but
    // untrusted directories still throw and therefore fail closed.
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
  let before: Stats;
  try {
    before = lstatSync(filePath);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.uid !== expectedUid
    || (before.mode & 0o777) !== expectedMode
    || before.size < 1
    || before.size > maxBytes
  ) {
    throw new PluginUpdateRailError('UNTRUSTED_RECORD', `Untrusted plugin update record: ${filePath}`);
  }
  before = reconcileCommittedTempLink(filePath, before, expectedUid, expectedMode);

  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== 'number' || noFollow === 0) {
    throw new PluginUpdateRailError('NO_NOFOLLOW', 'Plugin updater requires O_NOFOLLOW');
  }
  const fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollow);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.uid !== expectedUid
      || (opened.mode & 0o777) !== expectedMode
      || opened.nlink !== 1
      || opened.size !== before.size
    ) {
      throw new PluginUpdateRailError('RECORD_CHANGED', `Plugin update record changed: ${filePath}`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function exactIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function splitExactLine(content: string, fields: number): string[] {
  if (!content.endsWith('\n') || content.slice(0, -1).includes('\n') || content.includes('\r')) {
    throw new PluginUpdateRailError('INVALID_RECORD_SCHEMA', 'Plugin update record must be one line');
  }
  const parts = content.slice(0, -1).split(' ');
  if (parts.length !== fields || parts.some((part) => part.length === 0)) {
    throw new PluginUpdateRailError('INVALID_RECORD_SCHEMA', 'Plugin update record field count mismatch');
  }
  return parts;
}

export function parsePluginUpdateReceipt(content: string): PluginUpdateReceipt {
  const [
    schema,
    requestId,
    packageName,
    channel,
    previousVersion,
    targetVersion,
    installedToken,
    successToken,
    requestedAt,
    startedAt,
    finishedAt,
    reason,
  ] = splitExactLine(content, 12);
  if (schema !== 'v1' || !isUuidV4(requestId)) {
    throw new PluginUpdateRailError('INVALID_RECEIPT_SCHEMA', 'Invalid receipt identity');
  }
  if (packageName !== PAYARA_PLUGIN_PACKAGE || channel !== PAYARA_PLUGIN_CHANNEL) {
    throw new PluginUpdateRailError('INVALID_RECEIPT_SCOPE', 'Receipt package/channel mismatch');
  }
  if (
    !isExactSemver(previousVersion)
    || !isExactSemver(targetVersion)
    || semver.major(targetVersion) !== PAYARA_PLUGIN_TARGET_MAJOR
  ) {
    throw new PluginUpdateRailError('INVALID_RECEIPT_VERSION', 'Receipt versions are invalid');
  }
  const installedVersion = installedToken === 'none' ? undefined : installedToken;
  if (installedVersion !== undefined && !isExactSemver(installedVersion)) {
    throw new PluginUpdateRailError('INVALID_RECEIPT_VERSION', 'Receipt installed version is invalid');
  }
  if (successToken !== 'success' && successToken !== 'failure') {
    throw new PluginUpdateRailError('INVALID_RECEIPT_STATUS', 'Receipt status is invalid');
  }
  if (![requestedAt, startedAt, finishedAt].every(exactIsoTimestamp)) {
    throw new PluginUpdateRailError('INVALID_RECEIPT_TIMESTAMP', 'Receipt timestamp is invalid');
  }
  if (Date.parse(startedAt) < Date.parse(requestedAt) || Date.parse(finishedAt) < Date.parse(startedAt)) {
    throw new PluginUpdateRailError('INVALID_RECEIPT_TIMESTAMP', 'Receipt timestamps are not monotonic');
  }
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(reason)) {
    throw new PluginUpdateRailError('INVALID_RECEIPT_REASON', 'Receipt reason is invalid');
  }
  if (
    successToken === 'success'
    && (installedVersion !== targetVersion || (reason !== 'installed' && reason !== 'recovered_install'))
  ) {
    throw new PluginUpdateRailError('INVALID_RECEIPT_SUCCESS', 'Successful receipt is not exact');
  }
  return {
    requestId,
    package: PAYARA_PLUGIN_PACKAGE,
    channel: PAYARA_PLUGIN_CHANNEL,
    previousVersion,
    targetVersion,
    installedVersion,
    success: successToken === 'success',
    requestedAt,
    startedAt,
    finishedAt,
    reason,
  };
}

function serializeActive(operation: PluginUpdateActiveOperation): string {
  return `v1 ${operation.requestId} ${operation.expectedCurrentVersion} ${operation.expectedVersion} ${operation.requestedAt}\n`;
}

function parseActive(content: string): PluginUpdateActiveOperation {
  const [schema, requestId, current, target, requestedAt] = splitExactLine(content, 5);
  const request = {
    requestId,
    package: PAYARA_PLUGIN_PACKAGE,
    expectedCurrentVersion: current,
    expectedVersion: target,
  };
  if (schema !== 'v1' || !exactIsoTimestamp(requestedAt)) {
    throw new PluginUpdateRailError('INVALID_ACTIVE_OPERATION', 'Invalid active operation');
  }
  validatePluginUpdateRequest(request);
  return { ...request, channel: PAYARA_PLUGIN_CHANNEL, requestedAt };
}

function sameRequest(left: PluginUpdateRequest, right: PluginUpdateRequest): boolean {
  return left.requestId === right.requestId
    && left.package === right.package
    && left.expectedCurrentVersion === right.expectedCurrentVersion
    && left.expectedVersion === right.expectedVersion;
}

export class PluginUpdateRail {
  readonly triggerFile: string;
  readonly activeFile: string;
  readonly receiptDir: string;
  readonly receiptOwnerUid: number;
  readonly agentOwnerUid: number;
  readonly receiptTimeoutMs: number;
  readonly receiptPollMs: number;
  private readonly systemctlBin: string;
  private readonly pathUnit: string;
  private readonly execFileRunner: NonNullable<PluginUpdateRailOptions['execFileRunner']>;

  constructor(options: PluginUpdateRailOptions = {}) {
    this.triggerFile = options.triggerFile ?? PLUGIN_UPDATE_TRIGGER_FILE;
    this.activeFile = options.activeFile ?? PLUGIN_UPDATE_ACTIVE_FILE;
    this.receiptDir = options.receiptDir ?? PLUGIN_UPDATE_RECEIPT_DIR;
    this.receiptOwnerUid = options.receiptOwnerUid ?? 0;
    this.agentOwnerUid = options.agentOwnerUid ?? (process.getuid?.() ?? 0);
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? PLUGIN_UPDATE_RECEIPT_TIMEOUT_MS;
    this.receiptPollMs = options.receiptPollMs ?? PLUGIN_UPDATE_RECEIPT_POLL_MS;
    this.systemctlBin = options.systemctlBin ?? '/usr/bin/systemctl';
    this.pathUnit = options.pathUnit ?? PLUGIN_UPDATER_PATH_UNIT;
    this.execFileRunner = options.execFileRunner ?? (async (file, args, execOptions) => {
      return await execFileAsync(file, args, execOptions) as { stdout: string; stderr: string };
    });
  }

  async isActive(): Promise<boolean> {
    try {
      await this.execFileRunner(
        this.systemctlBin,
        ['is-active', '--quiet', this.pathUnit],
        { timeout: 10_000, encoding: 'utf8' }
      );
      return true;
    } catch {
      return false;
    }
  }

  getReceiptPath(requestId: string): string {
    if (!isUuidV4(requestId)) {
      throw new PluginUpdateRailError('INVALID_REQUEST_ID', 'Invalid requestId');
    }
    return join(this.receiptDir, `${requestId}.receipt`);
  }

  readReceipt(requestId: string): PluginUpdateReceipt | null {
    const content = readTrustedRegularFile(
      this.getReceiptPath(requestId),
      this.receiptOwnerUid,
      0o644
    );
    return content === null ? null : parsePluginUpdateReceipt(content);
  }

  readActive(): PluginUpdateActiveOperation | null {
    const content = readTrustedRegularFile(this.activeFile, this.agentOwnerUid, 0o600);
    return content === null ? null : parseActive(content);
  }

  readTrigger(): PluginUpdateActiveOperation | null {
    const content = readTrustedRegularFile(this.triggerFile, this.agentOwnerUid, 0o600);
    return content === null ? null : parseActive(content);
  }

  begin(request: PluginUpdateRequest): PluginUpdateBeginResult {
    validatePluginUpdateRequest(request);
    assertTrustedDirectory(dirname(this.triggerFile), this.agentOwnerUid);
    assertTrustedDirectory(dirname(this.activeFile), this.agentOwnerUid);

    const local = this.readLocalTerminal(request.requestId);
    if (local) {
      if (
        local.package !== request.package
        || local.previousVersion !== request.expectedCurrentVersion
        || local.targetVersion !== request.expectedVersion
      ) {
        throw new PluginUpdateRailError('REQUEST_ID_CONFLICT', 'requestId local terminal mismatch');
      }
      return { kind: 'terminal', terminal: { source: 'local', value: local } };
    }
    const receipt = this.readReceipt(request.requestId);
    if (receipt) {
      if (
        receipt.package !== request.package
        || receipt.previousVersion !== request.expectedCurrentVersion
        || receipt.targetVersion !== request.expectedVersion
      ) {
        throw new PluginUpdateRailError('REQUEST_ID_CONFLICT', 'requestId receipt mismatch');
      }
      return { kind: 'terminal', terminal: { source: 'receipt', value: receipt } };
    }

    const existing = this.readActive();
    if (existing) {
      if (existing.requestId === request.requestId && !sameRequest(existing, request)) {
        throw new PluginUpdateRailError('REQUEST_ID_CONFLICT', 'requestId was used for different versions');
      }
      if (sameRequest(existing, request)) {
        return { kind: 'pending', operation: existing };
      }
      throw new PluginUpdateRailError('PLUGIN_UPDATE_IN_PROGRESS', 'Another plugin update is active');
    }

    // Trigger-first publication is recoverable because the root helper is
    // required to observe an exact matching active record before npm. If the
    // Agent crashes between the two exclusive writes, replay can safely finish
    // the active publication; after active exists a missing trigger is
    // ambiguous and is never re-published.
    const preparedTrigger = this.readTrigger();
    if (preparedTrigger) {
      if (!sameRequest(preparedTrigger, request)) {
        throw new PluginUpdateRailError('PLUGIN_UPDATE_IN_PROGRESS', 'Another plugin trigger is prepared');
      }
      publishDurableNoReplace(this.activeFile, serializeActive(preparedTrigger), 0o600);
      return { kind: 'pending', operation: preparedTrigger };
    }

    const operation: PluginUpdateActiveOperation = {
      ...request,
      channel: PAYARA_PLUGIN_CHANNEL,
      requestedAt: new Date().toISOString(),
    };
    try {
      publishDurableNoReplace(this.triggerFile, serializeActive(operation), 0o600);
      publishDurableNoReplace(this.activeFile, serializeActive(operation), 0o600);
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
        throw new PluginUpdateRailError('PLUGIN_UPDATE_IN_PROGRESS', 'Plugin update trigger already exists');
      }
      throw err;
    }
    return { kind: 'started', operation };
  }

  clearActive(operation: PluginUpdateActiveOperation): void {
    const current = this.readActive();
    if (!current || !sameRequest(current, operation)) return;
    unlinkSync(this.activeFile);
    fsyncDirectory(dirname(this.activeFile));
  }

  async waitForReceipt(
    request: PluginUpdateRequest,
    signal?: AbortSignal
  ): Promise<PluginUpdateReceipt> {
    const deadline = performance.now() + this.receiptTimeoutMs;
    while (performance.now() < deadline) {
      if (signal?.aborted) {
        throw new PluginUpdateRailError('PLUGIN_UPDATE_CANCELLED', 'Receipt wait cancelled');
      }
      const receipt = this.readReceipt(request.requestId);
      if (receipt) return receipt;
      await new Promise((resolve) => setTimeout(resolve, this.receiptPollMs));
    }
    throw new PluginUpdateRailError('PLUGIN_UPDATE_TIMEOUT', 'Timed out waiting for root updater receipt');
  }

  localTerminalPath(requestId: string): string {
    if (!isUuidV4(requestId)) throw new PluginUpdateRailError('INVALID_REQUEST_ID', 'Invalid requestId');
    return join(dirname(this.activeFile), `.plugin-update-terminal-${requestId}`);
  }

  writeLocalTerminal(terminal: PluginUpdateLocalTerminal): void {
    assertTrustedDirectory(dirname(this.activeFile), this.agentOwnerUid);
    const line = `v1 ${terminal.requestId} ${terminal.package} ${terminal.channel} ${terminal.previousVersion} ${terminal.targetVersion} ${terminal.installedVersion} ${terminal.success ? 'success' : 'failure'} ${terminal.requestedAt} ${terminal.startedAt} ${terminal.finishedAt} ${terminal.code}\n`;
    try {
      publishDurableNoReplace(this.localTerminalPath(terminal.requestId), line, 0o600);
    } catch (err) {
      if (!(err instanceof Error) || !('code' in err) || err.code !== 'EEXIST') throw err;
      const existing = this.readLocalTerminal(terminal.requestId);
      if (
        !existing
        || existing.requestId !== terminal.requestId
        || existing.package !== terminal.package
        || existing.channel !== terminal.channel
        || existing.previousVersion !== terminal.previousVersion
        || existing.targetVersion !== terminal.targetVersion
        || existing.installedVersion !== terminal.installedVersion
        || existing.success !== terminal.success
        || existing.requestedAt !== terminal.requestedAt
        || existing.startedAt !== terminal.startedAt
        || existing.finishedAt !== terminal.finishedAt
        || existing.code !== terminal.code
      ) {
        throw new PluginUpdateRailError(
          'LOCAL_TERMINAL_CONFLICT',
          'Existing local terminal does not exactly match the requested terminal record'
        );
      }
    }
  }

  readLocalTerminal(requestId: string): PluginUpdateLocalTerminal | null {
    const content = readTrustedRegularFile(
      this.localTerminalPath(requestId),
      this.agentOwnerUid,
      0o600
    );
    if (content === null) return null;
    const [
      schema,
      id,
      packageName,
      channel,
      previous,
      target,
      installed,
      status,
      requestedAt,
      startedAt,
      finishedAt,
      code,
    ] = splitExactLine(content, 12);
    const request = { requestId: id, package: packageName, expectedCurrentVersion: previous, expectedVersion: target };
    if (
      schema !== 'v1'
      || channel !== PAYARA_PLUGIN_CHANNEL
      || ![requestedAt, startedAt, finishedAt].every(exactIsoTimestamp)
      || Date.parse(startedAt) < Date.parse(requestedAt)
      || Date.parse(finishedAt) < Date.parse(startedAt)
      || !isExactSemver(installed)
      || (status !== 'success' && status !== 'failure')
      || !/^[A-Z][A-Z0-9_]{1,63}$/.test(code)
    ) {
      throw new PluginUpdateRailError('INVALID_LOCAL_TERMINAL', 'Invalid local terminal record');
    }
    validatePluginUpdateRequest(request);
    return {
      requestId: id,
      package: PAYARA_PLUGIN_PACKAGE,
      channel: PAYARA_PLUGIN_CHANNEL,
      previousVersion: previous,
      targetVersion: target,
      installedVersion: installed,
      success: status === 'success',
      requestedAt,
      startedAt,
      finishedAt,
      code,
    };
  }

  restartMarkerPath(requestId: string): string {
    if (!isUuidV4(requestId)) throw new PluginUpdateRailError('INVALID_REQUEST_ID', 'Invalid requestId');
    return join(dirname(this.activeFile), `.plugin-update-restart-${requestId}`);
  }

  markRestartScheduled(requestId: string, targetVersion: string): boolean {
    assertTrustedDirectory(dirname(this.activeFile), this.agentOwnerUid);
    const markerPath = this.restartMarkerPath(requestId);
    const existing = readTrustedRegularFile(markerPath, this.agentOwnerUid, 0o600);
    if (existing !== null) {
      this.assertRestartMarker(existing, requestId, targetVersion);
      return false;
    }
    try {
      publishDurableNoReplace(
        markerPath,
        `v1 ${requestId} ${targetVersion} ${new Date().toISOString()}\n`,
        0o600
      );
      return true;
    } catch (err) {
      if (!(err instanceof Error) || !('code' in err) || err.code !== 'EEXIST') throw err;
      const raced = readTrustedRegularFile(markerPath, this.agentOwnerUid, 0o600);
      if (raced === null) throw err;
      this.assertRestartMarker(raced, requestId, targetVersion);
      return false;
    }
  }

  hasRestartMarker(requestId: string, targetVersion: string): boolean {
    const content = readTrustedRegularFile(
      this.restartMarkerPath(requestId),
      this.agentOwnerUid,
      0o600
    );
    if (content === null) return false;
    this.assertRestartMarker(content, requestId, targetVersion);
    return true;
  }

  private assertRestartMarker(content: string, requestId: string, targetVersion: string): void {
    const [schema, id, target, timestamp] = splitExactLine(content, 4);
    if (
      schema !== 'v1'
      || id !== requestId
      || target !== targetVersion
      || !isExactSemver(target)
      || !exactIsoTimestamp(timestamp)
    ) {
      throw new PluginUpdateRailError('INVALID_RESTART_MARKER', 'Invalid restart marker');
    }
  }
}

export interface PayaraPostUpdateRecoveryEvidence {
  requestId: string;
  previousVersion: string;
  targetVersion: string;
}

export type PayaraPostUpdateRecoveryRail = Pick<
  PluginUpdateRail,
  'readActive' | 'readReceipt' | 'readLocalTerminal' | 'hasRestartMarker'
>;

/**
 * Recognize the sole durable state that may keep the authenticated update
 * status plane alive after the root helper installed Payara 3 but before the
 * new plugin process could be confirmed. The global manifest is checked by the
 * startup caller independently; no Agent-owned record can attest installation.
 */
export function inspectPayaraPostUpdateRecoveryEvidence(
  rail: PayaraPostUpdateRecoveryRail = new PluginUpdateRail()
): PayaraPostUpdateRecoveryEvidence | null {
  const active = rail.readActive();
  if (!active) return null;

  // This exception is deliberately bounded to the Agent 2 / Payara 2 -> 3
  // recovery rail. Later same-major updates must complete through normal
  // config authority and do not widen this bootstrap bypass.
  if (
    semver.major(active.expectedCurrentVersion) !== 2
    || semver.major(active.expectedVersion) !== PAYARA_PLUGIN_TARGET_MAJOR
    || !semver.gt(active.expectedVersion, active.expectedCurrentVersion)
  ) {
    throw new PluginUpdateRailError(
      'POST_UPDATE_RECOVERY_SCOPE_INVALID',
      'Post-update recovery evidence is not an exact Payara 2.x to 3.x operation'
    );
  }

  // A local terminal means startup was already confirmed or failed. It must
  // never be replayed as authority for a config-from-Vault bypass.
  if (rail.readLocalTerminal(active.requestId)) return null;

  const receipt = rail.readReceipt(active.requestId);
  if (!receipt || !receipt.success) return null;
  if (
    receipt.requestId !== active.requestId
    || receipt.package !== active.package
    || receipt.channel !== active.channel
    || receipt.previousVersion !== active.expectedCurrentVersion
    || receipt.targetVersion !== active.expectedVersion
    || receipt.installedVersion !== active.expectedVersion
    || receipt.requestedAt !== active.requestedAt
  ) {
    throw new PluginUpdateRailError(
      'POST_UPDATE_RECOVERY_EVIDENCE_MISMATCH',
      'Root receipt does not exactly match the active Payara update operation'
    );
  }
  if (!rail.hasRestartMarker(active.requestId, active.expectedVersion)) return null;

  return {
    requestId: active.requestId,
    previousVersion: active.expectedCurrentVersion,
    targetVersion: active.expectedVersion,
  };
}
