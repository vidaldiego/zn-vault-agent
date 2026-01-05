// Path: src/lib/deployer.ts
// Certificate deployment with atomic writes and verification

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import os from 'node:os';
import type { CertTarget } from './config.js';
import { decryptCertificate, getCertificate, ackDelivery } from './api.js';
import { updateTargetFingerprint, loadConfig } from './config.js';
import { deployLogger as log } from './logger.js';
import { metrics } from './metrics.js';
import { updateCertStatus } from './health.js';

export interface DeployResult {
  success: boolean;
  certId: string;
  name: string;
  message: string;
  fingerprint?: string;
  filesWritten?: string[];
  reloadOutput?: string;
  healthCheckPassed?: boolean;
  rolledBack?: boolean;
  durationMs?: number;
}

/**
 * Parse PEM certificate bundle into components
 */
function parsePemBundle(pemData: string): {
  certificate: string;
  privateKey: string;
  chain: string[];
} {
  const certRegex = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  // Support all private key formats: RSA, EC, PKCS8, and encrypted
  const keyRegex = /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/;

  const certs = pemData.match(certRegex) || [];
  const keyMatch = pemData.match(keyRegex);

  log.debug({
    certsFound: certs.length,
    hasPrivateKey: !!keyMatch,
    pemLength: pemData.length,
  }, 'Parsed PEM bundle');

  return {
    certificate: certs[0] || '',
    privateKey: keyMatch ? keyMatch[0] : '',
    chain: certs.slice(1),
  };
}

/**
 * Calculate SHA-256 hash of content
 */
function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Write file atomically using temp file + rename
 * This ensures the file is either fully written or not at all
 */
function writeFileAtomic(filePath: string, content: string, mode: number): void {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);

  // Create directory if needed
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    // Write to temp file
    fs.writeFileSync(tempPath, content, { mode });

    // Atomic rename
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    // Clean up temp file on error
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Verify file was written correctly by re-reading and comparing hash
 */
function verifyFile(filePath: string, expectedHash: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const actualHash = hashContent(content);
    return actualHash === expectedHash;
  } catch {
    return false;
  }
}

/**
 * Write file with proper ownership and permissions, using atomic write
 */
function writeSecureFile(filePath: string, content: string, owner?: string, mode?: string): { hash: string } {
  const fileMode = mode ? parseInt(mode, 8) : 0o600;

  // Atomic write
  writeFileAtomic(filePath, content, fileMode);

  // Set ownership if specified and running as root
  if (owner && process.getuid?.() === 0) {
    const [user, group] = owner.split(':');
    try {
      execSync(`chown ${user}:${group || user} "${filePath}"`, { stdio: 'pipe' });
    } catch (err) {
      log.warn({ filePath, owner, err }, 'Failed to set file ownership');
    }
  }

  // Set permissions (may be different from atomic write due to umask)
  if (mode) {
    try {
      fs.chmodSync(filePath, fileMode);
    } catch (err) {
      log.warn({ filePath, mode, err }, 'Failed to set file permissions');
    }
  }

  return { hash: hashContent(content) };
}

/**
 * Backup existing files before deployment
 */
function backupFiles(outputs: CertTarget['outputs']): Map<string, string> {
  const backups = new Map<string, string>();

  for (const filePath of Object.values(outputs)) {
    if (filePath && fs.existsSync(filePath)) {
      const backupPath = `${filePath}.bak`;
      try {
        fs.copyFileSync(filePath, backupPath);
        backups.set(filePath, backupPath);
        log.debug({ original: filePath, backup: backupPath }, 'Created backup');
      } catch (err) {
        log.warn({ filePath, err }, 'Failed to create backup');
      }
    }
  }

  return backups;
}

/**
 * Restore files from backup
 */
function restoreBackups(backups: Map<string, string>): void {
  for (const [original, backup] of backups) {
    if (fs.existsSync(backup)) {
      try {
        fs.copyFileSync(backup, original);
        log.info({ original, backup }, 'Restored from backup');
      } catch (err) {
        log.error({ original, backup, err }, 'Failed to restore backup');
      }
    }
  }
}

/**
 * Clean up backup files after successful deployment
 */
function cleanupBackups(backups: Map<string, string>): void {
  for (const backup of backups.values()) {
    try {
      if (fs.existsSync(backup)) {
        fs.unlinkSync(backup);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Execute reload command
 */
function executeReload(cmd: string): { success: boolean; output: string } {
  log.debug({ cmd }, 'Executing reload command');
  try {
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
    log.info({ cmd }, 'Reload command succeeded');
    return { success: true, output };
  } catch (err) {
    const error = err as { message?: string; stderr?: string };
    const output = error.stderr || error.message || 'Unknown error';
    log.error({ cmd, error: output }, 'Reload command failed');
    return { success: false, output };
  }
}

/**
 * Execute health check command
 */
function executeHealthCheck(cmd: string): boolean {
  log.debug({ cmd }, 'Executing health check');
  try {
    execSync(cmd, { encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
    log.debug({ cmd }, 'Health check passed');
    return true;
  } catch (err) {
    log.warn({ cmd, err }, 'Health check failed');
    return false;
  }
}

/**
 * Deploy a certificate to its target locations
 */
export async function deployCertificate(
  target: CertTarget,
  force: boolean = false
): Promise<DeployResult> {
  const { certId, name, outputs, owner, mode, reloadCmd, healthCheckCmd } = target;
  const config = loadConfig();
  const startTime = Date.now();

  log.info({ certId, name, force }, 'Starting certificate deployment');

  try {
    // Get certificate metadata to check fingerprint
    const metadata = await getCertificate(certId);

    // Update expiry metric
    metrics.setCertExpiry(certId, name, metadata.daysUntilExpiry);

    // Check if certificate has changed (unless forced)
    if (!force && target.lastFingerprint === metadata.fingerprintSha256) {
      const duration = Date.now() - startTime;
      log.debug({ certId, name, duration }, 'Certificate unchanged, skipping');
      return {
        success: true,
        certId,
        name,
        message: 'Certificate unchanged',
        fingerprint: metadata.fingerprintSha256,
        durationMs: duration,
      };
    }

    // Check expiry
    if (metadata.daysUntilExpiry < 0) {
      const duration = Date.now() - startTime;
      const message = `Certificate is EXPIRED (${Math.abs(metadata.daysUntilExpiry)} days ago)`;
      log.error({ certId, name, daysExpired: Math.abs(metadata.daysUntilExpiry) }, message);
      metrics.syncFailure(name, 'expired');
      return {
        success: false,
        certId,
        name,
        message,
        durationMs: duration,
      };
    }

    // Decrypt certificate
    const decrypted = await decryptCertificate(
      certId,
      `Agent sync to ${os.hostname()}`
    );

    // Decode from base64
    const pemData = Buffer.from(decrypted.certificateData, 'base64').toString('utf-8');

    // Parse PEM bundle
    const { certificate, privateKey, chain } = parsePemBundle(pemData);

    if (!certificate) {
      throw new Error('No certificate found in PEM data');
    }

    // Backup existing files
    const backups = backupFiles(outputs);
    const filesWritten: string[] = [];
    const fileHashes = new Map<string, string>();

    try {
      // Write files based on output configuration
      if (outputs.combined) {
        const combined = [certificate, privateKey, ...chain].filter(Boolean).join('\n');
        const { hash } = writeSecureFile(outputs.combined, combined, owner, mode);
        fileHashes.set(outputs.combined, hash);
        filesWritten.push(outputs.combined);
      }

      if (outputs.cert) {
        const { hash } = writeSecureFile(outputs.cert, certificate, owner, mode);
        fileHashes.set(outputs.cert, hash);
        filesWritten.push(outputs.cert);
      }

      if (outputs.key) {
        if (privateKey) {
          const { hash } = writeSecureFile(outputs.key, privateKey, owner, mode || '0600');
          fileHashes.set(outputs.key, hash);
          filesWritten.push(outputs.key);
        } else {
          log.warn({
            certId,
            name,
            keyPath: outputs.key,
          }, 'Private key output configured but certificate has no private key - was the key included when storing?');
        }
      }

      if (outputs.chain && chain.length > 0) {
        const chainContent = chain.join('\n');
        const { hash } = writeSecureFile(outputs.chain, chainContent, owner, mode);
        fileHashes.set(outputs.chain, hash);
        filesWritten.push(outputs.chain);
      }

      if (outputs.fullchain) {
        const fullchain = [certificate, ...chain].filter(Boolean).join('\n');
        const { hash } = writeSecureFile(outputs.fullchain, fullchain, owner, mode);
        fileHashes.set(outputs.fullchain, hash);
        filesWritten.push(outputs.fullchain);
      }

      // Verify all written files
      for (const [filePath, expectedHash] of fileHashes) {
        if (!verifyFile(filePath, expectedHash)) {
          throw new Error(`File verification failed for ${filePath}`);
        }
      }
      log.debug({ files: filesWritten.length }, 'All files written and verified');

      // Execute reload command
      const reloadCommand = reloadCmd || config.globalReloadCmd;
      let reloadOutput: string | undefined;

      if (reloadCommand) {
        const result = executeReload(reloadCommand);
        reloadOutput = result.output;

        if (!result.success) {
          // Reload failed, rollback
          log.warn({ certId, name }, 'Reload failed, rolling back');
          restoreBackups(backups);
          if (reloadCommand) {
            executeReload(reloadCommand); // Try to reload with old certs
          }
          metrics.syncFailure(name, 'reload_failed');
          return {
            success: false,
            certId,
            name,
            message: `Reload failed: ${result.output}`,
            rolledBack: true,
            durationMs: Date.now() - startTime,
          };
        }
      }

      // Execute health check
      let healthCheckPassed: boolean | undefined;
      if (healthCheckCmd) {
        healthCheckPassed = executeHealthCheck(healthCheckCmd);

        if (!healthCheckPassed) {
          // Health check failed, rollback
          log.warn({ certId, name }, 'Health check failed, rolling back');
          restoreBackups(backups);
          if (reloadCommand) {
            executeReload(reloadCommand); // Reload with old certs
          }
          metrics.syncFailure(name, 'health_check_failed');
          return {
            success: false,
            certId,
            name,
            message: 'Health check failed after deployment',
            rolledBack: true,
            durationMs: Date.now() - startTime,
          };
        }
      }

      // Update fingerprint in config
      updateTargetFingerprint(certId, metadata.fingerprintSha256);

      // Acknowledge delivery to server
      await ackDelivery(certId, os.hostname(), metadata.version);

      // Clean up backups after successful deployment
      cleanupBackups(backups);

      const duration = Date.now() - startTime;
      const message = `Deployed v${metadata.version} (expires in ${metadata.daysUntilExpiry}d)`;

      log.info({ certId, name, version: metadata.version, expiresIn: metadata.daysUntilExpiry, duration }, message);
      metrics.syncSuccess(name);
      metrics.syncDuration(name, duration);

      return {
        success: true,
        certId,
        name,
        message,
        fingerprint: metadata.fingerprintSha256,
        filesWritten,
        reloadOutput,
        healthCheckPassed,
        durationMs: duration,
      };
    } catch (deployErr) {
      // Deployment failed, try to rollback
      log.error({ certId, name, err: deployErr }, 'Deployment failed, rolling back');
      restoreBackups(backups);
      throw deployErr;
    }
  } catch (err) {
    const duration = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    log.error({ certId, name, err, duration }, 'Certificate deployment failed');
    metrics.syncFailure(name, 'error');
    return {
      success: false,
      certId,
      name,
      message,
      durationMs: duration,
    };
  }
}

/**
 * Deploy all configured certificate targets
 */
export async function deployAllCertificates(force: boolean = false): Promise<DeployResult[]> {
  const config = loadConfig();
  const results: DeployResult[] = [];
  let successCount = 0;
  let errorCount = 0;

  log.info({ count: config.targets.length, force }, 'Deploying all certificates');

  for (const target of config.targets) {
    const result = await deployCertificate(target, force);
    results.push(result);
    if (result.success) {
      successCount++;
    } else {
      errorCount++;
    }
  }

  // Update health status
  updateCertStatus(successCount, errorCount);
  metrics.setCertsTracked(config.targets.length);

  log.info({ total: config.targets.length, success: successCount, errors: errorCount }, 'Deployment complete');

  return results;
}
