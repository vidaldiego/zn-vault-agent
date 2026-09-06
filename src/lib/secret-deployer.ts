// Path: src/lib/secret-deployer.ts
// Secret deployment with atomic writes

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { SecretTarget } from './config.js';
import { chownSafe } from '../utils/shell.js';
import { validateOutputPath } from '../utils/path.js';
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
      const prefix = options.envPrefix ?? '';
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
  // Validate path to prevent traversal attacks
  validateOutputPath(filePath);

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write to temp file first (atomic)
  const tempPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tempPath, content, { mode: parseInt(mode ?? '0600', 8) });

  // Set ownership if specified and running as root (using safe chown)
  if (owner && process.getuid?.() === 0) {
    try {
      chownSafe(tempPath, owner);
    } catch {
      // Ignore chown errors
    }
  }

  // Atomic rename
  fs.renameSync(tempPath, filePath);
}

/**
 * Decide whether deploySecret can short-circuit. Trusting lastVersion
 * alone is unsafe: tmpfs output paths get wiped on host reboot while
 * lastVersion persists in config.json, so skipping leaves the consumer
 * with no file. Check the output exists too (when there is one).
 */
export function shouldSkipDeploy(
  target: Pick<SecretTarget, 'lastVersion' | 'format' | 'output'>,
  remoteVersion: number,
  fileExists: (path: string) => boolean = fs.existsSync,
): boolean {
  if (target.lastVersion !== remoteVersion) return false;
  // 'none' format is subscribe-only — no file on disk to check.
  if (target.format === 'none') return true;
  // Any other format must have an output path; if it's missing or the
  // file is gone, re-deploy. The output? guard mirrors the later
  // `Output path required` throw — let that throw fire when we're
  // actually deploying.
  return Boolean(target.output) && fileExists(target.output as string);
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
    if (!force && shouldSkipDeploy(target, secret.version)) {
      return {
        success: true,
        secretId: target.secretId,
        name: target.name,
        message: 'Already up to date',
        version: secret.version,
        durationMs: Date.now() - startTime,
      };
    }

    // Skip file writing for 'none' format (subscribe-only mode)
    if (target.format !== 'none') {
      // Format the data
      const content = formatSecretData(secret.data, target.format, {
        key: target.key,
        envPrefix: target.envPrefix,
        templatePath: target.templatePath,
      });

      // Write to file
      if (!target.output) {
        throw new Error(`Output path required for format '${target.format}'`);
      }
      writeSecretFile(target.output, content, target.owner, target.mode);
    }

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

    const isSubscribeOnly = target.format === 'none';
    log.info({
      name: target.name,
      secretId: target.secretId,
      version: secret.version,
      output: isSubscribeOnly ? '(subscribe-only)' : target.output,
      durationMs,
    }, isSubscribeOnly ? 'Secret synced (subscribe-only)' : 'Secret deployed successfully');

    return {
      success: true,
      secretId: target.secretId,
      name: target.name,
      message: isSubscribeOnly ? 'Synced (subscribe-only)' : 'Deployed successfully',
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
  const targets = config.secretTargets ?? [];

  if (targets.length === 0) {
    log.debug('No secret targets configured');
    return [];
  }

  log.info({ count: targets.length }, 'Deploying all secrets');

  const results: SecretDeployResult[] = [];

  for (const target of targets) {
    // A referenced parent can resolve to new content while its own Vault
    // version stays unchanged. Always re-resolve it during a full sync so an
    // agent restart also recovers changes missed while it was offline.
    const result = await deploySecret(
      target,
      force || (target.refreshOn?.length ?? 0) > 0
    );
    results.push(result);
  }

  const successCount = results.filter(r => r.success).length;
  const errorCount = results.filter(r => !r.success).length;

  log.info({ total: results.length, success: successCount, errors: errorCount }, 'Secret deployment complete');

  return results;
}

export interface SecretRefreshTarget {
  target: SecretTarget;
  reference: string;
  key: string;
}

function secretReferenceVariants(reference: string): string[] {
  if (!reference) return [];
  return reference.startsWith('alias:')
    ? [reference, reference.slice('alias:'.length)]
    : [reference, `alias:${reference}`];
}

/** Stable per-target/per-reference identity for polling watermarks. */
export function secretRefreshKey(target: SecretTarget, reference: string): string {
  const normalizedReference = reference.startsWith('alias:')
    ? reference.slice('alias:'.length)
    : reference;
  return `refresh:${target.secretId}:${normalizedReference}`;
}

/** Enumerate every configured reference dependency once. */
export function listSecretRefreshTargets(targets: SecretTarget[]): SecretRefreshTarget[] {
  const seen = new Set<string>();
  const matches: SecretRefreshTarget[] = [];
  for (const target of targets) {
    for (const reference of target.refreshOn ?? []) {
      const key = secretRefreshKey(target, reference);
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ target, reference, key });
    }
  }
  return matches;
}

/** Resolve a child event to every referenced parent target that depends on it. */
export function findSecretRefreshTargets(
  targets: SecretTarget[],
  ...eventReferences: string[]
): SecretRefreshTarget[] {
  const eventVariants = new Set(eventReferences.flatMap(secretReferenceVariants));
  return listSecretRefreshTargets(targets).filter(({ reference }) =>
    secretReferenceVariants(reference).some(variant => eventVariants.has(variant))
  );
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
