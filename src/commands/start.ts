// Path: src/commands/start.ts
// Start command - runs the agent daemon

import { Command } from 'commander';
import chalk from 'chalk';
import { isConfigured, loadConfig, getTargets } from '../lib/config.js';
import { validateConfig, formatValidationResult } from '../lib/validation.js';
import { startDaemon } from '../lib/websocket.js';
import { logger } from '../lib/logger.js';
import { NpmAutoUpdateService, loadUpdateConfig } from '../services/npm-auto-update.js';

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

      // Warn if no targets
      if (targets.length === 0) {
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

      // Auto-update status
      const updateConfig = loadUpdateConfig();
      const autoUpdateEnabled = options.autoUpdate !== false && updateConfig.enabled;
      console.log(`  Auto-update: ${autoUpdateEnabled ? chalk.green('enabled') : 'disabled'}`);
      console.log();

      if (targets.length > 0) {
        console.log(chalk.gray('Subscribed certificates:'));
        for (const target of targets) {
          console.log(`  - ${target.name} (${target.certId.substring(0, 8)}...)`);
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
        });
      } catch (err) {
        logger.error({ err }, 'Daemon error');
        console.error(chalk.red('Daemon error:'), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
