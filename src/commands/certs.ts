import type { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import {
  addTarget,
  removeTarget,
  getTargets,
  isConfigured,
  type CertTarget,
} from '../lib/config.js';
import { listCertificates, getCertificate } from '../lib/api.js';
import type {
  AvailableCommandOptions,
  CertAddCommandOptions,
  CertRemoveCommandOptions,
} from './types.js';

export function registerCertsCommands(program: Command): void {
  // List available certificates in vault
  program
    .command('available')
    .description('List certificates available in vault')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Examples:
  zn-vault-agent available         # Human-readable list with status
  zn-vault-agent available --json  # JSON output for scripting
`)
    .action(async (options: AvailableCommandOptions) => {
      if (!isConfigured()) {
        console.error(chalk.red('Not configured. Run: zn-vault-agent login'));
        process.exit(1);
      }

      const spinner = ora('Fetching certificates...').start();

      try {
        const result = await listCertificates();
        spinner.stop();

        if (options.json === true) {
          console.log(JSON.stringify(result.items, null, 2));
          return;
        }

        if (result.items.length === 0) {
          console.log('No certificates found in vault');
          return;
        }

        console.log();
        console.log(chalk.bold('Available Certificates'));
        console.log();

        const targets = getTargets();
        const configuredIds = new Set(targets.map(t => t.certId));

        for (const cert of result.items) {
          const configured = configuredIds.has(cert.id);
          const status = configured ? chalk.green('✓ configured') : chalk.gray('not configured');
          const expiry = cert.daysUntilExpiry < 30
            ? chalk.yellow(`${cert.daysUntilExpiry}d`)
            : `${cert.daysUntilExpiry}d`;

          console.log(`  ${cert.id.substring(0, 8)}  ${cert.alias.padEnd(25)} ${status}`);
          console.log(`            ${chalk.gray(cert.subjectCn)} (expires: ${expiry})`);
          console.log();
        }

        console.log(`Total: ${result.total} certificate(s)`);
      } catch (err) {
        spinner.fail('Failed to fetch certificates');
        console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // Add a certificate target
  program
    .command('add')
    .description('Add a certificate to sync')
    .option('-c, --cert <id>', 'Certificate ID or alias')
    .option('-n, --name <name>', 'Local name for this certificate')
    .option('--combined <path>', 'Path for combined cert+key file (HAProxy)')
    .option('--cert-file <path>', 'Path for certificate file')
    .option('--key-file <path>', 'Path for private key file')
    .option('--chain-file <path>', 'Path for CA chain file')
    .option('--fullchain-file <path>', 'Path for fullchain file')
    .option('--owner <user:group>', 'File ownership (e.g., haproxy:haproxy)')
    .option('--mode <mode>', 'File permissions (e.g., 0640)')
    .option('--reload-cmd <cmd>', 'Command to reload service')
    .option('--health-cmd <cmd>', 'Health check command after reload')
    .option('-y, --yes', 'Non-interactive mode (use defaults, skip prompts)')
    .addHelpText('after', `
Examples:
  # Interactive mode (prompts for all options)
  zn-vault-agent add

  # Non-interactive: HAProxy combined cert+key file
  zn-vault-agent add --cert $CERT_ID \\
    --name haproxy-frontend \\
    --combined /etc/haproxy/certs/frontend.pem \\
    --owner haproxy:haproxy --mode 0640 \\
    --reload-cmd "systemctl reload haproxy" \\
    --yes

  # Non-interactive: Nginx separate fullchain and key files
  zn-vault-agent add --cert $CERT_ID \\
    --name nginx-api \\
    --fullchain-file /etc/nginx/ssl/api-fullchain.pem \\
    --key-file /etc/nginx/ssl/api.key \\
    --reload-cmd "nginx -t && systemctl reload nginx" \\
    --yes

  # With health check
  zn-vault-agent add --cert $CERT_ID \\
    --name app-server \\
    --combined /etc/ssl/app.pem \\
    --reload-cmd "systemctl restart app" \\
    --health-cmd "curl -sf http://localhost:8080/health" \\
    --yes
`)
    .action(async (options: CertAddCommandOptions) => {
      if (!isConfigured()) {
        console.error(chalk.red('Not configured. Run: zn-vault-agent login'));
        process.exit(1);
      }

      // Determine if we can run non-interactively
      const hasOutputPath = options.combined ?? options.certFile ?? options.keyFile ?? options.fullchainFile;
      const nonInteractive = options.yes === true && options.cert != null && hasOutputPath != null;

      // If cert ID not provided, show selection
      let certId = options.cert;

      if (!certId) {
        if (options.yes) {
          console.error(chalk.red('--cert is required in non-interactive mode'));
          process.exit(1);
        }

        const spinner = ora('Fetching certificates...').start();
        const result = await listCertificates();
        spinner.stop();

        if (result.items.length === 0) {
          console.log('No certificates found in vault');
          process.exit(1);
        }

        const { selectedCert } = await inquirer.prompt<{ selectedCert: string }>([
          {
            type: 'list',
            name: 'selectedCert',
            message: 'Select certificate to add:',
            choices: result.items.map(c => ({
              name: `${c.alias} (${c.subjectCn}) - expires in ${c.daysUntilExpiry}d`,
              value: c.id,
            })),
          },
        ]);

        certId = selectedCert;
      }

      // At this point certId is guaranteed to be defined
      if (!certId) {
        console.error(chalk.red('No certificate selected'));
        process.exit(1);
      }

      // Get certificate details
      const spinner = ora('Fetching certificate details...').start();
      const cert = await getCertificate(certId);
      spinner.stop();

      if (!nonInteractive) {
        console.log();
        console.log(chalk.bold('Certificate:'), cert.alias);
        console.log(chalk.gray(`Subject: ${cert.subjectCn}`));
        console.log(chalk.gray(`Expires: ${cert.daysUntilExpiry} days`));
        console.log();
      }

      // In non-interactive mode, use provided options directly
      let answers: Record<string, string>;

      if (nonInteractive) {
        // Use defaults and provided options
        answers = {
          name: options.name ?? cert.alias.replace(/[^a-zA-Z0-9-_]/g, '-'),
          outputFormat: options.combined ? 'combined' : 'separate',
          combined: options.combined ?? '',
          certFile: options.certFile ?? '',
          keyFile: options.keyFile ?? '',
          chainFile: options.chainFile ?? '',
          owner: options.owner ?? 'root:root',
          mode: options.mode ?? '0640',
          reloadCmd: options.reloadCmd ?? '',
          healthCmd: options.healthCmd ?? '',
        };
      } else {
        // Gather output configuration interactively
        answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'name',
            message: 'Local name for this target:',
            default: options.name ?? cert.alias.replace(/[^a-zA-Z0-9-_]/g, '-'),
          },
          {
            type: 'list',
            name: 'outputFormat',
            message: 'Output format:',
            choices: [
              { name: 'Combined (cert+key in one file) - for HAProxy', value: 'combined' },
              { name: 'Separate files (cert, key, chain)', value: 'separate' },
              { name: 'Custom', value: 'custom' },
            ],
          },
          {
            type: 'input',
            name: 'combined',
            message: 'Combined file path:',
            when: (ans) => ans.outputFormat === 'combined',
            default: options.combined ?? `/etc/ssl/${cert.alias}.pem`,
          },
          {
            type: 'input',
            name: 'certFile',
            message: 'Certificate file path:',
            when: (ans) => ans.outputFormat === 'separate',
            default: options.certFile ?? `/etc/ssl/certs/${cert.alias}.crt`,
          },
          {
            type: 'input',
            name: 'keyFile',
            message: 'Private key file path:',
            when: (ans) => ans.outputFormat === 'separate',
            default: options.keyFile ?? `/etc/ssl/private/${cert.alias}.key`,
          },
          {
            type: 'input',
            name: 'chainFile',
            message: 'CA chain file path (optional):',
            when: (ans) => ans.outputFormat === 'separate',
            default: options.chainFile ?? '',
          },
          {
            type: 'input',
            name: 'owner',
            message: 'File ownership (user:group):',
            default: options.owner ?? 'root:root',
          },
          {
            type: 'input',
            name: 'mode',
            message: 'File permissions:',
            default: options.mode ?? '0640',
          },
          {
            type: 'input',
            name: 'reloadCmd',
            message: 'Reload command (run after cert update):',
            default: options.reloadCmd ?? 'systemctl reload haproxy',
          },
          {
            type: 'input',
            name: 'healthCmd',
            message: 'Health check command (optional):',
            default: options.healthCmd ?? '',
          },
        ]);
      }

      // Build target configuration
      const target: CertTarget = {
        certId: cert.id, // Use resolved ID from getCertificate
        name: answers.name,
        outputs: {},
        owner: answers.owner,
        mode: answers.mode,
        reloadCmd: answers.reloadCmd || undefined, // Empty string -> undefined
        healthCheckCmd: answers.healthCmd || undefined, // Empty string -> undefined
      };

      if (answers.outputFormat === 'combined' || options.combined != null) {
        target.outputs.combined = answers.combined || options.combined;
      }
      if (answers.certFile || options.certFile != null) {
        target.outputs.cert = answers.certFile || options.certFile;
      }
      if (answers.keyFile || options.keyFile != null) {
        target.outputs.key = answers.keyFile || options.keyFile;
      }
      if (answers.chainFile || options.chainFile != null) {
        target.outputs.chain = answers.chainFile || options.chainFile;
      }
      if (options.fullchainFile != null) {
        target.outputs.fullchain = options.fullchainFile;
      }

      // Handle custom output (only in interactive mode)
      if (!nonInteractive && answers.outputFormat === 'custom') {
        interface CustomOutputAnswers {
          combined: string;
          cert: string;
          key: string;
          chain: string;
          fullchain: string;
        }
        const customAnswers = await inquirer.prompt<CustomOutputAnswers>([
          {
            type: 'input',
            name: 'combined',
            message: 'Combined file path (leave empty to skip):',
            default: options.combined ?? '',
          },
          {
            type: 'input',
            name: 'cert',
            message: 'Certificate file path (leave empty to skip):',
            default: options.certFile ?? '',
          },
          {
            type: 'input',
            name: 'key',
            message: 'Private key file path (leave empty to skip):',
            default: options.keyFile ?? '',
          },
          {
            type: 'input',
            name: 'chain',
            message: 'CA chain file path (leave empty to skip):',
            default: options.chainFile ?? '',
          },
          {
            type: 'input',
            name: 'fullchain',
            message: 'Fullchain file path (leave empty to skip):',
            default: options.fullchainFile ?? '',
          },
        ]);

        if (customAnswers.combined) target.outputs.combined = customAnswers.combined;
        if (customAnswers.cert) target.outputs.cert = customAnswers.cert;
        if (customAnswers.key) target.outputs.key = customAnswers.key;
        if (customAnswers.chain) target.outputs.chain = customAnswers.chain;
        if (customAnswers.fullchain) target.outputs.fullchain = customAnswers.fullchain;
      }

      // Save target
      addTarget(target);

      console.log();
      console.log(chalk.green('✓') + ` Certificate target "${answers.name}" added`);
      console.log();
      console.log('Output files:');
      for (const [type, path] of Object.entries(target.outputs)) {
        if (path) console.log(`  ${type}: ${path}`);
      }
      console.log();
      console.log('Run ' + chalk.cyan('zn-vault-agent sync') + ' to deploy now');
    });

  // List configured targets
  program
    .command('list')
    .description('List configured certificate targets')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Examples:
  zn-vault-agent list         # Human-readable list
  zn-vault-agent list --json  # JSON output for scripting
`)
    .action((options: AvailableCommandOptions) => {
      const targets = getTargets();

      if (options.json === true) {
        console.log(JSON.stringify(targets, null, 2));
        return;
      }

      if (targets.length === 0) {
        console.log('No certificate targets configured.');
        console.log('Run ' + chalk.cyan('zn-vault-agent add') + ' to add one.');
        return;
      }

      console.log();
      console.log(chalk.bold('Configured Certificate Targets'));
      console.log();

      for (const target of targets) {
        const syncStatus = target.lastSync
          ? chalk.green(`synced ${new Date(target.lastSync).toLocaleString()}`)
          : chalk.yellow('not synced');

        console.log(`  ${chalk.bold(target.name)}`);
        console.log(`    Certificate: ${target.certId.substring(0, 8)}...`);
        console.log(`    Status: ${syncStatus}`);
        console.log(`    Outputs:`);
        for (const [type, path] of Object.entries(target.outputs)) {
          if (path) console.log(`      ${type}: ${path}`);
        }
        if (target.reloadCmd) {
          console.log(`    Reload: ${target.reloadCmd}`);
        }
        console.log();
      }

      console.log(`Total: ${targets.length} target(s)`);
    });

  // Remove a target
  program
    .command('remove <name>')
    .description('Remove a certificate target')
    .option('-f, --force', 'Skip confirmation')
    .addHelpText('after', `
Examples:
  zn-vault-agent remove haproxy-frontend          # Interactive confirmation
  zn-vault-agent remove haproxy-frontend --force  # Skip confirmation
`)
    .action(async (name: string, options: CertRemoveCommandOptions) => {
      const targets = getTargets();
      const target = targets.find(t => t.name === name || t.certId === name);

      if (!target) {
        console.error(chalk.red(`Target "${name}" not found`));
        process.exit(1);
      }

      if (options.force !== true) {
        const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
          {
            type: 'confirm',
            name: 'confirm',
            message: `Remove target "${target.name}"?`,
            default: false,
          },
        ]);

        if (!confirm) {
          console.log('Cancelled');
          return;
        }
      }

      removeTarget(name);
      console.log(chalk.green('✓') + ` Target "${target.name}" removed`);
    });
}
