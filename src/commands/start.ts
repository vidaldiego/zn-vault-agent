// Path: src/commands/start.ts
// Start command - runs the agent daemon

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  isConfigured,
  loadConfig,
  getTargets,
  isManagedKeyMode,
  type ExecConfig,
  DEFAULT_EXEC_CONFIG,
} from '../lib/config.js';
import { validateConfig, formatValidationResult } from '../lib/validation.js';
import { startDaemon } from '../lib/websocket.js';
import { logger } from '../lib/logger.js';
import { NpmAutoUpdateService, loadUpdateConfig } from '../services/npm-auto-update.js';
import { parseSecretMapping, type ExecSecret } from '../lib/secret-env.js';

// Helper to collect repeatable options
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('Start the certificate sync daemon')
    .option('-v, --verbose', 'Enable verbose logging')
    .option('--health-port <port>', 'Health/metrics HTTP server port (default: disabled)', parseInt)
    .option('--validate', 'Validate configuration before starting')
    .option('--foreground', 'Run in foreground (default)')
    .option('--auto-update', 'Enable automatic updates (uses saved config)')
    .option('--no-auto-update', 'Disable automatic updates')
    // Exec mode options
    .option('--exec <command>', 'Command to execute with secrets (combined mode)')
    .option('-s, --secret <mapping>', 'Secret mapping for exec (ENV=secret, repeatable)', collect, [])
    .option('--restart-on-change', 'Restart child on cert/secret changes (default: true)')
    .option('--no-restart-on-change', 'Do not restart child on cert/secret changes')
    .option('--restart-delay <ms>', 'Delay in ms before restarting child (default: 5000)', parseInt)
    .option('--max-restarts <n>', 'Max restarts in window (default: 10)', parseInt)
    .option('--restart-window <ms>', 'Restart count window in ms (default: 300000)', parseInt)
    .addHelpText('after', `
Examples:
  # Start in foreground (default)
  zn-vault-agent start

  # Enable health/metrics endpoint for monitoring
  zn-vault-agent start --health-port 9100

  # Verbose logging for debugging
  zn-vault-agent start --verbose

  # Validate configuration before starting
  zn-vault-agent start --validate

  # With auto-updates enabled
  zn-vault-agent start --health-port 9100 --auto-update

  # Combined mode: cert sync + exec with secrets
  zn-vault-agent start \\
    --exec "payara start-domain domain1" \\
    -s ZINC_CONFIG_USE_VAULT=literal:true \\
    -s ZINC_CONFIG_API_KEY=alias:infra/prod.apiKey \\
    --health-port 9100

  # Production setup (systemd)
  # See docs/GUIDE.md for systemd service file
`)
    .action(async (options) => {
      // Check configuration
      if (!isConfigured()) {
        console.error(chalk.red('Not configured. Run: zn-vault-agent login'));
        process.exit(1);
      }

      const config = loadConfig();
      const targets = getTargets();

      // Build exec config from CLI options or config file
      let execConfig: ExecConfig | undefined;

      if (options.exec) {
        // CLI options take precedence
        const secrets: ExecSecret[] = [];

        // Parse -s/--secret mappings
        for (const mapping of options.secret as string[]) {
          try {
            const parsed = parseSecretMapping(mapping);
            if (parsed.literal !== undefined) {
              secrets.push({ env: parsed.envVar, literal: parsed.literal });
            } else {
              // Reconstruct the secret reference (with key if present)
              const secretRef = parsed.key
                ? `${parsed.secretId}.${parsed.key}`
                : parsed.secretId;
              secrets.push({ env: parsed.envVar, secret: secretRef });
            }
          } catch (err) {
            console.error(chalk.red('Invalid secret mapping:'), mapping);
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
          }
        }

        // Parse exec command (split on spaces if needed)
        const command = options.exec.includes(' ')
          ? options.exec.split(/\s+/)
          : [options.exec];

        execConfig = {
          command,
          secrets,
          inheritEnv: true, // Always inherit for CLI
          restartOnChange: options.restartOnChange !== false,
          restartDelayMs: options.restartDelay ?? DEFAULT_EXEC_CONFIG.restartDelayMs,
          maxRestarts: options.maxRestarts ?? DEFAULT_EXEC_CONFIG.maxRestarts,
          restartWindowMs: options.restartWindow ?? DEFAULT_EXEC_CONFIG.restartWindowMs,
        };
      } else if (config.exec) {
        // Use exec config from config file
        execConfig = config.exec;
      }

      // Validate configuration if requested
      if (options.validate) {
        const result = validateConfig(config);
        console.log(formatValidationResult(result));
        console.log();

        if (!result.valid) {
          console.error(chalk.red('Configuration validation failed. Fix errors before starting.'));
          process.exit(1);
        }
      }

      // Warn if no targets and no exec
      if (targets.length === 0 && !execConfig) {
        console.log(chalk.yellow('Warning: No certificate targets configured.'));
        console.log('Run ' + chalk.cyan('zn-vault-agent add') + ' to add certificates to sync.');
        console.log();
      }

      // Set log level based on verbose flag
      if (options.verbose) {
        process.env.LOG_LEVEL = 'debug';
      }

      // Print startup banner
      console.log();
      console.log(chalk.bold('ZN-Vault Certificate Agent'));
      console.log();
      console.log(`  Vault:       ${config.vaultUrl}`);
      console.log(`  Tenant:      ${config.tenantId}`);
      console.log(`  Targets:     ${targets.length} certificate(s)`);
      console.log(`  Poll:        every ${config.pollInterval || 3600}s`);
      if (options.healthPort) {
        console.log(`  Health:      http://0.0.0.0:${options.healthPort}/health`);
        console.log(`  Metrics:     http://0.0.0.0:${options.healthPort}/metrics`);
      }

      // Auth mode status
      if (isManagedKeyMode()) {
        const nextRotation = config.managedKey?.nextRotationAt
          ? new Date(config.managedKey.nextRotationAt).toLocaleString()
          : 'unknown';
        console.log(`  Auth:        ${chalk.cyan('Managed API Key')} (${config.managedKey?.name})`);
        console.log(`  Key rotates: ${nextRotation}`);
      } else if (config.auth.apiKey) {
        console.log(`  Auth:        API Key`);
      } else {
        console.log(`  Auth:        Username/Password`);
      }

      // Auto-update status
      const updateConfig = loadUpdateConfig();
      const autoUpdateEnabled = options.autoUpdate !== false && updateConfig.enabled;
      console.log(`  Auto-update: ${autoUpdateEnabled ? chalk.green('enabled') : 'disabled'}`);

      // Exec mode status
      if (execConfig) {
        console.log(`  Exec:        ${chalk.cyan(execConfig.command.join(' '))}`);
        console.log(`  Exec secrets: ${execConfig.secrets.length} env var(s)`);
        if (execConfig.restartOnChange) {
          console.log(`  Restart:     on cert/secret change (delay: ${execConfig.restartDelayMs}ms)`);
        }
      }
      console.log();

      if (targets.length > 0) {
        console.log(chalk.gray('Subscribed certificates:'));
        for (const target of targets) {
          console.log(`  - ${target.name} (${target.certId.substring(0, 8)}...)`);
        }
        console.log();
      }

      if (execConfig && execConfig.secrets.length > 0) {
        console.log(chalk.gray('Exec environment variables:'));
        for (const s of execConfig.secrets) {
          const source = s.literal !== undefined ? 'literal' : s.secret;
          console.log(`  - ${s.env} = ${source}`);
        }
        console.log();
      }

      console.log(chalk.gray('Starting daemon...'));
      console.log();

      // Start auto-update service if enabled
      let autoUpdateService: NpmAutoUpdateService | null = null;
      if (autoUpdateEnabled) {
        logger.info('Starting npm-based auto-update service');
        autoUpdateService = new NpmAutoUpdateService(updateConfig);
        autoUpdateService.start();
      }

      try {
        await startDaemon({
          verbose: options.verbose,
          healthPort: options.healthPort,
          exec: execConfig,
        });
      } catch (err) {
        logger.error({ err }, 'Daemon error');
        console.error(chalk.red('Daemon error:'), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
