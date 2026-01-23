// Path: src/commands/start.ts
// Start command - runs the agent daemon

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  isConfigured,
  loadConfig,
  getTargets,
  getSecretTargets,
  isManagedKeyMode,
  setConfigInMemory,
  fetchConfigFromVault,
  isConfigFromVaultEnabled,
  saveConfig,
  type ExecConfig,
  type AgentConfig,
  DEFAULT_EXEC_CONFIG,
} from '../lib/config.js';
import { validateConfig, formatValidationResult } from '../lib/validation.js';
import { startDaemon } from '../lib/websocket.js';
import { logger } from '../lib/logger.js';
import {
  needsBootstrapRegistration,
  exchangeBootstrapToken,
  applyRegistrationResult,
} from '../lib/auth/bootstrap.js';
import { NpmAutoUpdateService, loadUpdateConfig } from '../services/npm-auto-update.js';
import { PluginAutoUpdateService, loadPluginUpdateConfig } from '../services/plugin-auto-update.js';
import { parseSecretMapping, isSensitiveEnvVar, type ExecSecret } from '../lib/secret-env.js';
import type { StartCommandOptions } from './types.js';

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
    .option('--plugin-auto-update', 'Enable automatic plugin updates (default: enabled)')
    .option('--no-plugin-auto-update', 'Disable automatic plugin updates')
    // Exec mode options
    .option('--exec <command>', 'Command to execute with secrets (combined mode)')
    .option('-s, --secret <mapping>', 'Secret mapping for exec (ENV=secret, repeatable)', collect, [])
    .option('-F, --secret-file <mapping>', 'Secret written to file instead of env var (ENV=secret, repeatable)', collect, [])
    .option('--secrets-to-files', 'Auto-detect sensitive secrets and write to files instead of env vars')
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

  # SECURE MODE: Write sensitive secrets to files instead of env vars
  # This prevents secrets from appearing in sudo logs or journald
  zn-vault-agent start \\
    --exec "python server.py" \\
    -s ZINC_CONFIG_USE_VAULT=literal:true \\
    -sf ZINC_CONFIG_VAULT_API_KEY=api-key:my-key \\
    -sf AWS_SECRET_ACCESS_KEY=alias:aws.secretKey \\
    --health-port 9100

  # Auto-detect sensitive secrets and write to files
  zn-vault-agent start \\
    --exec "python server.py" \\
    -s ZINC_CONFIG_USE_VAULT=literal:true \\
    -s ZINC_CONFIG_VAULT_API_KEY=api-key:my-key \\
    --secrets-to-files \\
    --health-port 9100

  # Production setup (systemd)
  # See docs/GUIDE.md for systemd service file
`)
    .action(async (options: StartCommandOptions) => {
      // Check configuration
      if (!isConfigured()) {
        console.error(chalk.red('Not configured. Run: zn-vault-agent login'));
        process.exit(1);
      }

      let config = loadConfig();

      // ========================================================================
      // Bootstrap Registration (one-command deployment)
      // ========================================================================
      // If config has a bootstrap token but no API key, register with vault first
      if (needsBootstrapRegistration(config)) {
        console.log(chalk.cyan('Bootstrap mode detected, registering with vault...'));
        logger.info({ vaultUrl: config.vaultUrl, hostname: config.hostname }, 'Starting bootstrap registration');

        try {
          const result = await exchangeBootstrapToken(config);

          // Apply registration result to config
          config = applyRegistrationResult(config, result);

          // Persist updated config (removes bootstrap token, adds API key)
          saveConfig(config);

          console.log(chalk.green('Registration successful!'));
          console.log(`  Agent ID:    ${result.agentId}`);
          console.log(`  Tenant:      ${result.tenantId}`);
          if (result.managedKeyName) {
            console.log(`  Managed Key: ${result.managedKeyName}`);
          }
          console.log();

          logger.info(
            {
              agentId: result.agentId,
              tenantId: result.tenantId,
              hostConfigId: result.hostConfigId,
              managedKeyName: result.managedKeyName,
            },
            'Bootstrap registration complete, config persisted'
          );
        } catch (err) {
          console.error(chalk.red('Bootstrap registration failed:'), err instanceof Error ? err.message : String(err));
          console.error(chalk.yellow('Hint: Ensure the vault server is reachable and your bootstrap token is valid.'));
          logger.error({ err }, 'Bootstrap registration failed');
          process.exit(1);
        }
      }

      // Config-from-vault mode: fetch config from vault server at startup
      if (isConfigFromVaultEnabled(config)) {
        console.log(chalk.cyan('Config-from-vault mode enabled, fetching config from vault...'));
        logger.info({ vaultUrl: config.vaultUrl }, 'Fetching config from vault');

        const result = await fetchConfigFromVault({
          vaultUrl: config.vaultUrl,
          apiKey: config.auth.apiKey ?? '',
          insecure: config.insecure,
          agentId: config.agentId,
          configVersion: config.configVersion,
        });

        if (!result.success) {
          console.error(chalk.red('Failed to fetch config from vault:'), result.error);
          console.error(chalk.yellow('Hint: Ensure the vault server is reachable and your API key is valid.'));
          logger.error({ error: result.error }, 'Failed to fetch config from vault');
          process.exit(1);
        }

        if (result.config) {
          // Merge vault config with local auth (keep local API key)
          config = {
            ...result.config,
            auth: config.auth, // Keep local auth
            agentId: config.agentId, // Keep local agent ID
          };

          // Update in-memory config for daemon (don't persist to disk)
          setConfigInMemory(config);

          console.log(chalk.green(`Config fetched from vault (version ${result.version})`));
          logger.info({
            version: result.version,
            targets: config.targets?.length ?? 0,
            secretTargets: config.secretTargets?.length ?? 0,
            plugins: (config as AgentConfig & { plugins?: unknown[] }).plugins?.length ?? 0,
          }, 'Config loaded from vault');
        } else if (!result.modified) {
          console.log(chalk.gray('Config unchanged (using cached version)'));
          logger.debug({ version: result.version }, 'Config not modified');
        }
      }

      const targets = getTargets();
      const secretTargets = getSecretTargets();

      // Build exec config from CLI options or config file
      let execConfig: ExecConfig | undefined;

      if (options.exec) {
        // CLI options take precedence
        const secrets: ExecSecret[] = [];
        const autoFileMode = options.secretsToFiles === true;

        // Helper to create ExecSecret from parsed mapping
        const createExecSecret = (mapping: string, forceFile: boolean): ExecSecret => {
          const parsed = parseSecretMapping(mapping);
          const shouldOutputToFile = forceFile || (autoFileMode && isSensitiveEnvVar(parsed.envVar));

          if (parsed.literal !== undefined) {
            return { env: parsed.envVar, literal: parsed.literal, outputToFile: shouldOutputToFile };
          } else if (parsed.apiKeyName) {
            // Managed API key reference (api-key:name format)
            return { env: parsed.envVar, apiKey: parsed.apiKeyName, outputToFile: shouldOutputToFile };
          } else {
            // Reconstruct the secret reference (with key if present)
            const secretRef = parsed.key
              ? `${parsed.secretId}.${parsed.key}`
              : parsed.secretId;
            return { env: parsed.envVar, secret: secretRef, outputToFile: shouldOutputToFile };
          }
        };

        // Parse -s/--secret mappings (env vars by default, or files if --secrets-to-files)
        for (const mapping of options.secret ?? []) {
          try {
            secrets.push(createExecSecret(mapping, false));
          } catch (err) {
            console.error(chalk.red('Invalid secret mapping:'), mapping);
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
          }
        }

        // Parse -F/--secret-file mappings (always write to files)
        for (const mapping of options.secretFile ?? []) {
          try {
            secrets.push(createExecSecret(mapping, true));
          } catch (err) {
            console.error(chalk.red('Invalid secret-file mapping:'), mapping);
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
      if (targets.length === 0 && secretTargets.length === 0 && !execConfig) {
        console.log(chalk.yellow('Warning: No certificate or secret targets configured.'));
        console.log('Run ' + chalk.cyan('zn-vault-agent add') + ' to add certificates to sync.');
        console.log();
      }

      // Set log level based on verbose flag
      if (options.verbose) {
        process.env.LOG_LEVEL = 'debug';
      }

      // Print startup banner
      console.log();
      console.log(chalk.bold('ZnVault Certificate Agent'));
      console.log();
      console.log(`  Vault:       ${config.vaultUrl}`);
      console.log(`  Tenant:      ${config.tenantId}`);
      if (isConfigFromVaultEnabled(config)) {
        console.log(`  Config:      ${chalk.cyan('from vault')} (version ${config.configVersion ?? 0})`);
      }
      console.log(`  Certs:       ${targets.length} certificate(s)`);
      console.log(`  Secrets:     ${secretTargets.length} secret(s)`);
      console.log(`  Poll:        every ${config.pollInterval ?? 3600}s`);
      if (options.healthPort) {
        console.log(`  Health:      http://0.0.0.0:${options.healthPort}/health`);
        console.log(`  Metrics:     http://0.0.0.0:${options.healthPort}/metrics`);
      }

      // Auth mode status
      if (isManagedKeyMode()) {
        const nextRotation = config.managedKey?.nextRotationAt
          ? new Date(config.managedKey.nextRotationAt).toLocaleString()
          : 'unknown';
        const keyName = config.managedKey?.name ?? 'unknown';
        console.log(`  Auth:        ${chalk.cyan('Managed API Key')} (${keyName})`);
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

      // Plugin auto-update status (shown later if plugins are configured)

      // Exec mode status
      if (execConfig) {
        console.log(`  Exec:        ${chalk.cyan(execConfig.command.join(' '))}`);
        console.log(`  Exec secrets: ${execConfig.secrets.length} env var(s)`);
        if (execConfig.restartOnChange) {
          console.log(`  Restart:     on cert/secret change (delay: ${execConfig.restartDelayMs ?? 5000}ms)`);
        }
      }

      // Plugin status
      interface PluginConfig {
        package?: string;
        path?: string;
        enabled?: boolean;
        autoUpdate?: { enabled?: boolean };
      }
      const pluginConfigs = ((config as typeof config & { plugins?: PluginConfig[] }).plugins) ?? [];
      const enabledPlugins = pluginConfigs.filter(p => p.enabled !== false);
      if (enabledPlugins.length > 0) {
        const pluginUpdateEnabled = options.pluginAutoUpdate !== false && loadPluginUpdateConfig().enabled;
        console.log(`  Plugins:     ${chalk.cyan(enabledPlugins.length.toString())} configured`);
        console.log(`  Plugin update: ${pluginUpdateEnabled ? chalk.green('enabled') : 'disabled'}`);
      }
      console.log();

      if (targets.length > 0) {
        console.log(chalk.gray('Subscribed certificates:'));
        for (const target of targets) {
          console.log(`  - ${target.name} (${target.certId.substring(0, 8)}...)`);
        }
        console.log();
      }

      if (secretTargets.length > 0) {
        console.log(chalk.gray('Subscribed secrets:'));
        for (const target of secretTargets) {
          console.log(`  - ${target.name} (${target.secretId.substring(0, 8)}...)`);
        }
        console.log();
      }

      // List configured plugins
      if (enabledPlugins.length > 0) {
        console.log(chalk.gray('Configured plugins:'));
        for (const plugin of enabledPlugins) {
          const name = plugin.package ?? plugin.path ?? 'unknown';
          console.log(`  - ${name}`);
        }
        console.log();
      }

      if (execConfig && execConfig.secrets.length > 0) {
        const fileSecrets = execConfig.secrets.filter(s => s.outputToFile);
        const envSecrets = execConfig.secrets.filter(s => !s.outputToFile);

        if (envSecrets.length > 0) {
          console.log(chalk.gray('Exec environment variables:'));
          for (const s of envSecrets) {
            let source: string;
            if (s.literal !== undefined) {
              source = 'literal';
            } else if (s.apiKey) {
              source = `api-key:${s.apiKey}`;
            } else {
              source = s.secret ?? '(unknown)';
            }
            console.log(`  - ${s.env} = ${source}`);
          }
          console.log();
        }

        if (fileSecrets.length > 0) {
          console.log(chalk.gray('Exec secrets (written to files for security):'));
          for (const s of fileSecrets) {
            let source: string;
            if (s.literal !== undefined) {
              source = 'literal';
            } else if (s.apiKey) {
              source = `api-key:${s.apiKey}`;
            } else {
              source = s.secret ?? '(unknown)';
            }
            console.log(`  - ${s.env}_FILE = ${source} ${chalk.green('(secure)')}`);
          }
          console.log();
        }
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

      // Start plugin auto-update service if enabled and plugins are configured
      let pluginAutoUpdateService: PluginAutoUpdateService | null = null;
      const pluginUpdateConfig = loadPluginUpdateConfig();
      const pluginAutoUpdateEnabled = options.pluginAutoUpdate !== false && pluginUpdateConfig.enabled && enabledPlugins.length > 0;
      if (pluginAutoUpdateEnabled) {
        logger.info({ plugins: enabledPlugins.length }, 'Starting plugin auto-update service');
        pluginAutoUpdateService = new PluginAutoUpdateService(pluginConfigs, pluginUpdateConfig);
        pluginAutoUpdateService.start();
      }

      try {
        await startDaemon({
          verbose: options.verbose,
          healthPort: options.healthPort,
          exec: execConfig,
          pluginAutoUpdateService,
          npmAutoUpdateService: autoUpdateService,
          configFromVault: isConfigFromVaultEnabled(config),
        });
      } catch (err) {
        logger.error({ err }, 'Daemon error');
        console.error(chalk.red('Daemon error:'), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
