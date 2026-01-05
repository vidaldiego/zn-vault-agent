// Path: src/lib/validation.ts
// Configuration validation for zn-vault-agent

import fs from 'node:fs';
import path from 'node:path';
import type { AgentConfig, CertTarget } from './config.js';
import { configLogger as log } from './logger.js';

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  field: string;
  message: string;
  value?: unknown;
}

export interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

/**
 * Validate a URL format
 */
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate octal permission format (e.g., "0640", "0600")
 */
function isValidPermissions(mode: string): boolean {
  return /^0[0-7]{3}$/.test(mode);
}

/**
 * Check if a directory exists or can be created
 */
function isValidOutputPath(filePath: string): { valid: boolean; reason?: string } {
  const dir = path.dirname(filePath);

  if (fs.existsSync(dir)) {
    return { valid: true };
  }

  // Check if parent of parent exists (one level of mkdir is OK)
  const parentDir = path.dirname(dir);
  if (fs.existsSync(parentDir)) {
    return { valid: true };
  }

  return {
    valid: false,
    reason: `Parent directory does not exist: ${parentDir}`,
  };
}

/**
 * Validate a certificate target configuration
 */
function validateTarget(target: CertTarget, index: number): { errors: ValidationError[]; warnings: ValidationWarning[] } {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const prefix = `targets[${index}]`;

  // Required fields
  if (!target.certId || typeof target.certId !== 'string') {
    errors.push({ field: `${prefix}.certId`, message: 'Certificate ID is required', value: target.certId });
  }

  if (!target.name || typeof target.name !== 'string') {
    errors.push({ field: `${prefix}.name`, message: 'Target name is required', value: target.name });
  }

  // Outputs validation
  if (!target.outputs || typeof target.outputs !== 'object') {
    errors.push({ field: `${prefix}.outputs`, message: 'At least one output path is required' });
  } else {
    const outputPaths = Object.entries(target.outputs).filter(([, v]) => v);

    if (outputPaths.length === 0) {
      errors.push({ field: `${prefix}.outputs`, message: 'At least one output path must be configured' });
    }

    for (const [key, outputPath] of outputPaths) {
      if (typeof outputPath !== 'string') continue;

      // Check path is absolute
      if (!path.isAbsolute(outputPath)) {
        errors.push({
          field: `${prefix}.outputs.${key}`,
          message: 'Output path must be absolute',
          value: outputPath,
        });
      } else {
        // Check parent directory exists
        const pathCheck = isValidOutputPath(outputPath);
        if (!pathCheck.valid) {
          warnings.push({
            field: `${prefix}.outputs.${key}`,
            message: pathCheck.reason || 'Output directory may not exist',
            suggestion: `Ensure directory exists: mkdir -p ${path.dirname(outputPath)}`,
          });
        }
      }
    }
  }

  // Mode validation
  if (target.mode && !isValidPermissions(target.mode)) {
    errors.push({
      field: `${prefix}.mode`,
      message: 'Invalid permission format. Use octal format like "0640" or "0600"',
      value: target.mode,
    });
  }

  // Owner validation (basic format check)
  if (target.owner && !/^[a-z_][a-z0-9_-]*(:([a-z_][a-z0-9_-]*))?$/i.test(target.owner)) {
    warnings.push({
      field: `${prefix}.owner`,
      message: 'Owner format may be invalid',
      suggestion: 'Use format "user" or "user:group"',
    });
  }

  // Reload command warning
  if (target.reloadCmd) {
    warnings.push({
      field: `${prefix}.reloadCmd`,
      message: 'Reload command will be executed with agent privileges',
      suggestion: 'Ensure command is safe and necessary',
    });
  }

  return { errors, warnings };
}

/**
 * Validate the full agent configuration
 */
export function validateConfig(config: AgentConfig): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Vault URL
  if (!config.vaultUrl) {
    errors.push({ field: 'vaultUrl', message: 'Vault URL is required' });
  } else if (!isValidUrl(config.vaultUrl)) {
    errors.push({ field: 'vaultUrl', message: 'Invalid URL format', value: config.vaultUrl });
  } else if (config.vaultUrl.startsWith('http://')) {
    warnings.push({
      field: 'vaultUrl',
      message: 'Using HTTP instead of HTTPS',
      suggestion: 'Use HTTPS for production deployments',
    });
  }

  // Tenant ID
  if (!config.tenantId) {
    errors.push({ field: 'tenantId', message: 'Tenant ID is required' });
  }

  // Authentication
  if (!config.auth) {
    errors.push({ field: 'auth', message: 'Authentication configuration is required' });
  } else {
    const hasApiKey = !!config.auth.apiKey || !!process.env.ZNVAULT_API_KEY;
    const hasPassword = (!!config.auth.username && !!config.auth.password) ||
                       (!!config.auth.username && !!process.env.ZNVAULT_PASSWORD);

    if (!hasApiKey && !hasPassword) {
      errors.push({
        field: 'auth',
        message: 'Either API key or username/password is required',
      });
    }

    // Warn if credentials in config file
    if (config.auth.apiKey) {
      warnings.push({
        field: 'auth.apiKey',
        message: 'API key stored in config file',
        suggestion: 'Use ZNVAULT_API_KEY environment variable instead',
      });
    }
    if (config.auth.password) {
      warnings.push({
        field: 'auth.password',
        message: 'Password stored in config file',
        suggestion: 'Use ZNVAULT_PASSWORD environment variable instead',
      });
    }
  }

  // Insecure mode warning
  if (config.insecure) {
    warnings.push({
      field: 'insecure',
      message: 'TLS verification is disabled',
      suggestion: 'Enable TLS verification for production deployments',
    });
  }

  // Targets
  if (!config.targets || !Array.isArray(config.targets)) {
    warnings.push({
      field: 'targets',
      message: 'No certificate targets configured',
      suggestion: 'Add targets using: zn-vault-agent add <cert-id>',
    });
  } else if (config.targets.length === 0) {
    warnings.push({
      field: 'targets',
      message: 'No certificate targets configured',
      suggestion: 'Add targets using: zn-vault-agent add <cert-id>',
    });
  } else {
    for (let i = 0; i < config.targets.length; i++) {
      const targetValidation = validateTarget(config.targets[i], i);
      errors.push(...targetValidation.errors);
      warnings.push(...targetValidation.warnings);
    }
  }

  // Poll interval
  if (config.pollInterval !== undefined) {
    if (typeof config.pollInterval !== 'number' || config.pollInterval < 60) {
      warnings.push({
        field: 'pollInterval',
        message: 'Poll interval is less than 60 seconds',
        suggestion: 'Consider using at least 300 seconds (5 minutes) to reduce load',
      });
    }
  }

  const result = {
    valid: errors.length === 0,
    errors,
    warnings,
  };

  // Log validation results
  if (errors.length > 0) {
    log.error({ errors }, 'Configuration validation failed');
  }
  if (warnings.length > 0) {
    log.warn({ warnings }, 'Configuration has warnings');
  }

  return result;
}

/**
 * Format validation result for display
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.errors.length > 0) {
    lines.push('Errors:');
    for (const error of result.errors) {
      lines.push(`  ✗ ${error.field}: ${error.message}`);
      if (error.value !== undefined) {
        lines.push(`    Value: ${JSON.stringify(error.value)}`);
      }
    }
  }

  if (result.warnings.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`  ⚠ ${warning.field}: ${warning.message}`);
      if (warning.suggestion) {
        lines.push(`    Suggestion: ${warning.suggestion}`);
      }
    }
  }

  if (result.valid && result.warnings.length === 0) {
    lines.push('✓ Configuration is valid');
  } else if (result.valid) {
    lines.push('');
    lines.push('✓ Configuration is valid (with warnings)');
  }

  return lines.join('\n');
}
