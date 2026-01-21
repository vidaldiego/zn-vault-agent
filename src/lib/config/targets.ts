// Path: src/lib/config/targets.ts
// Certificate and secret target management

import type { CertTarget, SecretTarget } from './types.js';
import { loadConfig } from './loader.js';
import { saveConfig } from './saver.js';

// ============================================================================
// Certificate Targets
// ============================================================================

/**
 * Add a certificate target
 */
export function addTarget(target: CertTarget): void {
  const config = loadConfig();

  // Check if target with same certId exists
  const existingIndex = config.targets.findIndex(t => t.certId === target.certId);
  if (existingIndex >= 0) {
    config.targets[existingIndex] = target;
  } else {
    config.targets.push(target);
  }

  saveConfig(config);
}

/**
 * Remove a certificate target
 */
export function removeTarget(certIdOrName: string): boolean {
  const config = loadConfig();
  const initialLength = config.targets.length;

  config.targets = config.targets.filter(
    t => t.certId !== certIdOrName && t.name !== certIdOrName
  );

  if (config.targets.length < initialLength) {
    saveConfig(config);
    return true;
  }
  return false;
}

/**
 * Get all targets
 */
export function getTargets(): CertTarget[] {
  return loadConfig().targets;
}

/**
 * Update target fingerprint after successful sync
 */
export function updateTargetFingerprint(certId: string, fingerprint: string): void {
  const config = loadConfig();
  const target = config.targets.find(t => t.certId === certId);
  if (target) {
    target.lastFingerprint = fingerprint;
    target.lastSync = new Date().toISOString();
    saveConfig(config);
  }
}

// ============================================================================
// Secret Targets
// ============================================================================

/**
 * Add a secret target
 */
export function addSecretTarget(target: SecretTarget): void {
  const config = loadConfig();
  config.secretTargets = config.secretTargets ?? [];

  // Check if target with same name exists (allows same secret with different output configs)
  const existingIndex = config.secretTargets.findIndex(t => t.name === target.name);
  if (existingIndex >= 0) {
    config.secretTargets[existingIndex] = target;
  } else {
    config.secretTargets.push(target);
  }

  saveConfig(config);
}

/**
 * Remove a secret target
 */
export function removeSecretTarget(secretIdOrName: string): boolean {
  const config = loadConfig();
  if (!config.secretTargets) return false;

  const initialLength = config.secretTargets.length;
  config.secretTargets = config.secretTargets.filter(
    t => t.secretId !== secretIdOrName && t.name !== secretIdOrName
  );

  if (config.secretTargets.length < initialLength) {
    saveConfig(config);
    return true;
  }
  return false;
}

/**
 * Get all secret targets
 */
export function getSecretTargets(): SecretTarget[] {
  return loadConfig().secretTargets ?? [];
}

/**
 * Update secret target version after successful sync
 */
export function updateSecretTargetVersion(secretId: string, version: number): void {
  const config = loadConfig();
  const target = config.secretTargets?.find(t => t.secretId === secretId);
  if (target) {
    target.lastVersion = version;
    target.lastSync = new Date().toISOString();
    saveConfig(config);
  }
}
