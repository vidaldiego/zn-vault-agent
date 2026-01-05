#!/usr/bin/env node

import { Command } from 'commander';
import { registerLoginCommand } from './commands/login.js';
import { registerCertsCommands } from './commands/certs.js';
import { registerSecretsCommands } from './commands/secrets.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerStartCommand } from './commands/start.js';
import { registerStatusCommand } from './commands/status.js';
import { registerExecCommand } from './commands/exec.js';
import { registerSetupCommand } from './commands/setup.js';

// Version injected at build time by esbuild
declare const __VERSION__: string;
const version = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0-dev';

const program = new Command();

program
  .name('zn-vault-agent')
  .description('ZN-Vault Agent - Sync certificates and secrets from vault')
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

// Parse arguments
program.parse();
