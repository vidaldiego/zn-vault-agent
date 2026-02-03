import type { Command } from 'commander';
import os from 'node:os';
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import { loadConfig, saveConfig, getConfigPath } from '../lib/config.js';
import { login as apiLogin, listCertificates, getApiKeySelf, bindManagedApiKey } from '../lib/api.js';
import { exchangeBootstrapToken, applyRegistrationResult } from '../lib/auth/bootstrap.js';
import type { LoginCommandOptions } from './types.js';

/**
 * Response type for login prompt answers
 */
interface LoginPromptAnswers {
  vaultUrl: string;
  authMethod: 'apiKey' | 'password';
  apiKey?: string;
  username?: string;
  password?: string;
  insecure: boolean;
}

/**
 * Check if we have all required values for non-interactive mode
 */
function canRunNonInteractive(options: LoginCommandOptions): boolean {
  const hasUrl = !!options.url;
  const hasApiKey = !!options.apiKey;
  const hasBootstrapToken = !!options.bootstrapToken;

  // Bootstrap token or API key only needs URL (tenant is auto-detected)
  if (hasBootstrapToken && hasUrl) {
    return true;
  }

  // API key auth: tenant is auto-detected from key
  return hasUrl && hasApiKey;
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

/**
 * Validate bootstrap token format (zrt_ + 64 hex chars)
 */
function isValidBootstrapToken(token: string): boolean {
  return /^zrt_[a-f0-9]{64}$/i.test(token);
}

/**
 * Handle bootstrap token authentication flow.
 * This is the recommended secure way to provision new agents.
 * Uses host-based registration which links the agent to a host template.
 */
async function handleBootstrapToken(
  options: LoginCommandOptions,
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  console.log();
  console.log(chalk.bold('ZnVault Agent Bootstrap'));
  console.log();

  // Validate required options
  if (!options.url) {
    console.error(chalk.red('Error:'), 'Vault URL is required (--url)');
    process.exit(1);
  }

  if (!isValidUrl(options.url)) {
    console.error(chalk.red('Error:'), 'Invalid URL format');
    process.exit(1);
  }

  const token = options.bootstrapToken;
  if (!token || !isValidBootstrapToken(token)) {
    console.error(chalk.red('Error:'), 'Invalid bootstrap token format (expected: zrt_<64-hex-chars>)');
    process.exit(1);
  }

  // Use provided hostname or fall back to machine hostname
  const hostname = options.hostName ?? os.hostname();

  const insecure = options.insecure ?? false;

  console.log(`  Vault URL:   ${options.url}`);
  console.log(`  Hostname:    ${hostname}${options.hostName ? '' : chalk.gray(' (auto-detected)')}`);
  console.log(`  Token:       ${token.substring(0, 8)}...`);
  console.log(`  TLS Verify:  ${insecure ? 'disabled' : 'enabled'}`);
  console.log();

  // Set up config for the registration request
  config.vaultUrl = options.url;
  config.insecure = insecure;
  config.hostname = hostname;
  config.auth = {
    ...config.auth,
    bootstrapToken: token,
  };
  saveConfig(config);

  const spinner = ora('Registering agent with vault server...').start();

  try {
    // Call host-based registration endpoint
    const result = await exchangeBootstrapToken(config);

    spinner.succeed('Registration successful!');

    // Apply registration result to config (removes bootstrap token, adds API key)
    const updatedConfig = applyRegistrationResult(config, result);

    // If we got a managed key, set up the managed key config
    if (result.managedKeyName) {
      updatedConfig.managedKey = {
        name: result.managedKeyName,
        lastBind: new Date().toISOString(),
      };
    }

    // Enable config-from-vault if we got a host config ID
    if (result.hostConfigId) {
      updatedConfig.configFromVault = true;
    }

    // Save the updated config
    Object.assign(config, updatedConfig);
    saveConfig(config);

    // Test connection by listing certificates
    spinner.start('Testing connection...');
    const certs = await listCertificates();
    spinner.succeed('Connection successful!');

    console.log();
    console.log(chalk.green('✓') + ` Configuration saved to: ${getConfigPath()}`);
    console.log(chalk.green('✓') + ` Agent ID: ${result.agentId}`);
    console.log(chalk.green('✓') + ` Tenant: ${result.tenantId}`);
    if (result.hostConfigId) {
      console.log(chalk.green('✓') + ` Host config: ${result.hostConfigId}`);
      console.log(chalk.gray('  Config-from-vault enabled - agent will pull config from vault'));
    }
    if (result.managedKeyName) {
      console.log(chalk.green('✓') + ` Managed key: ${result.managedKeyName}`);
      console.log(chalk.gray('  Auto-rotation enabled - key will refresh before expiration'));
    }
    console.log(chalk.green('✓') + ` Found ${certs.total} certificate(s) in vault`);

    console.log();
    console.log('Next steps:');
    if (result.hostConfigId) {
      console.log('  Config-from-vault is enabled. Start the daemon:');
      console.log('  ' + chalk.cyan('zn-vault-agent start --health-port 9100'));
    } else {
      console.log('  1. Add certificates to sync: ' + chalk.cyan('zn-vault-agent certs add'));
      console.log('  2. List configured targets:  ' + chalk.cyan('zn-vault-agent list'));
      console.log('  3. Sync certificates now:    ' + chalk.cyan('zn-vault-agent sync'));
      console.log('  4. Start daemon:             ' + chalk.cyan('zn-vault-agent start'));
    }
    console.log();
  } catch (err) {
    spinner.fail('Registration failed');
    const message = err instanceof Error ? err.message : String(err);

    // Provide helpful error messages
    if (message.includes('401') || message.includes('Unauthorized')) {
      console.error(chalk.red('Error:'), 'Invalid or expired registration token');
      console.log(chalk.gray('  The token may have already been used or expired.'));
      console.log(chalk.gray('  Generate a new token: znvault host token <template-name>'));
    } else if (message.includes('404')) {
      console.error(chalk.red('Error:'), 'Host template or managed key not found');
      console.log(chalk.gray('  The host template may have been deleted.'));
    } else if (message.includes('Hostname is required')) {
      console.error(chalk.red('Error:'), 'Hostname is required for registration');
      console.log(chalk.gray('  Add --host-name <hostname> to your command'));
    } else if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
      console.error(chalk.red('Error:'), 'Cannot connect to vault server');
      console.log(chalk.gray('  Check that the URL is correct and the server is running.'));
    } else {
      console.error(chalk.red('Error:'), message);
    }

    process.exit(1);
  }
}

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Configure vault connection and authenticate')
    .option('-u, --url <url>', 'Vault server URL')
    .option('-k, --api-key <key>', 'API key (tenant auto-detected from key)')
    .option('-b, --bootstrap-token <token>', 'One-time registration token')
    .option('-H, --host-name <hostname>', 'Hostname for agent registration (defaults to machine hostname)')
    .option('--insecure', 'Skip TLS certificate verification')
    .option('-y, --yes', 'Non-interactive mode (skip prompts, use provided values)')
    .option('--skip-test', 'Skip connection test after saving config')
    .addHelpText('after', `
Examples:
  # Bootstrap with registration token (RECOMMENDED - most secure)
  # Uses machine hostname by default, or specify with --host-name
  zn-vault-agent login --url https://vault.example.com \\
    --bootstrap-token zrt_abc123...

  # Bootstrap with explicit hostname
  zn-vault-agent login --url https://vault.example.com \\
    --bootstrap-token zrt_abc123... \\
    --host-name my-server-01

  # Login with API key (tenant auto-detected, managed keys auto-detected)
  zn-vault-agent login --url https://vault.example.com --api-key znv_abc123...

  # Skip TLS verification (self-signed certs)
  zn-vault-agent login --url https://localhost:8443 --api-key znv_... --insecure

  # Non-interactive with connection test skipped
  zn-vault-agent login --url https://vault.example.com --api-key znv_... -y --skip-test

Bootstrap Token Flow (Recommended for Production):
  1. Admin creates a host template: znvault host create <template-name> --managed-key <key-name>
  2. Admin generates a registration token: znvault host token <template-name>
  3. Pass the token to the new server (cloud-init, Ansible, etc.)
  4. On server, run:
     zn-vault-agent login --url <vault-url> --bootstrap-token <token>
     (hostname auto-detected, or use --host-name to override)
  5. Token is consumed (one-time use), agent is registered and linked to host template
`)
    .action(async (options: LoginCommandOptions) => {
      const config = loadConfig();

      // Handle bootstrap token flow (takes priority over other auth methods)
      if (options.bootstrapToken) {
        await handleBootstrapToken(options, config);
        return;
      }

      // Check if we can/should run non-interactively
      const nonInteractive = options.yes === true || canRunNonInteractive(options);

      let vaultUrl: string;
      let apiKey: string | undefined;
      let insecure: boolean;
      let authMethod: 'apiKey' | 'password' = 'apiKey';
      let username: string | undefined;
      let password: string | undefined;

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
        if (!options.apiKey) {
          console.error(chalk.red('Error:'), 'API key is required (--api-key)');
          process.exit(1);
        }

        vaultUrl = options.url;
        apiKey = options.apiKey;
        insecure = options.insecure ?? false;

        console.log();
        console.log(chalk.bold('ZnVault Agent Configuration') + ' (non-interactive)');
        console.log();
        console.log(`  Vault URL:   ${vaultUrl}`);
        console.log(`  TLS Verify:  ${insecure ? 'disabled' : 'enabled'}`);
        console.log();
      } else {
        // Interactive mode: prompt for values
        console.log();
        console.log(chalk.bold('ZnVault Agent Configuration'));
        console.log();

        const answers = await inquirer.prompt<LoginPromptAnswers>([
          {
            type: 'input',
            name: 'vaultUrl',
            message: 'Vault URL:',
            default: options.url ?? config.vaultUrl,
            validate: (input: string) => {
              try {
                new URL(input);
                return true;
              } catch {
                return 'Please enter a valid URL';
              }
            },
          },
          {
            type: 'list',
            name: 'authMethod',
            message: 'Authentication method:',
            choices: [
              { name: 'API Key (auto-detects managed keys)', value: 'apiKey' },
              { name: 'Username/Password', value: 'password' },
            ],
            default: options.apiKey ? 'apiKey' : (config.auth.apiKey ? 'apiKey' : 'password'),
          },
          {
            type: 'input',
            name: 'apiKey',
            message: 'API Key:',
            when: (ans: Partial<LoginPromptAnswers>) => ans.authMethod === 'apiKey',
            default: options.apiKey ?? config.auth.apiKey,
            validate: (input: string) => input.length > 0 || 'API key is required',
          },
          {
            type: 'input',
            name: 'username',
            message: 'Username:',
            when: (ans: Partial<LoginPromptAnswers>) => ans.authMethod === 'password',
            default: options.username ?? config.auth.username,
            validate: (input: string) => input.length > 0 || 'Username is required',
          },
          {
            type: 'password',
            name: 'password',
            message: 'Password:',
            when: (ans: Partial<LoginPromptAnswers>) => ans.authMethod === 'password',
            mask: '*',
            validate: (input: string) => input.length > 0 || 'Password is required',
          },
          {
            type: 'confirm',
            name: 'insecure',
            message: 'Skip TLS verification? (for self-signed certs)',
            default: options.insecure ?? config.insecure ?? false,
          },
        ]);

        vaultUrl = answers.vaultUrl;
        authMethod = answers.authMethod;
        apiKey = answers.apiKey;
        username = answers.username;
        password = answers.password;
        insecure = answers.insecure;
      }

      // Update config
      config.vaultUrl = vaultUrl;
      config.insecure = insecure;

      if (authMethod === 'apiKey') {
        if (!apiKey) {
          console.error(chalk.red('Error:'), 'API key is required');
          process.exit(1);
        }
        config.auth = { apiKey };
        config.managedKey = undefined; // Clear until we detect
      } else {
        if (!username || !password) {
          console.error(chalk.red('Error:'), 'Username and password are required');
          process.exit(1);
        }
        config.auth = { username, password };
        config.managedKey = undefined; // Clear managed key config
      }

      // Save config first (needed for API calls)
      saveConfig(config);

      // Skip connection test if requested
      if (options.skipTest) {
        console.log(chalk.green('✓') + ` Configuration saved to: ${getConfigPath()}`);
        console.log(chalk.yellow('!') + ' Connection test skipped (--skip-test)');
        console.log(chalk.yellow('!') + ' Tenant will be auto-detected on first API call');
        return;
      }

      // Test connection
      const spinner = ora('Testing connection...').start();

      try {
        if (authMethod === 'password' && username && password) {
          await apiLogin(username, password);
        }

        // Try to list certificates
        const certs = await listCertificates();

        spinner.succeed('Connection successful!');

        console.log();
        console.log(chalk.green('✓') + ` Configuration saved to: ${getConfigPath()}`);
        console.log(chalk.green('✓') + ` Found ${certs.total} certificate(s) in vault`);

        // Get tenant info and check if it's a managed key
        spinner.start('Retrieving account information...');
        try {
          const keyInfo = await getApiKeySelf();

          // Save tenant ID from API key info
          config.tenantId = keyInfo.tenantId;
          saveConfig(config);

          console.log(chalk.green('✓') + ` Tenant: ${keyInfo.tenantId}`);

          if (authMethod === 'apiKey') {
            if (keyInfo.isManaged && keyInfo.managedKeyName) {
              spinner.text = 'Binding to managed API key...';

              // Bind to get the current key value and metadata
              const bindResponse = await bindManagedApiKey(keyInfo.managedKeyName);

              // Update config with bound key and managed key metadata
              config.auth.apiKey = bindResponse.key;
              config.managedKey = {
                name: keyInfo.managedKeyName,
                nextRotationAt: bindResponse.nextRotationAt,
                graceExpiresAt: bindResponse.graceExpiresAt,
                rotationMode: bindResponse.rotationMode,
                lastBind: new Date().toISOString(),
              };
              saveConfig(config);

              spinner.succeed('Managed API key detected and bound');

              const nextRotation = bindResponse.nextRotationAt
                ? new Date(bindResponse.nextRotationAt).toLocaleString()
                : 'unknown';
              console.log(chalk.green('✓') + ` Managed key: ${keyInfo.managedKeyName} (rotates: ${nextRotation})`);
              console.log(chalk.gray('  Auto-rotation enabled - key will refresh before expiration'));
            } else {
              spinner.succeed('Static API key configured');
              console.log(chalk.yellow('⚠') + ' ' + chalk.yellow('Security recommendation:') + ' Consider using a managed API key for automatic rotation.');
              console.log(chalk.gray('  Create one in the vault dashboard under API Keys → Create Managed Key'));
            }
          } else {
            spinner.succeed('Password authentication configured');
          }
        } catch {
          // If self endpoint doesn't exist or fails, continue without tenant info
          spinner.info('Authentication configured (could not retrieve account information)');
          if (authMethod === 'apiKey') {
            console.log(chalk.yellow('⚠') + ' ' + chalk.yellow('Security recommendation:') + ' Consider using a managed API key for automatic rotation.');
          }
        }

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
