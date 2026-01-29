// Path: src/services/tls-certificate-manager.ts
// TLS Certificate Manager Service
// Manages agent TLS certificate lifecycle: request, renewal, and hot-reload

import { loadConfig, saveConfig } from '../lib/config.js';
import {
  requestAgentTLSCertificate,
  renewAgentTLSCertificate,
  getAgentTLSCertificate,
  activateAgentTLSCertificate,
  type AgentTLSCertificateResponse,
} from '../lib/api.js';
import { createLogger } from '../lib/logger.js';
import {
  registerCounter,
  registerGauge,
  incCounter,
  setGauge,
} from '../lib/metrics.js';
import { ManagedTimer } from '../utils/timer.js';
import { DEFAULT_TLS_CONFIG, type TLSConfig } from '../lib/config/types.js';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const log = createLogger({ module: 'tls-cert-manager' });

// =============================================================================
// Constants
// =============================================================================

/** Default renewal check interval (12 hours) */
const DEFAULT_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Retry delay on failure (5 minutes) */
const RETRY_DELAY_MS = 5 * 60 * 1000;

/** Max retry attempts before giving up */
const MAX_RETRY_ATTEMPTS = 5;

// =============================================================================
// State Management
// =============================================================================

interface TLSManagerState {
  isRunning: boolean;
  certExpiresAt: Date | null;
  lastCheckAt: Date | null;
  lastRenewalAt: Date | null;
  retryCount: number;
  agentTlsCertId: string | null;
}

const state: TLSManagerState = {
  isRunning: false,
  certExpiresAt: null,
  lastCheckAt: null,
  lastRenewalAt: null,
  retryCount: 0,
  agentTlsCertId: null,
};

const checkTimer = new ManagedTimer();

/** Callback for when certificate is updated (for HTTPS server hot-reload) */
let onCertificateUpdatedCallback: ((certPath: string, keyPath: string) => void) | null = null;

// =============================================================================
// Metrics Registration
// =============================================================================

let metricsRegistered = false;

function registerTLSMetrics(): void {
  if (metricsRegistered) return;
  metricsRegistered = true;

  registerCounter('znvault_agent_tls_renewals_total', 'Total TLS certificate renewals');
  registerCounter('znvault_agent_tls_renewal_failures_total', 'Total TLS certificate renewal failures');
  registerGauge('znvault_agent_tls_cert_expiry_timestamp', 'TLS certificate expiry timestamp');
  registerGauge('znvault_agent_tls_days_until_expiry', 'Days until TLS certificate expires');

  log.debug('TLS certificate manager metrics registered');
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if TLS is enabled in config
 */
export function isTLSEnabled(): boolean {
  const config = loadConfig();
  return config.tls?.enabled ?? false;
}

/**
 * Get TLS config with defaults - exported for use by daemon
 */
export function getTLSConfig(): Required<Pick<TLSConfig, 'certPath' | 'keyPath' | 'renewBeforeDays' | 'httpsPort' | 'keepHttpServer'>> & TLSConfig {
  const config = loadConfig();
  const tls: Partial<TLSConfig> = config.tls ?? {};

  // Get agent ID for default paths
  const agentId = config.agentId ?? 'unknown';
  const defaultDir = '/var/lib/zn-vault-agent/tls';

  return {
    enabled: tls.enabled ?? false,
    certPath: tls.certPath ?? join(defaultDir, `${agentId}.crt`),
    keyPath: tls.keyPath ?? join(defaultDir, `${agentId}.key`),
    renewBeforeDays: tls.renewBeforeDays ?? DEFAULT_TLS_CONFIG.renewBeforeDays ?? 7,
    httpsPort: tls.httpsPort ?? DEFAULT_TLS_CONFIG.httpsPort ?? 9443,
    keepHttpServer: tls.keepHttpServer ?? DEFAULT_TLS_CONFIG.keepHttpServer ?? true,
    clientCaCertPath: tls.clientCaCertPath,
    certExpiresAt: tls.certExpiresAt,
    agentTlsCertId: tls.agentTlsCertId,
  };
}

/**
 * Write certificate and key files
 */
async function writeCertificateFiles(
  certPem: string,
  certPath: string,
  keyPath: string
): Promise<void> {
  // Split combined PEM into cert and key
  const certMatch = certPem.match(/-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----/s);
  const keyMatch = certPem.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----.+?-----END (?:RSA )?PRIVATE KEY-----/s);

  if (!certMatch) {
    throw new Error('Certificate not found in PEM data');
  }
  if (!keyMatch) {
    throw new Error('Private key not found in PEM data');
  }

  const cert = certMatch[0];
  const key = keyMatch[0];

  // Ensure directories exist
  await mkdir(dirname(certPath), { recursive: true });
  await mkdir(dirname(keyPath), { recursive: true });

  // Write files with secure permissions
  await writeFile(certPath, cert + '\n', { mode: 0o644 });
  await writeFile(keyPath, key + '\n', { mode: 0o600 });

  log.info({ certPath, keyPath }, 'TLS certificate files written');
}

/**
 * Check if certificate file exists and is valid
 */
async function certificateExists(certPath: string): Promise<boolean> {
  if (!existsSync(certPath)) {
    return false;
  }

  try {
    const content = await readFile(certPath, 'utf-8');
    return content.includes('-----BEGIN CERTIFICATE-----');
  } catch {
    return false;
  }
}

/**
 * Parse expiry from config or calculate renewal time
 */
function calculateNextCheckMs(tlsConfig: ReturnType<typeof getTLSConfig>): number {
  if (!state.certExpiresAt) {
    // No cert yet, check again in retry delay
    return RETRY_DELAY_MS;
  }

  const now = Date.now();
  const expiresAt = state.certExpiresAt.getTime();
  const renewBeforeMs = (tlsConfig.renewBeforeDays ?? 7) * 24 * 60 * 60 * 1000;

  // Time until we should renew
  const renewAt = expiresAt - renewBeforeMs;
  const timeUntilRenewal = renewAt - now;

  if (timeUntilRenewal <= 0) {
    // Already past renewal threshold, check soon
    return 60 * 1000; // 1 minute
  }

  // Check halfway to renewal, or at default interval, whichever is sooner
  return Math.min(timeUntilRenewal / 2, DEFAULT_CHECK_INTERVAL_MS);
}

/**
 * Update metrics with current state
 */
function updateMetrics(): void {
  if (state.certExpiresAt) {
    const expiryTimestamp = state.certExpiresAt.getTime() / 1000;
    setGauge('znvault_agent_tls_cert_expiry_timestamp', expiryTimestamp);

    const daysUntilExpiry = (state.certExpiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    setGauge('znvault_agent_tls_days_until_expiry', daysUntilExpiry);
  }
}

// =============================================================================
// Core Certificate Management
// =============================================================================

/**
 * Request a new TLS certificate from vault
 */
async function requestCertificate(): Promise<AgentTLSCertificateResponse | null> {
  const config = loadConfig();
  const tlsConfig = getTLSConfig();

  if (!config.agentId) {
    log.error('Agent ID not set - cannot request TLS certificate');
    return null;
  }

  try {
    log.info({ agentId: config.agentId }, 'Requesting TLS certificate from vault');

    const response = await requestAgentTLSCertificate(config.agentId, {
      hostname: config.hostname,
    });

    // Write certificate files
    await writeCertificateFiles(
      response.certificate,
      tlsConfig.certPath,
      tlsConfig.keyPath
    );

    // Update state
    state.certExpiresAt = new Date(response.expiresAt);
    state.agentTlsCertId = response.agentTlsCertId;
    state.lastRenewalAt = new Date();
    state.retryCount = 0;

    // Update config with certificate info
    const updatedConfig = loadConfig();
    const existingTls = updatedConfig.tls ?? { enabled: true };
    updatedConfig.tls = {
      ...existingTls,
      certExpiresAt: response.expiresAt,
      agentTlsCertId: response.agentTlsCertId,
    };
    saveConfig(updatedConfig);

    // Activate certificate to acknowledge receipt
    await activateAgentTLSCertificate(config.agentId, response.agentTlsCertId);

    log.info({
      agentTlsCertId: response.agentTlsCertId,
      expiresAt: response.expiresAt,
      hostname: response.hostname,
    }, 'TLS certificate obtained and activated');

    incCounter('znvault_agent_tls_renewals_total', { type: 'initial' });
    updateMetrics();

    // Notify callback for hot-reload
    if (onCertificateUpdatedCallback) {
      onCertificateUpdatedCallback(tlsConfig.certPath, tlsConfig.keyPath);
    }

    return response;
  } catch (err) {
    log.error({ err }, 'Failed to request TLS certificate');
    incCounter('znvault_agent_tls_renewal_failures_total', { type: 'initial' });
    state.retryCount++;
    return null;
  }
}

/**
 * Renew TLS certificate
 */
async function renewCertificate(): Promise<AgentTLSCertificateResponse | null> {
  const config = loadConfig();
  const tlsConfig = getTLSConfig();

  if (!config.agentId) {
    log.error('Agent ID not set - cannot renew TLS certificate');
    return null;
  }

  try {
    log.info({ agentId: config.agentId }, 'Renewing TLS certificate');

    const response = await renewAgentTLSCertificate(config.agentId);

    // Write certificate files
    await writeCertificateFiles(
      response.certificate,
      tlsConfig.certPath,
      tlsConfig.keyPath
    );

    // Update state
    state.certExpiresAt = new Date(response.expiresAt);
    state.agentTlsCertId = response.agentTlsCertId;
    state.lastRenewalAt = new Date();
    state.retryCount = 0;

    // Update config with new certificate info
    const updatedConfig = loadConfig();
    const existingTls = updatedConfig.tls ?? { enabled: true };
    updatedConfig.tls = {
      ...existingTls,
      certExpiresAt: response.expiresAt,
      agentTlsCertId: response.agentTlsCertId,
    };
    saveConfig(updatedConfig);

    // Activate certificate
    await activateAgentTLSCertificate(config.agentId, response.agentTlsCertId);

    log.info({
      agentTlsCertId: response.agentTlsCertId,
      expiresAt: response.expiresAt,
    }, 'TLS certificate renewed and activated');

    incCounter('znvault_agent_tls_renewals_total', { type: 'renewal' });
    updateMetrics();

    // Notify callback for hot-reload
    if (onCertificateUpdatedCallback) {
      onCertificateUpdatedCallback(tlsConfig.certPath, tlsConfig.keyPath);
    }

    return response;
  } catch (err) {
    log.error({ err }, 'Failed to renew TLS certificate');
    incCounter('znvault_agent_tls_renewal_failures_total', { type: 'renewal' });
    state.retryCount++;
    return null;
  }
}

/**
 * Check certificate status and renew if needed
 */
async function checkAndRenewIfNeeded(): Promise<void> {
  const tlsConfig = getTLSConfig();
  state.lastCheckAt = new Date();

  // If no cert exists, request initial
  const certExists = await certificateExists(tlsConfig.certPath);
  if (!certExists) {
    log.info('No TLS certificate found, requesting initial certificate');
    await requestCertificate();
    scheduleNextCheck();
    return;
  }

  // Check if renewal is needed
  if (!state.certExpiresAt) {
    // Try to get expiry from vault
    try {
      const config = loadConfig();
      if (config.agentId) {
        const certInfo = await getAgentTLSCertificate(config.agentId);
        state.certExpiresAt = new Date(certInfo.expiresAt);
        state.agentTlsCertId = certInfo.id;
        updateMetrics();
      }
    } catch (err) {
      log.warn({ err }, 'Failed to get certificate info from vault');
    }
  }

  if (state.certExpiresAt) {
    const now = Date.now();
    const expiresAt = state.certExpiresAt.getTime();
    const renewBeforeMs = (tlsConfig.renewBeforeDays ?? 7) * 24 * 60 * 60 * 1000;
    const renewAt = expiresAt - renewBeforeMs;

    const daysUntilExpiry = (expiresAt - now) / (24 * 60 * 60 * 1000);

    if (now >= renewAt) {
      log.info({
        daysUntilExpiry: daysUntilExpiry.toFixed(1),
        renewBeforeDays: tlsConfig.renewBeforeDays,
      }, 'TLS certificate approaching expiry, renewing');

      await renewCertificate();
    } else {
      log.debug({
        daysUntilExpiry: daysUntilExpiry.toFixed(1),
        expiresAt: state.certExpiresAt.toISOString(),
      }, 'TLS certificate still valid');
    }
  }

  scheduleNextCheck();
}

/**
 * Schedule next certificate check
 */
function scheduleNextCheck(): void {
  checkTimer.clear();

  if (!state.isRunning) {
    return;
  }

  const tlsConfig = getTLSConfig();
  let delay: number;

  if (state.retryCount > 0 && state.retryCount < MAX_RETRY_ATTEMPTS) {
    // Exponential backoff on failure
    delay = Math.min(RETRY_DELAY_MS * Math.pow(2, state.retryCount - 1), DEFAULT_CHECK_INTERVAL_MS);
    log.debug({
      retryCount: state.retryCount,
      delayMinutes: Math.round(delay / 60000),
    }, 'Scheduling retry check');
  } else if (state.retryCount >= MAX_RETRY_ATTEMPTS) {
    // Give up retrying, check at normal interval
    log.error({ maxRetries: MAX_RETRY_ATTEMPTS }, 'Max retry attempts reached, falling back to normal check interval');
    state.retryCount = 0;
    delay = DEFAULT_CHECK_INTERVAL_MS;
  } else {
    delay = calculateNextCheckMs(tlsConfig);
  }

  checkTimer.setTimeout(() => {
    if (!state.isRunning) return;
    void checkAndRenewIfNeeded();
  }, delay);

  log.debug({
    checkInMinutes: Math.round(delay / 60000),
    checkAt: new Date(Date.now() + delay).toISOString(),
  }, 'TLS certificate check scheduled');
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Set callback for when certificate is updated (for HTTPS server hot-reload)
 */
export function onCertificateUpdated(callback: (certPath: string, keyPath: string) => void): void {
  onCertificateUpdatedCallback = callback;
}

/**
 * Start the TLS certificate manager service
 */
export async function startTLSCertificateManager(): Promise<void> {
  if (state.isRunning) {
    log.warn('TLS certificate manager already running');
    return;
  }

  if (!isTLSEnabled()) {
    log.debug('TLS not enabled, certificate manager not started');
    return;
  }

  // Register metrics
  registerTLSMetrics();

  state.isRunning = true;
  state.retryCount = 0;

  // Load expiry from config
  const config = loadConfig();
  if (config.tls?.certExpiresAt) {
    state.certExpiresAt = new Date(config.tls.certExpiresAt);
    state.agentTlsCertId = config.tls.agentTlsCertId ?? null;
  }

  log.info({ tlsEnabled: true }, 'Starting TLS certificate manager');

  // Initial check
  await checkAndRenewIfNeeded();
}

/**
 * Ensure TLS certificate is ready (fetched from vault if needed)
 * This starts the TLS manager and waits for the certificate to be available.
 * Returns the cert paths for use by HTTPS server.
 */
export async function ensureCertificateReady(): Promise<{
  certPath: string;
  keyPath: string;
  httpsPort: number;
  keepHttpServer: boolean;
} | null> {
  if (!isTLSEnabled()) {
    log.debug('TLS not enabled');
    return null;
  }

  const tlsConfig = getTLSConfig();
  const config = loadConfig();

  // Check if agent has the required identity for requesting certs
  if (!config.agentId && !config.auth.apiKey) {
    log.warn('Agent ID and API key not set - cannot request TLS certificate from vault');
    // Fall back to existing certificate if available
    if (existsSync(tlsConfig.certPath) && existsSync(tlsConfig.keyPath)) {
      log.info('Using existing TLS certificate files');
      return {
        certPath: tlsConfig.certPath,
        keyPath: tlsConfig.keyPath,
        httpsPort: tlsConfig.httpsPort,
        keepHttpServer: tlsConfig.keepHttpServer,
      };
    }
    return null;
  }

  // Start TLS certificate manager (this will fetch cert if needed)
  await startTLSCertificateManager();

  // Wait for certificate to be available (max 30 seconds)
  const maxWait = 30000;
  const checkInterval = 500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    if (existsSync(tlsConfig.certPath) && existsSync(tlsConfig.keyPath)) {
      log.info({ certPath: tlsConfig.certPath, keyPath: tlsConfig.keyPath }, 'TLS certificate ready');
      return {
        certPath: tlsConfig.certPath,
        keyPath: tlsConfig.keyPath,
        httpsPort: tlsConfig.httpsPort,
        keepHttpServer: tlsConfig.keepHttpServer,
      };
    }
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }

  log.error('Timeout waiting for TLS certificate to be ready');
  return null;
}

/**
 * Stop the TLS certificate manager service
 */
export function stopTLSCertificateManager(): void {
  checkTimer.clear();
  state.isRunning = false;
  state.certExpiresAt = null;
  state.lastCheckAt = null;
  state.lastRenewalAt = null;
  state.retryCount = 0;
  state.agentTlsCertId = null;
  onCertificateUpdatedCallback = null;

  log.debug('TLS certificate manager stopped');
}

/**
 * Force immediate certificate renewal
 */
export async function forceRenewal(): Promise<AgentTLSCertificateResponse | null> {
  if (!isTLSEnabled()) {
    log.warn('Cannot force renewal - TLS not enabled');
    return null;
  }

  const response = await renewCertificate();
  if (state.isRunning) {
    scheduleNextCheck();
  }
  return response;
}

/**
 * Get current TLS manager status
 */
export function getTLSManagerStatus(): {
  isRunning: boolean;
  tlsEnabled: boolean;
  certExpiresAt: string | null;
  daysUntilExpiry: number | null;
  lastCheckAt: string | null;
  lastRenewalAt: string | null;
  agentTlsCertId: string | null;
  certPath: string;
  keyPath: string;
} {
  const tlsConfig = getTLSConfig();

  let daysUntilExpiry: number | null = null;
  if (state.certExpiresAt) {
    daysUntilExpiry = (state.certExpiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  }

  return {
    isRunning: state.isRunning,
    tlsEnabled: isTLSEnabled(),
    certExpiresAt: state.certExpiresAt?.toISOString() ?? null,
    daysUntilExpiry,
    lastCheckAt: state.lastCheckAt?.toISOString() ?? null,
    lastRenewalAt: state.lastRenewalAt?.toISOString() ?? null,
    agentTlsCertId: state.agentTlsCertId,
    certPath: tlsConfig.certPath,
    keyPath: tlsConfig.keyPath,
  };
}
