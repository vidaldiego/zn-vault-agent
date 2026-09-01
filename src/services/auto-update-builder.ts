// Path: src/services/auto-update-builder.ts
// Pure wiring helper that decouples the manual update override from the
// automatic-update flag (FIX A, see docs/superpowers/specs/2026-06-17-agent-auto-update-fix-design.md).
//
// The NpmAutoUpdateService is ALWAYS constructed so that operator-initiated
// updates (the HTTP `POST /agent/update` trigger and the WebSocket
// `update-available` trigger) have a non-null service to call. Only the
// periodic checker (`.start()`) is gated on `enabled`, preserving the
// "automatic npm-polling stays off by default" supply-chain posture (M1.5 / CRIT-5).

import type { UpdateConfig } from '../types/update.js';
import { NpmAutoUpdateService } from './npm-auto-update.js';

/**
 * Result of building the auto-update service.
 */
export interface AutoUpdateServiceBuildResult {
  /** The constructed service. Always non-null. */
  service: NpmAutoUpdateService;
  /** Whether the periodic checker was started (`enabled` was true). */
  started: boolean;
}

/**
 * Construct the npm auto-update service and conditionally start its periodic checker.
 *
 * The service is always constructed so the manual override path works even when
 * automatic updates are disabled. The periodic background checker is only started
 * when `enabled` is true.
 *
 * @param updateConfig Update configuration (typically from `loadUpdateConfig()`).
 * @param enabled Whether the automatic periodic checker should run.
 * @returns The constructed service and whether the periodic checker was started.
 */
export function buildAutoUpdateService(
  updateConfig: Partial<UpdateConfig>,
  enabled: boolean,
  recoveryOnly = false,
): AutoUpdateServiceBuildResult {
  const service = new NpmAutoUpdateService(updateConfig);
  // Legacy Payara recovery must expose only health and the exact Payara
  // updater. Fence the Agent updater before its first timer is created so an
  // already-detected recovery process can never race an npm mutation.
  if (enabled && !recoveryOnly) {
    service.start();
    return { service, started: true };
  }
  return { service, started: false };
}
