import type { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig, saveConfig, getConfigPath } from '../lib/config.js';
import { login as apiLogin, listCertificates } from '../lib/api.js';

interface LoginOptions {
  url?: string;
  tenant?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  insecure?: boolean;
  yes?: boolean;
  skipTest?: boolean;
}

/**
 * Check if we have all required values for non-interactive mode
 */
function canRunNonInteractive(options: LoginOptions): boolean {
  const hasUrl = !!options.url;
  const hasTenant = !!options.tenant;
  const hasApiKey = !!options.apiKey;
  const hasUserPass = !!options.username && !!options.password;

  return hasUrl && hasTenant && (hasApiKey || hasUserPass);
}

/**
 * Validate URL format
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Configure vault connection and authenticate')
    .option('-u, --url <url>', 'Vault server URL')
    .option('-t, --tenant <id>', 'Tenant ID')
    .option('-k, --api-key <key>', 'API key (alternative to username/password)')
    .option('--username <user>', 'Username')
    .option('--password <pass>', 'Password')
    .option('--insecure', 'Skip TLS certificate verification')
    .option('-y, --yes', 'Non-interactive mode (skip prompts, use provided values)')
    .option('--skip-test', 'Skip connection test after saving config')
    .addHelpText('after', `
Examples:
  # Interactive login (prompts for values)
  zn-vault-agent login

  # Login with API key (recommended for automation)
  zn-vault-agent login --url https://vault.example.com --tenant acme --api-key znv_abc123

  # Login with username/password
  zn-vault-agent login -u https://vault.example.com -t acme --username admin --password secret

  # Skip TLS verification (self-signed certs)
  zn-vault-agent login --url https://localhost:8443 --tenant dev --api-key znv_... --insecure

  # Non-interactive with connection test skipped
  zn-vault-agent login --url https://vault.example.com --tenant acme --api-key znv_... -y --skip-test
`)
    .action(async (options: LoginOptions) => {
      const config = loadConfig();

      // Check if we can/should run non-interactively
      const nonInteractive = options.yes || canRunNonInteractive(options);

      let vaultUrl: string;
      let tenantId: string;
      let authMethod: 'apiKey' | 'password';
      let apiKey: string | undefined;
      let username: string | undefined;
      let password: string | undefined;
      let insecure: boolean;

      if (nonInteractive) {
        // Non-interactive mode: use CLI values directly
        if (!options.url) {
          console.error(chalk.red('Error:'), 'Vault URL is required (--url)');
          process.exit(1);
        }
        if (!isValidUrl(options.url)) {
          console.error(chalk.red('Error:'), 'Invalid URL format');
          process.exit(1);
        }
        if (!options.tenant) {
          console.error(chalk.red('Error:'), 'Tenant ID is required (--tenant)');
          process.exit(1);
        }
        if (!options.apiKey && (!options.username || !options.password)) {
          console.error(chalk.red('Error:'), 'Authentication required: provide --api-key OR (--username AND --password)');
          process.exit(1);
        }

        vaultUrl = options.url;
        tenantId = options.tenant;
        insecure = options.insecure || false;

        if (options.apiKey) {
          authMethod = 'apiKey';
          apiKey = options.apiKey;
        } else {
          authMethod = 'password';
          username = options.username;
          password = options.password;
        }

        console.log();
        console.log(chalk.bold('ZN-Vault Agent Configuration') + ' (non-interactive)');
        console.log();
        console.log(`  Vault URL:   ${vaultUrl}`);
        console.log(`  Tenant ID:   ${tenantId}`);
        console.log(`  Auth Method: ${authMethod === 'apiKey' ? 'API Key' : 'Username/Password'}`);
        console.log(`  TLS Verify:  ${insecure ? 'disabled' : 'enabled'}`);
        console.log();
      } else {
        // Interactive mode: prompt for values
        console.log();
        console.log(chalk.bold('ZN-Vault Agent Configuration'));
        console.log();

        const answers = await inquirer.prompt([
          {
            type: 'input',
            name: 'vaultUrl',
            message: 'Vault URL:',
            default: options.url || config.vaultUrl || 'https://vault.zincapp.com',
            validate: (input) => {
              try {
                new URL(input);
                return true;
              } catch {
                return 'Please enter a valid URL';
              }
            },
          },
          {
            type: 'input',
            name: 'tenantId',
            message: 'Tenant ID:',
            default: options.tenant || config.tenantId,
            validate: (input) => input.length > 0 || 'Tenant ID is required',
          },
          {
            type: 'list',
            name: 'authMethod',
            message: 'Authentication method:',
            choices: [
              { name: 'API Key (recommended for agents)', value: 'apiKey' },
              { name: 'Username/Password', value: 'password' },
            ],
            default: options.apiKey ? 'apiKey' : (config.auth.apiKey ? 'apiKey' : 'password'),
          },
          {
            type: 'input',
            name: 'apiKey',
            message: 'API Key:',
            when: (ans) => ans.authMethod === 'apiKey',
            default: options.apiKey || config.auth.apiKey,
            validate: (input) => input.length > 0 || 'API key is required',
          },
          {
            type: 'input',
            name: 'username',
            message: 'Username:',
            when: (ans) => ans.authMethod === 'password',
            default: options.username || config.auth.username,
            validate: (input) => input.length > 0 || 'Username is required',
          },
          {
            type: 'password',
            name: 'password',
            message: 'Password:',
            when: (ans) => ans.authMethod === 'password',
            mask: '*',
            validate: (input) => input.length > 0 || 'Password is required',
          },
          {
            type: 'confirm',
            name: 'insecure',
            message: 'Skip TLS verification? (for self-signed certs)',
            default: options.insecure || config.insecure || false,
          },
        ]);

        vaultUrl = answers.vaultUrl;
        tenantId = answers.tenantId;
        authMethod = answers.authMethod;
        apiKey = answers.apiKey;
        username = answers.username;
        password = answers.password;
        insecure = answers.insecure;
      }

      // Update config
      config.vaultUrl = vaultUrl;
      config.tenantId = tenantId;
      config.insecure = insecure;

      if (authMethod === 'apiKey') {
        config.auth = { apiKey: apiKey! };
      } else {
        config.auth = {
          username: username!,
          password: password!,
        };
      }

      // Save config first (needed for API calls)
      saveConfig(config);

      // Skip connection test if requested
      if (options.skipTest) {
        console.log(chalk.green('✓') + ` Configuration saved to: ${getConfigPath()}`);
        console.log(chalk.yellow('!') + ' Connection test skipped (--skip-test)');
        return;
      }

      // Test connection
      const spinner = ora('Testing connection...').start();

      try {
        if (authMethod === 'password') {
          await apiLogin(username!, password!);
        }

        // Try to list certificates
        const certs = await listCertificates();

        spinner.succeed('Connection successful!');

        console.log();
        console.log(chalk.green('✓') + ` Configuration saved to: ${getConfigPath()}`);
        console.log(chalk.green('✓') + ` Found ${certs.total} certificate(s) in vault`);
        console.log();
        console.log('Next steps:');
        console.log('  1. Add certificates to sync: ' + chalk.cyan('zn-vault-agent add'));
        console.log('  2. List configured targets:  ' + chalk.cyan('zn-vault-agent list'));
        console.log('  3. Sync certificates now:    ' + chalk.cyan('zn-vault-agent sync'));
        console.log('  4. Start daemon:             ' + chalk.cyan('zn-vault-agent start'));
        console.log();
      } catch (err) {
        spinner.fail('Connection failed');
        console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
        console.log();
        console.log('Configuration was saved. Please check your credentials and try again.');
        process.exit(1);
      }
    });
}
