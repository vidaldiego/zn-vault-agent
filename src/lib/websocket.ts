// Path: zn-vault-agent/src/lib/websocket.ts
// WebSocket client for real-time certificate and secret updates (unified mode)
// This file re-exports from the websocket/ module and provides the startDaemon function

import {
  loadConfig,
  syncManagedKeyFile,
  setConfigInMemory,
  fetchConfigFromVault,
  type ExecConfig,
  type AgentConfig,
  type CertTarget,
  type SecretTarget,
  type TLSConfig,
} from './config.js';
import { deployCertificate, deployAllCertificates } from './deployer.js';
import { deploySecret, deployAllSecrets, findSecretTarget } from './secret-deployer.js';
import { wsLogger as log } from './logger.js';
import { metrics, initializeMetrics } from './metrics.js';
import {
  startHealthServer,
  stopHealthServer,
  startHTTPSHealthServer,
  stopHTTPSHealthServer,
  reloadHTTPSCertificate,
  updateCertStatus,
  updateSecretStatus,
  setChildProcessManager,
  setPluginLoader,
  setPluginAutoUpdateService,
  setNpmAutoUpdateService,
  setPendingMutationRetries,
  setPluginRecoveryRequired,
} from './health.js';
import {
  reconcilePolledMutation,
  RestartRequiredMutationQueue,
} from './coalescing-retry-queue.js';
import {
  isTLSEnabled,
  getTLSConfig,
  onCertificateUpdated,
  ensureCertificateReady,
  stopTLSCertificateManager,
} from '../services/tls-certificate-manager.js';
import { flushLogs, setupLogRotation } from './logger.js';
import type { PluginAutoUpdateService } from '../services/plugin-auto-update.js';
import type { NpmAutoUpdateService } from '../services/npm-auto-update.js';
import { startApiKeyRenewal, stopApiKeyRenewal } from '../services/api-key-renewal.js';
import {
  startManagedKeyRenewal,
  stopManagedKeyRenewal,
  onKeyChanged as onManagedKeyChanged,
} from '../services/managed-key-renewal.js';
import { TrackedKeyPoller } from '../services/managed-key/tracked-keys-poller.js';
import { isManagedKeyMode } from './config.js';
import { ChildProcessManager } from '../services/child-process-manager.js';
import {
  extractSecretIds,
  extractApiKeyNames,
  parseSecretMappingFromConfig,
  type SecretMapping,
} from './secret-env.js';
import { bindManagedApiKey, getSecretMetadata } from './api.js';
import { createKeyRotationPropagator } from './key-rotation-propagation.js';
import {
  createPluginLoader,
  clearPluginLoader,
  PluginCompatibilityError,
  RequiredPluginLoadError,
  inspectConfiguredPayaraManifest,
  type PayaraManifestInspection,
  type PluginLoader,
} from '../plugins/loader.js';
import type {
  CertificateDeployedEvent,
  SecretDeployedEvent,
  SecretChangedEvent,
  ChildProcessEvent,
} from '../plugins/types.js';
import {
  initDegradedModeHandler,
  handleDegradedConnection,
  handleReprovisionAvailable,
  cleanupDegradedModeHandler,
  setAgentId,
} from '../services/degraded-mode-handler.js';
import {
  initializeDynamicSecrets,
  isDynamicSecretsEnabled,
  cleanupDynamicSecrets,
} from '../services/dynamic-secrets/index.js';
import {
  cleanupOrphanedFiles,
  extractTargetDirectories,
  type CleanupStats,
} from '../utils/startup-cleanup.js';
import {
  getDeferredShutdownSequence,
  getLastDeferredShutdownSignal,
  isSharedMutationSignalDeferralActive,
  SHARED_MUTATION_LOCK_PATH,
  withSharedMutationLock,
} from './shared-mutation-lock.js';
import { loadControlPlaneAuthenticator } from './control-plane-auth.js';

// Re-export types and client from websocket module
export type {
  CertificateEvent,
  SecretEvent,
  AgentUpdateEvent,
  ApiKeyRotationEvent,
  HostConfigEvent,
  DegradedReason,
  DegradedConnectionInfo,
  ReprovisionEvent,
  UnifiedAgentEvent,
  UnifiedWebSocketClient,
} from './websocket/index.js';

export {
  createUnifiedWebSocketClient,
  setShuttingDown,
  getIsShuttingDown,
} from './websocket/index.js';

// Import for internal use
import {
  createUnifiedWebSocketClient,
  setShuttingDown,
  getIsShuttingDown,
} from './websocket/index.js';
import type {
  CertificateEvent,
  SecretEvent,
  ApiKeyRotationEvent,
  HostConfigEvent,
} from './websocket/index.js';
import { handleUpdateEvent } from './websocket/update-handler.js';

// Track active deployments for graceful shutdown
let activeDeployments = 0;

/**
 * Account for any daemon mutation so shutdown cannot exit while it is active.
 * WebSocket handlers historically did this inline; polling must use the same
 * accounting because it reaches the same certificate/secret deployers.
 */
export async function withActiveDeployment<T>(
  operation: () => Promise<T>
): Promise<T> {
  activeDeployments++;
  try {
    return await operation();
  } finally {
    activeDeployments--;
  }
}

/** Wait until every already-admitted daemon mutation has fully unwound. */
export async function drainActiveDeployments(
  timeoutMs = 14 * 60_000,
  pollIntervalMs = 1_000
): Promise<number> {
  const startedAt = Date.now();
  while (activeDeployments > 0 && Date.now() - startedAt < timeoutMs) {
    log.info({ active: activeDeployments }, 'Waiting for active deployments');
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return activeDeployments;
}

/** Admit and account for one child restart without borrowing another lease. */
export async function runAdmittedChildRestart(
  reason: string,
  isShutdownRequested: () => boolean,
  restart: (reason: string) => Promise<void>
): Promise<void> {
  if (isShutdownRequested()) {
    throw new Error('Rejecting child restart after daemon shutdown admission closed');
  }
  await withActiveDeployment(async () => restart(reason));
}

export type InitialChildRestartDisposition =
  | 'covered-by-initial-start'
  | 'restart-required';

/**
 * Hold mutation acknowledgements until the post-sync initial child start has
 * actually succeeded. Mutations that reached this barrier before initial
 * start are already reflected in the files/environment consumed by that
 * start; later mutations must use the serialized restart rail.
 */
export class InitialChildStartBarrier {
  private state: 'closed' | 'starting' | 'started' | 'failed' = 'closed';
  private readonly completion: Promise<void>;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: Error) => void;

  constructor() {
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    // A daemon with no early mutation waiter must not emit an unhandled
    // rejection if its initial child start fails.
    void this.completion.catch(() => undefined);
  }

  open(): void {
    if (this.state === 'closed') this.state = 'starting';
  }

  complete(): void {
    if (this.state !== 'starting') return;
    this.state = 'started';
    this.resolveCompletion();
  }

  fail(error: unknown): void {
    if (this.state === 'started' || this.state === 'failed') return;
    this.state = 'failed';
    this.rejectCompletion(error instanceof Error ? error : new Error(String(error)));
  }

  async beforeRestart(): Promise<InitialChildRestartDisposition> {
    if (this.state !== 'closed') return 'restart-required';
    await this.completion;
    return 'covered-by-initial-start';
  }

  /** Plugin startup may await this callback, so it cannot wait on itself. */
  async beforePluginRestart(): Promise<InitialChildRestartDisposition> {
    if (this.state === 'closed') return 'covered-by-initial-start';
    return this.beforeRestart();
  }
}

/** Prevent timer callbacks from overlapping one asynchronous polling cycle. */
export function createSingleFlightOperation(
  operation: () => Promise<void>
): () => Promise<void> {
  let running = false;
  return async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await operation();
    } finally {
      running = false;
    }
  };
}

/** Monotonic generation guard used immediately before secret queue admission. */
export function isSecretVersionConsumed(
  consumedVersion: number | undefined,
  eventVersion: number,
  pendingGeneration: number | undefined
): boolean {
  const highestKnownGeneration = Math.max(
    consumedVersion ?? Number.NEGATIVE_INFINITY,
    pendingGeneration ?? Number.NEGATIVE_INFINITY
  );
  return eventVersion <= highestKnownGeneration;
}

/** Recheck a secret watermark after plugin work that may yield to another event. */
export async function admitSecretMutationAfterAwait(options: {
  isAlreadyConsumed: () => boolean;
  beforeEnqueue: () => Promise<void>;
  enqueue: () => void;
}): Promise<boolean> {
  if (options.isAlreadyConsumed()) return false;
  await options.beforeEnqueue();
  if (options.isAlreadyConsumed()) return false;
  // No await is allowed between this revalidation and queue admission.
  options.enqueue();
  return true;
}

export interface ExecSecretPollMetadata {
  id: string;
  alias: string;
  version: number;
}

export interface ExecSecretPollMutation {
  reference: string;
  identity: string;
  metadata: ExecSecretPollMetadata;
}

export interface SecretRetryItem {
  event: SecretEvent;
  target?: SecretTarget;
  restartReason: string;
  execIdentity?: string;
  execPollReference?: string;
}

export interface SecretMutationEvidence {
  version: number;
}

export type SecretEventAdmissionResult =
  | { status: 'consumed' }
  | { status: 'untracked' }
  | { status: 'queued'; queuedKey: string; execIdentity: string };

function secretReferenceVariants(reference: string): string[] {
  if (!reference) return [];
  if (reference.startsWith('alias:')) {
    return [reference, reference.slice('alias:'.length)];
  }
  return [reference, `alias:${reference}`];
}

function findSecretIdentity(
  identityByReference: Map<string, string>,
  ...references: string[]
): string | undefined {
  for (const reference of references) {
    for (const variant of secretReferenceVariants(reference)) {
      const identity = identityByReference.get(variant);
      if (identity) return identity;
    }
  }
  return undefined;
}

function bindSecretIdentity(
  identityByReference: Map<string, string>,
  identity: string,
  ...references: string[]
): void {
  for (const reference of references) {
    for (const variant of secretReferenceVariants(reference)) {
      identityByReference.set(variant, identity);
    }
  }
}

function hasSecretReference(
  references: Set<string>,
  ...candidates: string[]
): boolean {
  return candidates.some(candidate =>
    secretReferenceVariants(candidate).some(variant => references.has(variant))
  );
}

/** Build the exact alias/UUID identity seed used by the production handler. */
export function initializeExecSecretIdentity(
  references: string[],
  identityByReference: Map<string, string>
): Set<string> {
  const trackedReferences = new Set(references.flatMap(secretReferenceVariants));
  for (const reference of references) {
    bindSecretIdentity(identityByReference, reference, reference);
  }
  return trackedReferences;
}

/**
 * Resolve and admit one real WebSocket secret event to the restart-required
 * queue. Alias binding, the final watermark recheck, queue key selection and
 * immediate retry are shared verbatim by production and focal wiring tests.
 */
export async function admitSecretEventToRetryQueue(options: {
  event: SecretEvent;
  execSecretReferences: Set<string>;
  execSecretIdentityByReference: Map<string, string>;
  consumedSecretVersions: Map<string, number>;
  consumedExecSecretVersions: Map<string, number>;
  queue: RestartRequiredMutationQueue<SecretRetryItem, SecretMutationEvidence>;
  findTarget: (reference: string) => SecretTarget | undefined;
  beforeEnqueue?: () => Promise<void>;
}): Promise<SecretEventAdmissionResult> {
  const { event } = options;
  const resolveMutationContext = (): {
    isExecSecret: boolean;
    target: SecretTarget | undefined;
    execIdentity: string;
    execKey: string;
    alreadyConsumed: boolean;
  } => {
    const isExecSecret = hasSecretReference(
      options.execSecretReferences,
      event.secretId,
      event.alias
    );
    const target = options.findTarget(event.secretId)
      ?? options.findTarget(event.alias);
    const execIdentity = isExecSecret
      ? findSecretIdentity(
        options.execSecretIdentityByReference,
        event.secretId,
        event.alias
      ) ?? event.secretId
      : event.secretId;
    if (isExecSecret) {
      bindSecretIdentity(
        options.execSecretIdentityByReference,
        execIdentity,
        event.secretId,
        event.alias
      );
    }
    const execKey = `exec:${execIdentity}`;
    const alreadyConsumed = target
      ? isSecretVersionConsumed(
        options.consumedSecretVersions.get(target.secretId),
        event.version,
        options.queue.getPendingGeneration(target.secretId)
      )
      : isExecSecret && isSecretVersionConsumed(
        options.consumedExecSecretVersions.get(execIdentity),
        event.version,
        options.queue.getPendingGeneration(execKey)
      );
    return { isExecSecret, target, execIdentity, execKey, alreadyConsumed };
  };

  let queuedKey: string | undefined;
  let queuedExecIdentity = event.secretId;
  const admitted = await admitSecretMutationAfterAwait({
    isAlreadyConsumed: () => resolveMutationContext().alreadyConsumed,
    beforeEnqueue: options.beforeEnqueue ?? (async () => undefined),
    enqueue: () => {
      const { isExecSecret, target, execIdentity, execKey } = resolveMutationContext();
      queuedExecIdentity = execIdentity;
      if (target) {
        options.queue.enqueue(target.secretId, event.version, {
          event,
          target,
          restartReason: isExecSecret
            ? 'secret file and exec value updated'
            : 'secret file updated',
        });
        queuedKey = target.secretId;
      } else if (isExecSecret) {
        options.queue.enqueuePrepared(execKey, event.version, {
          event,
          restartReason: 'exec secret updated',
          execIdentity,
        }, {
          version: event.version,
        });
        queuedKey = execKey;
      }
    },
  });

  if (!admitted) return { status: 'consumed' };
  if (!queuedKey) return { status: 'untracked' };

  await options.queue.retryNow(queuedKey);
  return {
    status: 'queued',
    queuedKey,
    execIdentity: queuedExecIdentity,
  };
}

/** Advance only the canonical consumer watermark after notify+restart pass. */
export function acknowledgeSecretMutation(
  item: SecretRetryItem,
  evidence: SecretMutationEvidence,
  state: {
    consumedSecretVersions: Map<string, number>;
    consumedExecSecretVersions: Map<string, number>;
    execSecretIdentityByReference: Map<string, string>;
  }
): string {
  if (item.target) {
    state.consumedSecretVersions.set(item.target.secretId, evidence.version);
    return item.target.secretId;
  }

  const identity = item.execIdentity
    ?? findSecretIdentity(
      state.execSecretIdentityByReference,
      item.event.secretId,
      item.event.alias
    )
    ?? item.event.secretId;
  bindSecretIdentity(
    state.execSecretIdentityByReference,
    identity,
    item.event.secretId,
    item.event.alias
  );
  state.consumedExecSecretVersions.set(identity, evidence.version);
  return identity;
}

/**
 * Poll metadata for exec-only secrets and report versions not yet consumed.
 * Identity bindings coalesce an alias and UUID for the same secret after the
 * first metadata response, while exact file targets are skipped without an
 * extra HTTP request.
 */
export async function pollExecOnlySecretVersions(options: {
  references: string[];
  fileTargetReferences: string[];
  identityByReference: Map<string, string>;
  consumedVersions: Map<string, number>;
  fetchMetadata: (reference: string) => Promise<ExecSecretPollMetadata>;
  onMutation: (mutation: ExecSecretPollMutation) => Promise<void>;
  onFetchFailure?: (reference: string, identity: string, error: unknown) => void;
  onFetchSuccess?: (
    reference: string,
    identity: string,
    metadata: ExecSecretPollMetadata
  ) => void;
}): Promise<void> {
  const fileTargetReferences = new Set(
    options.fileTargetReferences.flatMap(secretReferenceVariants)
  );
  const seenIdentities = new Set<string>();

  for (const reference of new Set(options.references)) {
    if (hasSecretReference(fileTargetReferences, reference)) continue;

    const knownIdentity = findSecretIdentity(options.identityByReference, reference);
    if (knownIdentity && seenIdentities.has(knownIdentity)) continue;

    let metadata: ExecSecretPollMetadata;
    try {
      metadata = await options.fetchMetadata(reference);
    } catch (error) {
      const identity = knownIdentity ?? reference;
      bindSecretIdentity(options.identityByReference, identity, reference);
      options.onFetchFailure?.(reference, identity, error);
      continue;
    }

    const identity = knownIdentity
      ?? findSecretIdentity(
        options.identityByReference,
        metadata.id,
        metadata.alias
      )
      ?? reference;
    bindSecretIdentity(
      options.identityByReference,
      identity,
      reference,
      metadata.id,
      metadata.alias
    );
    options.onFetchSuccess?.(reference, identity, metadata);

    if (seenIdentities.has(identity)) continue;
    seenIdentities.add(identity);
    if (hasSecretReference(
      fileTargetReferences,
      reference,
      metadata.id,
      metadata.alias
    )) {
      continue;
    }
    const consumedVersion = options.consumedVersions.get(identity);
    if (consumedVersion !== undefined && metadata.version <= consumedVersion) continue;

    await options.onMutation({ reference, identity, metadata });
  }
}

/**
 * Startup cleanup mutates the same target directories as certificate/secret
 * deployment, so it participates in the host-wide Payara mutation fence.
 */
export async function runStartupCleanup(
  directories: string[],
  mutationLockPath = SHARED_MUTATION_LOCK_PATH
): Promise<CleanupStats> {
  return withActiveDeployment(
    async () => withSharedMutationLock(
      'startup-cleanup',
      async () => cleanupOrphanedFiles(directories),
      mutationLockPath
    )
  );
}

// Keep one stable pair for the daemon lifetime. SharedMutationLock temporarily
// removes and later restores these exact functions. Replacing their identities
// during an overlapping mutation can otherwise restore the obsolete startup
// callback alongside the runtime callback, so one signal reaches two owners.
let activeShutdownHandler: ((signal: string) => Promise<void>) | null = null;
const ownedSigintHandler = (): void => {
  activeShutdownHandler?.('SIGINT').catch((e: unknown) => {
    log.error({ err: e }, 'Shutdown error');
  });
};
const ownedSigtermHandler = (): void => {
  activeShutdownHandler?.('SIGTERM').catch((e: unknown) => {
    log.error({ err: e }, 'Shutdown error');
  });
};

/**
 * Remove signal handlers to prevent memory leak on daemon restart.
 */
function cleanupSignalHandlers(): void {
  activeShutdownHandler = null;
  process.off('SIGINT', ownedSigintHandler);
  process.off('SIGTERM', ownedSigtermHandler);
}

/**
 * Set up signal handlers for graceful shutdown.
 * Removes any existing handlers first to prevent accumulation.
 */
function setupSignalHandlers(shutdownFn: (signal: string) => Promise<void>): void {
  activeShutdownHandler = shutdownFn;

  // When the shared mutation rail currently owns deferral, it has captured and
  // removed the stable handlers. It will restore those exact identities on
  // release; adding a second listener here would bypass the mutation fence.
  if (isSharedMutationSignalDeferralActive()) return;

  // This CLI daemon is the sole SIGINT/SIGTERM lifecycle owner. In particular,
  // transitive config-storage hooks may re-raise the signal synchronously,
  // killing the daemon before its async child/deployment drain. Their normal
  // process `exit` hooks remain installed and still perform temp cleanup after
  // our orderly process.exit(0).
  for (const listener of process.listeners('SIGINT')) {
    if (listener !== ownedSigintHandler) process.off('SIGINT', listener);
  }
  for (const listener of process.listeners('SIGTERM')) {
    if (listener !== ownedSigtermHandler) process.off('SIGTERM', listener);
  }

  // Close daemon/child admission before any subsequently installed listener.
  if (!process.listeners('SIGINT').includes(ownedSigintHandler)) {
    process.prependListener('SIGINT', ownedSigintHandler);
  }
  if (!process.listeners('SIGTERM').includes(ownedSigtermHandler)) {
    process.prependListener('SIGTERM', ownedSigtermHandler);
  }
}

/** @internal Signal lifecycle seam used by regression tests. */
export const daemonSignalLifecycleForTest = {
  setup: setupSignalHandlers,
  cleanup: cleanupSignalHandlers,
};

interface RecoveryPluginUpdaterLifecycle {
  disablePeriodicPolling(): void;
  stop(): void;
}

interface RecoveryNpmUpdaterLifecycle {
  stop(): void;
}

export interface RecoveryControlPlaneStartupOptions {
  pluginVersion: string;
  recoveryCode?: 'UPDATE_REQUIRED' | 'STARTUP_CONFIRMATION_PENDING';
  pluginAutoUpdateService: RecoveryPluginUpdaterLifecycle;
  npmAutoUpdateService?: RecoveryNpmUpdaterLifecycle | null;
  startHttp?: () => Promise<unknown>;
  startHttps?: () => Promise<unknown>;
  stopHttp?: () => Promise<void>;
  stopHttps?: () => Promise<void>;
  isShutdownRequested?: () => boolean;
}

/**
 * Start the manifest-only recovery listeners as one transaction. Any exit
 * before the complete listener set is live fences both background updaters,
 * closes partial listeners, and clears the health-module registrations so an
 * abandoned receipt monitor cannot schedule a later restart.
 */
export async function startRecoveryControlPlaneTransaction(
  options: RecoveryControlPlaneStartupOptions
): Promise<void> {
  const stopHttp = options.stopHttp ?? stopHealthServer;
  const stopHttps = options.stopHttps ?? stopHTTPSHealthServer;
  const rollback = async (): Promise<void> => {
    options.pluginAutoUpdateService.stop();
    options.npmAutoUpdateService?.stop();
    await stopHttps().catch(() => undefined);
    await stopHttp().catch(() => undefined);
    setNpmAutoUpdateService(null);
    setPluginAutoUpdateService(null);
    setPluginRecoveryRequired(null);
  };

  // Recovery never retains the Agent self-updater. The Payara updater keeps
  // only its durable manual endpoint/receipt monitor while startup succeeds.
  options.npmAutoUpdateService?.stop();
  setNpmAutoUpdateService(null);
  options.pluginAutoUpdateService.disablePeriodicPolling();
  setPluginAutoUpdateService(options.pluginAutoUpdateService as PluginAutoUpdateService);
  setPluginRecoveryRequired(options.pluginVersion, options.recoveryCode);

  if (!options.startHttp && !options.startHttps) {
    await rollback();
    throw new Error('UPDATE_REQUIRED recovery has no configured control-plane listener');
  }

  try {
    if (options.startHttp) {
      await options.startHttp();
      if (options.isShutdownRequested?.()) {
        throw new Error('Recovery startup cancelled by signal');
      }
    }
    if (options.startHttps) {
      await options.startHttps();
      if (options.isShutdownRequested?.()) {
        throw new Error('Recovery startup cancelled by signal');
      }
    }
  } catch (err) {
    await rollback();
    throw err;
  }
}

export type PayaraRecoveryStartup =
  | { phase: 'legacy'; version: string }
  | { phase: 'post-update'; version: string }
  | null;

/** Resolve and validate the immutable manifest/recovery handoff. */
export function resolvePayaraRecoveryStartup(
  manifest: PayaraManifestInspection,
  expectedLegacyVersion?: string,
  expectedPostUpdateVersion?: string
): PayaraRecoveryStartup {
  if (expectedLegacyVersion && expectedPostUpdateVersion) {
    throw new Error('Conflicting Payara recovery startup modes');
  }
  if (expectedLegacyVersion) {
    if (!manifest.recoveryRequired || manifest.version !== expectedLegacyVersion) {
      throw new Error('Installed Payara recovery manifest changed during startup');
    }
    return { phase: 'legacy', version: expectedLegacyVersion };
  }
  if (expectedPostUpdateVersion) {
    if (
      !manifest.configured
      || manifest.recoveryRequired
      || manifest.version !== expectedPostUpdateVersion
    ) {
      throw new Error('Installed Payara post-update manifest changed during startup');
    }
    return { phase: 'post-update', version: expectedPostUpdateVersion };
  }
  if (!manifest.recoveryRequired) return null;
  if (!manifest.version) {
    throw new Error('Installed Payara recovery manifest has no exact version');
  }
  return { phase: 'legacy', version: manifest.version };
}

export const POST_UPDATE_AUTHORITY_RETRY_MS = 30_000;

/**
 * Probe remote config authority without transitioning the synthetic recovery
 * process in-place. A successful full fetch requests one clean restart; failed
 * probes remain in the live status plane and cannot consume systemd's burst.
 */
export function startPostUpdateAuthorityRetry(options: {
  probe: () => Promise<boolean>;
  requestRestart: () => void;
  retryMs?: number;
}): () => void {
  const retryMs = options.retryMs ?? POST_UPDATE_AUTHORITY_RETRY_MS;
  let stopped = false;
  let timeout: NodeJS.Timeout | null = null;

  const schedule = (): void => {
    if (stopped) return;
    timeout = setTimeout(() => {
      timeout = null;
      void attempt();
    }, retryMs);
  };
  const attempt = async (): Promise<void> => {
    let authoritative = false;
    try {
      authoritative = await options.probe();
    } catch (err) {
      log.warn({ err }, 'Payara post-update authority probe failed');
    }
    if (stopped) return;
    if (authoritative) {
      stopped = true;
      try {
        options.requestRestart();
        return;
      } catch (err) {
        stopped = false;
        log.error({ err }, 'Could not restart after Payara config authority recovered');
      }
    }
    schedule();
  };

  schedule();
  return () => {
    stopped = true;
    if (timeout) clearTimeout(timeout);
    timeout = null;
  };
}

/**
 * Start the agent daemon with unified WebSocket connection
 */
export async function startDaemon(options: {
  verbose?: boolean;
  healthPort?: number;
  /**
   * Bind host for the agent's health/metrics/plugin HTTP server.
   * Default '127.0.0.1' (loopback only). Operators who genuinely need
   * network exposure must set this to '0.0.0.0' explicitly via config;
   * monitoring routes are public while control and plugin routes require the
   * dedicated local Bearer credential.
   */
  healthHost?: string;
  /** Path only; the control-plane secret itself must never enter argv or env. */
  controlPlaneTokenFile?: string;
  exec?: ExecConfig;
  pluginAutoUpdateService?: PluginAutoUpdateService | null;
  npmAutoUpdateService?: NpmAutoUpdateService | null;
  configFromVault?: boolean;
  /** Exact manifest observed before any remote bootstrap/config request. */
  expectedPayaraRecoveryVersion?: string;
  /** Exact root-attested Payara 3 target awaiting startup confirmation. */
  expectedPayaraPostUpdateRecoveryVersion?: string;
  /** Returns true only after a complete remote config response (never 304). */
  postUpdateAuthorityProbe?: () => Promise<boolean>;
  tls?: TLSConfig;
} = {}): Promise<void> {
  // Refuse startup before plugin or child mutations if the local control plane
  // cannot authenticate callers. The optional environment value is only a
  // file path for isolated install/test roots, never the credential itself.
  const controlPlaneAuth = loadControlPlaneAuthenticator(
    options.controlPlaneTokenFile ?? process.env.ZNVAULT_CONTROL_TOKEN_FILE
  );
  const startupShutdownSequence = getDeferredShutdownSequence();
  let startupShutdownSignal: string | null = null;
  const deferredStartupShutdownSignal = (): string | null =>
    getDeferredShutdownSequence() > startupShutdownSequence
      ? getLastDeferredShutdownSignal()
      : null;
  const isStartupShutdownRequested = (): boolean =>
    startupShutdownSignal !== null || deferredStartupShutdownSignal() !== null;
  const isShutdownRequested = (): boolean =>
    getIsShuttingDown() || isStartupShutdownRequested();
  let childManager: ChildProcessManager | null = null;
  const initialChildStartBarrier = new InitialChildStartBarrier();

  // Install a remembering handler before the first asynchronous startup
  // mutation. SharedMutationLock temporarily replaces it while holding the
  // fence, then replays into it only after the mutation has fully unwound.
  setupSignalHandlers(async (signal) => {
    childManager?.beginShutdown();
    initialChildStartBarrier.fail(
      new Error(`Initial child start cancelled by ${signal}`)
    );
    startupShutdownSignal ??= signal;
  });

  const config = loadConfig();
  // Compatibility inspection is the first action after authenticated config
  // load. Exact Payara 2.x enters a read-only recovery daemon; missing,
  // corrupt, legacy-non-2 or future manifests still throw before any cleanup,
  // dynamic-secret, key, child, WebSocket or plugin mutation.
  const payaraManifest = inspectConfiguredPayaraManifest(config);
  let payaraRecovery: PayaraRecoveryStartup;
  try {
    payaraRecovery = resolvePayaraRecoveryStartup(
      payaraManifest,
      options.expectedPayaraRecoveryVersion,
      options.expectedPayaraPostUpdateRecoveryVersion
    );
  } catch (err) {
    options.pluginAutoUpdateService?.stop();
    options.npmAutoUpdateService?.stop();
    setNpmAutoUpdateService(null);
    setPluginAutoUpdateService(null);
    setPluginRecoveryRequired(null);
    throw err;
  }
  if (payaraRecovery) {
    if (
      !options.pluginAutoUpdateService
      || (payaraRecovery.phase === 'post-update' && !options.postUpdateAuthorityProbe)
    ) {
      options.pluginAutoUpdateService?.stop();
      options.npmAutoUpdateService?.stop();
      setNpmAutoUpdateService(null);
      setPluginAutoUpdateService(null);
      setPluginRecoveryRequired(null);
      throw new Error('Payara recovery cannot start without its exact updater and authority probe');
    }
    const configuredTls = getTLSConfig();
    const recoveryTlsEnabled = options.tls?.enabled ?? configuredTls.enabled ?? false;
    const keepRecoveryHttp = options.tls?.keepHttpServer ?? configuredTls.keepHttpServer;
    const recoveryCertPath = options.tls?.certPath ?? configuredTls.certPath;
    const recoveryKeyPath = options.tls?.keyPath ?? configuredTls.keyPath;
    const recoveryHttpsPort = options.tls?.httpsPort ?? configuredTls.httpsPort;
    const recoveryHost = options.healthHost ?? '127.0.0.1';
    const startRecoveryHttp = options.healthPort !== undefined
      && (!recoveryTlsEnabled || keepRecoveryHttp);
    await startRecoveryControlPlaneTransaction({
      pluginVersion: payaraRecovery.version,
      recoveryCode: payaraRecovery.phase === 'post-update'
        ? 'STARTUP_CONFIRMATION_PENDING'
        : 'UPDATE_REQUIRED',
      pluginAutoUpdateService: options.pluginAutoUpdateService,
      npmAutoUpdateService: options.npmAutoUpdateService,
      isShutdownRequested: isStartupShutdownRequested,
      startHttp: startRecoveryHttp
        ? () => startHealthServer(
          options.healthPort,
          undefined,
          recoveryHost,
          controlPlaneAuth,
          true
        )
        : undefined,
      startHttps: recoveryTlsEnabled
        ? () => startHTTPSHealthServer(
          recoveryHttpsPort,
          recoveryCertPath,
          recoveryKeyPath,
          undefined,
          recoveryHost,
          controlPlaneAuth,
          true
        )
        : undefined,
    });
    let stopPostUpdateAuthorityRetry: (() => void) | undefined;
    setupSignalHandlers(async () => {
      stopPostUpdateAuthorityRetry?.();
      options.pluginAutoUpdateService?.stop();
      options.npmAutoUpdateService?.stop();
      setNpmAutoUpdateService(null);
      setPluginAutoUpdateService(null);
      setPluginRecoveryRequired(null);
      await stopHTTPSHealthServer();
      await stopHealthServer();
    });
    if (payaraRecovery.phase === 'post-update') {
      stopPostUpdateAuthorityRetry = startPostUpdateAuthorityRetry({
        probe: options.postUpdateAuthorityProbe!,
        requestRestart: () => {
          log.info('Remote config authority recovered; restarting for Payara startup confirmation');
          process.kill(process.pid, 'SIGTERM');
        },
      });
      log.error(
        { package: '@zincapp/znvault-plugin-payara', version: payaraRecovery.version },
        'STARTUP_CONFIRMATION_PENDING: root-attested Payara recovery daemon active'
      );
    } else {
      log.error(
        { package: '@zincapp/znvault-plugin-payara', version: payaraRecovery.version },
        'UPDATE_REQUIRED: legacy Payara plugin recovery daemon active'
      );
    }
    return;
  }
  setPluginRecoveryRequired(null);
  const secretTargets = config.secretTargets ?? [];
  // Runtime acknowledgements represent the version the child/plugin consumer
  // has actually crossed, not merely the fingerprint/version persisted by a
  // deployer before a restart. They are advanced only after the full pipeline.
  const consumedCertificateFingerprints = new Map(
    config.targets.map(target => [target.certId, target.lastFingerprint])
  );
  const consumedCertificateVersions = new Map<string, number>();
  const consumedSecretVersions = new Map<string, number>(
    secretTargets.flatMap(target => target.lastVersion === undefined
      ? []
      : [[target.secretId, target.lastVersion]])
  );
  const execSecretIdentityByReference = new Map<string, string>();
  const consumedExecSecretVersions = new Map<string, number>();

  // Initialize plugin loader
  let pluginLoader: PluginLoader | null = null;

  // Initialize metrics
  initializeMetrics();

  // Setup log rotation handler
  setupLogRotation();

  // Clean up orphaned temp and old backup files from previous crashed deployments
  // This prevents disk space leaks from interrupted atomic writes
  const targetDirectories = extractTargetDirectories(
    config.targets.map(t => ({ outputs: t.outputs })),
    secretTargets
  );
  if (targetDirectories.length > 0 && !isStartupShutdownRequested()) {
    const cleanupStats = await runStartupCleanup(targetDirectories);
    if (cleanupStats.tempFilesRemoved > 0 || cleanupStats.backupFilesRemoved > 0) {
      log.info({
        tempFilesRemoved: cleanupStats.tempFilesRemoved,
        backupFilesRemoved: cleanupStats.backupFilesRemoved,
      }, 'Startup cleanup: removed orphaned files');
    }
  }

  // Initialize dynamic secrets service if enabled
  if (isDynamicSecretsEnabled() && !isStartupShutdownRequested()) {
    initializeDynamicSecrets();
    log.info('Dynamic secrets capability enabled');
  }

  // CRITICAL: Verify and sync managed key file before doing anything else
  // This ensures apps that read from file always have the correct key
  // By default, sync failure blocks startup (MANAGED_KEY_SYNC_REQUIRED=true)
  const managedKeySyncRequired = process.env.MANAGED_KEY_SYNC_REQUIRED !== 'false';

  if (config.managedKey?.filePath && !isStartupShutdownRequested()) {
    const syncResult = await syncManagedKeyFile();
    if (syncResult.wasOutOfSync) {
      if (syncResult.keptExistingFile) {
        log.error({
          filePath: config.managedKey.filePath,
        }, 'Managed key file differs from config but config key is STALE (failed vault auth) - kept existing key file. Fix the config source.');
      } else if (syncResult.synced) {
        log.warn({
          filePath: config.managedKey.filePath,
        }, 'Managed key file was out of sync - auto-fixed on startup');
      } else {
        log.error({
          filePath: config.managedKey.filePath,
          error: syncResult.error,
        }, 'CRITICAL: Managed key file sync failed');

        // Block startup if sync is required (default behavior)
        if (managedKeySyncRequired) {
          throw new Error(`Managed key file sync failed: ${syncResult.error ?? 'unknown error'}. Set MANAGED_KEY_SYNC_REQUIRED=false to continue anyway.`);
        }
        log.warn('Continuing despite sync failure (MANAGED_KEY_SYNC_REQUIRED=false)');
      }
    } else {
      log.info({
        filePath: config.managedKey.filePath,
      }, 'Managed key file verified - in sync');
    }
  }

  // Extract exec secret IDs and managed API key names for WebSocket subscription
  let execSecretIds: string[] = [];
  let execSecretReferences = new Set<string>();
  let execManagedKeyNames: string[] = [];
  let execSecretMappings: (SecretMapping & { literal?: string })[] = [];
  const execOutputFile = options.exec?.envFile; // Output file path for env file mode

  if (options.exec) {
    execSecretMappings = options.exec.secrets.map(parseSecretMappingFromConfig);
    execSecretIds = extractSecretIds(execSecretMappings);
    execSecretReferences = initializeExecSecretIdentity(
      execSecretIds,
      execSecretIdentityByReference
    );
    execManagedKeyNames = extractApiKeyNames(execSecretMappings);
  }

  // Track all managed key names (exec + plugins + agent's own key)
  // This is populated after plugins are loaded
  const allManagedKeyNames: string[] = [...execManagedKeyNames];

  // Add agent's own managed key if configured
  if (config.managedKey?.name) {
    allManagedKeyNames.push(config.managedKey.name);
  }

  log.info({
    vault: config.vaultUrl,
    certTargets: config.targets.length,
    secretTargets: secretTargets.length,
    execSecrets: execSecretIds.length,
    execManagedKeys: execManagedKeyNames.length,
    execCommand: options.exec?.command.join(' '),
  }, 'Starting ZnVault Agent');

  // Initialize child process manager if exec config provided
  if (options.exec) {
    childManager = new ChildProcessManager(options.exec, {
      forwardTerminationSignals: false,
    });

    // Register with health module for status reporting
    setChildProcessManager(childManager);

    childManager.on('started', (pid) => {
      log.info({ pid }, 'Child process started');
    });

    childManager.on('stopped', (code, signal) => {
      log.info({ code, signal }, 'Child process stopped');
    });

    childManager.on('restarting', (reason) => {
      log.info({ reason }, 'Restarting child process');
    });

    childManager.on('maxRestartsExceeded', () => {
      log.error('Child process max restarts exceeded, entering degraded state');
    });

    childManager.on('error', (err) => {
      log.error({ err }, 'Child process error');
    });
  }

  const restartChildAfterMutation = childManager && options.exec?.restartOnChange !== false
    ? async (reason: string): Promise<void> => {
        try {
          if (isShutdownRequested()) {
            throw new Error('Rejecting child restart after daemon shutdown admission closed');
          }
          const disposition = await initialChildStartBarrier.beforeRestart();
          if (disposition === 'covered-by-initial-start') return;
          // Count from admission, including time queued behind another restart,
          // so shutdown cannot observe a false zero between serialized jobs.
          await runAdmittedChildRestart(
            reason,
            isShutdownRequested,
            async admittedReason => childManager.restart(admittedReason)
          );
        } catch (err) {
          log.error(
            { err, reason },
            'Child restart failed after mutation; keeping the target pending'
          );
          throw err;
        }
      }
    : undefined;
  const restartChildForPlugin = restartChildAfterMutation
    ? async (reason: string): Promise<void> => {
        const disposition = await initialChildStartBarrier.beforePluginRestart();
        if (disposition === 'covered-by-initial-start') return;
        await restartChildAfterMutation(reason);
      }
    : undefined;

  // Initialize plugin system if plugins are configured
  const pluginConfigs = (config as AgentConfig & { plugins?: unknown[] }).plugins;
  if (pluginConfigs && pluginConfigs.length > 0 && !isStartupShutdownRequested()) {
    log.info({ pluginCount: pluginConfigs.length }, 'Initializing plugin system');

    pluginLoader = createPluginLoader(
      {
        config,
        childProcessManager: childManager,
        restartChild: restartChildForPlugin,
      },
      {
        pluginDir: process.env.ZNVAULT_AGENT_PLUGIN_DIR,
      }
    );

    try {
      // Load plugins from config
      await pluginLoader.loadPlugins(config);

      // A signal received while loading is sticky: do not admit the next
      // plugin lifecycle phase after the await boundary.
      if (!isShutdownRequested()) {
        await pluginLoader.initializePlugins();
      }

      if (!isShutdownRequested()) {
        log.info({ plugins: pluginLoader.getAllPluginStatuses() }, 'Plugins initialized');
      }

      // Extract managed key names from plugin configs (e.g., "api-key:my-key" in secrets)
      // This ensures we subscribe to rotation events for keys used by plugins
      for (const pluginConfig of pluginConfigs) {
        const pc = pluginConfig as { config?: { secrets?: Record<string, string> } };
        if (pc.config?.secrets) {
          for (const value of Object.values(pc.config.secrets)) {
            if (typeof value === 'string' && value.startsWith('api-key:')) {
              const keyName = value.substring(8); // Remove 'api-key:' prefix
              if (keyName && !allManagedKeyNames.includes(keyName)) {
                allManagedKeyNames.push(keyName);
                log.debug({ keyName, source: 'plugin' }, 'Tracking managed key from plugin config');
              }
            }
          }
        }
      }

      if (allManagedKeyNames.length > execManagedKeyNames.length) {
        log.info({
          totalManagedKeys: allManagedKeyNames.length,
          fromExec: execManagedKeyNames.length,
          fromPlugins: allManagedKeyNames.length - execManagedKeyNames.length - (config.managedKey?.name ? 1 : 0),
          fromAgent: config.managedKey?.name ? 1 : 0,
        }, 'Managed API keys tracked for rotation events');
      }
    } catch (err) {
      log.error({ err }, 'Failed to initialize plugins');
      if (
        err instanceof PluginCompatibilityError
        || err instanceof RequiredPluginLoadError
      ) {
        throw err;
      }
      // Continue running agent without plugins
    }

    // Wire up child process events to plugins - use .catch() for error handling in event callbacks
    if (childManager) {
      childManager.on('started', (pid: number) => {
        const event: ChildProcessEvent = { type: 'started', pid };
        pluginLoader?.dispatchEvent('childProcess', event).catch((err: unknown) => {
          log.error({ err, type: 'started' }, 'Plugin failed to handle childProcess event');
        });
      });

      childManager.on('stopped', (code: number | null, signal: string | null) => {
        const event: ChildProcessEvent = {
          type: 'stopped',
          exitCode: code ?? undefined,
          signal: signal ?? undefined,
        };
        pluginLoader?.dispatchEvent('childProcess', event).catch((err: unknown) => {
          log.error({ err, type: 'stopped' }, 'Plugin failed to handle childProcess event');
        });
      });

      childManager.on('restarting', (reason: string) => {
        const event: ChildProcessEvent = { type: 'restarting', reason };
        pluginLoader?.dispatchEvent('childProcess', event).catch((err: unknown) => {
          log.error({ err, type: 'restarting' }, 'Plugin failed to handle childProcess event');
        });
      });

      childManager.on('maxRestartsExceeded', () => {
        const event: ChildProcessEvent = { type: 'max_restarts' };
        pluginLoader?.dispatchEvent('childProcess', event).catch((err: unknown) => {
          log.error({ err, type: 'max_restarts' }, 'Plugin failed to handle childProcess event');
        });
      });
    }
  }

  // Unified propagation of rotated managed keys to ALL consumers (live config,
  // plugin keyRotated dispatch, exec env files, child restart). Both detection
  // channels — the WebSocket rotation event AND the renewal service's polling
  // rails — go through this one path, so a lost WebSocket event can no longer
  // leave plugin-deployed key files stale (2026-07-05 incident).
  const childManagerForRestart = childManager;
  const keyRotationPropagator = createKeyRotationPropagator({
    config,
    getPluginLoader: () => pluginLoader,
    execOutputFile,
    execSecretMappings,
    isShuttingDown: isShutdownRequested,
    restartChild: childManagerForRestart && options.exec?.restartOnChange !== false
      ? async (reason: string) => {
          await restartChildAfterMutation?.(reason);
        }
      : undefined,
  });

  // Polling rail for tracked managed keys BEYOND the agent's own auth key
  // (exec/plugin `api-key:` mappings). The renewal service covers only the
  // own key; without this poller, a lost WebSocket event would leave those
  // keys' consumers stale until restart — the 2026-07-05 incident class.
  // Started after plugins are running (so keyRotated dispatches reach them);
  // unchanged polls are no-ops via the propagator's per-key dedup.
  const trackedKeyPoller = new TrackedKeyPoller({
    keyNames: allManagedKeyNames.filter((name) => name !== config.managedKey?.name),
    propagate: (newKey, meta, opts) => keyRotationPropagator.propagate(newKey, meta, opts),
    isShuttingDown: isShutdownRequested,
  });

  // Register plugin auto-update service with health module for HTTP endpoints
  if (options.pluginAutoUpdateService) {
    setPluginAutoUpdateService(options.pluginAutoUpdateService);
  }

  // Register npm auto-update service with health module for agent version/update endpoints
  if (options.npmAutoUpdateService) {
    setNpmAutoUpdateService(options.npmAutoUpdateService);
  }

  /**
   * Listener startup is a transaction. No background service may survive a
   * requested HTTP/HTTPS listener failing to bind or initialize: startDaemon()
   * rejects and its caller exits instead of leaving a headless partial daemon.
   */
  const rollbackControlPlaneStartup = async (startupError: unknown): Promise<never> => {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (err) {
        cleanupErrors.push(err);
      }
    };

    childManager?.beginShutdown();
    await cleanup(stopHTTPSHealthServer);
    await cleanup(stopHealthServer);
    await cleanup(() => stopTLSCertificateManager());
    await cleanup(() => options.pluginAutoUpdateService?.stop());
    await cleanup(() => options.npmAutoUpdateService?.stop());
    setPluginAutoUpdateService(null);
    setNpmAutoUpdateService(null);

    if (pluginLoader) {
      await cleanup(() => pluginLoader?.stopPlugins());
    }
    clearPluginLoader();
    setPluginLoader(null);

    // Listener startup precedes initial child admission. Closing admission is
    // sufficient here and avoids treating pre-existing secret files as
    // artifacts of a child which this daemon never spawned.
    setChildProcessManager(null);

    if (isDynamicSecretsEnabled()) {
      await cleanup(cleanupDynamicSecrets);
    }

    const primaryError = startupError instanceof Error
      ? startupError
      : new Error(String(startupError));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'Control-plane listener startup failed and cleanup was incomplete'
      );
    }
    throw primaryError;
  };

  try {
    // Start health server if port specified (pass plugin loader for routes and health aggregation)
    // Skip HTTP server if TLS is enabled and keepHttpServer is false
    const tlsEnabledForSkipCheck = options.tls?.enabled || isTLSEnabled();
    const skipHttpServer = tlsEnabledForSkipCheck && options.tls?.keepHttpServer === false;
    if (options.healthPort && !skipHttpServer && !isShutdownRequested()) {
      await startHealthServer(
        options.healthPort,
        pluginLoader ?? undefined,
        options.healthHost ?? '127.0.0.1',
        controlPlaneAuth
      );
      if (isShutdownRequested()) {
        await stopHealthServer();
      }
    }

    // Start HTTPS health server if TLS is enabled
    // TLS can be enabled via CLI options (options.tls) or config file (isTLSEnabled())
    const tlsEnabled = options.tls?.enabled || isTLSEnabled();
    if (tlsEnabled && !isShutdownRequested()) {
      // Set up certificate update callback for hot-reload BEFORE starting manager
      onCertificateUpdated((certPath, keyPath) => {
        if (isShutdownRequested()) return;
        reloadHTTPSCertificate(certPath, keyPath).then(success => {
          if (success) {
            log.info({ certPath, keyPath }, 'HTTPS certificate hot-reloaded');
          }
        }).catch((err: unknown) => {
          log.error({ err }, 'Failed to hot-reload HTTPS certificate');
        });
      });

      // Ensure certificate is ready (auto-fetch from vault if needed)
      // This starts the TLS manager which will request a cert if none exists
      log.info('TLS enabled - ensuring certificate is ready');
      const tlsReady = await withActiveDeployment(
        async () => ensureCertificateReady()
      );

      if (isShutdownRequested()) {
        stopTLSCertificateManager();
      } else if (tlsReady) {
        // Use CLI-provided paths if available, otherwise use auto-detected paths
        const certPath = options.tls?.certPath ?? tlsReady.certPath;
        const keyPath = options.tls?.keyPath ?? tlsReady.keyPath;
        const httpsPort = options.tls?.httpsPort ?? tlsReady.httpsPort;

        await startHTTPSHealthServer(
          httpsPort,
          certPath,
          keyPath,
          pluginLoader ?? undefined,
          options.healthHost ?? '127.0.0.1',
          controlPlaneAuth
        );

        if (isShutdownRequested()) {
          await stopHTTPSHealthServer();
          stopTLSCertificateManager();
        } else {
          log.info({ httpsPort, certPath }, 'HTTPS health server started with TLS');
        }
      } else {
        throw new Error(
          'TLS is enabled but no certificate is available; refusing partial daemon startup'
        );
      }
    }
  } catch (err) {
    log.error({ err }, 'Control-plane listener startup failed; rolling back daemon startup');
    await rollbackControlPlaneStartup(err);
  }

  // Update tracked metrics
  metrics.setCertsTracked(config.targets.length);

  // Create unified WebSocket client with exec secret IDs and managed key names
  const unifiedClient = createUnifiedWebSocketClient(execSecretIds, allManagedKeyNames);

  // Initialize degraded mode handler
  initDegradedModeHandler({
    onCredentialsUpdated: (_newKey) => {
      if (isShutdownRequested()) return;
      log.info('Credentials updated via reprovision, reconnecting');
      // Reconnect with new credentials
      unifiedClient.disconnect();
      setTimeout(() => {
        if (!isShutdownRequested()) {
          unifiedClient.connect();
        }
      }, 500);
    },
    onStateChanged: (isDegraded, reason) => {
      if (isDegraded) {
        log.warn({ reason }, 'Agent entered degraded mode');
      } else {
        log.info('Agent exited degraded mode');
      }
    },
  });

  // Handle degraded connection notifications
  unifiedClient.onDegradedConnection((info) => {
    if (isShutdownRequested()) return;
    handleDegradedConnection(info);
  });

  // Handle reprovision available notifications
  unifiedClient.onReprovisionAvailable((expiresAt) => {
    if (isShutdownRequested()) return;
    handleReprovisionAvailable(expiresAt);
  });

  interface CertificateRetryItem {
    event: CertificateEvent;
    target: CertTarget;
  }

  interface CertificateMutationEvidence {
    fingerprint: string;
    version: number;
  }

  let pendingSecretQueueCount = 0;
  const execMetadataUnknown = new Set<string>();
  const publishPendingSecretHealth = (): void => {
    setPendingMutationRetries(
      'secret',
      pendingSecretQueueCount + execMetadataUnknown.size
    );
  };
  const dispatchSecretChanged = async (
    event: SecretEvent,
    version: number
  ): Promise<void> => {
    if (!pluginLoader) return;
    const valueChanged = event.event === 'secret.updated'
      || event.event === 'secret.rotated';
    const secretChangedEvent: SecretChangedEvent = {
      secretId: event.secretId,
      alias: event.alias,
      version,
      valueChanged,
      changedAt: event.timestamp,
    };
    try {
      await pluginLoader.dispatchEvent('secretChanged', secretChangedEvent);
    } catch (pluginErr) {
      log.error(
        { err: pluginErr, secretId: event.secretId },
        'Plugin failed to handle secretChanged event'
      );
    }
  };

  const isLockContention = (errorCode?: string): boolean =>
    errorCode === 'SHARED_MUTATION_LOCK_CONTENDED';

  const certificateRetryQueue = new RestartRequiredMutationQueue<
    CertificateRetryItem,
    CertificateMutationEvidence
  >({
    account: withActiveDeployment,
    prepare: async ({ event, target }) => {
      log.info({ name: target.name, event: event.event }, 'Processing certificate event');
      const result = await deployCertificate(target, true);

      if (!result.success) {
        if (isLockContention(result.errorCode)) return { decision: 'retry' };
        log.error({ name: target.name, error: result.message }, 'Certificate deployment failed');
        return { decision: 'failed' };
      }

      log.info({ name: target.name, fingerprint: result.fingerprint }, 'Certificate deployed');
      return {
        decision: 'resolved',
        evidence: {
          fingerprint: result.fingerprint ?? event.fingerprint,
          version: result.version ?? event.version,
        },
      };
    },
    notify: async ({ target }, evidence) => {
      if (pluginLoader) {
        const certEvent: CertificateDeployedEvent = {
          certId: target.certId,
          name: target.name,
          paths: target.outputs,
          fingerprint: evidence.fingerprint,
          expiresAt: '',
          commonName: '',
          isUpdate: true,
        };
        try {
          await pluginLoader.dispatchEvent('certificateDeployed', certEvent);
        } catch (pluginErr) {
          log.error({ err: pluginErr, certId: target.certId }, 'Plugin failed to handle certificateDeployed event');
        }
      }
    },
    restart: async () => {
      await restartChildAfterMutation?.('certificate rotated');
    },
    acknowledge: ({ target }, evidence) => {
      consumedCertificateFingerprints.set(target.certId, evidence.fingerprint);
      consumedCertificateVersions.set(target.certId, evidence.version);
    },
    onPendingChange: count => setPendingMutationRetries('certificate', count),
    onExhausted: (key, item, generation) => {
      log.error(
        { certId: key, name: item.target.name, generation },
        'Certificate mutation retry exhausted; polling recovery required'
      );
    },
  });

  // Handle certificate events
  async function handleCertificateEvent(event: CertificateEvent): Promise<void> {
    if (isShutdownRequested()) {
      log.debug({ event: event.event }, 'Ignoring certificate event during shutdown');
      return;
    }

    await withActiveDeployment(async () => {
      const target = config.targets.find(t => t.certId === event.certificateId);
      if (target) {
        if (consumedCertificateFingerprints.get(target.certId) === event.fingerprint
            && !certificateRetryQueue.isPending(target.certId)) {
          log.debug(
            { certId: target.certId, version: event.version },
            'Ignoring already-consumed certificate event'
          );
          return;
        }
        const item = { event, target };
        certificateRetryQueue.enqueue(target.certId, event.version, item);
        await certificateRetryQueue.retryNow(target.certId);
      } else {
        log.debug({ certId: event.certificateId }, 'Received event for untracked certificate');
      }
    });
  }

  unifiedClient.onCertificateEvent((event) => {
    handleCertificateEvent(event).catch((err: unknown) => {
      log.error({ err }, 'Error handling certificate event');
    });
  });

  const secretRetryQueue = new RestartRequiredMutationQueue<
    SecretRetryItem,
    SecretMutationEvidence
  >({
    account: withActiveDeployment,
    prepare: async (item) => {
      const { event, target } = item;
      if (!target) {
        if (item.execPollReference) {
          try {
            const metadata = await getSecretMetadata(item.execPollReference);
            const identity = item.execIdentity
              ?? findSecretIdentity(
                execSecretIdentityByReference,
                metadata.id,
                metadata.alias,
                item.execPollReference
              )
              ?? item.execPollReference;
            bindSecretIdentity(
              execSecretIdentityByReference,
              identity,
              item.execPollReference,
              metadata.id,
              metadata.alias
            );
            item.execIdentity = identity;
            event.secretId = metadata.id;
            event.alias = metadata.alias;
            event.version = metadata.version;
            return {
              decision: 'resolved',
              evidence: { version: metadata.version },
            };
          } catch (err) {
            log.error(
              { err, secretId: item.execPollReference },
              'Exec-only secret metadata retry failed'
            );
            return { decision: 'failed' };
          }
        }
        return { decision: 'resolved', evidence: { version: event.version } };
      }
      log.info({ name: target.name, event: event.event, version: event.version }, 'Processing secret event');
      const result = await deploySecret(target, true);

      if (!result.success) {
        if (isLockContention(result.errorCode)) return { decision: 'retry' };
        log.error({ name: target.name, error: result.message }, 'Secret deployment failed');
        return { decision: 'failed' };
      }

      log.info({ name: target.name, version: result.version }, 'Secret deployed');
      return {
        decision: 'resolved',
        evidence: { version: result.version ?? event.version },
      };
    },
    notify: async ({ event, target }, evidence) => {
      if (pluginLoader) {
        await dispatchSecretChanged(event, evidence.version);

        if (target) {
          const secretEvent: SecretDeployedEvent = {
            secretId: target.secretId,
            alias: event.alias,
            name: target.name,
            path: target.output,
            format: target.format,
            version: evidence.version,
            isUpdate: true,
          };
          try {
            await pluginLoader.dispatchEvent('secretDeployed', secretEvent);
          } catch (pluginErr) {
            log.error({ err: pluginErr, secretId: target.secretId }, 'Plugin failed to handle secretDeployed event');
          }
        }
      }
    },
    restart: async ({ restartReason }) => {
      await restartChildAfterMutation?.(restartReason);
    },
    acknowledge: (item, evidence) => {
      acknowledgeSecretMutation(item, evidence, {
        consumedSecretVersions,
        consumedExecSecretVersions,
        execSecretIdentityByReference,
      });
    },
    onPendingChange: count => {
      pendingSecretQueueCount = count;
      publishPendingSecretHealth();
    },
    onExhausted: (key, item, generation) => {
      log.error(
        { secretId: key, name: item.target?.name, generation },
        'Secret mutation retry exhausted; polling recovery required'
      );
    },
  });

  // Handle secret events
  async function handleSecretEvent(event: SecretEvent): Promise<void> {
    if (isShutdownRequested()) {
      log.debug({ event: event.event }, 'Ignoring secret event during shutdown');
      return;
    }

    await withActiveDeployment(async () => {
      const admission = await admitSecretEventToRetryQueue({
        event,
        execSecretReferences,
        execSecretIdentityByReference,
        consumedSecretVersions,
        consumedExecSecretVersions,
        queue: secretRetryQueue,
        findTarget: reference => findSecretTarget(reference),
      });
      if (admission.status === 'consumed') {
        log.debug(
          { secretId: event.secretId, version: event.version },
          'Ignoring already-consumed secret event'
        );
        return;
      }

      if (admission.status === 'untracked') {
        // Plugins may subscribe to secrets that the core agent neither writes
        // to a file nor injects into exec. Preserve that generic event path.
        await dispatchSecretChanged(event, event.version);
        log.debug({ secretId: event.secretId, alias: event.alias }, 'Received event for untracked secret');
      }
    });

  }

  unifiedClient.onSecretEvent((event) => {
    handleSecretEvent(event).catch((err: unknown) => {
      log.error({ err }, 'Error handling secret event');
    });
  });

  // Handle update events (operator-initiated update-available from vault).
  // The dispatcher fires this for top-level {type:'update-available',...} messages
  // (and the legacy {type:'event', topic:'updates'} path). Drive the manual,
  // gate-bypassing update path so updates work even when the automatic periodic
  // checker is off (AUTO_UPDATE=false default). Fire-and-handle like the other
  // async handlers - handleUpdateEvent never throws, but .catch() defensively.
  unifiedClient.onUpdateEvent((event) => {
    if (isShutdownRequested()) return;
    handleUpdateEvent(event, options.npmAutoUpdateService).catch((err: unknown) => {
      log.error({ err }, 'Error handling update event');
    });
  });

  // Handle API key rotation events
  async function handleApiKeyRotationEvent(event: ApiKeyRotationEvent): Promise<void> {
    if (isShutdownRequested()) {
      log.debug({ event: event.event }, 'Ignoring API key rotation event during shutdown');
      return;
    }

    // Check if this key is one we're using (exec mode, plugins, or agent's own key)
    if (!allManagedKeyNames.includes(event.apiKeyName)) {
      log.debug({ keyName: event.apiKeyName, tracked: allManagedKeyNames }, 'Received rotation event for untracked managed key');
      return;
    }

    log.info({
      keyName: event.apiKeyName,
      graceExpiresAt: event.graceExpiresAt,
      reason: event.reason,
    }, 'Processing managed API key rotation event');

    await withActiveDeployment(async () => {
      try {
      // Fetch the new key via bind
      const bindResponse = await bindManagedApiKey(event.apiKeyName);
      const newKey = bindResponse.key;

      log.info({
        keyName: event.apiKeyName,
      }, 'Fetched new API key value');

      // Propagate to ALL consumers: live config mutation (plugins read
      // ctx.config), disk/env persistence, plugin keyRotated dispatch, exec
      // env-file update, optional child restart. Shared with the renewal
      // service's polling rails so both channels behave identically.
      // Metadata comes from the authoritative bind response (the event may
      // be older than the bind we just performed); detectedAt is when the
      // bind resolved — the propagator uses it to discard stale detections.
      await keyRotationPropagator.propagate(newKey, {
        keyName: event.apiKeyName,
        newPrefix: event.newPrefix ?? bindResponse.prefix,
        nextRotationAt: bindResponse.nextRotationAt,
        graceExpiresAt: bindResponse.graceExpiresAt ?? event.graceExpiresAt,
        rotationMode: bindResponse.rotationMode ?? event.rotationMode,
        source: 'ws_event',
      }, { persist: true, detectedAt: Date.now() });
      } catch (err) {
        log.error({
          err,
          keyName: event.apiKeyName,
        }, 'Failed to process API key rotation event');
      }
    });
  }

  unifiedClient.onApiKeyRotationEvent((event) => {
    handleApiKeyRotationEvent(event).catch((err: unknown) => {
      log.error({ err }, 'Error handling API key rotation event');
    });
  });

  // Handle host config update events (config-from-vault mode)
  async function handleHostConfigEvent(event: HostConfigEvent): Promise<void> {
    if (isShutdownRequested()) {
      log.debug({ event: event.event }, 'Ignoring host config event during shutdown');
      return;
    }

    // Only process if in config-from-vault mode
    if (!options.configFromVault) {
      log.debug({ hostname: event.hostname }, 'Ignoring host config event (not in config-from-vault mode)');
      return;
    }

    log.info({
      hostname: event.hostname,
      version: event.version,
      force: event.force,
    }, 'Processing host config update event');

    try {
      // Fetch the latest config from vault
      const result = await fetchConfigFromVault({
        vaultUrl: config.vaultUrl,
        apiKey: config.auth.apiKey ?? '',
        insecure: config.insecure,
        agentId: config.agentId,
        hostConfigId: config.hostConfigId,
        configVersion: event.force ? undefined : config.configVersion,
      });

      if (!result.success) {
        log.error({ error: result.error }, 'Failed to fetch updated config from vault');
        return;
      }

      if (!result.modified) {
        log.debug({ version: result.version }, 'Config not modified, skipping reload');
        return;
      }

      if (result.config) {
        // Update in-memory config (preserving local auth and managed key file settings)
        const updatedConfig = {
          ...result.config,
          auth: config.auth,
          agentId: config.agentId,
          // Merge managedKey: vault provides key name, local provides file write settings
          managedKey: result.config.managedKey ? {
            ...config.managedKey,  // Local settings (filePath, fileOwner, fileMode)
            ...result.config.managedKey,  // Vault settings (name, rotation metadata)
          } : config.managedKey,
        };
        setConfigInMemory(updatedConfig);

        log.info({
          version: result.version,
          targets: updatedConfig.targets?.length ?? 0,
          secretTargets: updatedConfig.secretTargets?.length ?? 0,
        }, 'Config reloaded from vault');

        // TODO: In a future enhancement, we could:
        // - Restart plugins if plugin config changed
        // - Re-sync certificates if targets changed
        // - Re-sync secrets if secretTargets changed
        // For now, we just log that the config was updated.
        // A full restart may be required for changes to take effect.
      }
    } catch (err) {
      log.error({ err }, 'Failed to process host config update event');
    }
  }

  // Only register handler if in config-from-vault mode
  if (options.configFromVault) {
    unifiedClient.onHostConfigEvent((event) => {
      handleHostConfigEvent(event).catch((err: unknown) => {
        log.error({ err }, 'Error handling host config event');
      });
    });
    log.info('Config-from-vault mode: subscribed to host config updates');
  }

  unifiedClient.onConnect((agentId) => {
    log.info({ agentId }, 'Connected to vault');
    // Store agent ID for degraded mode handling
    setAgentId(agentId);
  });

  unifiedClient.onDisconnect((reason) => {
    log.warn({ reason }, 'Disconnected from vault');
  });

  unifiedClient.onError((err) => {
    log.error({ err }, 'WebSocket error');
  });

  // Start API key renewal service (managed or standard)
  if (isManagedKeyMode() && !isShutdownRequested()) {
    log.info('Using managed API key mode');

    // Set up callback for when managed key changes.
    //
    // 2026-07-05 incident fix: rotations detected by the renewal service's
    // polling rails (scheduled refresh / grace poll / heartbeat / reconnect)
    // previously only reconnected the WebSocket — the new key was never
    // propagated to plugins or exec env files, so plugin-deployed key files
    // (e.g. payara's ZINC_CONFIG_VAULT_API_KEY) stayed stale until an agent
    // restart whenever the WebSocket rotation event was lost. Rail detections
    // now run the same propagation path as the WebSocket event handler.
    // The renewal service has already persisted the key (updateManagedKey),
    // so the propagator is invoked without the persist option.
    onManagedKeyChanged((newKey, meta) => {
      if (isShutdownRequested()) {
        log.debug({ keyName: meta.keyName }, 'Ignoring managed key change during shutdown');
        return;
      }
      // The renewal service's bind resolved just before this callback fired.
      const detectedAt = Date.now();
      void (async () => {
        // Count as an active deployment so graceful shutdown waits for the
        // consumer updates (same invariant as the WebSocket rotation handler).
        await withActiveDeployment(async () => {
          try {
          await keyRotationPropagator.propagate(newKey, meta, { detectedAt });
          } catch (err) {
            log.error({ err, keyName: meta.keyName }, 'Failed to propagate rail-detected key rotation');
          }
        });

        log.info({ source: meta.source }, 'Managed key changed, reconnecting WebSocket');
        // Reconnect WebSocket with new key
        unifiedClient.disconnect();
        // Small delay to allow config to be saved
        setTimeout(() => {
          if (!isShutdownRequested()) {
            unifiedClient.connect();
          }
        }, 500);
      })();
    });

    // Start managed key renewal service and AWAIT initial bind
    // This ensures the key is rotated BEFORE we connect WebSocket or start child process
    try {
      await startManagedKeyRenewal();
    } catch (err) {
      log.error({ err }, 'Failed to start managed key renewal service');
    }
  } else if (!isShutdownRequested()) {
    // Use standard API key renewal
    const allowStaticKey = process.env.ALLOW_STATIC_KEY === 'true';
    if (!allowStaticKey) {
      log.warn(
        {},
        'SECURITY WARNING: Using static API key. Managed keys are recommended for production. ' +
          'To suppress this warning, set ALLOW_STATIC_KEY=true or migrate to a managed key.'
      );
    }
    startApiKeyRenewal();
  }

  // Connect unified WebSocket
  if (!isShutdownRequested()) {
    unifiedClient.connect();
  }

  // Start plugins (after WebSocket is connecting but before initial sync)
  if (pluginLoader && !isShutdownRequested()) {
    try {
      await pluginLoader.startPlugins();
      log.info({ plugins: pluginLoader.getAllPluginStatuses() }, 'Plugins started');
      const payara = pluginLoader.getPlugin('payara');
      options.pluginAutoUpdateService?.confirmPluginStartup(
        payara?.version ?? '',
        pluginLoader.getPluginStatus('payara') === 'running'
      );
    } catch (err) {
      log.error({ err }, 'Failed to start plugins');
      options.pluginAutoUpdateService?.confirmPluginStartup('', false);
    }
  }

  // Start the polling rail for non-own tracked keys AFTER plugins are running
  // so their keyRotated handlers receive the dispatches.
  if (!isShutdownRequested()) {
    trackedKeyPoller.start();
  }

  // Initial sync - certificates
  if (config.targets.length > 0 && !isStartupShutdownRequested()) {
    log.info('Performing initial certificate sync');
    const certResults = await withActiveDeployment(
      async () => deployAllCertificates(false, () => !isStartupShutdownRequested())
    );
    const certSuccess = certResults.filter(r => r.success).length;
    const certErrors = certResults.filter(r => !r.success).length;
    for (const result of certResults) {
      if (result.success && result.fingerprint) {
        consumedCertificateFingerprints.set(result.certId, result.fingerprint);
        if (result.version !== undefined) {
          consumedCertificateVersions.set(result.certId, result.version);
        }
      }
    }
    updateCertStatus(certSuccess, certErrors);
    log.info({ total: certResults.length, success: certSuccess, errors: certErrors }, 'Certificate sync complete');
  }

  // Initial sync - secrets
  if (secretTargets.length > 0 && !isStartupShutdownRequested()) {
    log.info('Performing initial secret sync');
    const secretResults = await withActiveDeployment(
      async () => deployAllSecrets(false, () => !isStartupShutdownRequested())
    );
    const secretSuccess = secretResults.filter(r => r.success).length;
    const secretErrors = secretResults.filter(r => !r.success).length;
    for (const result of secretResults) {
      if (result.success && result.version !== undefined) {
        consumedSecretVersions.set(result.secretId, result.version);
      }
    }
    updateSecretStatus(secretSuccess, secretErrors);
    log.info({ total: secretResults.length, success: secretSuccess, errors: secretErrors }, 'Secret sync complete');
  }

  // Start child process after initial sync (if exec mode)
  if (childManager && !isShutdownRequested()) {
    // From this point, mutation restarts queue behind the serialized initial
    // start instead of starting a child before initial sync has completed.
    initialChildStartBarrier.open();
    log.info('Starting child process');
    try {
      await childManager.start();
      if (!childManager.isHealthy()) {
        throw new Error('Initial child start did not reach running state');
      }
      initialChildStartBarrier.complete();
    } catch (err) {
      initialChildStartBarrier.fail(err);
      log.error({ err }, 'Failed to start child process');
      // Continue running daemon even if child fails to start
    }
  }

  // Set up polling interval as fallback
  const pollInterval = (config.pollInterval ?? 3600) * 1000;

  const runPoll = async (): Promise<void> => {
    if (isShutdownRequested()) return;

    log.debug('Starting periodic poll');

    // Poll certificates
    for (const target of config.targets) {
      if (isShutdownRequested()) break;

      try {
        if (certificateRetryQueue.isPending(target.certId)) {
          await certificateRetryQueue.retryNow(target.certId);
          continue;
        }
        await withActiveDeployment(async () => {
          const consumedFingerprint = consumedCertificateFingerprints.get(target.certId);
          const result = await deployCertificate({
            ...target,
            lastFingerprint: consumedFingerprint,
          }, false);
          if (!result.success || !result.fingerprint) {
            const generation = result.version
              ?? ((consumedCertificateVersions.get(target.certId) ?? 0) + 1);
            const event: CertificateEvent = {
              event: 'certificate.rotated',
              certificateId: target.certId,
              fingerprint: result.fingerprint ?? consumedFingerprint ?? '',
              version: generation,
              timestamp: new Date().toISOString(),
            };
            certificateRetryQueue.enqueue(target.certId, generation, { event, target });
            log.error(
              { name: target.name, generation, error: result.message },
              'Certificate poll deployment failed; mutation remains pending'
            );
            return;
          }

          const generation = result.version ?? 0;
          const event: CertificateEvent = {
            event: 'certificate.rotated',
            certificateId: target.certId,
            fingerprint: result.fingerprint,
            version: generation,
            timestamp: new Date().toISOString(),
          };
          const reconciliation = await reconcilePolledMutation({
            queue: certificateRetryQueue,
            key: target.certId,
            generation,
            value: { event, target },
            evidence: { fingerprint: result.fingerprint, version: generation },
            consumedMarker: consumedFingerprint,
            observedMarker: result.fingerprint,
          });
          if (reconciliation === 'resolved') {
            log.info({ name: target.name, message: result.message }, 'Certificate updated and consumer restarted during poll');
          } else if (reconciliation === 'pending') {
            log.error({ name: target.name, generation }, 'Certificate poll mutation remains pending consumer restart');
          } else if (result.version !== undefined) {
            consumedCertificateVersions.set(target.certId, result.version);
          }
        });
      } catch (err) {
        log.error({ name: target.name, err }, 'Error polling certificate');
      }
    }

    // Poll secrets
    for (const target of secretTargets) {
      if (isShutdownRequested()) break;

      try {
        if (secretRetryQueue.isPending(target.secretId)) {
          await secretRetryQueue.retryNow(target.secretId);
          continue;
        }
        await withActiveDeployment(async () => {
          const consumedVersion = consumedSecretVersions.get(target.secretId);
          const result = await deploySecret({
            ...target,
            lastVersion: consumedVersion,
          }, false);
          if (!result.success || result.version === undefined) {
            const generation = result.version ?? ((consumedVersion ?? 0) + 1);
            const event: SecretEvent = {
              event: 'secret.updated',
              secretId: target.secretId,
              alias: target.secretId,
              version: generation,
              timestamp: new Date().toISOString(),
              tenantId: config.tenantId ?? '',
            };
            secretRetryQueue.enqueue(target.secretId, generation, {
              event,
              target,
              restartReason: 'secret file updated during poll',
            });
            log.error(
              { name: target.name, generation, error: result.message },
              'Secret poll deployment failed; mutation remains pending'
            );
            return;
          }

          const event: SecretEvent = {
            event: 'secret.updated',
            secretId: target.secretId,
            alias: target.secretId,
            version: result.version,
            timestamp: new Date().toISOString(),
            tenantId: config.tenantId ?? '',
          };
          const item: SecretRetryItem = {
            event,
            target,
            restartReason: 'secret file updated during poll',
          };
          const reconciliation = await reconcilePolledMutation({
            queue: secretRetryQueue,
            key: target.secretId,
            generation: result.version,
            value: item,
            evidence: { version: result.version },
            consumedMarker: consumedVersion,
            observedMarker: result.version,
          });
          if (reconciliation === 'resolved') {
            log.info({ name: target.name, message: result.message }, 'Secret updated and consumer restarted during poll');
          } else if (reconciliation === 'pending') {
            log.error({ name: target.name, version: result.version }, 'Secret poll mutation remains pending consumer restart');
          }
        });
      } catch (err) {
        log.error({ name: target.name, err }, 'Error polling secret');
      }
    }

    if (!isShutdownRequested() && execSecretIds.length > 0) {
      await withActiveDeployment(async () => pollExecOnlySecretVersions({
        references: execSecretIds,
        fileTargetReferences: secretTargets.map(target => target.secretId),
        identityByReference: execSecretIdentityByReference,
        consumedVersions: consumedExecSecretVersions,
        fetchMetadata: getSecretMetadata,
        onMutation: async ({ reference, identity, metadata }) => {
          const key = `exec:${identity}`;
          const event: SecretEvent = {
            event: 'secret.updated',
            secretId: metadata.id,
            alias: metadata.alias,
            version: metadata.version,
            timestamp: new Date().toISOString(),
            tenantId: config.tenantId ?? '',
          };
          const item: SecretRetryItem = {
            event,
            restartReason: 'exec secret updated during poll',
            execIdentity: identity,
            execPollReference: reference,
          };
          secretRetryQueue.enqueuePrepared(key, metadata.version, item, {
            version: metadata.version,
          });
          const resolved = await secretRetryQueue.retryNow(key);
          if (!resolved) {
            log.error(
              { secretId: reference, version: metadata.version },
              'Exec-only secret poll mutation remains pending consumer restart'
            );
          }
        },
        onFetchFailure: (reference, identity, err) => {
          execMetadataUnknown.add(identity);
          publishPendingSecretHealth();
          log.error(
            { err, secretId: reference },
            'Exec-only secret metadata poll failed; observation state is unknown'
          );
        },
        onFetchSuccess: (reference, identity, metadata) => {
          let changed = false;
          for (const candidate of [
            reference,
            identity,
            metadata.id,
            metadata.alias,
          ]) {
            for (const variant of secretReferenceVariants(candidate)) {
              changed = execMetadataUnknown.delete(variant) || changed;
            }
          }
          if (changed) publishPendingSecretHealth();
        },
      }));
    }
  };

  // setInterval does not await its callback. Keep the entire poll rail
  // single-flight so two cycles cannot both deploy and enqueue the same lost
  // mutation before either one publishes pending state.
  const poll = createSingleFlightOperation(runPoll);

  const pollTimer = setInterval(() => {
    poll().catch((e: unknown) => { log.error({ err: e }, 'Poll error'); });
  }, pollInterval);

  // Periodic managed key file sync check (every 60 seconds)
  // This catches cases where the file is overwritten/corrupted mid-run
  let keySyncTimer: NodeJS.Timeout | null = null;
  if (config.managedKey?.filePath) {
    const KEY_SYNC_INTERVAL = 60_000; // 60 seconds
    const managedKeyFilePath = config.managedKey.filePath;

    keySyncTimer = setInterval(() => {
      if (isShutdownRequested()) return;

      void (async () => {
        const syncResult = await syncManagedKeyFile();
        if (syncResult.wasOutOfSync) {
          if (syncResult.keptExistingFile) {
            log.error({
              filePath: managedKeyFilePath,
            }, 'Periodic check: config key is STALE (failed vault auth) - kept existing key file');
          } else if (syncResult.synced) {
            log.warn({
              filePath: managedKeyFilePath,
            }, 'Periodic check: Managed key file was out of sync - auto-fixed');
          } else {
            log.error({
              filePath: managedKeyFilePath,
              error: syncResult.error,
            }, 'Periodic check: CRITICAL - Managed key file sync failed');
          }
        }
        // Don't log on success - too noisy
      })().catch((err: unknown) => {
        log.error({ err, filePath: managedKeyFilePath }, 'Periodic managed key sync check threw');
      });
    }, KEY_SYNC_INTERVAL);

    log.info({ intervalMs: KEY_SYNC_INTERVAL }, 'Periodic managed key file sync check enabled');
  }

  // Graceful shutdown handler
  let markShutdownStarted!: () => void;
  const shutdownStarted = new Promise<void>(resolve => {
    markShutdownStarted = resolve;
  });
  const shutdown = async (signal: string): Promise<void> => {
    if (getIsShuttingDown()) {
      log.warn('Shutdown already in progress');
      return;
    }

    setShuttingDown(true);
    markShutdownStarted();
    childManager?.beginShutdown();
    initialChildStartBarrier.fail(
      new Error(`Initial child start cancelled by ${signal}`)
    );
    log.info({ signal }, 'Shutting down');

    // Clean up signal handlers to prevent memory leak
    cleanupSignalHandlers();

    // Stop accepting new events
    clearInterval(pollTimer);
    if (keySyncTimer) clearInterval(keySyncTimer);
    trackedKeyPoller.stop();
    keyRotationPropagator.stop();
    certificateRetryQueue.stop();
    secretRetryQueue.stop();
    unifiedClient.disconnect();

    // Cancel every source of new mutation work before draining operations
    // that were already admitted.
    if (isManagedKeyMode()) {
      stopManagedKeyRenewal();
    } else {
      stopApiKeyRenewal();
    }

    // Leave one minute of the systemd 900s stop budget for final teardown.
    // Plugin dispatch and child restart remain available until the mutation
    // that admitted them has completed; only then may those consumers stop.
    const remainingDeployments = await drainActiveDeployments();
    if (remainingDeployments > 0) {
      log.warn(
        { active: remainingDeployments },
        'Forcing shutdown with active deployments'
      );
    }

    // Cleanup degraded mode handler
    cleanupDegradedModeHandler();

    // Cleanup dynamic secrets
    if (isDynamicSecretsEnabled()) {
      await cleanupDynamicSecrets();
      log.info('Dynamic secrets cleaned up');
    }

    // Stop plugins
    if (pluginLoader) {
      try {
        await pluginLoader.stopPlugins();
        clearPluginLoader();
        log.info('Plugins stopped');
      } catch (err) {
        log.warn({ err }, 'Error stopping plugins');
      }
    }

    // Stop the child only after mutation-triggered restarts have drained.
    if (childManager) {
      log.info('Stopping child process');
      try {
        await childManager.stop();
        log.info('Child process stopped');
      } catch (err) {
        log.error({ err }, 'Error stopping child process');
        throw err;
      }
    }

    // Stop TLS certificate manager
    stopTLSCertificateManager();

    // Stop health servers
    await stopHealthServer();
    await stopHTTPSHealthServer();

    // Flush logs
    await flushLogs();

    log.info('Shutdown complete');
    process.exit(0);
  };

  // Handle shutdown signals (using tracked handlers to prevent memory leak)
  setupSignalHandlers(shutdown);

  if (startupShutdownSignal) {
    await shutdown(startupShutdownSignal);
    return;
  }

  const deferredStartupSignal = deferredStartupShutdownSignal();
  if (deferredStartupSignal) {
    // SharedMutationLock owns delivery of a signal observed while its mutation
    // fence was active. Keep the stable runtime handler installed and wait for
    // that replay; starting shutdown directly here would remove the handler
    // before the already-scheduled signal arrives and restore OS default exit.
    log.info(
      { signal: deferredStartupSignal },
      'Waiting for deferred startup shutdown replay'
    );
    await shutdownStarted;
    return;
  }

  // A runtime signal can arrive after handler installation but immediately
  // before the pending-startup probes above. Do not publish a running state
  // while its asynchronous shutdown is already in progress.
  if (getIsShuttingDown()) {
    await shutdownStarted;
    return;
  }

  log.info({ pollInterval: config.pollInterval ?? 3600 }, 'Agent running. Press Ctrl+C to stop.');
}
