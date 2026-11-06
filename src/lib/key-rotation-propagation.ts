// Path: src/lib/key-rotation-propagation.ts
// Unified propagation of a rotated managed API key to ALL consumers

/**
 * Initial, real-event and explicit managed-key observations share one coordinator.
 * Reserve per-key request ordering before awaiting an authoritative bind. Inside
 * the serialized consumer chain, reject superseded responses before touching
 * live auth, persistent auth, plugin keys or exec environment files. Failed reads
 * do not advance accepted authority. Known-generation application retries keep
 * their original observation ID and cannot regain authority after a newer key.
 */

import type { AgentConfig } from './config.js';
import { updateManagedKey } from './config.js';
import { updateEnvFile, findEnvVarsForApiKey } from './secret-env.js';
import type { SecretMapping } from './secret-env.js';
import type {
  KeyRotatedEvent,
  PluginEventDispatchResult,
  PluginEventMap,
} from '../plugins/types.js';
import { createLogger } from './logger.js';
import { bindManagedApiKey, type ManagedApiKeyBindResponse } from './api.js';

/** Where a rotation was detected (mirrors the renewal service's RefreshSource). */
export type KeyRotationSource =
  | 'scheduled'
  | 'ws_event'
  | 'grace_poll'
  | 'reconnect'
  | 'heartbeat'
  | 'manual';

/** Minimal plugin-loader surface the propagator needs (injectable for tests). */
export interface KeyRotatedDispatcher {
  dispatchEvent<K extends keyof PluginEventMap>(
    eventType: K,
    event: PluginEventMap[K]
  ): Promise<PluginEventDispatchResult>;
}

/** Rotation metadata accompanying a propagation. */
export interface KeyRotationMeta {
  /** Managed key name the rotation applies to */
  keyName: string;
  /** Server-supplied compatibility field for the plugin event; never log it */
  newPrefix: string;
  /** Next scheduled rotation (ISO timestamp) */
  nextRotationAt?: string;
  /** When the old key's grace period expires (ISO timestamp) */
  graceExpiresAt?: string;
  /** Rotation mode of the key */
  rotationMode?: 'scheduled' | 'on-use' | 'on-bind';
  /** Detection channel */
  source: KeyRotationSource;
}

/** How long to wait before retrying a partially-failed propagation. */
export const PROPAGATION_RETRY_DELAY_MS = 30 * 1000;
/** Maximum retry attempts for a partially-failed propagation. */
export const MAX_PROPAGATION_RETRIES = 5;

export interface KeyRotationPropagatorDeps {
  /** Authoritative read boundary; request ordering is reserved before awaiting it. */
  bindManagedKey?: (name: string) => Promise<ManagedApiKeyBindResponse>;
  /**
   * The LIVE config object created at daemon startup — the same object plugins
   * read through ctx.config. Mutating it (not a loadConfig() copy) is what
   * makes plugins see the new key (see the v1.20.14 fix).
   */
  config: AgentConfig;
  /** Plugin loader accessor (loader is created after the propagator). */
  getPluginLoader: () => KeyRotatedDispatcher | null;
  /** Exec env-file mode: output file path (daemon combined mode / exec watch). */
  execOutputFile?: string;
  /** Exec secret mappings (to find env vars bound to the rotated key). */
  execSecretMappings?: (SecretMapping & { literal?: string })[];
  /** Called after an env var is written (e.g. to update exec's in-memory cache). */
  onEnvVarUpdated?: (envVar: string, value: string) => void;
  /** Restart the child process after propagation (combined mode, restartOnChange). */
  restartChild?: (reason: string) => Promise<void>;
  /** Stage pre-start changes without awaiting a child which has not been admitted. */
  prepareChildRestart?: (reason: string) => Promise<{ consumerReady?: Promise<void> } | void>;
  /** Shutdown probe — suppresses propagation and retries during shutdown. */
  isShuttingDown?: () => boolean;
  /** Persist hook — defaults to updateManagedKey (injectable for tests). */
  persistManagedKey?: (
    newKey: string,
    metadata: { nextRotationAt?: string; graceExpiresAt?: string; rotationMode?: 'scheduled' | 'on-use' | 'on-bind' }
  ) => void;
  /** Env-file writer — defaults to updateEnvFile (injectable for tests). */
  updateEnvFileFn?: typeof updateEnvFile;
  /** Retry delay override (injectable for tests). */
  retryDelayMs?: number;
  /** Logger — defaults to a module logger (injectable for tests). */
  logger?: ReturnType<typeof createLogger>;
}

export interface PropagationResult {
  /** True when a propagation ran (even partially); false when skipped. */
  propagated: boolean;
  /** Set when skipped. */
  skipped?: 'duplicate' | 'stale' | 'shutting_down';
  /** Number of plugin keyRotated handlers whose execution was attempted. */
  pluginsNotified: number;
  /** Env vars rewritten in the exec output file. */
  envVarsUpdated: string[];
  /** Non-fatal errors encountered (plugin dispatch, env file, child restart). */
  errors: string[];
}

export interface KeyRotationPropagator {
  bindAndPropagate(
    keyName: string,
    source: KeyRotationSource,
    options?: { persist?: boolean; isCancelled?: () => boolean; onStaged?: () => void }
  ): Promise<KeyBindingObservation>;
  /**
   * Propagate a rotated key value to all consumers.
   *
   * Serialized per key name; safe to call concurrently from both detection
   * channels. Never rejects — failures are contained per consumer and
   * reported in the result.
   *
   * @param newKey - The new plaintext key value (already fetched via bind)
   * @param meta - Rotation metadata incl. detection source
   * @param opts.persist - Also persist to config file/env (the WebSocket path
   *   persists here; the renewal-service path has already persisted before
   *   invoking the propagator and passes nothing)
   * @param opts.detectedAt - Legacy ordering for an already-bound value. New
   *   reads must use bindAndPropagate so arrival time cannot grant authority.
   */
  propagate(
    newKey: string,
    meta: KeyRotationMeta,
    opts?: { persist?: boolean; detectedAt?: number }
  ): Promise<PropagationResult>;
  /** Cancel pending retry timers (call on shutdown). */
  stop(): void;
}

export interface KeyBindingObservation {
  /** Superseded/cancelled responses never leave the coordinator with authority. */
  response: ManagedApiKeyBindResponse | null;
  propagation: PropagationResult;
}

export interface KeyPreparation<Result> {
  prepared: Promise<void>;
  completed: Promise<Result>;
}

export function prepareKeyObservation<Result>(
  operation: (onStaged: () => void) => Promise<Result>
): KeyPreparation<Result> {
  let resolvePrepared!: () => void;
  let rejectPrepared!: (error: unknown) => void;
  const prepared = new Promise<void>((resolve, reject) => { resolvePrepared = resolve; rejectPrepared = reject; });
  const completed = operation(resolvePrepared).then(result => { resolvePrepared(); return result; }, (error: unknown) => { rejectPrepared(error); throw error; });
  // Startup explicitly owns and joins completed later; an earlier failure must
  // remain handled while its caller is still waiting for preparation.
  void prepared.catch(() => undefined);
  void completed.catch(() => undefined);
  return { prepared, completed };
}

interface StagedPropagationResult extends PropagationResult {
  /** Present only when this preparation is covered by a not-yet-admitted child. */
  consumerReady?: Promise<void>;
}

interface OrderedPropagationOptions {
  persist?: boolean;
  detectedAt: number;
  observationId: number;
  isCancelled?: () => boolean;
  useTimestampFence?: boolean;
  onStaged?: () => void;
}

interface KeyPropagationState {
  /** Last FULLY-successfully propagated value for this key. */
  lastPropagatedValue: string | null;
  /** detectedAt of the newest propagation attempt (success or failure). */
  lastDetectedAt: number;
  /** Latest read/event admitted, assigned before its asynchronous boundary. */
  observationId: number;
  /** Latest authoritative response admitted before consumer mutation. */
  acceptedObservationId: number;
  /** Serialization chain — propagations for the same key run one at a time. */
  chain: Promise<unknown>;
  /** Pending retry timer for a partially-failed propagation. */
  retryTimer: NodeJS.Timeout | null;
  /** Retry attempts consumed for the currently-failing value. */
  retryAttempts: number;
}

/**
 * Create the propagator bound to a daemon's live state.
 * The agent's own key is seeded as already-propagated with its boot value:
 * plugins write their files themselves during onInit/onStart, so the boot
 * value needs no propagation.
 */
export function createKeyRotationPropagator(deps: KeyRotationPropagatorDeps): KeyRotationPropagator {
  const log = deps.logger ?? createLogger({ module: 'key-rotation' });
  const persist = deps.persistManagedKey ?? updateManagedKey;
  const writeEnvVar = deps.updateEnvFileFn ?? updateEnvFile;
  const retryDelayMs = deps.retryDelayMs ?? PROPAGATION_RETRY_DELAY_MS;

  const states = new Map<string, KeyPropagationState>();
  let stopped = false;

  function getState(keyName: string): KeyPropagationState {
    let state = states.get(keyName);
    if (!state) {
      state = {
        // Seed the agent's own key with the boot-time value: propagating the
        // value the agent (and its plugins) already started with is a no-op.
        lastPropagatedValue:
          deps.config.managedKey?.name === keyName ? (deps.config.auth.apiKey ?? null) : null,
        lastDetectedAt: 0,
        observationId: 0,
        acceptedObservationId: 0,
        chain: Promise.resolve(),
        retryTimer: null,
        retryAttempts: 0,
      };
      states.set(keyName, state);
    }
    return state;
  }

  function clearRetry(state: KeyPropagationState): void {
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
  }

  function scheduleRetry(
    state: KeyPropagationState,
    newKey: string,
    meta: KeyRotationMeta,
    opts: OrderedPropagationOptions
  ): void {
    if (stopped || deps.isShuttingDown?.()) return;
    if (state.retryAttempts >= MAX_PROPAGATION_RETRIES) {
      log.error({
        keyName: meta.keyName,
        attempts: state.retryAttempts,
      }, 'Key rotation propagation retries exhausted - consumers may hold a stale key until the next rotation or agent restart');
      return;
    }
    clearRetry(state);
    state.retryAttempts++;
    const attempt = state.retryAttempts;
    // The rails cannot re-detect this rotation (the renewal service's
    // currentKey has already advanced), so the propagator must retry itself.
    // Retries reuse the original detectedAt: if a newer detection lands in
    // the meantime, the monotonicity guard discards the retry.
    const timer = setTimeout(() => {
      state.retryTimer = null;
      log.info({ keyName: meta.keyName, attempt }, 'Retrying key rotation propagation');
      void enqueuePropagation(state, newKey, meta, opts);
    }, retryDelayMs);
    timer.unref?.();
    state.retryTimer = timer;
    log.warn({
      keyName: meta.keyName,
      attempt,
      retryInMs: retryDelayMs,
    }, 'Key rotation propagation partially failed - retry scheduled');
  }

  async function runPropagation(
    state: KeyPropagationState,
    newKey: string,
    meta: KeyRotationMeta,
    opts: OrderedPropagationOptions
  ): Promise<StagedPropagationResult> {
    const detectedAt = opts.detectedAt;

    if (stopped || deps.isShuttingDown?.() || opts.isCancelled?.()) {
      return { propagated: false, skipped: 'shutting_down', pluginsNotified: 0, envVarsUpdated: [], errors: [] };
    }

    // Monotonicity: an older detection must never overwrite a newer one.
    if (opts.observationId < state.acceptedObservationId || (opts.useTimestampFence === true && detectedAt < state.lastDetectedAt)) {
      log.warn({
        keyName: meta.keyName,
        source: meta.source,
        detectedAt,
        newerDetectionAt: state.lastDetectedAt,
      }, 'Discarding stale key rotation propagation (a newer detection already ran)');
      return { propagated: false, skipped: 'stale', pluginsNotified: 0, envVarsUpdated: [], errors: [] };
    }

    // This synchronous admission is the CAS boundary. A failed/cancelled read
    // never advances it, and an accepted newer response fences older reads and
    // their retained retries before live auth, persistence or consumer writes.
    state.acceptedObservationId = opts.observationId;

    if (newKey === state.lastPropagatedValue && !opts.persist) {
      state.lastDetectedAt = detectedAt;
      log.debug({
        keyName: meta.keyName,
        source: meta.source,
      }, 'Key already propagated - skipping duplicate rotation propagation');
      return { propagated: false, skipped: 'duplicate', pluginsNotified: 0, envVarsUpdated: [], errors: [] };
    }

    // Keep the legacy plugin-event field without ever deriving it from the
    // credential locally. The server supplies it on every supported path.
    const newPrefix = meta.newPrefix || '[REDACTED]';
    const errors: string[] = [];
    state.lastDetectedAt = detectedAt;

    // 1. Mutate the LIVE config object so plugins reading ctx.config see the
    //    new key immediately — but ONLY for the agent's own managed key.
    //    Rotation events for other tracked keys (exec/plugin keys that are not
    //    the agent's auth key) must never clobber the agent's credentials.
    //    (The pre-propagator WebSocket handler mutated config.auth.apiKey
    //    unconditionally — a latent bug in multi-key setups.)
    const isOwnKey = deps.config.managedKey?.name === meta.keyName;
    if (isOwnKey) {
      deps.config.auth.apiKey = newKey;
      if (deps.config.managedKey) {
        deps.config.managedKey.nextRotationAt = meta.nextRotationAt;
        deps.config.managedKey.graceExpiresAt = meta.graceExpiresAt;
        deps.config.managedKey.rotationMode = meta.rotationMode;
        deps.config.managedKey.lastBind = new Date().toISOString();
      }

      // 2. Persist to disk + process env (WebSocket path only — the renewal
      //    service persists before invoking the propagator).
      if (opts?.persist) {
        persist(newKey, {
          nextRotationAt: meta.nextRotationAt,
          graceExpiresAt: meta.graceExpiresAt,
          rotationMode: meta.rotationMode,
        });
      }
    }

    if (newKey === state.lastPropagatedValue) {
      // A fresh accepted bind may update rotation metadata/file receipts even
      // when its credential is unchanged. Consumer delivery stays deduplicated.
      return { propagated: false, skipped: 'duplicate', pluginsNotified: 0, envVarsUpdated: [], errors: [] };
    }

    // 3. Dispatch keyRotated to plugins (e.g. payara rewrites its API key file).
    let pluginsNotified = 0;
    const pluginLoader = deps.getPluginLoader();
    if (pluginLoader) {
      const keyEvent: KeyRotatedEvent = {
        keyName: meta.keyName,
        newPrefix,
        graceExpiresAt: meta.graceExpiresAt,
        nextRotationAt: meta.nextRotationAt,
        rotationMode: meta.rotationMode ?? 'scheduled',
      };
      try {
        const dispatchResult = await pluginLoader.dispatchEvent('keyRotated', keyEvent);
        pluginsNotified = dispatchResult.handlersInvoked;
        if (dispatchResult.handlersFailed > 0) {
          errors.push(`plugin dispatch failed for ${dispatchResult.handlersFailed} handler(s)`);
        }
        if (dispatchResult.handlersSkipped > 0) {
          errors.push(`plugin dispatch skipped ${dispatchResult.handlersSkipped} handler(s)`);
        }
        log.debug({
          keyName: meta.keyName,
          ...dispatchResult,
        }, 'Plugin keyRotated event dispatch completed');
      } catch (pluginErr) {
        const message = pluginErr instanceof Error ? pluginErr.message : String(pluginErr);
        errors.push(`plugin dispatch failed: ${message}`);
        log.error({
          err: pluginErr,
          keyName: meta.keyName,
        }, 'Plugin failed to handle keyRotated event');
        // Continue — plugin failure must not block key propagation.
      }
    }

    // 4. Update exec env file entries bound to this key.
    const envVarsUpdated: string[] = [];
    if (deps.execOutputFile && deps.execSecretMappings && deps.execSecretMappings.length > 0) {
      const envVars = findEnvVarsForApiKey(deps.execSecretMappings, meta.keyName);
      for (const envVar of envVars) {
        try {
          writeEnvVar(deps.execOutputFile, envVar, newKey);
          deps.onEnvVarUpdated?.(envVar, newKey);
          envVarsUpdated.push(envVar);
          log.info({
            keyName: meta.keyName,
            envVar,
            filePath: deps.execOutputFile,
          }, 'Updated env file with rotated API key');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`env file update failed for ${envVar}: ${message}`);
          log.error({
            err,
            keyName: meta.keyName,
            envVar,
            filePath: deps.execOutputFile,
          }, 'Failed to update env file with rotated API key');
        }
      }
    }

    let consumerReady: Promise<void> | undefined;
    try {
      const reason = `managed API key '${meta.keyName}' rotated`;
      if (deps.prepareChildRestart) {
        consumerReady = (await deps.prepareChildRestart(reason))?.consumerReady;
        if (consumerReady) void consumerReady.catch(() => undefined);
      } else if (deps.restartChild) {
        await deps.restartChild(reason);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`child restart failed: ${message}`);
      log.error({ err, keyName: meta.keyName }, 'Failed to restart child process after key rotation');
    }
    return { propagated: true, pluginsNotified, envVarsUpdated, errors, ...(consumerReady ? { consumerReady } : {}) };
  }

  function finishPropagation(
    state: KeyPropagationState,
    newKey: string,
    meta: KeyRotationMeta,
    opts: OrderedPropagationOptions,
    result: PropagationResult
  ): PropagationResult {
    if (!result.propagated) return result;
    if (stopped || deps.isShuttingDown?.() || opts.isCancelled?.()) {
      return { ...result, propagated: false, skipped: 'shutting_down' };
    }
    if (opts.observationId < state.acceptedObservationId) {
      return { ...result, propagated: false, skipped: 'stale' };
    }
    if (result.errors.length === 0) {
      state.lastPropagatedValue = newKey;
      state.retryAttempts = 0;
      clearRetry(state);
    } else {
      scheduleRetry(state, newKey, meta, opts);
    }
    log.info({ keyName: meta.keyName, source: meta.source,
      pluginsNotified: result.pluginsNotified, envVarsUpdated: result.envVarsUpdated,
      errors: result.errors.length > 0 ? result.errors : undefined,
    }, result.errors.length === 0
      ? 'Managed key rotation propagated to consumers'
      : 'Managed key rotation propagated with errors - retry scheduled');
    return result;
  }

  async function propagate(
    newKey: string,
    meta: KeyRotationMeta,
    opts?: { persist?: boolean; detectedAt?: number }
  ): Promise<PropagationResult> {
    // Capture the detection time BEFORE queueing so time spent waiting in the
    // serialization chain does not make an older detection look newer.
    const detectedAt = opts?.detectedAt ?? Date.now();
    const state = getState(meta.keyName);
    if (detectedAt < state.lastDetectedAt) {
      return { propagated: false, skipped: 'stale', pluginsNotified: 0, envVarsUpdated: [], errors: [] };
    }
    return enqueuePropagation(state, newKey, meta, { ...opts, detectedAt, observationId: ++state.observationId, useTimestampFence: true });
  }

  function enqueuePropagation(
    state: KeyPropagationState,
    newKey: string,
    meta: KeyRotationMeta,
    opts: OrderedPropagationOptions
  ): Promise<PropagationResult> {

    const prepared = state.chain.then(async () => {
      const result = await runPropagation(state, newKey, meta, opts);
      if (!result.consumerReady) return finishPropagation(state, newKey, meta, opts, result);
      return result;
    });
    // Initial-child acknowledgement must not hold the preparation chain: a
    // genuine early event may precede an initializer for the very same key.
    state.chain = prepared.catch(() => undefined);
    return prepared.then(async staged => {
      const { consumerReady, ...result } = staged as StagedPropagationResult;
      opts.onStaged?.();
      if (!result.propagated || !consumerReady) return result;
      try { await consumerReady; }
      catch (error) {
        result.errors.push(`initial child acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const completed = state.chain.then(() => finishPropagation(state, newKey, meta, opts, result));
      state.chain = completed.catch(() => undefined);
      return completed;
    });
  }

  async function bindAndPropagate(
    keyName: string,
    source: KeyRotationSource,
    options?: { persist?: boolean; isCancelled?: () => boolean; onStaged?: () => void }
  ): Promise<KeyBindingObservation> {
    const state = getState(keyName);
    const observationId = ++state.observationId;
    const detectedAt = Date.now();
    if (stopped || deps.isShuttingDown?.() || options?.isCancelled?.()) {
      return { response: null, propagation: { propagated: false, skipped: 'shutting_down', pluginsNotified: 0, envVarsUpdated: [], errors: [] } };
    }
    const response = await (deps.bindManagedKey ?? bindManagedApiKey)(keyName);
    const propagation = await enqueuePropagation(state, response.key, {
      keyName, source, newPrefix: response.prefix,
      nextRotationAt: response.nextRotationAt, graceExpiresAt: response.graceExpiresAt,
      rotationMode: response.rotationMode,
    }, { ...options, detectedAt, observationId });
    return {
      response: propagation.skipped === 'stale' || propagation.skipped === 'shutting_down' ? null : response,
      propagation,
    };
  }

  function stop(): void {
    stopped = true;
    for (const state of states.values()) {
      clearRetry(state);
    }
  }

  return { propagate, bindAndPropagate, stop };
}
