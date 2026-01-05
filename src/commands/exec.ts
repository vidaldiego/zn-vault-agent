// Path: src/commands/exec.ts
// Exec mode - run a command with secrets as environment variables

import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import { isConfigured } from '../lib/config.js';
import { getSecret } from '../lib/api.js';

interface SecretMapping {
  envVar: string;
  secretId: string;
  key?: string;
}

/**
 * Parse secret mapping from CLI argument
 * Formats:
 *   ENV_VAR=alias:secret/path           -> entire secret as JSON
 *   ENV_VAR=alias:secret/path.key       -> specific key from secret
 *   ENV_VAR=uuid                        -> entire secret as JSON
 *   ENV_VAR=uuid.key                    -> specific key from secret
 */
function parseSecretMapping(mapping: string): SecretMapping {
  const eqIndex = mapping.indexOf('=');
  if (eqIndex === -1) {
    throw new Error(`Invalid mapping format: ${mapping}. Expected: ENV_VAR=secret-id[.key]`);
  }

  const envVar = mapping.substring(0, eqIndex);
  let secretPath = mapping.substring(eqIndex + 1);

  if (!envVar || !secretPath) {
    throw new Error(`Invalid mapping format: ${mapping}. Expected: ENV_VAR=secret-id[.key]`);
  }

  // Check if there's a key after the secret ID
  // For alias format: alias:path/to/secret.key
  // For UUID format: uuid.key
  let key: string | undefined;

  if (secretPath.startsWith('alias:')) {
    // Handle alias:path/to/secret.key
    const lastDotIndex = secretPath.lastIndexOf('.');
    if (lastDotIndex > secretPath.indexOf(':') + 1) {
      // There's a dot after the alias prefix
      const potentialKey = secretPath.substring(lastDotIndex + 1);
      // Check if this looks like a key (not a file extension or path segment)
      if (potentialKey && !potentialKey.includes('/')) {
        key = potentialKey;
        secretPath = secretPath.substring(0, lastDotIndex);
      }
    }
  } else {
    // Handle uuid.key or uuid
    const dotIndex = secretPath.indexOf('.');
    if (dotIndex !== -1) {
      key = secretPath.substring(dotIndex + 1);
      secretPath = secretPath.substring(0, dotIndex);
    }
  }

  return {
    envVar,
    secretId: secretPath,
    key,
  };
}

/**
 * Fetch secrets and build environment variables
 */
async function buildSecretEnv(mappings: SecretMapping[]): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  // Group by secretId to minimize API calls
  const secretCache = new Map<string, Record<string, unknown>>();

  for (const mapping of mappings) {
    let data = secretCache.get(mapping.secretId);

    if (!data) {
      const secret = await getSecret(mapping.secretId);
      data = secret.data;
      secretCache.set(mapping.secretId, data);
    }

    if (mapping.key) {
      // Get specific key
      const value = data[mapping.key];
      if (value === undefined) {
        throw new Error(`Key "${mapping.key}" not found in secret "${mapping.secretId}"`);
      }
      env[mapping.envVar] = typeof value === 'string' ? value : JSON.stringify(value);
    } else {
      // Get entire secret as JSON
      env[mapping.envVar] = JSON.stringify(data);
    }
  }

  return env;
}

export function registerExecCommand(program: Command): void {
  program
    .command('exec')
    .description('Run a command with secrets as environment variables')
    .option('-s, --secret <mapping>', 'Secret mapping (ENV_VAR=secret-id[.key])', (val, acc: string[]) => {
      acc.push(val);
      return acc;
    }, [])
    .option('-o, --output <path>', 'Write secrets to env file instead of running command')
    .option('--inherit', 'Inherit current environment variables (default: true)', true)
    .option('--no-inherit', 'Do not inherit current environment variables')
    .argument('[command...]', 'Command to execute')
    .addHelpText('after', `
Examples:
  # Run node with database password
  zn-vault-agent exec -s DB_PASSWORD=alias:db/prod.password -- node server.js

  # Multiple secrets
  zn-vault-agent exec \\
    -s DB_HOST=alias:db/prod.host \\
    -s DB_PASSWORD=alias:db/prod.password \\
    -s API_KEY=alias:api/key.value \\
    -- ./start.sh

  # Export to env file
  zn-vault-agent exec \\
    -s DB_PASSWORD=alias:db/prod.password \\
    --output /tmp/secrets.env

  # Get entire secret as JSON
  zn-vault-agent exec -s CONFIG=alias:app/config -- node app.js
`)
    .action(async (command: string[], options) => {
      if (!isConfigured()) {
        console.error(chalk.red('Not configured. Run: zn-vault-agent login'));
        process.exit(1);
      }

      if (options.secret.length === 0) {
        console.error(chalk.red('At least one --secret mapping is required'));
        process.exit(1);
      }

      // Parse mappings
      let mappings: SecretMapping[];
      try {
        mappings = options.secret.map(parseSecretMapping);
      } catch (err) {
        console.error(chalk.red('Error:'), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // Fetch secrets
      let secretEnv: Record<string, string>;
      try {
        secretEnv = await buildSecretEnv(mappings);
      } catch (err) {
        console.error(chalk.red('Failed to fetch secrets:'), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // If --output specified, write to file and exit
      if (options.output) {
        const fs = await import('node:fs');
        const content = Object.entries(secretEnv)
          .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
          .join('\n') + '\n';

        fs.writeFileSync(options.output, content, { mode: 0o600 });
        console.log(chalk.green('✓') + ` Secrets written to ${options.output}`);
        return;
      }

      // Must have a command to run
      if (command.length === 0) {
        console.error(chalk.red('No command specified. Provide a command after --'));
        console.error('Example: zn-vault-agent exec -s VAR=secret -- ./my-command');
        process.exit(1);
      }

      // Build environment
      const env = options.inherit
        ? { ...process.env, ...secretEnv }
        : secretEnv;

      // Run the command
      const [cmd, ...args] = command;

      const child = spawn(cmd, args, {
        env,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });

      // Forward signals to child
      const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
      for (const signal of signals) {
        process.on(signal, () => {
          child.kill(signal);
        });
      }

      // Exit with child's exit code
      child.on('exit', (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
        } else {
          process.exit(code ?? 0);
        }
      });

      child.on('error', (err) => {
        console.error(chalk.red('Failed to start command:'), err.message);
        process.exit(1);
      });
    });
}
