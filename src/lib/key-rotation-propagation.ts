// Path: src/lib/key-rotation-propagation.ts
// Unified propagation of a rotated managed API key to ALL consumers

/**
 * Single propagation path for a rotated managed API key.
 *
 * Background (2026-07-05 production incident): the agent had TWO ways to learn
 * about a managed-key rotation — the live WebSocket `apikey.rotated` event and
 * the renewal service's polling safety rails (scheduled refresh, grace poll,
 * heartbeat, reconnect). Only the WebSocket path propagated the new key to
 * consumers (plugin `keyRotated` dispatch, exec env-file update, live config
 * mutation). Rail-detected rotations updated the agent's own credentials and
 * reconnected the WebSocket — nothing else. When the WebSocket event was lost,
 * plugin-deployed key files (e.g. the payara plugin's
 * /var/lib/zn-vault-agent/secrets/ZINC_CONFIG_VAULT_API_KEY) stayed stale
 * until the agent was restarted, while sync logs reported success.
 *
 * This module is the one path both detection channels go through, so any
 * detection — push or poll — refreshes every consumer within one cycle.
 *
 * Concurrency model: both channels routinely fire for the same rotation (the
 * dispatcher notifies the renewal service AND runs the WebSocket handler), so
 * propagations are SERIALIZED per key name and deduplicated inside the
 * critical section:
 * - per-key value dedup: the last FULLY-successful propagated value is
 *   remembered; repeats are skipped. A partially-failed propagation (e.g. a
 *   plugin threw) is not recorded and is retried by an internal bounded
 *   retry timer — the polling rails cannot re-detect the same rotation
 *   (the renewal service's currentKey has already advanced).
 * - monotonicity: each propagation carries the time its bind RESOLVED
 *   (detectedAt); an older detection can never overwrite the result of a
 *   newer one (a slow, stale bind response must not revert consumers to a
 *   soon-revoked key).
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
  /** New key prefix (for logging/plugin event); derived from the key if absent */
  newPrefix?: string;
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
   * @param opts.detectedAt - When the bind carrying this value resolved
   *   (defaults to now); used for the monotonicity guard
   */
  propagate(
    newKey: string,
    meta: KeyRotationMeta,
    opts?: { persist?: boolean; detectedAt?: number }
  ): Promise<PropagationResult>;
  /** Cancel pending retry timers (call on shutdown). */
  stop(): void;
}

interface KeyPropagationState {
  /** Last FULLY-successfully propagated value for this key. */
  lastPropagatedValue: string | null;
  /** detectedAt of the newest propagation attempt (success or failure). */
  lastDetectedAt: number;
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

  function getState(keyName: string): KeyPropagationState {
    let state = states.get(keyName);
    if (!state) {
      state = {
        // Seed the agent's own key with the boot-time value: propagating the
        // value the agent (and its plugins) already started with is a no-op.
        lastPropagatedValue:
          deps.config.managedKey?.name === keyName ? (deps.config.auth.apiKey ?? null) : null,
        lastDetectedAt: 0,
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
    opts: { persist?: boolean; detectedAt: number }
  ): void {
    if (deps.isShuttingDown?.()) return;
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
      void propagate(newKey, meta, opts);
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
    opts?: { persist?: boolean; detectedAt?: number }
  ): Promise<PropagationResult> {
    const detectedAt = opts?.detectedAt ?? Date.now();

    if (deps.isShuttingDown?.()) {
      return { propagated: false, skipped: 'shutting_down', pluginsNotified: 0, envVarsUpdated: [], errors: [] };
    }

    // Monotonicity: an older detection must never overwrite a newer one.
    if (detectedAt < state.lastDetectedAt) {
      log.warn({
        keyName: meta.keyName,
        source: meta.source,
        detectedAt,
        newerDetectionAt: state.lastDetectedAt,
      }, 'Discarding stale key rotation propagation (a newer detection already ran)');
      return { propagated: false, skipped: 'stale', pluginsNotified: 0, envVarsUpdated: [], errors: [] };
    }

    if (newKey === state.lastPropagatedValue) {
      state.lastDetectedAt = detectedAt;
      log.debug({
        keyName: meta.keyName,
        source: meta.source,
        keyPrefix: newKey.substring(0, 8),
      }, 'Key already propagated - skipping duplicate rotation propagation');
      return { propagated: false, skipped: 'duplicate', pluginsNotified: 0, envVarsUpdated: [], errors: [] };
    }

    const startTime = Date.now();
    const oldPrefix = deps.config.auth.apiKey?.substring(0, 8) ?? '(none)';
    const newPrefix = meta.newPrefix ?? newKey.substring(0, 8);
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

    // 5. Restart child process if configured (combined mode restartOnChange).
    if (deps.restartChild) {
      try {
        await deps.restartChild(`managed API key '${meta.keyName}' rotated`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`child restart failed: ${message}`);
        log.error({ err, keyName: meta.keyName }, 'Failed to restart child process after key rotation');
      }
    }

    // Record only fully-successful propagations; retry the rest ourselves —
    // no detection channel will re-fire for this rotation.
    if (errors.length === 0) {
      state.lastPropagatedValue = newKey;
      state.retryAttempts = 0;
      clearRetry(state);
    } else {
      scheduleRetry(state, newKey, meta, { persist: opts?.persist, detectedAt });
    }

    log.info({
      keyName: meta.keyName,
      source: meta.source,
      oldPrefix,
      newPrefix: newKey.substring(0, 8),
      pluginsNotified,
      envVarsUpdated,
      errors: errors.length > 0 ? errors : undefined,
      durationMs: Date.now() - startTime,
    }, errors.length === 0
      ? 'Managed key rotation propagated to consumers'
      : 'Managed key rotation propagated with errors - retry scheduled');

    return { propagated: true, pluginsNotified, envVarsUpdated, errors };
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

    // Serialize per key: both detection channels routinely fire for the same
    // rotation; without this, two concurrent propagations pass the dedup
    // check together and double-dispatch plugins / double-restart the child.
    const run = state.chain.then(() => runPropagation(state, newKey, meta, { ...opts, detectedAt }));
    // Keep the chain alive regardless of outcome (runPropagation contains its
    // own error handling and never rejects in practice; be defensive anyway).
    state.chain = run.catch(() => undefined);
    return run;
  }

  function stop(): void {
    for (const state of states.values()) {
      clearRetry(state);
    }
  }

  return { propagate, stop };
}
