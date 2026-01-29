// Path: src/commands/tls.ts
// TLS configuration commands for agent HTTPS server

import type { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { loadConfig, saveConfig, isConfigured } from '../lib/config.js';
import { DEFAULT_TLS_CONFIG } from '../lib/config/types.js';
import { getAgentTLSCA } from '../lib/api.js';
import { getTLSManagerStatus } from '../services/tls-certificate-manager.js';

/**
 * Options for the 'tls enable' command
 */
export interface TLSEnableCommandOptions {
  port?: number;
  renewDays?: number;
  keepHttp?: boolean;
  certPath?: string;
  keyPath?: string;
}

/**
 * Options for the 'tls status' command
 */
export interface TLSStatusCommandOptions {
  json?: boolean;
}

export function registerTLSCommands(program: Command): void {
  const tlsCommand = program
    .command('tls')
    .description('Manage TLS configuration for agent HTTPS server');

  // tls enable
  tlsCommand
    .command('enable')
    .description('Enable TLS for the agent HTTPS server')
    .option('-p, --port <port>', 'HTTPS port (default: 9443)', parseInt)
    .option('-r, --renew-days <days>', 'Renew certificate before expiry (default: 7)', parseInt)
    .option('--keep-http', 'Keep HTTP server running alongside HTTPS (default: true)')
    .option('--no-keep-http', 'Disable HTTP server when HTTPS is enabled')
    .option('--cert-path <path>', 'Path to TLS certificate (for manual mode)')
    .option('--key-path <path>', 'Path to TLS private key (for manual mode)')
    .addHelpText('after', `
Examples:
  # Enable auto-managed TLS (certificate fetched from vault)
  zn-vault-agent tls enable

  # Enable with custom HTTPS port
  zn-vault-agent tls enable --port 8443

  # Enable HTTPS only (disable HTTP)
  zn-vault-agent tls enable --no-keep-http

  # Enable with manual certificate paths
  zn-vault-agent tls enable --cert-path /etc/ssl/agent.crt --key-path /etc/ssl/agent.key

  # Customize auto-renewal threshold
  zn-vault-agent tls enable --renew-days 14

Notes:
  Auto-managed mode requires:
  - Agent registered with vault (has agentId)
  - Tenant has a CA assigned for 'agent-tls' purpose
  - Agent has permission to request certificates

  The agent will automatically:
  - Request a TLS certificate from vault on startup
  - Renew the certificate before expiry
  - Hot-reload the HTTPS server when certificate is renewed
`)
    .action(async (options: TLSEnableCommandOptions) => {
      if (!isConfigured()) {
        console.error(chalk.red('Agent not configured. Run: zn-vault-agent login'));
        process.exit(1);
      }

      const config = loadConfig();

      // Determine mode: manual (explicit paths) or auto (vault-managed)
      const manualMode = options.certPath && options.keyPath;

      if (manualMode) {
        // Validate paths exist
        if (!existsSync(options.certPath!)) {
          console.error(chalk.red(`Certificate file not found: ${options.certPath}`));
          process.exit(1);
        }
        if (!existsSync(options.keyPath!)) {
          console.error(chalk.red(`Key file not found: ${options.keyPath}`));
          process.exit(1);
        }
      }

      // Update config
      config.tls = {
        ...config.tls,
        enabled: true,
        httpsPort: options.port ?? config.tls?.httpsPort ?? DEFAULT_TLS_CONFIG.httpsPort,
        renewBeforeDays: options.renewDays ?? config.tls?.renewBeforeDays ?? DEFAULT_TLS_CONFIG.renewBeforeDays,
        keepHttpServer: options.keepHttp ?? config.tls?.keepHttpServer ?? DEFAULT_TLS_CONFIG.keepHttpServer,
        ...(manualMode ? {
          certPath: options.certPath,
          keyPath: options.keyPath,
        } : {}),
      };

      saveConfig(config);

      console.log();
      console.log(chalk.green.bold('TLS enabled!'));
      console.log();

      if (manualMode) {
        console.log(`  Mode:        ${chalk.cyan('manual')} (using provided certificate)`);
        console.log(`  Certificate: ${options.certPath}`);
        console.log(`  Key:         ${options.keyPath}`);
      } else {
        console.log(`  Mode:        ${chalk.cyan('auto-managed')} (vault-issued certificate)`);
        console.log(`  Certificate: Will be fetched from vault on startup`);
        if (!config.agentId) {
          console.log();
          console.log(chalk.yellow('  Warning: Agent not registered yet.'));
          console.log(chalk.yellow('  The agent will attempt to register on first startup.'));
        }
      }

      console.log(`  HTTPS Port:  ${config.tls?.httpsPort}`);
      console.log(`  Auto-Renew:  ${config.tls?.renewBeforeDays} days before expiry`);
      console.log(`  HTTP Server: ${config.tls?.keepHttpServer ? 'kept' : chalk.gray('disabled')}`);
      console.log();
      console.log(`Restart the agent to apply: ${chalk.cyan('sudo systemctl restart zn-vault-agent')}`);
      console.log();
    });

  // tls disable
  tlsCommand
    .command('disable')
    .description('Disable TLS for the agent HTTPS server')
    .action(async () => {
      if (!isConfigured()) {
        console.error(chalk.red('Agent not configured. Run: zn-vault-agent login'));
        process.exit(1);
      }

      const config = loadConfig();

      if (!config.tls?.enabled) {
        console.log(chalk.yellow('TLS is already disabled.'));
        return;
      }

      // Disable but keep other settings (cert paths, etc.) for easy re-enable
      config.tls = {
        ...config.tls,
        enabled: false,
      };

      saveConfig(config);

      console.log();
      console.log(chalk.green('TLS disabled.'));
      console.log();
      console.log(`Restart the agent to apply: ${chalk.cyan('sudo systemctl restart zn-vault-agent')}`);
      console.log();
    });

  // tls status
  tlsCommand
    .command('status')
    .description('Show TLS configuration and certificate status')
    .option('--json', 'Output as JSON')
    .action(async (options: TLSStatusCommandOptions) => {
      if (!isConfigured()) {
        console.error(chalk.red('Agent not configured. Run: zn-vault-agent login'));
        process.exit(1);
      }

      const config = loadConfig();
      const tlsConfig = config.tls;
      const managerStatus = getTLSManagerStatus();

      if (options.json) {
        console.log(JSON.stringify({
          config: tlsConfig ?? { enabled: false },
          runtime: managerStatus,
        }, null, 2));
        return;
      }

      console.log();
      console.log(chalk.bold('TLS Configuration'));
      console.log();

      if (!tlsConfig?.enabled) {
        console.log(`  Status:      ${chalk.gray('disabled')}`);
        console.log();
        console.log(`Enable TLS: ${chalk.cyan('zn-vault-agent tls enable')}`);
        console.log();
        return;
      }

      const hasExplicitPaths = tlsConfig.certPath && tlsConfig.keyPath;

      console.log(`  Status:      ${chalk.green('enabled')}`);
      console.log(`  Mode:        ${hasExplicitPaths ? chalk.cyan('manual') : chalk.cyan('auto-managed')}`);
      console.log(`  HTTPS Port:  ${tlsConfig.httpsPort ?? 9443}`);
      console.log(`  HTTP Server: ${tlsConfig.keepHttpServer !== false ? 'enabled' : chalk.gray('disabled')}`);
      console.log(`  Auto-Renew:  ${tlsConfig.renewBeforeDays ?? 7} days before expiry`);

      if (hasExplicitPaths) {
        console.log();
        console.log(chalk.bold('Certificate Paths'));
        console.log(`  Certificate: ${tlsConfig.certPath}`);
        console.log(`  Key:         ${tlsConfig.keyPath}`);
      }

      // Show certificate status if available
      if (tlsConfig.agentTlsCertId || managerStatus.certExpiresAt) {
        console.log();
        console.log(chalk.bold('Certificate Status'));

        if (tlsConfig.agentTlsCertId) {
          console.log(`  Cert ID:     ${tlsConfig.agentTlsCertId.substring(0, 8)}...`);
        }

        if (managerStatus.certExpiresAt) {
          const expiresAt = new Date(managerStatus.certExpiresAt);
          const daysLeft = managerStatus.daysUntilExpiry ?? 0;
          const renewThreshold = tlsConfig.renewBeforeDays ?? 7;
          const expiryColor = daysLeft <= renewThreshold ? chalk.yellow : chalk.green;

          console.log(`  Expires:     ${expiresAt.toLocaleDateString()} (${expiryColor(`${Math.ceil(daysLeft)} days`)})`);
        }

        if (managerStatus.lastRenewalAt) {
          console.log(`  Renewed:     ${new Date(managerStatus.lastRenewalAt).toLocaleString()}`);
        }

        if (managerStatus.lastCheckAt) {
          console.log(`  Last Check:  ${new Date(managerStatus.lastCheckAt).toLocaleString()}`);
        }
      }

      // Runtime status
      console.log();
      console.log(chalk.bold('Runtime'));
      console.log(`  Manager:     ${managerStatus.isRunning ? chalk.green('running') : chalk.gray('stopped')}`);
      console.log(`  Cert Path:   ${managerStatus.certPath}`);
      console.log(`  Key Path:    ${managerStatus.keyPath}`);

      console.log();
    });

  // tls ca
  tlsCommand
    .command('ca')
    .description('Fetch and display the CA certificate for TLS verification')
    .option('--raw', 'Output raw PEM without formatting')
    .action(async (options: { raw?: boolean }) => {
      if (!isConfigured()) {
        console.error(chalk.red('Agent not configured. Run: zn-vault-agent login'));
        process.exit(1);
      }

      try {
        const ca = await getAgentTLSCA();

        if (options.raw) {
          console.log(ca.certificate);
          return;
        }

        console.log();
        console.log(chalk.bold('Agent TLS CA Certificate'));
        console.log();
        console.log(`  CA ID:       ${ca.caId.substring(0, 8)}...`);
        console.log(`  Subject:     ${ca.subjectCn}`);
        console.log(`  Fingerprint: ${ca.fingerprintSha256.substring(0, 16)}...`);
        console.log(`  Valid From:  ${new Date(ca.notBefore).toLocaleDateString()}`);
        console.log(`  Valid Until: ${new Date(ca.notAfter).toLocaleDateString()}`);
        console.log();
        console.log(chalk.bold('PEM Certificate:'));
        console.log();
        console.log(ca.certificate);
        console.log();
        console.log(chalk.gray('Use this CA certificate to verify connections to agents.'));
        console.log(chalk.gray(`Save with: ${chalk.cyan('zn-vault-agent tls ca --raw > ca.crt')}`));
        console.log();
      } catch (err) {
        console.error(chalk.red('Failed to fetch CA certificate:'), err instanceof Error ? err.message : String(err));
        console.error();
        console.error(chalk.yellow('Ensure your tenant has a CA assigned for agent TLS.'));
        process.exit(1);
      }
    });
}
