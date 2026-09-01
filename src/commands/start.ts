// Path: src/commands/start.ts
// Start command - runs the agent daemon

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  isConfigured,
  loadConfig,
  loadPersistedConfig,
  getTargets,
  getSecretTargets,
  isManagedKeyMode,
  setConfigInMemory,
  fetchConfigFromVault,
  isConfigFromVaultEnabled,
  discoverAgentIdentity,
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
import { loadUpdateConfig } from '../services/npm-auto-update.js';
import { buildAutoUpdateService } from '../services/auto-update-builder.js';
import { PluginAutoUpdateService, loadPluginUpdateConfig } from '../services/plugin-auto-update.js';
import {
  inspectConfiguredPayaraManifest,
  inspectPayaraStartupPreflight,
} from '../plugins/loader.js';
import type { PluginConfig } from '../plugins/types.js';
import {
  PAYARA_PLUGIN_PACKAGE,
  inspectPayaraPostUpdateRecoveryEvidence,
} from '../services/plugin-update-rail.js';
import { parseSecretMapping, isSensitiveEnvVar, type ExecSecret } from '../lib/secret-env.js';
import type { StartCommandOptions } from './types.js';

// Helper to collect repeatable options
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** Keep only the local transport/control state needed by the exact recovery updater. */
export function buildPayaraRecoveryConfig(config: AgentConfig): AgentConfig {
  const recoveryPlugin: PluginConfig = {
    package: PAYARA_PLUGIN_PACKAGE,
    enabled: true,
    autoUpdate: {
      enabled: false,
    },
  };
  return {
    ...config,
    targets: [],
    secretTargets: [],
    exec: undefined,
    globalReloadCmd: undefined,
    plugins: [recoveryPlugin],
  };
}

/**
 * Re-run the complete persisted authority preflight while a synthetic
 * post-update process remains status-only. Success means Vault returned a full
 * configuration body; callers still restart before using it.
 */
export async function probeFullVaultConfigurationAuthority(): Promise<boolean> {
  let config = loadPersistedConfig();
  if (!isConfigFromVaultEnabled(config)) return false;

  if (needsBootstrapRegistration(config)) {
    try {
      const registration = await exchangeBootstrapToken(config);
      config = applyRegistrationResult(config, registration);
      saveConfig(config);
    } catch (err) {
      logger.warn({ err }, 'Post-update authority bootstrap probe failed');
      return false;
    }
  }

  const apiKey = process.env.ZNVAULT_API_KEY ?? config.auth.apiKey;
  if (!apiKey) return false;
  if (!config.agentId) {
    try {
      const identity = await discoverAgentIdentity({
        vaultUrl: config.vaultUrl,
        apiKey,
        hostname: config.hostname,
        tenantId: config.tenantId,
        insecure: config.insecure,
      });
      if (identity) {
        config = { ...config, agentId: identity.agentId };
        try {
          saveConfig(config);
        } catch (err) {
          logger.warn({ err }, 'Could not persist identity during post-update authority probe');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Post-update authority identity probe failed; trying full config fetch');
    }
  }

  const result = await fetchConfigFromVault({
    vaultUrl: config.vaultUrl,
    apiKey,
    insecure: config.insecure,
    agentId: config.agentId,
    hostConfigId: config.hostConfigId,
    // Pending startup confirmation must receive the actual remote plugin
    // declaration; an unqualified 304 is not sufficient.
    configVersion: undefined,
  });
  return result.success && result.modified !== false && result.config !== undefined;
}

export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('Start the certificate sync daemon')
    .option('-v, --verbose', 'Enable verbose logging')
    .option('--health-port <port>', 'Health/metrics HTTP server port (default: disabled)', parseInt)
    .option('--health-host <host>', 'HTTP/HTTPS bind host (default: 127.0.0.1; 0.0.0.0 exposes public monitoring routes, while control/plugin routes still require the local Bearer credential)')
    .option('--validate', 'Validate configuration before starting')
    .option('--foreground', 'Run in foreground (default)')
    .option('--auto-update', 'Allow automatic updates when explicitly enabled by configuration')
    .option('--no-auto-update', 'Disable automatic updates')
    .option('--plugin-auto-update', 'Allow automatic plugin updates when explicitly enabled by configuration')
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
    // TLS options for HTTPS health server
    .option('--tls', 'Enable HTTPS health server')
    .option('--tls-cert <path>', 'Path to TLS certificate (PEM format)')
    .option('--tls-key <path>', 'Path to TLS private key (PEM format)')
    .option('--tls-https-port <port>', 'HTTPS port (default: 9443)', parseInt)
    .option('--no-tls-keep-http', 'Disable HTTP server when HTTPS is enabled')
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
    -F ZINC_CONFIG_VAULT_API_KEY=api-key:my-key \\
    -F AWS_SECRET_ACCESS_KEY=alias:aws.secretKey \\
    --health-port 9100

  # Auto-detect sensitive secrets and write to files
  zn-vault-agent start \\
    --exec "python server.py" \\
    -s ZINC_CONFIG_USE_VAULT=literal:true \\
    -s ZINC_CONFIG_VAULT_API_KEY=api-key:my-key \\
    --secrets-to-files \\
    --health-port 9100

  # Enable HTTPS health server with TLS
  zn-vault-agent start \\
    --health-port 9100 \\
    --tls --tls-cert /etc/znvault/tls.crt --tls-key /etc/znvault/tls.key

  # HTTPS only (disable HTTP server)
  zn-vault-agent start \\
    --tls --tls-cert /etc/znvault/tls.crt --tls-key /etc/znvault/tls.key \\
    --no-tls-keep-http

  # Production setup (systemd)
  # See docs/GUIDE.md for systemd service file
`)
    .action(async (options: StartCommandOptions) => {
      let config = loadConfig();
      const vaultConfigAuthority = isConfigFromVaultEnabled(config);
      // A pending startup-confirmation tuple requires a complete authoritative
      // response on the next normal boot. A 304 cannot safely validate a local
      // bootstrap file that may never have contained the remote plugin list.
      // Invalid local evidence still cannot block a healthy remote authority;
      // it only makes the fetch unconditional and is surfaced if fallback is
      // later required.
      let requireFullAuthorityConfig = false;
      if (vaultConfigAuthority) {
        try {
          requireFullAuthorityConfig = inspectPayaraPostUpdateRecoveryEvidence() !== null;
        } catch (err) {
          requireFullAuthorityConfig = true;
          logger.warn(
            { err },
            'Local Payara post-update evidence is invalid; requiring a full authoritative config'
          );
        }
      }
      const preflightManifest = inspectPayaraStartupPreflight(config);
      const recoveryCandidateVersion = preflightManifest.recoveryRequired
        ? preflightManifest.version
        : undefined;
      let expectedPayaraRecoveryVersion: string | undefined;
      let expectedPayaraPostUpdateRecoveryVersion: string | undefined;
      let postUpdateAuthorityProbe: (() => Promise<boolean>) | undefined;
      const payaraRecoverySelected = (): boolean =>
        expectedPayaraRecoveryVersion !== undefined
        || expectedPayaraPostUpdateRecoveryVersion !== undefined;
      const activatePayaraRecovery = (reason: string, err?: unknown): boolean => {
        if (recoveryCandidateVersion) {
          config = buildPayaraRecoveryConfig(config);
          setConfigInMemory(config);
          expectedPayaraRecoveryVersion = recoveryCandidateVersion;
          logger.error(
            {
              package: PAYARA_PLUGIN_PACKAGE,
              version: expectedPayaraRecoveryVersion,
              reason,
              ...(err === undefined ? {} : { err }),
            },
            'UPDATE_REQUIRED fallback: exact Payara recovery selected'
          );
          return true;
        }

        // An installed major 3 alone is never authority. Only the exact,
        // root-attested 2 -> 3 operation tuple may keep its status endpoint
        // alive while config-from-Vault is temporarily unavailable.
        if (!vaultConfigAuthority) return false;
        const evidence = inspectPayaraPostUpdateRecoveryEvidence();
        if (!evidence) return false;

        const recoveryConfig = buildPayaraRecoveryConfig(config);
        const installedManifest = inspectConfiguredPayaraManifest(recoveryConfig);
        if (
          !installedManifest.configured
          || installedManifest.recoveryRequired
          || installedManifest.version !== evidence.targetVersion
        ) {
          throw new Error(
            'Installed Payara post-update manifest does not match the root-attested target'
          );
        }

        postUpdateAuthorityProbe = probeFullVaultConfigurationAuthority;
        config = recoveryConfig;
        setConfigInMemory(config);
        expectedPayaraPostUpdateRecoveryVersion = evidence.targetVersion;
        logger.error(
          {
            package: PAYARA_PLUGIN_PACKAGE,
            requestId: evidence.requestId,
            previousVersion: evidence.previousVersion,
            version: evidence.targetVersion,
            reason,
            ...(err === undefined ? {} : { err }),
          },
          'STARTUP_CONFIRMATION_PENDING fallback: root-attested Payara target selected'
        );
        return true;
      };

      // Local configuration is authoritative, so an explicitly configured
      // exact 2.x package may enter recovery immediately. In config-from-Vault
      // mode the same installed manifest is only a fallback candidate: the
      // remote authority must win whenever it can answer.
      if (!vaultConfigAuthority && recoveryCandidateVersion) {
        activatePayaraRecovery('authoritative local configuration requires Payara 2.x recovery');
      }

      // Normal operation requires Vault authentication. Exact Payara recovery
      // authenticates its bounded local control plane with the separate token
      // file and must remain available even when Vault credentials are broken.
      if (!payaraRecoverySelected() && !isConfigured()) {
        if (!vaultConfigAuthority || !activatePayaraRecovery('remote configuration cannot be authenticated')) {
          console.error(chalk.red('Not configured. Run: zn-vault-agent login'));
          process.exit(1);
        }
      }

      // ========================================================================
      // Bootstrap Registration (one-command deployment)
      // ========================================================================
      // If config has a bootstrap token but no API key, register with vault first
      if (!payaraRecoverySelected() && needsBootstrapRegistration(config)) {
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
          if (!vaultConfigAuthority || !activatePayaraRecovery('bootstrap registration failed', err)) {
            console.error(chalk.red('Bootstrap registration failed:'), err instanceof Error ? err.message : String(err));
            console.error(chalk.yellow('Hint: Ensure the vault server is reachable and your bootstrap token is valid.'));
            logger.error({ err }, 'Bootstrap registration failed');
            process.exit(1);
          }
        }
      }

      // Config-from-vault mode: fetch config from vault server at startup
      if (!payaraRecoverySelected() && isConfigFromVaultEnabled(config)) {
        // Auto-discover agent ID if not set (enables linking to host config)
        if (!config.agentId && config.auth?.apiKey) {
          console.log(chalk.cyan('Discovering agent identity from vault...'));
          let identity: Awaited<ReturnType<typeof discoverAgentIdentity>> = null;
          try {
            identity = await discoverAgentIdentity({
              vaultUrl: config.vaultUrl,
              apiKey: config.auth.apiKey,
              hostname: config.hostname,
              tenantId: config.tenantId,
              insecure: config.insecure,
            });
          } catch (err) {
            // Identity discovery is best-effort. The authoritative config
            // request can still succeed by hostConfigId or hostname and must
            // be attempted before considering the installed 2.x fallback.
            logger.warn({ err }, 'Agent identity discovery failed; continuing to config fetch');
          }

          if (identity) {
            config.agentId = identity.agentId;
            console.log(chalk.green(`Agent ID discovered: ${identity.agentId}`));
            logger.info({ agentId: identity.agentId }, 'Agent ID discovered from vault');

            // Persist agentId to config so future restarts don't need to discover
            try {
              saveConfig({
                ...config,
                agentId: identity.agentId,
              });
              logger.debug({ agentId: identity.agentId }, 'Agent ID persisted to config');
            } catch (err) {
              // Non-fatal: we can still proceed without persisting
              logger.warn({ err }, 'Failed to persist agentId to config');
            }
          } else {
            console.log(chalk.yellow('Agent ID not found (agent may need to connect once first)'));
            logger.debug('Agent identity not found, will continue without agentId');
          }
        }

        console.log(chalk.cyan('Config-from-vault mode enabled, fetching config from vault...'));
        logger.info({ vaultUrl: config.vaultUrl }, 'Fetching config from vault');

        let result: Awaited<ReturnType<typeof fetchConfigFromVault>>;
        try {
          result = await fetchConfigFromVault({
            vaultUrl: config.vaultUrl,
            apiKey: config.auth.apiKey ?? '',
            insecure: config.insecure,
            agentId: config.agentId,
            hostConfigId: config.hostConfigId,
            configVersion: requireFullAuthorityConfig ? undefined : config.configVersion,
          });
        } catch (err) {
          if (!activatePayaraRecovery('remote configuration request threw', err)) {
            throw err;
          }
          result = { success: false, error: err instanceof Error ? err.message : String(err) };
        }

        if (
          result.success
          && requireFullAuthorityConfig
          && (result.modified === false || result.config === undefined)
        ) {
          result = {
            success: false,
            error: 'Full authoritative config required while Payara startup confirmation is pending',
          };
        }

        if (!result.success) {
          if (!payaraRecoverySelected()
            && !activatePayaraRecovery('remote configuration request failed', result.error)) {
            console.error(chalk.red('Failed to fetch config from vault:'), result.error);
            console.error(chalk.yellow('Hint: Ensure the vault server is reachable and your API key is valid.'));
            logger.error({ error: result.error }, 'Failed to fetch config from vault');
            process.exit(1);
          }
        } else if (result.config) {
          // Merge vault config with local config (keep local auth and managed key file settings)
          config = {
            ...result.config,
            auth: config.auth, // Keep local auth
            agentId: config.agentId, // Keep local agent ID
            // Merge managedKey: vault provides key name, local provides file write settings
            managedKey: result.config.managedKey ? {
              ...config.managedKey,  // Local settings (filePath, fileOwner, fileMode)
              ...result.config.managedKey,  // Vault settings (name, rotation metadata)
            } : config.managedKey,
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

      // Inspect the installed Payara manifest before constructing or starting
      // either background updater. Exact 2.x runs as a recovery-only control
      // plane, where Agent self-update and periodic plugin polling are both
      // forbidden; only the exact manual Payara 2 -> 3 rail remains available.
      const payaraManifest = inspectConfiguredPayaraManifest(config);
      if (
        expectedPayaraRecoveryVersion
        && (!payaraManifest.recoveryRequired
          || payaraManifest.version !== expectedPayaraRecoveryVersion)
      ) {
        throw new Error('Installed Payara recovery manifest changed during startup');
      }
      if (
        expectedPayaraPostUpdateRecoveryVersion
        && (!payaraManifest.configured
          || payaraManifest.recoveryRequired
          || payaraManifest.version !== expectedPayaraPostUpdateRecoveryVersion)
      ) {
        throw new Error('Installed Payara post-update manifest changed during startup');
      }
      if (payaraManifest.recoveryRequired) {
        if (!payaraManifest.version) {
          throw new Error('Installed Payara recovery manifest has no exact version');
        }
        expectedPayaraRecoveryVersion = payaraManifest.version;
      }
      const payaraRecoveryOnly = payaraManifest.recoveryRequired
        || expectedPayaraPostUpdateRecoveryVersion !== undefined;

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
            console.error(chalk.red('Invalid secret mapping'));
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
          }
        }

        // Parse -F/--secret-file mappings (always write to files)
        for (const mapping of options.secretFile ?? []) {
          try {
            secrets.push(createExecSecret(mapping, true));
          } catch (err) {
            console.error(chalk.red('Invalid secret-file mapping'));
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
        const healthHost = options.healthHost ?? '127.0.0.1';
        console.log(`  Health:      http://${healthHost}:${options.healthPort}/health`);
        console.log(`  Metrics:     http://${healthHost}:${options.healthPort}/metrics`);
      }

      // TLS status (from CLI options or config)
      const tlsEnabled = options.tls ?? config.tls?.enabled ?? false;
      const tlsCertPath = options.tlsCert ?? config.tls?.certPath;
      const tlsKeyPath = options.tlsKey ?? config.tls?.keyPath;
      const tlsHttpsPort = options.tlsHttpsPort ?? config.tls?.httpsPort ?? 9443;
      const tlsKeepHttp = options.tlsKeepHttp ?? config.tls?.keepHttpServer ?? true;
      const tlsRenewBeforeDays = config.tls?.renewBeforeDays ?? 7;

      if (tlsEnabled) {
        const hasExplicitPaths = tlsCertPath && tlsKeyPath;
        const hasExistingCert = config.tls?.agentTlsCertId;

        if (hasExplicitPaths) {
          // Using explicit cert paths (manual mode)
          console.log(`  TLS Mode:    ${chalk.green('manual')} (using provided certificate paths)`);
          console.log(`  HTTPS:       https://0.0.0.0:${tlsHttpsPort}/health`);
          console.log(`  Cert Path:   ${tlsCertPath}`);
          console.log(`  Key Path:    ${tlsKeyPath}`);
        } else if (hasExistingCert) {
          // Auto-managed with existing cert
          const expiresAt = config.tls?.certExpiresAt ? new Date(config.tls.certExpiresAt) : null;
          const daysLeft = expiresAt ? Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)) : null;
          console.log(`  TLS Mode:    ${chalk.cyan('auto-managed')} (vault-issued certificate)`);
          console.log(`  HTTPS:       https://0.0.0.0:${tlsHttpsPort}/health`);
          if (expiresAt && daysLeft !== null) {
            const expiryColor = daysLeft <= tlsRenewBeforeDays ? chalk.yellow : chalk.green;
            console.log(`  Cert Expiry: ${expiresAt.toLocaleDateString()} (${expiryColor(`${daysLeft} days`)})`);
          }
          console.log(`  Auto-Renew:  ${tlsRenewBeforeDays} days before expiry`);
        } else {
          // Auto-fetch mode - will request cert from vault on startup
          console.log(`  TLS Mode:    ${chalk.cyan('auto-managed')} (will fetch from vault)`);
          console.log(`  HTTPS:       https://0.0.0.0:${tlsHttpsPort}/health ${chalk.gray('(pending cert)')}`);
          console.log(`  Auto-Renew:  ${tlsRenewBeforeDays} days before expiry`);
        }

        if (!tlsKeepHttp && !options.healthPort) {
          console.log(`  HTTP:        ${chalk.gray('disabled')}`);
        }
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
      const autoUpdateEnabled = options.autoUpdate !== false
        && updateConfig.enabled
        && !payaraRecoveryOnly;
      const autoUpdateStatus = autoUpdateEnabled
        ? chalk.green('enabled')
        : payaraRecoveryOnly
          ? expectedPayaraPostUpdateRecoveryVersion
            ? 'disabled (STARTUP_CONFIRMATION_PENDING recovery)'
            : 'disabled (UPDATE_REQUIRED recovery)'
          : 'disabled (manual trigger available)';
      console.log(`  Auto-update: ${autoUpdateStatus}`);

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
      const pluginConfigs = config.plugins ?? [];
      const enabledPlugins = pluginConfigs.filter(p => p.enabled !== false);
      if (enabledPlugins.length > 0) {
        const pluginUpdateEnabled = options.pluginAutoUpdate !== false
          && loadPluginUpdateConfig().enabled
          && !payaraRecoveryOnly;
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

      // Always construct the auto-update service so operator-initiated updates
      // (POST /agent/update + the WebSocket update-available trigger) have a
      // non-null service to call. Only the periodic checker is gated on the
      // auto-update flag — automatic npm-polling stays off by default (FIX A).
      if (autoUpdateEnabled) {
        logger.info('Starting npm-based auto-update service');
      } else if (payaraRecoveryOnly) {
        logger.info('Agent auto-update disabled by UPDATE_REQUIRED recovery fence');
      } else {
        logger.info('Auto-update periodic checker disabled; manual trigger available');
      }
      const { service: autoUpdateService } = buildAutoUpdateService(
        updateConfig,
        autoUpdateEnabled,
        payaraRecoveryOnly
      );

      // Always expose the exact manual Payara updater when Payara is configured.
      // Only periodic registry polling is gated by config/CLI flags.
      let pluginAutoUpdateService: PluginAutoUpdateService | null = null;
      const pluginUpdateConfig = loadPluginUpdateConfig();
      pluginUpdateConfig.enabled = options.pluginAutoUpdate !== false
        && pluginUpdateConfig.enabled
        && !payaraRecoveryOnly;
      const payaraConfigured = pluginConfigs.some(
        plugin => plugin.package === PAYARA_PLUGIN_PACKAGE && plugin.enabled !== false
      );
      if (payaraConfigured) {
        logger.info(
          { periodicEnabled: pluginUpdateConfig.enabled },
          'Starting exact Payara plugin updater service'
        );
        pluginAutoUpdateService = new PluginAutoUpdateService(pluginConfigs, pluginUpdateConfig);
        pluginAutoUpdateService.start();
      }

      try {
        await startDaemon({
          verbose: options.verbose,
          healthPort: options.healthPort,
          healthHost: options.healthHost,
          exec: execConfig,
          pluginAutoUpdateService,
          npmAutoUpdateService: autoUpdateService,
          configFromVault: isConfigFromVaultEnabled(config),
          expectedPayaraRecoveryVersion,
          expectedPayaraPostUpdateRecoveryVersion,
          postUpdateAuthorityProbe,
          // TLS options
          tls: tlsEnabled ? {
            enabled: tlsEnabled,
            certPath: tlsCertPath,
            keyPath: tlsKeyPath,
            httpsPort: tlsHttpsPort,
            keepHttpServer: tlsKeepHttp,
          } : undefined,
        });
      } catch (err) {
        logger.error({ err }, 'Daemon error');
        console.error(chalk.red('Daemon error:'), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
