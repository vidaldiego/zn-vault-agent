import { bindManagedApiKey, bindHostManagedKey, type ManagedApiKeyBindResponse } from '../../lib/api.js';
import { loadConfig, updateManagedKey, isManagedKeyMode } from '../../lib/config.js';
import { createLogger } from '../../lib/logger.js';
import type { ManagedKeyStatus, KeyChangeMeta, RefreshSource } from './types.js';
import type { ManagedKeyMaterial } from '../../types/managed-key-targets.js';

const log = createLogger({ module: 'managed-key-renewal' });
let running = false;
let currentKey: string | null = null;
let stale = false;
let callback: ((key: string, meta: KeyChangeMeta) => void) | null = null;
let lastWsEventAt: string | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

export function onKeyChanged(handler: (key: string, meta: KeyChangeMeta) => void): void { callback = handler; }

/** Accept only a current, identity-fenced revision. graceExpiresAt belongs to its predecessor. */
export function acceptHostManagedKey(material: ManagedKeyMaterial, source: RefreshSource = 'ws_event'): ManagedApiKeyBindResponse {
  const config = loadConfig();
  if (!config.managedKey || material.tenantId !== config.tenantId || (config.managedKey.keyId && material.keyId !== config.managedKey.keyId) || !Number.isSafeInteger(material.rotationCount) || material.rotationCount < (config.managedKey.rotationCount ?? 0) || !material.key || !Number.isFinite(Date.parse(material.authorizedUntil ?? material.expiresAt)) || Date.parse(material.authorizedUntil ?? material.expiresAt) <= Date.now()) throw new Error('REENROLLMENT_REQUIRED');
  const response: ManagedApiKeyBindResponse = { id: material.keyId, name: material.name, key: material.key, prefix: '[REDACTED]', rotationCount: material.rotationCount, expiresAt: material.expiresAt, authorizedUntil: material.authorizedUntil, gracePeriod: '', graceExpiresAt: material.graceExpiresAt, nextRotationAt: material.nextRotationAt, rotationMode: 'scheduled', permissions: [] };
  apply(response, source); return response;
}
function apply(response: ManagedApiKeyBindResponse, source: RefreshSource): void {
  const config = loadConfig(); const old = currentKey;
  if (!Number.isFinite(Date.parse(response.expiresAt)) || Date.parse(response.expiresAt) <= Date.now()) throw new Error('REENROLLMENT_REQUIRED');
  currentKey = response.key; stale = false;
  if (config.managedKey) { config.managedKey.keyId = response.id; config.managedKey.rotationCount = response.rotationCount; config.managedKey.expiresAt = response.expiresAt; }
  updateManagedKey(response.key, { nextRotationAt: response.nextRotationAt, graceExpiresAt: response.graceExpiresAt, rotationMode: response.rotationMode });
  if (expiryTimer) clearTimeout(expiryTimer);
  const deadline = Math.min(Date.parse(response.expiresAt), Date.parse(response.authorizedUntil ?? response.expiresAt));
  const expire = (): void => {
    if (Date.now() < deadline) { expiryTimer = setTimeout(expire, Math.min(deadline - Date.now(), 2147483647)); expiryTimer.unref?.(); return; }
    stale = true; log.error({}, 'REENROLLMENT_REQUIRED: own identity authorization expired');
  };
  expiryTimer = setTimeout(expire, Math.max(0, Math.min(deadline - Date.now(), 2147483647))); expiryTimer.unref?.();
  if (old && old !== response.key) callback?.(response.key, { keyName: response.name, newPrefix: response.prefix, nextRotationAt: response.nextRotationAt, graceExpiresAt: response.graceExpiresAt, rotationMode: response.rotationMode, source });
}
async function refresh(source: RefreshSource): Promise<ManagedApiKeyBindResponse | null> {
  if (!isManagedKeyMode()) return null;
  const config = loadConfig();
  if (!config.auth.apiKey || !config.managedKey?.name) return null;
  try {
    if (config.hostConfigId) {
      if (!config.agentId) throw new Error('REENROLLMENT_REQUIRED');
      return acceptHostManagedKey(await bindHostManagedKey(config.hostConfigId, config.agentId), source);
    }
    const response = await bindManagedApiKey(config.managedKey.name); apply(response, source); return response;
  } catch { stale = true; log.error({ source }, 'Managed key unavailable; explicit retry or reenrollment required'); return null; }
}
export async function startManagedKeyRenewal(): Promise<ManagedApiKeyBindResponse | null> {
  if (running || !isManagedKeyMode()) return null;
  running = true; const config = loadConfig(); currentKey = config.auth.apiKey ?? null;
  // Enrolled agents authenticate their channel first; only changed revisions bind.
  if (config.hostConfigId) return null;
  return await refresh('manual');
}
export function stopManagedKeyRenewal(): void {
  if (expiryTimer) clearTimeout(expiryTimer); expiryTimer = undefined;
  running = false; currentKey = null; stale = false; callback = null; lastWsEventAt = null;
}
export async function forceRefresh(): Promise<ManagedApiKeyBindResponse | null> { return await refresh('manual'); }
/** Reconnect is reconciled by per-identity revisions, never an unconditional bind. */
export function onWebSocketReconnect(): Promise<void> { return Promise.resolve(); }
/** Invalid authority never authorizes recovery or another credential lookup. */
export function onWebSocketAuthFailure(): Promise<boolean> { stale = true; log.error({}, 'REENROLLMENT_REQUIRED: own identity rejected'); return Promise.resolve(false); }
export async function onWebSocketRotationEvent(keyName: string): Promise<void> {
  if (!running || keyName !== loadConfig().managedKey?.name) return;
  lastWsEventAt = new Date().toISOString(); await refresh('ws_event');
}
export function getManagedKeyStatus(): ManagedKeyStatus {
  const config = loadConfig();
  return { isRunning: running, isManagedMode: isManagedKeyMode(), staleKeyDetected: stale, managedKeyName: config.managedKey?.name,
    nextRotationAt: config.managedKey?.nextRotationAt, graceExpiresAt: config.managedKey?.graceExpiresAt,
    safetyRails: { lastWsEventAt, lastPollAt: null, wsEventReceived: lastWsEventAt !== null, missedRotations: 0, graceRemainingMs: null } };
}
