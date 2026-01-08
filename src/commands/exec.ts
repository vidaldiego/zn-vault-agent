// Path: src/commands/exec.ts
// Exec mode - run a command with secrets as environment variables

import type { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { isConfigured, loadConfig } from '../lib/config.js';
import {
  parseSecretMapping,
  buildSecretEnv,
  updateEnvFile,
  extractSecretIds,
  extractApiKeyNames,
  findEnvVarsForApiKey,
  type SecretMapping,
} from '../lib/secret-env.js';
import { createUnifiedWebSocketClient, type ApiKeyRotationEvent, type SecretEvent } from '../lib/websocket.js';
import { bindManagedApiKey, getSecret } from '../lib/api.js';
import { execLogger as log } from '../lib/logger.js';
import {
  startManagedKeyRenewal,
  stopManagedKeyRenewal,
  onKeyChanged as onManagedKeyChanged,
} from '../services/managed-key-renewal.js';
import { isManagedKeyMode } from '../lib/config.js';

export function registerExecCommand(program: Command): void {
  program
    .command('exec')
    .description('Run a command with secrets as environment variables')
    .option('-s, --secret <mapping>', 'Secret mapping (ENV_VAR=secret-id[.key])', (val, acc: string[]) => {
      acc.push(val);
      return acc;
    }, [])
    .option('-o, --output <path>', 'Write secrets to env file instead of running command')
    .option('-w, --watch', 'Keep running and update env file on secret/key changes (requires --output)')
    .option('--inherit', 'Inherit current environment variables (default: true)', true)
    .option('--no-inherit', 'Do not inherit current environment variables')
    .argument('[command...]', 'Command to execute')
    .addHelpText('after', `
Secret Mapping Formats:
  ENV_VAR=alias:path/to/secret       Entire secret as JSON
  ENV_VAR=alias:path/to/secret.key   Specific field from secret
  ENV_VAR=api-key:name               Managed API key (binds and gets current value)
  ENV_VAR=literal:value              Literal value (no vault fetch)

Examples:
  # Run node with database password
  zn-vault-agent exec -s DB_PASSWORD=alias:db/prod.password -- node server.js

  # Multiple secrets
  zn-vault-agent exec \\
    -s DB_HOST=alias:db/prod.host \\
    -s DB_PASSWORD=alias:db/prod.password \\
    -s API_KEY=alias:api/key.value \\
    -- ./start.sh

  # Use a managed API key (auto-rotating)
  zn-vault-agent exec \\
    -s ZINC_CONFIG_VAULT_API_KEY=api-key:my-api-key \\
    -- ./my-app

  # Export to env file (one-shot)
  zn-vault-agent exec \\
    -s DB_PASSWORD=alias:db/prod.password \\
    --output /tmp/secrets.env

  # Export to env file and watch for changes (daemon mode)
  zn-vault-agent exec \\
    -s VAULT_API_KEY=api-key:my-rotating-key \\
    --output /tmp/secrets.env --watch

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

      // Validate --watch requires --output
      if (options.watch && !options.output) {
        console.error(chalk.red('--watch requires --output to be specified'));
        process.exit(1);
      }

      // Parse mappings
      let mappings: (SecretMapping & { literal?: string })[];
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

      // If --output specified, write to file
      if (options.output) {
        const content = Object.entries(secretEnv)
          .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
          .join('\n') + '\n';

        fs.writeFileSync(options.output, content, { mode: 0o600 });
        console.log(chalk.green('✓') + ` Secrets written to ${options.output}`);

        // If --watch not specified, exit now
        if (!options.watch) {
          return;
        }

        // Watch mode: keep running and update file on changes
        console.log(chalk.blue('ℹ') + ' Watching for secret and API key changes...');
        console.log(chalk.gray('  Press Ctrl+C to stop'));

        await startWatchMode(options.output, mappings, secretEnv);
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

/**
 * Start watch mode - keeps process running and updates env file on secret/key changes
 */
async function startWatchMode(
  outputPath: string,
  mappings: (SecretMapping & { literal?: string })[],
  initialEnv: Record<string, string>
): Promise<void> {
  let isShuttingDown = false;
  const currentEnv = { ...initialEnv };

  // Extract secret IDs and API key names for WebSocket subscription
  const secretIds = extractSecretIds(mappings);
  const apiKeyNames = extractApiKeyNames(mappings);

  log.info({
    outputPath,
    secretIds,
    apiKeyNames,
  }, 'Starting watch mode');

  // Start managed key renewal if in managed key mode
  if (isManagedKeyMode()) {
    log.info('Starting managed key renewal service');
    onManagedKeyChanged((newKey) => {
      log.info({ newKeyPrefix: newKey.substring(0, 8) }, 'Managed key changed');
    });
    try {
      await startManagedKeyRenewal();
    } catch (err) {
      log.error({ err }, 'Failed to start managed key renewal');
    }
  }

  // Create WebSocket client with subscriptions
  const wsClient = createUnifiedWebSocketClient(secretIds, apiKeyNames);

  // Handle API key rotation events
  wsClient.onApiKeyRotationEvent(async (event: ApiKeyRotationEvent) => {
    if (isShuttingDown) return;

    // Check if this key is one we're using
    if (!apiKeyNames.includes(event.apiKeyName)) {
      log.debug({ keyName: event.apiKeyName }, 'Ignoring rotation for untracked key');
      return;
    }

    log.info({
      keyName: event.apiKeyName,
      newPrefix: event.newPrefix,
      graceExpiresAt: event.graceExpiresAt,
    }, 'API key rotation event received');

    try {
      // Fetch the new key via bind
      const bindResponse = await bindManagedApiKey(event.apiKeyName);
      const newKey = bindResponse.key;

      // Find which env vars map to this API key
      const envVars = findEnvVarsForApiKey(mappings, event.apiKeyName);

      for (const envVar of envVars) {
        // Update local cache
        currentEnv[envVar] = newKey;

        // Update env file
        await updateEnvFile(outputPath, envVar, newKey);
        console.log(chalk.green('✓') + ` Updated ${envVar} in ${outputPath} (API key rotated)`);
      }
    } catch (err) {
      log.error({ err, keyName: event.apiKeyName }, 'Failed to handle API key rotation');
      console.error(chalk.red('✗') + ` Failed to update API key ${event.apiKeyName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Handle secret update events
  wsClient.onSecretEvent(async (event: SecretEvent) => {
    if (isShuttingDown) return;

    // Find mappings that match this secret
    const matchingMappings = mappings.filter(
      m => m.secretId === event.secretId || m.secretId === event.alias
    );

    if (matchingMappings.length === 0) {
      log.debug({ secretId: event.secretId, alias: event.alias }, 'Ignoring event for untracked secret');
      return;
    }

    log.info({
      secretId: event.secretId,
      alias: event.alias,
      event: event.event,
      version: event.version,
    }, 'Secret update event received');

    try {
      // Fetch the updated secret
      const secret = await getSecret(event.secretId);

      for (const mapping of matchingMappings) {
        let value: string;

        if (mapping.key) {
          const keyValue = secret.data[mapping.key];
          if (keyValue === undefined) {
            log.warn({ key: mapping.key, secretId: mapping.secretId }, 'Key not found in secret');
            continue;
          }
          value = typeof keyValue === 'string' ? keyValue : JSON.stringify(keyValue);
        } else {
          value = JSON.stringify(secret.data);
        }

        // Update local cache
        currentEnv[mapping.envVar] = value;

        // Update env file
        await updateEnvFile(outputPath, mapping.envVar, value);
        console.log(chalk.green('✓') + ` Updated ${mapping.envVar} in ${outputPath} (secret ${event.event})`);
      }
    } catch (err) {
      log.error({ err, secretId: event.secretId }, 'Failed to handle secret update');
      console.error(chalk.red('✗') + ` Failed to update secret ${event.secretId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Handle connection events
  wsClient.onConnect((agentId) => {
    log.info({ agentId }, 'Connected to vault WebSocket');
    console.log(chalk.green('✓') + ' Connected to vault (watching for changes)');
  });

  wsClient.onDisconnect((reason) => {
    if (!isShuttingDown) {
      log.warn({ reason }, 'Disconnected from vault WebSocket');
      console.log(chalk.yellow('⚠') + ` Disconnected from vault: ${reason} (reconnecting...)`);
    }
  });

  wsClient.onError((err) => {
    log.error({ err }, 'WebSocket error');
  });

  // Connect to WebSocket
  wsClient.connect();

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(chalk.blue('\nℹ') + ` Received ${signal}, shutting down...`);

    wsClient.disconnect();

    if (isManagedKeyMode()) {
      stopManagedKeyRenewal();
    }

    process.exit(0);
  };

  // Handle shutdown signals
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process alive
  await new Promise(() => {
    // Never resolves - process runs until killed
  });
}
