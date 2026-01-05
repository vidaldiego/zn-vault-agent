// Path: src/lib/secret-deployer.ts
// Secret deployment with atomic writes

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { SecretTarget } from './config.js';
import { getSecret } from './api.js';
import { updateSecretTargetVersion, getSecretTargets, loadConfig } from './config.js';
import { deployLogger as log } from './logger.js';
import { metrics } from './metrics.js';

export interface SecretDeployResult {
  success: boolean;
  secretId: string;
  name: string;
  message: string;
  version?: number;
  durationMs?: number;
}

/**
 * Format secret data according to target format
 */
function formatSecretData(
  data: Record<string, unknown>,
  format: string,
  options: { key?: string; envPrefix?: string; templatePath?: string }
): string {
  switch (format) {
    case 'env': {
      const prefix = options.envPrefix || '';
      return Object.entries(data)
        .map(([k, v]) => {
          const key = prefix + k.toUpperCase();
          const value = typeof v === 'string' ? v : JSON.stringify(v);
          return `${key}="${value.replace(/"/g, '\\"')}"`;
        })
        .join('\n') + '\n';
    }

    case 'json':
      return JSON.stringify(data, null, 2) + '\n';

    case 'yaml': {
      // Simple YAML serialization
      return Object.entries(data)
        .map(([k, v]) => {
          if (typeof v === 'string') {
            // Quote strings that might need it
            if (v.includes(':') || v.includes('#') || v.includes('\n')) {
              return `${k}: "${v.replace(/"/g, '\\"')}"`;
            }
            return `${k}: ${v}`;
          }
          return `${k}: ${JSON.stringify(v)}`;
        })
        .join('\n') + '\n';
    }

    case 'raw': {
      if (!options.key) {
        throw new Error('Key must be specified for raw format');
      }
      const value = data[options.key];
      if (value === undefined) {
        throw new Error(`Key "${options.key}" not found in secret data`);
      }
      return typeof value === 'string' ? value : JSON.stringify(value);
    }

    case 'template': {
      if (!options.templatePath) {
        throw new Error('Template path must be specified for template format');
      }
      if (!fs.existsSync(options.templatePath)) {
        throw new Error(`Template file not found: ${options.templatePath}`);
      }
      let template = fs.readFileSync(options.templatePath, 'utf-8');
      // Replace {{ key }} placeholders
      for (const [k, v] of Object.entries(data)) {
        const value = typeof v === 'string' ? v : JSON.stringify(v);
        template = template.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), value);
      }
      return template;
    }

    default:
      return JSON.stringify(data, null, 2) + '\n';
  }
}

/**
 * Write secret to file with proper permissions (atomic)
 */
function writeSecretFile(
  filePath: string,
  content: string,
  owner?: string,
  mode?: string
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write to temp file first (atomic)
  const tempPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tempPath, content, { mode: parseInt(mode || '0600', 8) });

  // Set ownership if specified and running as root
  if (owner && process.getuid?.() === 0) {
    try {
      execSync(`chown ${owner} "${tempPath}"`, { stdio: 'ignore' });
    } catch {
      // Ignore chown errors
    }
  }

  // Atomic rename
  fs.renameSync(tempPath, filePath);
}

/**
 * Deploy a single secret target
 */
export async function deploySecret(
  target: SecretTarget,
  force = false
): Promise<SecretDeployResult> {
  const startTime = Date.now();

  try {
    log.debug({ name: target.name, secretId: target.secretId }, 'Deploying secret');

    // Fetch secret from vault
    const secret = await getSecret(target.secretId);

    // Check if update needed (unless forced)
    if (!force && target.lastVersion === secret.version) {
      return {
        success: true,
        secretId: target.secretId,
        name: target.name,
        message: 'Already up to date',
        version: secret.version,
        durationMs: Date.now() - startTime,
      };
    }

    // Format the data
    const content = formatSecretData(secret.data, target.format, {
      key: target.key,
      envPrefix: target.envPrefix,
      templatePath: target.templatePath,
    });

    // Write to file
    writeSecretFile(target.output, content, target.owner, target.mode);

    // Update config with new version
    updateSecretTargetVersion(target.secretId, secret.version);

    // Run reload command if specified
    if (target.reloadCmd) {
      try {
        log.debug({ cmd: target.reloadCmd }, 'Running reload command');
        execSync(target.reloadCmd, { stdio: 'pipe' });
      } catch (err) {
        log.warn({ err, cmd: target.reloadCmd }, 'Reload command failed');
      }
    }

    const durationMs = Date.now() - startTime;
    metrics.secretDeployed(target.name, true, durationMs);

    log.info({
      name: target.name,
      secretId: target.secretId,
      version: secret.version,
      output: target.output,
      durationMs,
    }, 'Secret deployed successfully');

    return {
      success: true,
      secretId: target.secretId,
      name: target.name,
      message: 'Deployed successfully',
      version: secret.version,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    metrics.secretDeployed(target.name, false, durationMs);

    log.error({
      name: target.name,
      secretId: target.secretId,
      err,
      durationMs,
    }, 'Secret deployment failed');

    return {
      success: false,
      secretId: target.secretId,
      name: target.name,
      message,
      durationMs,
    };
  }
}

/**
 * Deploy all configured secret targets
 */
export async function deployAllSecrets(force = false): Promise<SecretDeployResult[]> {
  const config = loadConfig();
  const targets = config.secretTargets || [];

  if (targets.length === 0) {
    log.debug('No secret targets configured');
    return [];
  }

  log.info({ count: targets.length }, 'Deploying all secrets');

  const results: SecretDeployResult[] = [];

  for (const target of targets) {
    const result = await deploySecret(target, force);
    results.push(result);
  }

  const successCount = results.filter(r => r.success).length;
  const errorCount = results.filter(r => !r.success).length;

  log.info({ total: results.length, success: successCount, errors: errorCount }, 'Secret deployment complete');

  return results;
}

/**
 * Find secret target by ID or alias
 */
export function findSecretTarget(secretIdOrAlias: string): SecretTarget | undefined {
  const targets = getSecretTargets();
  return targets.find(t =>
    t.secretId === secretIdOrAlias ||
    t.secretId === `alias:${secretIdOrAlias}` ||
    secretIdOrAlias.includes(t.secretId)
  );
}
