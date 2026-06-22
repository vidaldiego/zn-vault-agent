// Path: zn-vault-agent/src/commands/setup.ts

/**
 * Setup Command
 *
 * Installs systemd service and creates necessary directories
 * for running zn-vault-agent as a system daemon.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  chownSafe,
  chmodSafe,
  useraddSafe,
  userExists,
  systemctlSafe,
  systemctlSafeQuiet,
  rmDirSafe,
  whichSafe,
} from '../utils/shell.js';
import type { SetupCommandOptions } from './types.js';

const SYSTEM_USER = 'zn-vault-agent';
const SERVICE_NAME = 'zn-vault-agent';
const UPDATER_SERVICE_NAME = 'zn-vault-agent-updater';
const NPM_PACKAGE = '@zincapp/zn-vault-agent';
const SYSTEMD_DIR = '/etc/systemd/system';
const CONFIG_DIR = '/etc/zn-vault-agent';
const DATA_DIR = '/var/lib/zn-vault-agent';
const LOG_DIR = '/var/log/zn-vault-agent';
const CERT_DIR = '/etc/ssl/znvault';
const SERVICE_FILE = `${SYSTEMD_DIR}/${SERVICE_NAME}.service`;
const UPDATER_SERVICE_FILE = `${SYSTEMD_DIR}/${UPDATER_SERVICE_NAME}.service`;
const SUDOERS_FILE = `/etc/sudoers.d/${SYSTEM_USER}`;
const UPDATER_PATH_NAME = 'zn-vault-agent-updater';
const UPDATER_PATH_FILE = `${SYSTEMD_DIR}/${UPDATER_PATH_NAME}.path`;
const WRAPPER_INSTALL_DIR = '/usr/local/lib/zn-vault-agent';
const WRAPPER_INSTALL_PATH = `${WRAPPER_INSTALL_DIR}/zn-vault-agent-update.sh`;
const TRIGGER_FILE = `${DATA_DIR}/.update-trigger`;

// Payara plugin integration. When this plugin is present, the agent must be able
// to sudo (write setenv.conf, run asadmin as the payara user) — which the strict
// base profile blocks (NoNewPrivileges + empty CapabilityBoundingSet). We detect
// it and (a) emit the payara sudoers rules into the managed sudoers file, and
// (b) drop in a unit override that re-grants the caps sudo needs. See
// INC-2026-06-22 (setup clobbered the plugin's sudoers + strict profile broke
// the plugin's startup sudo, taking Payara down).
const PAYARA_PLUGIN_PACKAGE = '@zincapp/znvault-plugin-payara';
const PAYARA_DROPIN_FILE = `${SYSTEMD_DIR}/${SERVICE_NAME}.service.d/20-payara-sudo.conf`;
// The OS user Payara runs as, and its install root. Overridable via env for
// non-default deployments; defaults match the standard host layout.
const PAYARA_USER = process.env.ZNVAULT_PAYARA_USER ?? 'payara';
const PAYARA_HOME = process.env.ZNVAULT_PAYARA_HOME ?? '/opt/payara';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Detect whether the Payara plugin is installed for this agent. Checks the
 * common npm-global install locations for the plugin package — the most reliable
 * signal at setup time (a config-from-vault agent may have no local plugin
 * config on disk yet).
 */
function isPayaraPluginInstalled(): boolean {
  const candidates = [
    `/usr/lib/node_modules/${PAYARA_PLUGIN_PACKAGE}`,
    `/usr/local/lib/node_modules/${PAYARA_PLUGIN_PACKAGE}`,
    join(__dirname, '..', '..', '..', PAYARA_PLUGIN_PACKAGE),
  ];
  return candidates.some((p) => existsSync(p));
}

function resolveBundledFile(rel: string): string {
  const candidates = [
    join(__dirname, '..', '..', 'deploy', rel),
    join(__dirname, '..', 'deploy', rel),
    `/usr/local/lib/node_modules/@zincapp/zn-vault-agent/deploy/${rel}`,
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`Bundled file not found: ${rel} (looked in ${candidates.join(', ')})`);
}

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
    .action(async (options: SetupCommandOptions) => {
      // Check for root
      if (process.getuid && process.getuid() !== 0) {
        console.error(chalk.red('This command requires root. Run with sudo.'));
        process.exit(1);
      }

      if (options.uninstall === true) {
        await handleUninstall({ purge: options.purge, yes: options.yes });
      } else {
        await handleInstall({ skipUser: options.skipUser, yes: options.yes });
      }
    });
}

async function handleInstall(options: { skipUser?: boolean; yes?: boolean }): Promise<void> {
  console.log();
  console.log(chalk.bold('ZnVault Agent Setup'));
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
    console.log(`  - Install updater unit (root-owned): ${UPDATER_SERVICE_NAME}`);
    console.log(`  - Install sudoers rule: ${SUDOERS_FILE}`);
    console.log();

    const inquirer = await import('inquirer');
    const { confirm } = await inquirer.default.prompt<{ confirm: boolean }>([
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

  // Step 1: Create system user (using safe utilities)
  if (!options.skipUser) {
    if (userExists(SYSTEM_USER)) {
      console.log(chalk.gray(`User ${SYSTEM_USER} already exists`));
    } else {
      console.log(`Creating user ${SYSTEM_USER}...`);
      try {
        useraddSafe(SYSTEM_USER, {
          system: true,
          noCreateHome: true,
          shell: '/sbin/nologin',
        });
        console.log(chalk.green(`  Created user ${SYSTEM_USER}`));
      } catch {
        console.log(chalk.yellow(`  Could not create user (might already exist)`));
      }
    }
  }

  // Step 2: Create directories (using safe chown)
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
      chownSafe(dir.path, `${SYSTEM_USER}:${SYSTEM_USER}`);
      console.log(chalk.green(`  Created ${dir.path}/`));
    } else {
      console.log(chalk.gray(`${dir.path}/ already exists`));
    }
  }

  // Step 3: Create config template if not exists (using safe chown)
  const envFile = join(CONFIG_DIR, 'agent.env');
  if (!existsSync(envFile)) {
    console.log(`Creating ${envFile}...`);
    writeFileSync(
      envFile,
      `# ZnVault Agent Configuration
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
    chownSafe(envFile, `${SYSTEM_USER}:${SYSTEM_USER}`);
    console.log(chalk.green(`  Created ${envFile}`));
  } else {
    console.log(chalk.gray(`${envFile} already exists`));
  }

  // Step 4: Copy systemd service file
  console.log(`Installing systemd service...`);

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

  // Step 4b: Install the root-owned updater unit (oneshot, activated by the
  // companion .path watcher). The main agent unit runs as a sandboxed non-root
  // user and cannot self-install via npm (ProtectSystem=strict). This helper
  // runs the wrapper script as root. Written root:root 0644; not enabled
  // directly — the .path unit activates it on trigger-file creation.
  console.log('Installing updater unit...');
  const updaterContent = buildUpdaterUnit();
  // Overwrite if it already exists (idempotent refresh).
  writeFileSync(UPDATER_SERVICE_FILE, updaterContent, { mode: 0o644 });
  chownSafe(UPDATER_SERVICE_FILE, 'root:root');
  console.log(chalk.green(`  Installed ${UPDATER_SERVICE_FILE}`));

  // Install the root-owned updater wrapper script that the oneshot runs.
  console.log('Installing updater wrapper...');
  if (!existsSync(WRAPPER_INSTALL_DIR)) {
    mkdirSync(WRAPPER_INSTALL_DIR, { recursive: true, mode: 0o755 });
  }
  const wrapperSrc = resolveBundledFile('scripts/zn-vault-agent-update.sh');
  copyFileSync(wrapperSrc, WRAPPER_INSTALL_PATH);
  chownSafe(WRAPPER_INSTALL_PATH, 'root:root');
  chmodSafe(WRAPPER_INSTALL_PATH, '0755');
  console.log(chalk.green(`  Installed ${WRAPPER_INSTALL_PATH}`));

  // Install the .path unit that activates the updater on trigger-file creation.
  console.log('Installing updater path unit...');
  writeFileSync(UPDATER_PATH_FILE, buildUpdaterPathUnit(), { mode: 0o644 });
  chownSafe(UPDATER_PATH_FILE, 'root:root');
  console.log(chalk.green(`  Installed ${UPDATER_PATH_FILE}`));

  // Remove any stale trigger so enabling the .path does not fire-on-enable.
  if (existsSync(TRIGGER_FILE)) {
    unlinkSync(TRIGGER_FILE);
  }

  // Step 4b-payara: On Payara hosts, drop in a unit override that re-grants the
  // caps sudo needs (the plugin sudoes for setenv.conf + asadmin). The strict
  // base profile would otherwise break the plugin's startup → Payara down
  // (INC-2026-06-22). Non-Payara hosts are left on the strict profile.
  const payaraHost = isPayaraPluginInstalled();
  if (payaraHost) {
    console.log('Payara plugin detected — installing sudo capability drop-in...');
    const dropInDir = dirname(PAYARA_DROPIN_FILE);
    if (!existsSync(dropInDir)) {
      mkdirSync(dropInDir, { recursive: true, mode: 0o755 });
    }
    writeFileSync(PAYARA_DROPIN_FILE, buildPayaraDropIn(), { mode: 0o644 });
    chownSafe(PAYARA_DROPIN_FILE, 'root:root');
    console.log(chalk.green(`  Installed ${PAYARA_DROPIN_FILE}`));
  }

  // Step 4c: Provision the sudoers rule that lets the non-root agent user start
  // the root-owned updater unit (a bare `systemctl start` is polkit-denied). The
  // agent's self-update runs `sudo /usr/bin/systemctl start <updater unit>`,
  // which is the ONLY working path under ProtectSystem=strict (an in-process
  // `sudo npm install` EROFS'es — INC-2026-06-12-01). Written 0440 root:root
  // (the mode sudo requires) and overwritten idempotently.
  console.log(`Installing sudoers rule${payaraHost ? ' (incl. Payara plugin rules)' : ''}...`);
  const sudoersContent = buildSudoersFile(payaraHost);
  // Write restrictive first, then enforce ownership + mode (sudo refuses a
  // sudoers file that is group/world-writable or not owned by root).
  writeFileSync(SUDOERS_FILE, sudoersContent, { mode: 0o440 });
  chownSafe(SUDOERS_FILE, 'root:root');
  chmodSafe(SUDOERS_FILE, '0440');
  console.log(chalk.green(`  Installed ${SUDOERS_FILE}`));

  // Step 5: Reload systemd (using safe utilities)
  console.log('Reloading systemd...');
  systemctlSafe('daemon-reload');
  console.log(chalk.green('  systemd reloaded'));

  // Enable + start the updater .path watcher (enable --now is two calls here).
  console.log('Enabling updater path watcher...');
  systemctlSafe('enable', `${UPDATER_PATH_NAME}.path`);
  systemctlSafe('start', `${UPDATER_PATH_NAME}.path`);
  console.log(chalk.green(`  ${UPDATER_PATH_NAME}.path enabled`));

  // Enable service (but don't start)
  console.log('Enabling service...');
  systemctlSafe('enable', SERVICE_NAME);
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
  console.log(chalk.bold('ZnVault Agent Uninstall'));
  console.log();

  // Confirm uninstall
  if (!options.yes) {
    console.log('This will:');
    console.log(`  - Stop and disable systemd service: ${SERVICE_NAME}`);
    console.log(`  - Remove service file: ${SERVICE_FILE}`);
    console.log(`  - Remove updater unit: ${UPDATER_SERVICE_FILE}`);
    console.log(`  - Remove sudoers rule: ${SUDOERS_FILE}`);
    if (options.purge) {
      console.log(chalk.yellow(`  - Remove configuration: ${CONFIG_DIR}/`));
      console.log(chalk.yellow(`  - Remove data: ${DATA_DIR}/`));
      console.log(chalk.yellow(`  - Remove logs: ${LOG_DIR}/`));
    }
    console.log();

    const inquirer = await import('inquirer');
    const { confirm } = await inquirer.default.prompt<{ confirm: boolean }>([
      {
        type: 'confirm',
        name: 'confirm',
        message: options.purge === true
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

  // Stop service (using safe utilities)
  try {
    console.log('Stopping service...');
    systemctlSafeQuiet('stop', SERVICE_NAME);
    console.log(chalk.green(`  ${SERVICE_NAME} stopped`));
  } catch {
    console.log(chalk.gray('  Service not running'));
  }

  // Disable service (using safe utilities)
  try {
    console.log('Disabling service...');
    systemctlSafeQuiet('disable', SERVICE_NAME);
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

  // Remove the root-owned updater unit
  if (existsSync(UPDATER_SERVICE_FILE)) {
    console.log(`Removing ${UPDATER_SERVICE_FILE}...`);
    unlinkSync(UPDATER_SERVICE_FILE);
    console.log(chalk.green(`  Removed ${UPDATER_SERVICE_FILE}`));
  }

  // Remove the .path unit, wrapper script, and stale trigger
  if (existsSync(UPDATER_PATH_FILE)) {
    systemctlSafeQuiet('disable', `${UPDATER_PATH_NAME}.path`);
    console.log(`Removing ${UPDATER_PATH_FILE}...`);
    unlinkSync(UPDATER_PATH_FILE);
    console.log(chalk.green(`  Removed ${UPDATER_PATH_FILE}`));
  }
  if (existsSync(WRAPPER_INSTALL_PATH)) {
    unlinkSync(WRAPPER_INSTALL_PATH);
    console.log(chalk.green(`  Removed ${WRAPPER_INSTALL_PATH}`));
  }
  if (existsSync(TRIGGER_FILE)) {
    unlinkSync(TRIGGER_FILE);
  }
  if (existsSync(PAYARA_DROPIN_FILE)) {
    unlinkSync(PAYARA_DROPIN_FILE);
    console.log(chalk.green(`  Removed ${PAYARA_DROPIN_FILE}`));
  }

  // Remove the sudoers rule
  if (existsSync(SUDOERS_FILE)) {
    console.log(`Removing ${SUDOERS_FILE}...`);
    unlinkSync(SUDOERS_FILE);
    console.log(chalk.green(`  Removed ${SUDOERS_FILE}`));
  }

  // Reload systemd (using safe utilities)
  console.log('Reloading systemd...');
  systemctlSafe('daemon-reload');

  // Purge if requested (using safe rm)
  if (options.purge) {
    const dirsToRemove = [CONFIG_DIR, DATA_DIR, LOG_DIR];
    for (const dir of dirsToRemove) {
      if (existsSync(dir)) {
        console.log(`Removing ${dir}/...`);
        rmDirSafe(dir);
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
  // Find the binary path (using safe which)
  const foundPath = whichSafe('zn-vault-agent');
  const binPath = foundPath ?? '/usr/local/bin/zn-vault-agent';

  return `[Unit]
Description=ZnVault Certificate Agent
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

# System call filter - DISABLED
# Node.js uses syscalls not covered by @system-service (statx, rseq, etc.)
# and the filtering is too fragile across different Node.js versions.
# Other security hardening (NoNewPrivileges, ProtectSystem, etc.) still applies.
# SystemCallFilter=@system-service
# SystemCallArchitectures=native

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

/**
 * Build the content of the root-owned `zn-vault-agent-updater.service` unit.
 *
 * This is a `Type=oneshot` helper unit that runs the wrapper script as root,
 * outside the main agent unit's `ProtectSystem=strict` sandbox (which blocks the
 * agent from writing `/usr/lib/node_modules` + `/usr/bin` — see
 * INC-2026-06-12-01 P4). It is activated by the companion `.path` watcher when
 * an operator writes the trigger file. `ExecStartPost` restarts the agent onto
 * the freshly installed version.
 *
 * The unit has no `[Install]` section by design — it is activated by the `.path`
 * unit, not enabled directly.
 *
 * @returns The full systemd unit file content.
 */
export function buildUpdaterUnit(): string {
  const systemctlPath = whichSafe('systemctl') ?? '/usr/bin/systemctl';

  return `[Unit]
Description=Update ${SERVICE_NAME} (root-owned; agent unit sandbox blocks self-update - INC-2026-06-12-01 P4)
Documentation=https://github.com/zincapp/zn-vault

[Service]
Type=oneshot
ExecStart=${WRAPPER_INSTALL_PATH} ${TRIGGER_FILE}
ExecStartPost=${systemctlPath} try-restart ${SERVICE_NAME}
`;
}

/**
 * Build the root-owned `.path` unit that watches the trigger file and activates
 * the updater oneshot. Uses `PathExists` + delete-on-consume (the wrapper
 * deletes the trigger) so it cannot fire-on-enable against a stale file or loop
 * on a truncate. See the design spec.
 */
export function buildUpdaterPathUnit(): string {
  return `[Unit]
Description=Watch for ${SERVICE_NAME} self-update triggers

[Path]
PathExists=${TRIGGER_FILE}
Unit=${UPDATER_PATH_NAME}.service

[Install]
WantedBy=paths.target
`;
}

/**
 * Build the content of the `/etc/sudoers.d/zn-vault-agent` rules file.
 *
 * The agent runs as the unprivileged `${SYSTEM_USER}` service user under
 * `ProtectSystem=strict`, so it cannot self-update in process: `/usr` is
 * read-only in the agent's mount namespace and `sudo` only changes the uid, not
 * the namespace, so an in-process `sudo npm install` fails EROFS writing
 * `/usr/bin` (INC-2026-06-12-01). The only working path is starting the
 * root-owned `${UPDATER_SERVICE_NAME}.service`, which runs in its own clean
 * namespace — but a bare `systemctl start` is polkit-denied for the agent user
 * ("interactive authentication required").
 *
 * This file grants the two NOPASSWD rules the agent's self-update relies on:
 *  1. Starting the updater unit (the primary, sandbox-safe path):
 *       `sudo /usr/bin/systemctl start ${UPDATER_SERVICE_NAME}.service`
 *  2. A best-effort direct `npm install` for dev / non-systemd hosts that have
 *     no updater unit and no ProtectSystem sandbox.
 *
 * The first rule MUST match the command the agent runs byte-for-byte (absolute
 * `/usr/bin/systemctl` path + exact unit name) — sudoers matches on the literal
 * command, so any divergence makes the rule a no-op.
 *
 * The file MUST be installed mode 0440, owned root:root (sudo refuses to load a
 * sudoers file that is group/world-writable). See `handleInstall`.
 *
 * @returns The full sudoers rules-file content.
 */
export function buildSudoersFile(includePayara: boolean = isPayaraPluginInstalled()): string {
  const npmPath = whichSafe('npm') ?? '/usr/bin/npm';
  // Absolute systemctl path; must match the command performUpdate runs and the
  // path baked into the npm-auto-update service (SYSTEMCTL_BIN).
  const systemctlPath = '/usr/bin/systemctl';

  let content = `# Managed by 'zn-vault-agent setup' — do not edit by hand.
#
# Allow the unprivileged ${SYSTEM_USER} service user to self-update.
# The agent unit runs under ProtectSystem=strict, so an in-process
# 'sudo npm install' EROFS-fails writing /usr/bin (INC-2026-06-12-01). The
# working path is starting the root-owned updater unit, which runs in its own
# namespace. A bare 'systemctl start' is polkit-denied, so it is whitelisted
# here. The npm-install rule is a best-effort fallback for dev / non-systemd
# hosts that have no updater unit.
${SYSTEM_USER} ALL=(root) NOPASSWD: ${systemctlPath} start ${UPDATER_SERVICE_NAME}.service
${SYSTEM_USER} ALL=(root) NOPASSWD: ${npmPath} install -g ${NPM_PACKAGE}@latest
`;

  if (includePayara) {
    // Rules the Payara plugin needs: run asadmin as the payara user, and manage
    // setenv.conf as root. Without these, the plugin cannot start the domain and
    // Payara stays down (INC-2026-06-22). Emitted into the SAME managed file so a
    // later `setup` run preserves them (rather than clobbering an out-of-band file).
    content += `
# --- Payara plugin (${PAYARA_PLUGIN_PACKAGE}) ---
# Run asadmin / env / bash as the payara user (plugin lifecycle + health).
${SYSTEM_USER} ALL=(${PAYARA_USER}) NOPASSWD: /usr/bin/env *
${SYSTEM_USER} ALL=(${PAYARA_USER}) NOPASSWD: ${PAYARA_HOME}/bin/asadmin *
${SYSTEM_USER} ALL=(${PAYARA_USER}) NOPASSWD: ${PAYARA_HOME}/glassfish/bin/asadmin *
${SYSTEM_USER} ALL=(${PAYARA_USER}) NOPASSWD: /usr/bin/bash *
# Manage setenv.conf (secret injection) as root.
${SYSTEM_USER} ALL=(root) NOPASSWD: /usr/bin/tee ${PAYARA_HOME}/glassfish/domains/*/config/setenv.conf
${SYSTEM_USER} ALL=(root) NOPASSWD: /usr/bin/chmod 640 ${PAYARA_HOME}/glassfish/domains/*/config/setenv.conf
${SYSTEM_USER} ALL=(root) NOPASSWD: /usr/bin/chown ${PAYARA_USER}\\:${PAYARA_USER} ${PAYARA_HOME}/glassfish/domains/*/config/setenv.conf
# Process management for aggressive-mode deploys.
${SYSTEM_USER} ALL=(root) NOPASSWD: /usr/bin/kill *
${SYSTEM_USER} ALL=(root) NOPASSWD: /usr/bin/pkill *
`;
  }

  return content;
}

/**
 * Build the systemd drop-in that re-grants the capabilities `sudo` needs on
 * Payara hosts. The strict base unit sets NoNewPrivileges=true + an empty
 * CapabilityBoundingSet + PrivateDevices=yes, which together break sudo
 * (cannot setgid, audit plugin fails to init). The Payara plugin sudoes at
 * startup (setenv.conf) and during deploys (asadmin), so those hosts need this.
 * Non-Payara hosts keep the strict profile untouched.
 */
export function buildPayaraDropIn(): string {
  return `[Service]
# Payara plugin requires sudo (setenv.conf write + asadmin as the payara user).
# The strict base profile (NoNewPrivileges + empty CapabilityBoundingSet +
# PrivateDevices) blocks sudo; re-grant only what sudo needs. See INC-2026-06-22.
NoNewPrivileges=no
RestrictSUIDSGID=no
PrivateDevices=no
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_AUDIT_WRITE CAP_DAC_OVERRIDE CAP_CHOWN CAP_FOWNER
`;
}
