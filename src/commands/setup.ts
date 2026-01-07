// Path: zn-vault-agent/src/commands/setup.ts

/**
 * Setup Command
 *
 * Installs systemd service and creates necessary directories
 * for running zn-vault-agent as a system daemon.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SYSTEM_USER = 'zn-vault-agent';
const SERVICE_NAME = 'zn-vault-agent';
const CONFIG_DIR = '/etc/zn-vault-agent';
const DATA_DIR = '/var/lib/zn-vault-agent';
const LOG_DIR = '/var/log/zn-vault-agent';
const CERT_DIR = '/etc/ssl/znvault';
const SERVICE_FILE = `/etc/systemd/system/${SERVICE_NAME}.service`;

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Install systemd service and create directories')
    .option('--uninstall', 'Remove systemd service and optionally config')
    .option('--purge', 'Also remove configuration (only with --uninstall)')
    .option('--skip-user', 'Skip creating system user')
    .option('-y, --yes', 'Skip confirmation prompts')
    .addHelpText('after', `
Examples:
  # Install systemd service (requires root)
  sudo zn-vault-agent setup

  # Remove systemd service but keep config
  sudo zn-vault-agent setup --uninstall

  # Remove everything including config
  sudo zn-vault-agent setup --uninstall --purge
`)
    .action(async (options) => {
      // Check for root
      if (process.getuid && process.getuid() !== 0) {
        console.error(chalk.red('This command requires root. Run with sudo.'));
        process.exit(1);
      }

      if (options.uninstall) {
        await handleUninstall(options);
      } else {
        await handleInstall(options);
      }
    });
}

async function handleInstall(options: { skipUser?: boolean; yes?: boolean }): Promise<void> {
  console.log();
  console.log(chalk.bold('ZN-Vault Agent Setup'));
  console.log();

  // Confirm installation
  if (!options.yes) {
    console.log('This will:');
    console.log(`  - Create system user: ${SYSTEM_USER}`);
    console.log(`  - Create directories:`);
    console.log(`      ${CONFIG_DIR}/`);
    console.log(`      ${DATA_DIR}/`);
    console.log(`      ${LOG_DIR}/`);
    console.log(`      ${CERT_DIR}/`);
    console.log(`  - Install systemd service: ${SERVICE_NAME}`);
    console.log();

    const inquirer = await import('inquirer');
    const { confirm } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Proceed with installation?',
        default: true,
      },
    ]);

    if (!confirm) {
      console.log('Installation cancelled.');
      return;
    }
  }

  console.log();

  // Step 1: Create system user
  if (!options.skipUser) {
    try {
      // Check if user exists
      execSync(`id ${SYSTEM_USER}`, { stdio: 'pipe' });
      console.log(chalk.gray(`User ${SYSTEM_USER} already exists`));
    } catch {
      console.log(`Creating user ${SYSTEM_USER}...`);
      try {
        execSync(
          `useradd --system --no-create-home --shell /sbin/nologin ${SYSTEM_USER}`,
          { stdio: 'inherit' }
        );
        console.log(chalk.green(`  Created user ${SYSTEM_USER}`));
      } catch {
        console.log(chalk.yellow(`  Could not create user (might already exist)`));
      }
    }
  }

  // Step 2: Create directories
  const directories = [
    { path: CONFIG_DIR, mode: 0o755 },
    { path: DATA_DIR, mode: 0o750 },
    { path: LOG_DIR, mode: 0o750 },
    { path: CERT_DIR, mode: 0o750 },
  ];

  for (const dir of directories) {
    if (!existsSync(dir.path)) {
      console.log(`Creating ${dir.path}/...`);
      mkdirSync(dir.path, { recursive: true, mode: dir.mode });
      execSync(`chown ${SYSTEM_USER}:${SYSTEM_USER} ${dir.path}`);
      console.log(chalk.green(`  Created ${dir.path}/`));
    } else {
      console.log(chalk.gray(`${dir.path}/ already exists`));
    }
  }

  // Step 3: Create config template if not exists
  const envFile = join(CONFIG_DIR, 'agent.env');
  if (!existsSync(envFile)) {
    console.log(`Creating ${envFile}...`);
    writeFileSync(
      envFile,
      `# ZN-Vault Agent Configuration
# See: zn-vault-agent --help

# Logging
LOG_LEVEL=info

# Auto-update settings (optional)
# AUTO_UPDATE=true
# AUTO_UPDATE_INTERVAL=300
# AUTO_UPDATE_CHANNEL=latest
`,
      { mode: 0o640 }
    );
    execSync(`chown ${SYSTEM_USER}:${SYSTEM_USER} ${envFile}`);
    console.log(chalk.green(`  Created ${envFile}`));
  } else {
    console.log(chalk.gray(`${envFile} already exists`));
  }

  // Step 4: Copy systemd service file
  console.log(`Installing systemd service...`);
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Try to find the service file in the package
  const possiblePaths = [
    join(__dirname, '..', '..', 'deploy', 'systemd', 'zn-vault-agent.service'),
    join(__dirname, '..', 'deploy', 'systemd', 'zn-vault-agent.service'),
    '/usr/local/lib/node_modules/@zincapp/zn-vault-agent/deploy/systemd/zn-vault-agent.service',
  ];

  let sourceServiceFile: string | null = null;
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      sourceServiceFile = p;
      break;
    }
  }

  if (sourceServiceFile) {
    copyFileSync(sourceServiceFile, SERVICE_FILE);
    console.log(chalk.green(`  Installed ${SERVICE_FILE}`));
  } else {
    // Generate service file inline
    const serviceContent = generateServiceFile();
    writeFileSync(SERVICE_FILE, serviceContent, { mode: 0o644 });
    console.log(chalk.green(`  Generated ${SERVICE_FILE}`));
  }

  // Step 5: Reload systemd
  console.log('Reloading systemd...');
  execSync('systemctl daemon-reload', { stdio: 'inherit' });
  console.log(chalk.green('  systemd reloaded'));

  // Enable service (but don't start)
  console.log('Enabling service...');
  execSync(`systemctl enable ${SERVICE_NAME}`, { stdio: 'inherit' });
  console.log(chalk.green(`  ${SERVICE_NAME} enabled`));

  console.log();
  console.log(chalk.green.bold('Setup complete!'));
  console.log();
  console.log('Next steps:');
  console.log(`  1. Configure the agent: ${chalk.cyan('zn-vault-agent login')}`);
  console.log(`  2. Add certificates: ${chalk.cyan('zn-vault-agent certs add')}`);
  console.log(`  3. Start the service: ${chalk.cyan(`sudo systemctl start ${SERVICE_NAME}`)}`);
  console.log(`  4. Check status: ${chalk.cyan(`sudo systemctl status ${SERVICE_NAME}`)}`);
  console.log();
}

async function handleUninstall(options: { purge?: boolean; yes?: boolean }): Promise<void> {
  console.log();
  console.log(chalk.bold('ZN-Vault Agent Uninstall'));
  console.log();

  // Confirm uninstall
  if (!options.yes) {
    console.log('This will:');
    console.log(`  - Stop and disable systemd service: ${SERVICE_NAME}`);
    console.log(`  - Remove service file: ${SERVICE_FILE}`);
    if (options.purge) {
      console.log(chalk.yellow(`  - Remove configuration: ${CONFIG_DIR}/`));
      console.log(chalk.yellow(`  - Remove data: ${DATA_DIR}/`));
      console.log(chalk.yellow(`  - Remove logs: ${LOG_DIR}/`));
    }
    console.log();

    const inquirer = await import('inquirer');
    const { confirm } = await inquirer.default.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: options.purge
          ? 'Are you sure? This will remove all configuration and data!'
          : 'Proceed with uninstall?',
        default: false,
      },
    ]);

    if (!confirm) {
      console.log('Uninstall cancelled.');
      return;
    }
  }

  console.log();

  // Stop service
  try {
    console.log('Stopping service...');
    execSync(`systemctl stop ${SERVICE_NAME}`, { stdio: 'pipe' });
    console.log(chalk.green(`  ${SERVICE_NAME} stopped`));
  } catch {
    console.log(chalk.gray('  Service not running'));
  }

  // Disable service
  try {
    console.log('Disabling service...');
    execSync(`systemctl disable ${SERVICE_NAME}`, { stdio: 'pipe' });
    console.log(chalk.green(`  ${SERVICE_NAME} disabled`));
  } catch {
    console.log(chalk.gray('  Service not enabled'));
  }

  // Remove service file
  if (existsSync(SERVICE_FILE)) {
    console.log(`Removing ${SERVICE_FILE}...`);
    unlinkSync(SERVICE_FILE);
    console.log(chalk.green(`  Removed ${SERVICE_FILE}`));
  }

  // Reload systemd
  console.log('Reloading systemd...');
  execSync('systemctl daemon-reload', { stdio: 'inherit' });

  // Purge if requested
  if (options.purge) {
    const dirsToRemove = [CONFIG_DIR, DATA_DIR, LOG_DIR];
    for (const dir of dirsToRemove) {
      if (existsSync(dir)) {
        console.log(`Removing ${dir}/...`);
        execSync(`rm -rf ${dir}`, { stdio: 'inherit' });
        console.log(chalk.green(`  Removed ${dir}/`));
      }
    }
  }

  console.log();
  console.log(chalk.green.bold('Uninstall complete!'));
  if (!options.purge) {
    console.log();
    console.log(chalk.gray(`Configuration preserved in ${CONFIG_DIR}/`));
    console.log(chalk.gray(`Data preserved in ${DATA_DIR}/`));
    console.log(chalk.gray('Use --purge to remove all data.'));
  }
  console.log();
}

function generateServiceFile(): string {
  // Find the binary path
  let binPath = '/usr/local/bin/zn-vault-agent';
  try {
    const result = execSync('which zn-vault-agent', { encoding: 'utf-8', stdio: 'pipe' });
    binPath = result.trim();
  } catch {
    // Use default
  }

  return `[Unit]
Description=ZN-Vault Certificate Agent
Documentation=https://github.com/zincapp/zn-vault
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SYSTEM_USER}
Group=${SYSTEM_USER}

# Working directory
WorkingDirectory=${DATA_DIR}

# Main executable
ExecStart=${binPath} start --health-port 9100

# Restart policy
Restart=always
RestartSec=5
StartLimitInterval=60
StartLimitBurst=5

# Environment
EnvironmentFile=${CONFIG_DIR}/agent.env
EnvironmentFile=-${CONFIG_DIR}/secrets.env
# Set HOME to data directory (required for conf package and Node.js)
Environment=HOME=${DATA_DIR}

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Shutdown
TimeoutStopSec=30
KillMode=mixed
KillSignal=SIGTERM

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true

# Allow writing certificates, logs, and config
ReadWritePaths=${CERT_DIR}
ReadWritePaths=${DATA_DIR}
ReadWritePaths=${LOG_DIR}
ReadWritePaths=${CONFIG_DIR}

# Network access
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# System call filter
# Note: @system-service covers most syscalls, but Node.js 18+ requires statx
# which is not in @system-service. We add it explicitly.
SystemCallFilter=@system-service
SystemCallFilter=statx
SystemCallArchitectures=native

# Capabilities
CapabilityBoundingSet=
AmbientCapabilities=

# Resource limits
MemoryHigh=256M
MemoryMax=512M
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
`;
}
