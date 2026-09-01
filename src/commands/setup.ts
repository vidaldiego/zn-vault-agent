// Path: zn-vault-agent/src/commands/setup.ts

/**
 * Setup Command
 *
 * Installs systemd service and creates necessary directories
 * for running zn-vault-agent as a system daemon.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  chownSafe,
  chmodSafe,
  ensureUserInGroupSafe,
  getPrimaryGroupSafe,
  useraddSafe,
  userExists,
  systemctlSafe,
  systemctlSafeQuiet,
  rmDirSafe,
  whichSafe,
  validateSudoersSafe,
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
// Obsolete polling activation shipped by an early updater bootstrap. Starting
// the trigger-consuming oneshot on a clock with no trigger makes it fail every
// day and leaves otherwise healthy hosts in systemd's degraded state. The
// event-driven .path unit below is the sole supported activation mechanism.
const LEGACY_UPDATER_TIMER_FILE = `${SYSTEMD_DIR}/${UPDATER_SERVICE_NAME}.timer`;
const WRAPPER_INSTALL_DIR = '/usr/local/lib/zn-vault-agent';
const WRAPPER_INSTALL_PATH = `${WRAPPER_INSTALL_DIR}/zn-vault-agent-update.sh`;
const TRIGGER_FILE = `${DATA_DIR}/.update-trigger`;
const UPDATER_STATE_DIR = '/var/lib/zn-vault-agent-updater';
const PLUGIN_UPDATER_SERVICE_NAME = 'zn-vault-agent-plugin-updater';
const PLUGIN_UPDATER_PATH_NAME = PLUGIN_UPDATER_SERVICE_NAME;
const PLUGIN_UPDATER_SERVICE_FILE = `${SYSTEMD_DIR}/${PLUGIN_UPDATER_SERVICE_NAME}.service`;
const PLUGIN_UPDATER_PATH_FILE = `${SYSTEMD_DIR}/${PLUGIN_UPDATER_PATH_NAME}.path`;
const PLUGIN_UPDATER_WRAPPER_INSTALL_PATH = `${WRAPPER_INSTALL_DIR}/zn-vault-plugin-update.sh`;
const PLUGIN_UPDATE_TRIGGER_FILE = `${DATA_DIR}/.plugin-update-trigger`;
const PLUGIN_UPDATE_ACTIVE_FILE = `${DATA_DIR}/.plugin-update-active`;
const PLUGIN_UPDATE_RECEIPT_DIR = '/var/lib/zn-vault-agent-plugin-updater';
const PAYARA_MUTATION_TOKEN_FILE = `${CONFIG_DIR}/payara-mutation-token`;
const UPDATE_UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UPDATE_SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

function exactUpdateTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function readTrustedSetupUpdateRecord(
  filePath: string,
  expectedUid: number,
  expectedMode: number
): string | null {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(filePath);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.uid !== expectedUid
    || (before.mode & 0o777) !== expectedMode
    || before.nlink !== 1
    || before.size < 1
    || before.size > 512
  ) {
    throw new Error(`Untrusted pending updater evidence: ${filePath}`);
  }
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== 'number' || noFollow === 0) {
    throw new Error('Updater setup preflight requires O_NOFOLLOW support');
  }
  const fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollow);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.uid !== expectedUid
      || (opened.mode & 0o777) !== expectedMode
      || opened.nlink !== 1
      || opened.size !== before.size
    ) {
      throw new Error(`Pending updater evidence changed during setup preflight: ${filePath}`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function exactUpdateFields(content: string, count: number, filePath: string): string[] {
  if (!content.endsWith('\n') || content.slice(0, -1).includes('\n') || content.includes('\r')) {
    throw new Error(`Incompatible pending updater schema: ${filePath}`);
  }
  const fields = content.slice(0, -1).split(' ');
  if (fields.length !== count || fields.some(field => field.length === 0)) {
    throw new Error(`Incompatible pending updater schema: ${filePath}`);
  }
  return fields;
}

/** Fail closed before setup can activate a new wrapper against legacy evidence. */
export function validatePendingUpdaterEvidenceForSetup(
  expectedAgentUid: number,
  selfTrigger: string = TRIGGER_FILE,
  pluginTrigger: string = PLUGIN_UPDATE_TRIGGER_FILE,
  pluginActive: string = PLUGIN_UPDATE_ACTIVE_FILE
): { selfPending: boolean; pluginPending: boolean } {
  const fail = (message: string): never => {
    throw new Error(
      `${message}. Setup preserved the evidence; let the installed updater finish ` +
      'or reconcile it explicitly before retrying setup'
    );
  };

  let self: string | null;
  try {
    self = readTrustedSetupUpdateRecord(selfTrigger, expectedAgentUid, 0o600);
  } catch {
    return fail(`Incompatible pre-2.0 Agent update trigger at ${selfTrigger}`);
  }
  if (self !== null) {
    let fields: string[];
    try {
      fields = exactUpdateFields(self, 6, selfTrigger);
    } catch {
      return fail(`Incompatible pre-2.0 Agent update trigger at ${selfTrigger}`);
    }
    const [schema, requestId, current, target, channel, requestedAt] = fields;
    if (
      schema !== 'v1'
      || !UPDATE_UUID_V4_RE.test(requestId)
      || !UPDATE_SEMVER_RE.test(current)
      || !UPDATE_SEMVER_RE.test(target)
      || !['latest', 'beta', 'next'].includes(channel)
      || !exactUpdateTimestamp(requestedAt)
    ) {
      return fail(`Incompatible pre-2.0 Agent update trigger at ${selfTrigger}`);
    }
  }

  let pluginTriggerContent: string | null;
  let pluginActiveContent: string | null;
  try {
    pluginTriggerContent = readTrustedSetupUpdateRecord(pluginTrigger, expectedAgentUid, 0o600);
    pluginActiveContent = readTrustedSetupUpdateRecord(pluginActive, expectedAgentUid, 0o600);
  } catch {
    return fail('Untrusted pending Payara update evidence');
  }
  for (const [filePath, content] of [
    [pluginTrigger, pluginTriggerContent],
    [pluginActive, pluginActiveContent],
  ] as const) {
    if (content === null) continue;
    let fields: string[];
    try {
      fields = exactUpdateFields(content, 5, filePath);
    } catch {
      return fail(`Incompatible Payara update evidence at ${filePath}`);
    }
    const [schema, requestId, current, target, requestedAt] = fields;
    if (
      schema !== 'v1'
      || !UPDATE_UUID_V4_RE.test(requestId)
      || !UPDATE_SEMVER_RE.test(current)
      || !UPDATE_SEMVER_RE.test(target)
      || !target.startsWith('3.')
      || !exactUpdateTimestamp(requestedAt)
    ) {
      return fail(`Incompatible Payara update evidence at ${filePath}`);
    }
  }
  if (
    pluginTriggerContent !== null
    && pluginActiveContent !== null
    && pluginTriggerContent !== pluginActiveContent
  ) {
    return fail('Payara trigger and active update evidence do not match');
  }
  return {
    selfPending: self !== null,
    pluginPending: pluginTriggerContent !== null || pluginActiveContent !== null,
  };
}

export function ensurePluginUpdaterReceiptDirectory(
  directory: string = PLUGIN_UPDATE_RECEIPT_DIR,
  uid: number = 0,
  gid: number = 0
): void {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: false, mode: 0o755 });
  const before = lstatSync(directory);
  if (!before.isDirectory() || before.isSymbolicLink() || !fsConstants.O_NOFOLLOW) {
    throw new Error(`Refusing untrusted plugin updater receipt directory: ${directory}`);
  }
  const directoryFlag = fsConstants.O_DIRECTORY ?? 0;
  const fd = openSync(directory, fsConstants.O_RDONLY | directoryFlag | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Plugin updater receipt directory changed while opening: ${directory}`);
    }
    fchownSync(fd, uid, gid);
    fchmodSync(fd, 0o755);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Create or secure a regular file without ever following a symbolic link.
 * Ownership and mode are applied to the opened inode, closing the path-swap
 * race that would exist with path-based chown/chmod during privileged setup.
 */
export function ensureOwnedRegularFile(
  filePath: string,
  initialContent: string,
  mode: number,
  uid: number,
  gid: number,
  validateContent?: (content: string) => void,
  maximumContentBytes?: number
): boolean {
  validateContent?.(initialContent);
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== 'number' || noFollow === 0) {
    throw new Error('Secure system config setup requires O_NOFOLLOW support');
  }
  let fd: number | undefined;
  let created = false;

  try {
    try {
      fd = openSync(
        filePath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
        mode
      );
      created = true;
      writeFileSync(fd, initialContent, { encoding: 'utf8' });
    } catch (err) {
      if (!(err instanceof Error) || !('code' in err) || err.code !== 'EEXIST') {
        throw err;
      }

      const pathState = lstatSync(filePath);
      if (pathState.isSymbolicLink() || !pathState.isFile()) {
        throw new Error(`Refusing non-regular system config path: ${filePath}`);
      }
      fd = openSync(
        filePath,
        fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollow
      );
    }

    const openedState = fstatSync(fd);
    if (!openedState.isFile() || openedState.nlink !== 1) {
      throw new Error(`Refusing non-regular or multiply-linked system config: ${filePath}`);
    }
    if (
      maximumContentBytes !== undefined
      && openedState.size > maximumContentBytes
    ) {
      throw new Error(`Refusing oversized managed file: ${filePath}`);
    }
    if (!created && validateContent) {
      validateContent(readFileSync(fd, 'utf8'));
    }
    if (openedState.uid !== uid || openedState.gid !== gid) {
      fchownSync(fd, uid, gid);
    }
    fchmodSync(fd, mode);
    return created;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Strict on-disk representation for the separate Payara mutation credential. */
export function assertValidPayaraMutationToken(content: string): void {
  const match = /^([A-Za-z0-9_-]{43})\n?$/.exec(content);
  const token = match?.[1];
  if (
    token === undefined
    || Buffer.from(token, 'base64url').length !== 32
    || Buffer.from(token, 'base64url').toString('base64url') !== token
  ) {
    throw new Error(
      'Existing Payara mutation token must be exactly 32 random bytes encoded as base64url'
    );
  }
}

/**
 * Create the Payara mutation credential exactly once. Existing valid bytes are
 * preserved; unsafe inode types, links, modes, ownership, or malformed content
 * fail closed through ensureOwnedRegularFile.
 */
export function ensurePayaraMutationTokenFile(
  filePath: string,
  uid: number,
  gid: number,
  tokenFactory: () => string = () => randomBytes(32).toString('base64url')
): boolean {
  return ensureOwnedRegularFile(
    filePath,
    `${tokenFactory()}\n`,
    0o600,
    uid,
    gid,
    assertValidPayaraMutationToken,
    44
  );
}

export interface DataDirectoryPolicy {
  group: string;
  mode: number;
}

/** Payara reads only group-readable artifacts; it never receives directory write access. */
export function resolveDataDirectoryPolicy(
  payaraEnabled: boolean,
  payaraPrimaryGroup: string = 'payara'
): DataDirectoryPolicy {
  return payaraEnabled
    ? { group: payaraPrimaryGroup, mode: 0o2750 }
    : { group: SYSTEM_USER, mode: 0o750 };
}

/** Write, validate, and atomically install one privileged managed file. */
export function installValidatedFileAtomically(
  destination: string,
  content: string,
  mode: number,
  uid: number,
  gid: number,
  validate: (candidatePath: string) => void
): void {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== 'number' || noFollow === 0) {
    throw new Error('Secure privileged file installation requires O_NOFOLLOW support');
  }

  const candidate = join(dirname(destination), `.${randomUUID()}.candidate`);
  let fd: number | undefined;
  try {
    fd = openSync(
      candidate,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
      mode
    );
    writeFileSync(fd, content, { encoding: 'utf8' });
    const candidateState = fstatSync(fd);
    if (!candidateState.isFile() || candidateState.nlink !== 1) {
      throw new Error(`Refusing unsafe privileged file candidate: ${candidate}`);
    }
    if (candidateState.uid !== uid || candidateState.gid !== gid) {
      fchownSync(fd, uid, gid);
    }
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    validate(candidate);
    renameSync(candidate, destination);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(candidate)) unlinkSync(candidate);
  }
}

/**
 * Install a privileged updater wrapper without touching an in-flight durable
 * operation. Atomic rename keeps a helper already executing the old inode
 * intact, while future activations see the completely validated new script.
 *
 * @returns true when trigger or active evidence was present and preserved.
 */
export function installUpdaterWrapperAtomically(
  source: string,
  destination: string,
  triggerFile: string,
  activeFile: string | undefined,
  uid: number = 0,
  gid: number = 0
): boolean {
  const operationPresent = existsSync(triggerFile)
    || (activeFile !== undefined && existsSync(activeFile));
  const content = readFileSync(source, 'utf8');
  installValidatedFileAtomically(destination, content, 0o755, uid, gid, candidate => {
    execFileSync('/bin/bash', ['-n', candidate], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  });
  return operationPresent;
}

/** Remove one setup-managed file when its optional integration is disabled. */
export function removeManagedFileWhenDisabled(
  enabled: boolean,
  filePath: string
): boolean {
  if (enabled || !existsSync(filePath)) return false;

  const state = lstatSync(filePath);
  if (state.isDirectory()) {
    throw new Error(`Refusing to remove managed-file directory: ${filePath}`);
  }
  unlinkSync(filePath);
  return true;
}

// Payara plugin integration. When this plugin is present, the agent must be able
// to sudo (run asadmin and replace setenv.conf as the Payara user) — which the strict
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
// Real install dir behind the /opt/payara symlink (→ /opt/payara7). systemd
// ReadWritePaths usually resolves the symlink, but listing the real target too
// is the robust choice across systemd versions. Overridable for non-default
// layouts; '' (when PAYARA_HOME isn't symlinked) is filtered out.
const PAYARA_HOME_REAL = process.env.ZNVAULT_PAYARA_HOME_REAL ?? '/opt/payara7';
// Directory holding the deployed WAR (warPath). The deploy writes the WAR here,
// so it must be writable under the agent's ProtectSystem=strict sandbox.
const PAYARA_WAR_ROOT = process.env.ZNVAULT_PAYARA_WAR_ROOT ?? '/opt/zincapi';
// Memory cap for the agent unit on Payara hosts. The agent SPAWNS the Payara JVM
// (via `sudo -u payara ... start-domain`), so the JVM inherits the agent's
// cgroup. The base unit caps it at 512M, which an 8GB-heap JVM cannot start
// inside ("Failed to commit memory / Could not create the JVM", INC-2026-06-22).
// On dedicated Payara hosts we lift the cap (default: infinity). Override with a
// concrete value (e.g. '10G') via env if the host is shared.
const PAYARA_MEMORY_MAX = process.env.ZNVAULT_PAYARA_MEMORY_MAX ?? 'infinity';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Detect whether the Payara plugin is installed for this agent. Checks the
 * common npm-global install locations for the plugin package — the most reliable
 * signal at setup time (a config-from-vault agent may have no local plugin
 * config on disk yet).
 */
export function getPayaraPluginCandidates(): string[] {
  const packageBasename = PAYARA_PLUGIN_PACKAGE.slice(PAYARA_PLUGIN_PACKAGE.lastIndexOf('/') + 1);
  const executablePrefix = dirname(dirname(process.execPath));
  const configuredPrefix = process.env.npm_config_prefix;
  return [...new Set([
    `/usr/lib/node_modules/${PAYARA_PLUGIN_PACKAGE}`,
    `/usr/local/lib/node_modules/${PAYARA_PLUGIN_PACKAGE}`,
    // Globally installed scoped packages are siblings below @zincapp. Using
    // the full scoped name here would incorrectly duplicate the scope.
    join(__dirname, '..', '..', '..', packageBasename),
    join(executablePrefix, 'lib', 'node_modules', PAYARA_PLUGIN_PACKAGE),
    configuredPrefix
      ? join(configuredPrefix, 'lib', 'node_modules', PAYARA_PLUGIN_PACKAGE)
      : '',
  ].filter(Boolean))];
}

export function isPayaraPluginInstalled(
  candidates: string[] = getPayaraPluginCandidates()
): boolean {
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
    console.log(`  - Create or validate private mutation credential: ${PAYARA_MUTATION_TOKEN_FILE}`);
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

  const payaraHost = isPayaraPluginInstalled();

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

  let payaraPrimaryGroup: string | undefined;
  if (payaraHost) {
    if (!userExists(PAYARA_USER)) {
      throw new Error(
        `Payara plugin detected but Unix user ${PAYARA_USER} does not exist; ` +
        'create the Payara runtime account before running setup'
      );
    }
    payaraPrimaryGroup = getPrimaryGroupSafe(PAYARA_USER);
    if (ensureUserInGroupSafe(SYSTEM_USER, payaraPrimaryGroup)) {
      console.log(chalk.green(
        `  Added ${SYSTEM_USER} to Payara read group ${payaraPrimaryGroup}`
      ));
    } else {
      console.log(chalk.gray(
        `${SYSTEM_USER} already belongs to Payara read group ${payaraPrimaryGroup}`
      ));
    }
  }

  // Step 2: Create directories (using safe chown)
  const dataDirectoryPolicy = resolveDataDirectoryPolicy(
    payaraHost,
    payaraPrimaryGroup
  );
  const directories = [
    { path: CONFIG_DIR, mode: 0o755, group: SYSTEM_USER },
    { path: DATA_DIR, mode: dataDirectoryPolicy.mode, group: dataDirectoryPolicy.group },
    { path: LOG_DIR, mode: 0o750, group: SYSTEM_USER },
    { path: CERT_DIR, mode: 0o750, group: SYSTEM_USER },
  ];

  for (const dir of directories) {
    if (!existsSync(dir.path)) {
      console.log(`Creating ${dir.path}/...`);
      mkdirSync(dir.path, { recursive: true, mode: dir.mode });
      chownSafe(dir.path, `${SYSTEM_USER}:${dir.group}`);
      console.log(chalk.green(`  Created ${dir.path}/`));
    } else {
      console.log(chalk.gray(`${dir.path}/ already exists`));
    }
    const dirState = lstatSync(dir.path);
    if (dirState.isSymbolicLink() || !dirState.isDirectory()) {
      throw new Error(`Refusing non-directory setup path: ${dir.path}`);
    }
    chownSafe(dir.path, `${SYSTEM_USER}:${dir.group}`);
    chmodSafe(dir.path, dir.mode.toString(8).padStart(4, '0'));
  }

  // A 1.x updater trigger used a two-field, mode-0644 record that the exact
  // 2.0 root wrapper must never consume. Validate pending evidence before
  // installing/enabling any new updater assets; setup never deletes it.
  const updaterEvidence = validatePendingUpdaterEvidenceForSetup(statSync(DATA_DIR).uid);
  if (updaterEvidence.selfPending || updaterEvidence.pluginPending) {
    console.log(chalk.yellow('  Preserving validated in-flight updater evidence'));
  }

  // Step 3: Create config files through no-follow descriptors. CONFIG_DIR is
  // writable by the service account, so privileged setup must not use
  // path-based writes/chown on attacker-replaceable entries.
  const configDirState = statSync(CONFIG_DIR);
  const envFile = join(CONFIG_DIR, 'agent.env');
  const createdEnv = ensureOwnedRegularFile(
    envFile,
    `# ZnVault Agent Configuration
# See: zn-vault-agent --help

# Logging
LOG_LEVEL=info

# Auto-update settings (optional)
# AUTO_UPDATE=true
# AUTO_UPDATE_INTERVAL=300
# AUTO_UPDATE_CHANNEL=dr-m4
`,
    0o640,
    configDirState.uid,
    configDirState.gid
  );
  if (createdEnv) {
    console.log(`Creating ${envFile}...`);
    console.log(chalk.green(`  Created ${envFile}`));
  } else {
    console.log(chalk.gray(`${envFile} already exists`));
  }

  // Reserve the system configuration path for the service account. Without
  // this file, an operator running `login` as their own user would silently
  // create a separate per-user config that systemd never reads. Never
  // overwrite an existing configuration during setup or upgrades.
  const configFile = join(CONFIG_DIR, 'config.json');
  const createdConfig = ensureOwnedRegularFile(
    configFile,
    '{}\n',
    0o600,
    configDirState.uid,
    configDirState.gid
  );
  if (createdConfig) {
    console.log(`Creating ${configFile}...`);
    console.log(chalk.green(`  Created ${configFile}`));
  } else {
    console.log(chalk.gray(`${configFile} already exists`));
  }

  const createdMutationToken = ensurePayaraMutationTokenFile(
    PAYARA_MUTATION_TOKEN_FILE,
    configDirState.uid,
    configDirState.gid
  );
  if (createdMutationToken) {
    console.log(`Creating ${PAYARA_MUTATION_TOKEN_FILE}...`);
    console.log(chalk.green(`  Created ${PAYARA_MUTATION_TOKEN_FILE}`));
  } else {
    console.log(chalk.gray(`${PAYARA_MUTATION_TOKEN_FILE} already exists and is valid`));
  }

  // Step 4: Install the systemd service file. Generate it at setup time so
  // ExecStart uses the binary that is actually installed on this host. The
  // packaged reference unit intentionally cannot know whether npm linked the
  // executable under /usr/bin, /usr/local/bin, or another absolute prefix.
  console.log(`Installing systemd service...`);
  const serviceContent = buildAgentServiceUnit();
  writeFileSync(SERVICE_FILE, serviceContent, { mode: 0o644 });
  console.log(chalk.green(`  Installed ${SERVICE_FILE}`));

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
  const preservedAgentUpdate = installUpdaterWrapperAtomically(
    wrapperSrc,
    WRAPPER_INSTALL_PATH,
    TRIGGER_FILE,
    undefined
  );
  console.log(chalk.green(`  Installed ${WRAPPER_INSTALL_PATH}`));
  if (preservedAgentUpdate) {
    console.log(chalk.yellow('  Preserved in-flight Agent update trigger evidence'));
  }

  // Install the .path unit that activates the updater on trigger-file creation.
  console.log('Installing updater path unit...');
  writeFileSync(UPDATER_PATH_FILE, buildUpdaterPathUnit(), { mode: 0o644 });
  chownSafe(UPDATER_PATH_FILE, 'root:root');
  console.log(chalk.green(`  Installed ${UPDATER_PATH_FILE}`));

  // Separate allowlisted Payara updater. Unlike the Agent self-updater this
  // helper has no ExecStartPost: the Agent verifies its root receipt, restarts
  // once, then confirms Payara 3 startup before reporting terminal success.
  console.log('Installing exact Payara plugin updater rail...');
  ensurePluginUpdaterReceiptDirectory();
  writeFileSync(PLUGIN_UPDATER_SERVICE_FILE, buildPluginUpdaterUnit(), { mode: 0o644 });
  chownSafe(PLUGIN_UPDATER_SERVICE_FILE, 'root:root');
  writeFileSync(PLUGIN_UPDATER_PATH_FILE, buildPluginUpdaterPathUnit(), { mode: 0o644 });
  chownSafe(PLUGIN_UPDATER_PATH_FILE, 'root:root');
  const pluginWrapperSrc = resolveBundledFile('scripts/zn-vault-plugin-update.sh');
  const preservedPluginUpdate = installUpdaterWrapperAtomically(
    pluginWrapperSrc,
    PLUGIN_UPDATER_WRAPPER_INSTALL_PATH,
    PLUGIN_UPDATE_TRIGGER_FILE,
    PLUGIN_UPDATE_ACTIVE_FILE
  );
  console.log(chalk.green(`  Installed ${PLUGIN_UPDATER_SERVICE_FILE}`));
  console.log(chalk.green(`  Installed ${PLUGIN_UPDATER_PATH_FILE}`));
  console.log(chalk.green(`  Installed ${PLUGIN_UPDATER_WRAPPER_INSTALL_PATH}`));
  if (preservedPluginUpdate) {
    console.log(chalk.yellow('  Preserved in-flight Payara plugin update trigger/active evidence'));
  }

  // Retire the legacy daily timer before daemon-reload. A current setup must
  // also heal hosts upgraded from that older activation model; merely writing
  // the new .path unit leaves the old timer enabled indefinitely.
  systemctlSafeQuiet('stop', `${UPDATER_SERVICE_NAME}.timer`);
  systemctlSafeQuiet('disable', `${UPDATER_SERVICE_NAME}.timer`);
  if (existsSync(LEGACY_UPDATER_TIMER_FILE)) {
    unlinkSync(LEGACY_UPDATER_TIMER_FILE);
    console.log(chalk.green(`  Removed obsolete ${LEGACY_UPDATER_TIMER_FILE}`));
  }

  // Both updater triggers (and the Payara active record) are durable
  // transaction evidence owned by their exact root helpers. Setup must never
  // delete them: a helper may currently hold its kernel lock or may need the
  // evidence for crash reconciliation. Enabling the path unit deliberately
  // resumes that operation.

  // Step 4b-payara: On Payara hosts, drop in a unit override that re-grants the
  // caps sudo needs (the plugin sudoes to the Payara account). The strict
  // base profile would otherwise break the plugin's startup → Payara down
  // (INC-2026-06-22). Non-Payara hosts are left on the strict profile.
  if (payaraHost) {
    console.log('Payara plugin detected — installing sudo capability drop-in...');
    const dropInDir = dirname(PAYARA_DROPIN_FILE);
    if (!existsSync(dropInDir)) {
      mkdirSync(dropInDir, { recursive: true, mode: 0o755 });
    }
    writeFileSync(
      PAYARA_DROPIN_FILE,
      buildPayaraDropIn(payaraPrimaryGroup),
      { mode: 0o644 }
    );
    chownSafe(PAYARA_DROPIN_FILE, 'root:root');
    console.log(chalk.green(`  Installed ${PAYARA_DROPIN_FILE}`));
  } else if (removeManagedFileWhenDisabled(payaraHost, PAYARA_DROPIN_FILE)) {
    // setup owns this exact drop-in. Removing it when the plugin is absent
    // restores the strict base profile after a plugin uninstall or move.
    console.log(chalk.green(`  Removed obsolete ${PAYARA_DROPIN_FILE}`));
  }

  // Step 4c: Provision the sudoers rule that lets the non-root agent user start
  // the root-owned updater unit (a bare `systemctl start` is polkit-denied). The
  // agent's self-update runs `sudo /usr/bin/systemctl start <updater unit>`,
  // which is the ONLY working path under ProtectSystem=strict (an in-process
  // `sudo npm install` EROFS'es — INC-2026-06-12-01). Written 0440 root:root
  // (the mode sudo requires) and overwritten idempotently.
  console.log(`Installing sudoers rule${payaraHost ? ' (incl. Payara plugin rules)' : ''}...`);
  const sudoersContent = buildSudoersFile(payaraHost);
  // Validate a restrictive candidate before atomically replacing the live
  // fragment. A malformed write cannot partially lock out sudo, and a
  // pre-existing symlink is replaced rather than followed.
  installValidatedFileAtomically(
    SUDOERS_FILE,
    sudoersContent,
    0o440,
    0,
    0,
    validateSudoersSafe
  );
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
  systemctlSafe('enable', `${PLUGIN_UPDATER_PATH_NAME}.path`);
  systemctlSafe('start', `${PLUGIN_UPDATER_PATH_NAME}.path`);
  console.log(chalk.green(`  ${PLUGIN_UPDATER_PATH_NAME}.path enabled`));

  // Enable service (but don't start)
  console.log('Enabling service...');
  systemctlSafe('enable', SERVICE_NAME);
  console.log(chalk.green(`  ${SERVICE_NAME} enabled`));

  console.log();
  console.log(chalk.green.bold('Setup complete!'));
  console.log();
  console.log('Next steps:');
  const serviceCommandPrefix =
    'sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent zn-vault-agent';
  console.log(`  1. Configure the agent: ${chalk.cyan(`${serviceCommandPrefix} login`)}`);
  console.log(`  2. Add certificates: ${chalk.cyan(`${serviceCommandPrefix} certs add`)}`);
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
    console.log(`  - Remove Payara plugin updater unit: ${PLUGIN_UPDATER_SERVICE_FILE}`);
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

  systemctlSafeQuiet('stop', `${PLUGIN_UPDATER_PATH_NAME}.path`);
  systemctlSafeQuiet('disable', `${PLUGIN_UPDATER_PATH_NAME}.path`);
  systemctlSafeQuiet('stop', `${PLUGIN_UPDATER_SERVICE_NAME}.service`);
  for (const managedFile of [
    PLUGIN_UPDATER_PATH_FILE,
    PLUGIN_UPDATER_SERVICE_FILE,
    PLUGIN_UPDATER_WRAPPER_INSTALL_PATH,
    PLUGIN_UPDATE_TRIGGER_FILE,
    PLUGIN_UPDATE_ACTIVE_FILE,
  ]) {
    if (existsSync(managedFile)) {
      unlinkSync(managedFile);
      console.log(chalk.green(`  Removed ${managedFile}`));
    }
  }

  // Remove the .path unit, wrapper script, and stale trigger
  if (existsSync(UPDATER_PATH_FILE)) {
    systemctlSafeQuiet('disable', `${UPDATER_PATH_NAME}.path`);
    console.log(`Removing ${UPDATER_PATH_FILE}...`);
    unlinkSync(UPDATER_PATH_FILE);
    console.log(chalk.green(`  Removed ${UPDATER_PATH_FILE}`));
  }
  systemctlSafeQuiet('stop', `${UPDATER_SERVICE_NAME}.timer`);
  systemctlSafeQuiet('disable', `${UPDATER_SERVICE_NAME}.timer`);
  if (existsSync(LEGACY_UPDATER_TIMER_FILE)) {
    unlinkSync(LEGACY_UPDATER_TIMER_FILE);
    console.log(chalk.green(`  Removed ${LEGACY_UPDATER_TIMER_FILE}`));
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
    const dirsToRemove = [CONFIG_DIR, DATA_DIR, LOG_DIR, PLUGIN_UPDATE_RECEIPT_DIR];
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

export function buildAgentServiceUnit(binaryPath?: string): string {
  // Find the binary path (using safe which)
  const binPath = binaryPath ?? whichSafe('zn-vault-agent') ?? '/usr/local/bin/zn-vault-agent';

  if (!binPath.startsWith('/') || /\s/.test(binPath)) {
    throw new Error(`Unsafe zn-vault-agent binary path: ${binPath}`);
  }

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
RuntimeDirectory=${SERVICE_NAME}
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=restart

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
Environment=NODE_ENV=production

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

# Shutdown
TimeoutStopSec=900
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
 * an operator writes the trigger file. The wrapper owns restart as part of its
 * durable receipt reconciliation; the unit deliberately has no ExecStartPost.
 *
 * The unit has no `[Install]` section by design — it is activated by the `.path`
 * unit, not enabled directly. The wrapper retains the trigger until it has
 * written terminal root-owned evidence, so PathExists also fences a second
 * delegation while npm is still running.
 *
 * @returns The full systemd unit file content.
 */
export function buildUpdaterUnit(): string {
  const systemctlPath = whichSafe('systemctl') ?? '/usr/bin/systemctl';
  const npmPath = whichSafe('npm') ?? '/usr/bin/npm';
  const nodePath = whichSafe('node') ?? '/usr/bin/node';

  return `[Unit]
Description=Update ${SERVICE_NAME} (root-owned; agent unit sandbox blocks self-update - INC-2026-06-12-01 P4)
Documentation=https://github.com/zincapp/zn-vault

[Service]
Type=oneshot
User=root
Group=root
StateDirectory=zn-vault-agent-updater
StateDirectoryMode=0755
ExecStart=${WRAPPER_INSTALL_PATH} ${TRIGGER_FILE} ${UPDATER_STATE_DIR} ${npmPath} ${nodePath} ${systemctlPath} ${SERVICE_NAME}
`;
}

/**
 * Build the root-owned `.path` unit that watches the trigger file and activates
 * the updater oneshot. The root wrapper retains the complete trigger through
 * installation and deletes it only after durable terminal evidence, so a
 * concurrent request cannot overwrite or re-delegate the operation.
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

/** Root-owned, fixed-package Payara updater outside ProtectSystem=strict. */
export function buildPluginUpdaterUnit(): string {
  const npmPath = whichSafe('npm') ?? '/usr/bin/npm';
  const nodePath = whichSafe('node') ?? '/usr/bin/node';
  return `[Unit]
Description=Install one exact ZnVault Payara plugin artifact
Documentation=https://github.com/zincapp/zn-vault
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=10min
StartLimitBurst=6

[Service]
Type=oneshot
User=root
Group=root
UMask=0022
StateDirectory=zn-vault-agent-plugin-updater
StateDirectoryMode=0755
TimeoutStartSec=10min
KillMode=control-group
ExecStart=${PLUGIN_UPDATER_WRAPPER_INSTALL_PATH} ${PLUGIN_UPDATE_TRIGGER_FILE} ${PLUGIN_UPDATE_ACTIVE_FILE} ${PLUGIN_UPDATE_RECEIPT_DIR} ${npmPath} ${nodePath}
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictRealtime=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
`;
}

/** Event-driven activation only; no timer and no restart side effect. */
export function buildPluginUpdaterPathUnit(): string {
  return `[Unit]
Description=Watch for exact Payara plugin update requests

[Path]
PathExists=${PLUGIN_UPDATE_TRIGGER_FILE}
Unit=${PLUGIN_UPDATER_SERVICE_NAME}.service
TriggerLimitIntervalSec=10min
TriggerLimitBurst=6

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
    // Rules the Payara plugin needs: run lifecycle commands and atomically
    // replace setenv.conf as the Payara user. Without these, the plugin cannot start the domain and
    // Payara stays down (INC-2026-06-22). Emitted into the SAME managed file so a
    // later `setup` run preserves them (rather than clobbering an out-of-band file).
    content += `
# --- Payara plugin (${PAYARA_PLUGIN_PACKAGE}) ---
# Run asadmin / env / bash as the payara user (plugin lifecycle + health).
${SYSTEM_USER} ALL=(${PAYARA_USER}) NOPASSWD: /usr/bin/env *
${SYSTEM_USER} ALL=(${PAYARA_USER}) NOPASSWD: ${PAYARA_HOME}/bin/asadmin *
${SYSTEM_USER} ALL=(${PAYARA_USER}) NOPASSWD: ${PAYARA_HOME}/glassfish/bin/asadmin *
${SYSTEM_USER} ALL=(${PAYARA_USER}) NOPASSWD: /usr/bin/bash *
`;
  }

  return content;
}

/**
 * Build the systemd drop-in carrying every Payara-plugin requirement that the
 * strict base unit would otherwise block. Two parts, same incident
 * (INC-2026-06-22):
 *
 *  1. sudo capability — the strict base sets NoNewPrivileges=true + an empty
 *     CapabilityBoundingSet + PrivateDevices=yes, which break sudo (cannot
 *     setgid, audit plugin fails to init). The plugin sudoes to the Payara
 *     account for startup and deploys, so re-grant what sudo needs.
 *  2. ReadWritePaths — ProtectSystem=strict makes the FS read-only except the
 *     listed paths. The deploy writes the WAR (warPath) and Payara's domain
 *     state + setenv.conf, which live OUTSIDE the base RW list, so every
 *     `znvault deploy` EROFS-fails without these. /opt/payara is a symlink to
 *     /opt/payara7 — both are listed for robustness across systemd versions.
 *
 * Non-Payara hosts keep the strict profile untouched (this drop-in is only
 * written when the plugin is detected).
 */
export function buildPayaraDropIn(sharedReadGroup: string = PAYARA_USER): string {
  if (!/^[a-z_][a-z0-9_-]{0,30}\$?$/.test(sharedReadGroup)) {
    throw new Error(`Unsafe Payara shared group name: ${sharedReadGroup}`);
  }
  // De-dup + drop empties so a non-symlinked PAYARA_HOME (== PAYARA_HOME_REAL)
  // doesn't list the same path twice.
  const rwPaths = [...new Set([PAYARA_WAR_ROOT, PAYARA_HOME, PAYARA_HOME_REAL].filter(Boolean))];
  return `[Service]
# Payara plugin requires sudo to run lifecycle commands as the Payara user.
# The strict base profile (NoNewPrivileges + empty CapabilityBoundingSet +
# PrivateDevices) blocks sudo; re-grant only what sudo needs. See INC-2026-06-22.
NoNewPrivileges=no
RestrictSUIDSGID=no
PrivateDevices=no
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_AUDIT_WRITE CAP_DAC_OVERRIDE CAP_CHOWN CAP_FOWNER
# API-key files are agent-owned, group-readable, and created below a setgid
# directory. This group is Payara's existing primary group, so already-running
# JVMs can read rotations without gaining write permission.
SupplementaryGroups=${sharedReadGroup}
# ReadWritePaths for the deploy: WAR dir + Payara home (symlink + real target).
# ProtectSystem=strict makes everything else read-only → deploy EROFS without these.
ReadWritePaths=${rwPaths.join(' ')}
# Lift the agent's memory cap: the agent spawns the 8GB-heap Payara JVM, which
# inherits this cgroup. The base 512M cap makes the JVM fail to start. Dedicated
# Payara hosts run uncapped (INC-2026-06-22).
MemoryHigh=infinity
MemoryMax=${PAYARA_MEMORY_MAX}
`;
}
