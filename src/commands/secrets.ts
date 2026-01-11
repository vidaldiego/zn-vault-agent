// Path: src/commands/secrets.ts
// Secret sync commands

import type { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  loadConfig,
  addSecretTarget,
  removeSecretTarget,
  getSecretTargets,
  updateSecretTargetVersion,
  isConfigured,
  type SecretTarget,
} from '../lib/config.js';
import { listSecrets, getSecret, type DecryptedSecret } from '../lib/api.js';

/**
 * Format secret data for output
 */
function formatSecretData(
  secret: DecryptedSecret,
  format: SecretTarget['format'],
  options: { key?: string; envPrefix?: string; templatePath?: string }
): string {
  const data = secret.data;

  switch (format) {
    case 'env': {
      // Add underscore only if prefix doesn't already end with one
      const rawPrefix = options.envPrefix || '';
      const prefix = rawPrefix && !rawPrefix.endsWith('_') ? `${rawPrefix}_` : rawPrefix;
      return Object.entries(data)
        .map(([k, v]) => {
          const key = `${prefix}${k.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
          const value = typeof v === 'string' ? v : JSON.stringify(v);
          // Escape special characters in value
          const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
          return `${key}="${escaped}"`;
        })
        .join('\n') + '\n';
    }

    case 'json':
      return JSON.stringify(data, null, 2) + '\n';

    case 'yaml': {
      // Simple YAML serialization (no dependency needed for basic cases)
      const lines: string[] = [];
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') {
          // Quote strings that might be problematic
          if (v.includes('\n') || v.includes(':') || v.includes('#') || v.startsWith(' ')) {
            lines.push(`${k}: "${v.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
          } else {
            lines.push(`${k}: ${v}`);
          }
        } else {
          lines.push(`${k}: ${JSON.stringify(v)}`);
        }
      }
      return lines.join('\n') + '\n';
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
      throw new Error(`Unknown format: ${format}`);
  }
}

/**
 * Write secret to file with proper permissions
 */
function writeSecretFile(
  filePath: string,
  content: string,
  owner?: string,
  mode?: string
): void {
  // Ensure directory exists
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
 * Sync a single secret target
 */
async function syncSecretTarget(target: SecretTarget): Promise<boolean> {
  try {
    const secret = await getSecret(target.secretId);

    // Skip file writing for 'none' format (subscribe-only mode)
    if (target.format !== 'none') {
      // Format the data
      const content = formatSecretData(secret, target.format, {
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
        execSync(target.reloadCmd, { stdio: 'inherit' });
      } catch (err) {
        console.error(chalk.yellow(`Warning: Reload command failed: ${err}`));
      }
    }

    return true;
  } catch (err) {
    console.error(chalk.red(`Failed to sync ${target.name}:`), err instanceof Error ? err.message : String(err));
    return false;
  }
}

export function registerSecretsCommands(program: Command): void {
  const secretCmd = program
    .command('secret')
    .description('Manage secret synchronization')
    .addHelpText('after', `
Examples:
  zn-vault-agent secret available         # List secrets in vault
  zn-vault-agent secret add alias:db/creds --name db --format env --output /etc/app/db.env
  zn-vault-agent secret list              # Show configured targets
  zn-vault-agent secret sync              # Deploy all secrets
  zn-vault-agent secret remove db         # Remove a target
`);

  // List available secrets in vault
  secretCmd
    .command('available')
    .description('List secrets available in vault')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Examples:
  zn-vault-agent secret available         # Human-readable list
  zn-vault-agent secret available --json  # JSON output for scripting
`)
    .action(async (options) => {
      if (!isConfigured()) {
        console.error(chalk.red('Not configured. Run: zn-vault-agent login'));
        process.exit(1);
      }

      const spinner = ora('Fetching secrets...').start();

      try {
        const result = await listSecrets();
        spinner.stop();

        if (options.json) {
          console.log(JSON.stringify(result.items, null, 2));
          return;
        }

        if (result.items.length === 0) {
          console.log('No secrets found in vault');
          return;
        }

        console.log();
        console.log(chalk.bold('Available Secrets'));
        console.log();

        const targets = getSecretTargets();
        const configuredIds = new Set(targets.map(t => t.secretId));

        for (const secret of result.items) {
          const configured = configuredIds.has(secret.id) || configuredIds.has(`alias:${secret.alias}`);
          const status = configured ? chalk.green('✓ configured') : chalk.gray('not configured');

          console.log(`  ${secret.id.substring(0, 8)}  ${secret.alias.padEnd(30)} ${status}`);
          console.log(`            ${chalk.gray(`type: ${secret.type}, v${secret.version}`)}`);
          console.log();
        }

        console.log(`Total: ${result.total} secret(s)`);
      } catch (err) {
        spinner.fail('Failed to fetch secrets');
        console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // Add a secret target
  secretCmd
    .command('add <secret-id>')
    .description('Add a secret to sync (ID or alias:path)')
    .option('-n, --name <name>', 'Local name for this secret')
    .option('-f, --format <format>', 'Output format: env, json, yaml, raw, template', 'env')
    .option('-o, --output <path>', 'Output file path')
    .option('-k, --key <key>', 'For raw format: key to extract')
    .option('-t, --template <path>', 'For template format: template file path')
    .option('-p, --prefix <prefix>', 'For env format: variable name prefix')
    .option('--owner <user:group>', 'File ownership')
    .option('--mode <mode>', 'File permissions', '0600')
    .option('--reload <cmd>', 'Command to run after sync')
    .addHelpText('after', `
Examples:
  # Sync to .env file
  zn-vault-agent secret add alias:database/credentials \\
    --name db-creds --format env --output /etc/myapp/db.env

  # JSON format with reload command
  zn-vault-agent secret add alias:app/config \\
    --name app-config --format json --output /etc/myapp/config.json \\
    --reload "systemctl restart myapp"

  # Extract single key with raw format
  zn-vault-agent secret add alias:api/key \\
    --name api-key --format raw --key apiKey --output /etc/myapp/api-key.txt

  # YAML with custom permissions
  zn-vault-agent secret add alias:database/prod \\
    --name db-yaml --format yaml --output /etc/myapp/db.yml \\
    --owner www-data:www-data --mode 0640

  # Template-based output
  zn-vault-agent secret add alias:database/prod \\
    --name db-template --format template \\
    --template /etc/myapp/config.tmpl --output /etc/myapp/config.yml

  # Env format with prefix
  zn-vault-agent secret add alias:database/credentials \\
    --name db-prefixed --format env --prefix DB --output /etc/myapp/db.env
`)
    .action(async (secretId, options) => {
      if (!isConfigured()) {
        console.error(chalk.red('Not configured. Run: zn-vault-agent login'));
        process.exit(1);
      }

      // Validate format
      const validFormats = ['env', 'json', 'yaml', 'raw', 'template'];
      if (!validFormats.includes(options.format)) {
        console.error(chalk.red(`Invalid format. Must be one of: ${validFormats.join(', ')}`));
        process.exit(1);
      }

      // Validate format-specific options
      if (options.format === 'raw' && !options.key) {
        console.error(chalk.red('--key is required for raw format'));
        process.exit(1);
      }
      if (options.format === 'template' && !options.template) {
        console.error(chalk.red('--template is required for template format'));
        process.exit(1);
      }

      // Try to fetch the secret to validate it exists
      const spinner = ora('Validating secret...').start();
      let secret: DecryptedSecret;
      try {
        secret = await getSecret(secretId);
        spinner.stop();
      } catch (err) {
        spinner.fail('Secret not found');
        console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold('Secret:'), secret.alias);
      console.log(chalk.gray(`Type: ${secret.type}, Version: ${secret.version}`));
      console.log(chalk.gray(`Keys: ${Object.keys(secret.data).join(', ')}`));
      console.log();

      // Gather configuration interactively if not all options provided
      let name = options.name;
      let output = options.output;

      if (!name || !output) {
        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'name',
            message: 'Local name for this target:',
            default: options.name || secret.alias.replace(/[^a-zA-Z0-9-_]/g, '-'),
            when: !name,
          },
          {
            type: 'input',
            name: 'output',
            message: 'Output file path:',
            default: options.output || `/etc/secrets/${secret.alias.replace(/\//g, '-')}.${options.format === 'yaml' ? 'yml' : options.format}`,
            when: !output,
          },
        ]);
        name = name || answers.name;
        output = output || answers.output;
      }

      // Build target configuration
      const target: SecretTarget = {
        secretId,
        name,
        format: options.format as SecretTarget['format'],
        output,
        key: options.key,
        templatePath: options.template,
        envPrefix: options.prefix,
        owner: options.owner,
        mode: options.mode,
        reloadCmd: options.reload,
      };

      // Save target
      addSecretTarget(target);

      console.log(chalk.green('✓') + ` Secret target "${name}" added`);
      console.log();
      console.log(`Format: ${options.format}`);
      console.log(`Output: ${output}`);
      console.log();
      console.log('Run ' + chalk.cyan('zn-vault-agent secret sync') + ' to deploy now');
    });

  // List configured secret targets
  secretCmd
    .command('list')
    .description('List configured secret targets')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Examples:
  zn-vault-agent secret list         # Human-readable list
  zn-vault-agent secret list --json  # JSON output for scripting
`)
    .action(async (options) => {
      const targets = getSecretTargets();

      if (options.json) {
        console.log(JSON.stringify(targets, null, 2));
        return;
      }

      if (targets.length === 0) {
        console.log('No secret targets configured.');
        console.log('Run ' + chalk.cyan('zn-vault-agent secret add <id>') + ' to add one.');
        return;
      }

      console.log();
      console.log(chalk.bold('Configured Secret Targets'));
      console.log();

      for (const target of targets) {
        const syncStatus = target.lastSync
          ? chalk.green(`synced ${new Date(target.lastSync).toLocaleString()}`)
          : chalk.yellow('not synced');

        console.log(`  ${chalk.bold(target.name)}`);
        console.log(`    Secret: ${target.secretId}`);
        console.log(`    Format: ${target.format}`);
        console.log(`    Output: ${target.output}`);
        console.log(`    Status: ${syncStatus}`);
        if (target.reloadCmd) {
          console.log(`    Reload: ${target.reloadCmd}`);
        }
        console.log();
      }

      console.log(`Total: ${targets.length} target(s)`);
    });

  // Remove a secret target
  secretCmd
    .command('remove <name>')
    .description('Remove a secret target')
    .option('-f, --force', 'Skip confirmation')
    .addHelpText('after', `
Examples:
  zn-vault-agent secret remove db-creds          # Interactive confirmation
  zn-vault-agent secret remove db-creds --force  # Skip confirmation
`)
    .action(async (name, options) => {
      const targets = getSecretTargets();
      const target = targets.find(t => t.name === name || t.secretId === name);

      if (!target) {
        console.error(chalk.red(`Target "${name}" not found`));
        process.exit(1);
      }

      if (!options.force) {
        const { confirm } = await inquirer.prompt([
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

      removeSecretTarget(name);
      console.log(chalk.green('✓') + ` Target "${target.name}" removed`);
    });

  // Sync all secret targets
  secretCmd
    .command('sync')
    .description('Sync all configured secrets')
    .option('--name <name>', 'Sync only specific target')
    .addHelpText('after', `
Examples:
  zn-vault-agent secret sync              # Sync all configured secrets
  zn-vault-agent secret sync --name db    # Sync only "db" target
`)
    .action(async (options) => {
      if (!isConfigured()) {
        console.error(chalk.red('Not configured. Run: zn-vault-agent login'));
        process.exit(1);
      }

      let targets = getSecretTargets();

      if (targets.length === 0) {
        console.log('No secret targets configured.');
        console.log('Run ' + chalk.cyan('zn-vault-agent secret add <id>') + ' to add one.');
        return;
      }

      if (options.name) {
        targets = targets.filter(t => t.name === options.name || t.secretId === options.name);
        if (targets.length === 0) {
          console.error(chalk.red(`Target "${options.name}" not found`));
          process.exit(1);
        }
      }

      console.log();
      console.log(chalk.bold('Syncing secrets...'));
      console.log();

      let success = 0;
      let failed = 0;

      for (const target of targets) {
        const spinner = ora(`Syncing ${target.name}...`).start();

        if (await syncSecretTarget(target)) {
          spinner.succeed(`${target.name} → ${target.output}`);
          success++;
        } else {
          spinner.fail(`${target.name} failed`);
          failed++;
        }
      }

      console.log();
      console.log(`Synced: ${success}, Failed: ${failed}`);

      if (failed > 0) {
        process.exit(1);
      }
    });
}
