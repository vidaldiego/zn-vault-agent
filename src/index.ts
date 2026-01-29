#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { registerLoginCommand } from './commands/login.js';
import { registerCertsCommands } from './commands/certs.js';
import { registerSecretsCommands } from './commands/secrets.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerStartCommand } from './commands/start.js';
import { registerStatusCommand } from './commands/status.js';
import { registerExecCommand } from './commands/exec.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerTLSCommands } from './commands/tls.js';

// Read version from package.json at runtime
function getVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Try dist/../package.json first (installed via npm)
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
const version = getVersion();

const program = new Command();

program
  .name('zn-vault-agent')
  .description('ZnVault Agent - Sync certificates and secrets from vault')
  .version(version);

// Register commands
registerLoginCommand(program);
registerCertsCommands(program);
registerSecretsCommands(program);
registerSyncCommand(program);
registerStartCommand(program);
registerStatusCommand(program);
registerExecCommand(program);
registerSetupCommand(program);
registerTLSCommands(program);

// Parse arguments
program.parse();
