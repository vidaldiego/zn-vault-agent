// Path: zn-vault-agent/src/types/update.ts

/**
 * Update Types for npm-based Auto-Update
 */

export interface NpmVersionInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export type UpdateChannel = 'latest' | 'beta' | 'next';

export interface UpdateConfig {
  /** Enable auto-updates */
  enabled: boolean;
  /** How often to check for updates (ms) */
  checkIntervalMs: number;
  /** npm dist-tag to follow */
  channel: UpdateChannel;
  /** Maximum random delay before applying update for staged rollout (ms). 0 = no delay */
  stagedRolloutMaxDelayMs: number;
  /** Timeout for health check of new binary (ms) */
  healthCheckTimeoutMs: number;
  /** Enable rollback on health check failure */
  rollbackOnFailure: boolean;
}

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = {
  // Production-safe default: disabled. Auto-updating a long-running daemon
  // from npm is a supply-chain risk (no code signing on the upstream
  // package). Opt-in via config: set `update.enabled = true` in
  // /etc/zn-vault-agent/config.json or ZNVAULT_UPDATE_ENABLED=true after
  // an internal gating process is in place.
  enabled: false,
  checkIntervalMs: 5 * 60 * 1000, // 5 minutes
  channel: 'latest',
  stagedRolloutMaxDelayMs: 30 * 60 * 1000, // 30 minutes max delay for staged rollout
  healthCheckTimeoutMs: 30_000, // 30 seconds
  rollbackOnFailure: true,
};
