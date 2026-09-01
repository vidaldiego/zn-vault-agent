// Path: src/commands/setup.test.ts
// Unit tests for the setup command's systemd-unit content builders.

import { afterEach, describe, it, expect } from 'vitest';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildAgentServiceUnit,
  buildUpdaterUnit,
  buildSudoersFile,
  buildUpdaterPathUnit,
  buildPluginUpdaterUnit,
  buildPluginUpdaterPathUnit,
  buildPayaraDropIn,
  assertValidPayaraMutationToken,
  ensureOwnedRegularFile,
  ensurePayaraMutationTokenFile,
  ensurePluginUpdaterReceiptDirectory,
  getPayaraPluginCandidates,
  installUpdaterWrapperAtomically,
  installValidatedFileAtomically,
  isPayaraPluginInstalled,
  removeManagedFileWhenDisabled,
  resolveDataDirectoryPolicy,
  validatePendingUpdaterEvidenceForSetup,
} from './setup.js';

describe('setup updater-evidence preflight', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function paths(): {
    root: string;
    self: string;
    trigger: string;
    active: string;
    uid: number;
  } {
    const root = mkdtempSync(join(tmpdir(), 'znvault-setup-update-preflight-'));
    roots.push(root);
    return {
      root,
      self: join(root, '.update-trigger'),
      trigger: join(root, '.plugin-update-trigger'),
      active: join(root, '.plugin-update-active'),
      uid: statSync(root).uid,
    };
  }

  it('rejects and preserves a legacy two-field mode-0644 Agent trigger', () => {
    const fixture = paths();
    const legacy = '1.23.3 latest\n';
    writeFileSync(fixture.self, legacy, { mode: 0o644 });
    chmodSync(fixture.self, 0o644);

    expect(() => validatePendingUpdaterEvidenceForSetup(
      fixture.uid,
      fixture.self,
      fixture.trigger,
      fixture.active
    )).toThrow(/preserved the evidence/);
    expect(readFileSync(fixture.self, 'utf8')).toBe(legacy);
    expect(statSync(fixture.self).mode & 0o777).toBe(0o644);
  });

  it('accepts and preserves an exact Agent 2 trigger', () => {
    const fixture = paths();
    const exact = 'v1 44444444-4444-4444-8444-444444444444 2.0.0 2.0.1 latest 2026-01-01T00:00:00.000Z\n';
    writeFileSync(fixture.self, exact, { mode: 0o600 });
    chmodSync(fixture.self, 0o600);

    expect(validatePendingUpdaterEvidenceForSetup(
      fixture.uid,
      fixture.self,
      fixture.trigger,
      fixture.active
    )).toEqual({ selfPending: true, pluginPending: false });
    expect(readFileSync(fixture.self, 'utf8')).toBe(exact);
  });

  it('rejects mismatched Payara trigger/active without changing either record', () => {
    const fixture = paths();
    const trigger = 'v1 55555555-5555-4555-8555-555555555555 2.9.0 3.0.1 2026-01-01T00:00:00.000Z\n';
    const active = 'v1 55555555-5555-4555-8555-555555555555 2.9.0 3.0.2 2026-01-01T00:00:00.000Z\n';
    writeFileSync(fixture.trigger, trigger, { mode: 0o600 });
    writeFileSync(fixture.active, active, { mode: 0o600 });
    chmodSync(fixture.trigger, 0o600);
    chmodSync(fixture.active, 0o600);

    expect(() => validatePendingUpdaterEvidenceForSetup(
      fixture.uid,
      fixture.self,
      fixture.trigger,
      fixture.active
    )).toThrow(/do not match/);
    expect(readFileSync(fixture.trigger, 'utf8')).toBe(trigger);
    expect(readFileSync(fixture.active, 'utf8')).toBe(active);
  });
});

describe('system config inode safety', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'znvault-setup-config-'));
    roots.push(root);
    return root;
  }

  it('creates a single-link regular file with mode 0600', () => {
    const root = makeRoot();
    const configPath = join(root, 'config.json');
    const owner = statSync(root);

    expect(ensureOwnedRegularFile(configPath, '{}\n', 0o600, owner.uid, owner.gid))
      .toBe(true);

    const state = lstatSync(configPath);
    expect(state.isFile()).toBe(true);
    expect(state.nlink).toBe(1);
    expect(state.mode & 0o777).toBe(0o600);
    expect(readFileSync(configPath, 'utf8')).toBe('{}\n');
  });

  it('rejects a symlink without changing its target', () => {
    const root = makeRoot();
    const targetPath = join(root, 'target');
    const configPath = join(root, 'config.json');
    writeFileSync(targetPath, 'protected\n', { mode: 0o644 });
    chmodSync(targetPath, 0o644);
    symlinkSync(targetPath, configPath);
    const owner = statSync(root);

    expect(() => ensureOwnedRegularFile(configPath, '{}\n', 0o600, owner.uid, owner.gid))
      .toThrow(/non-regular/);

    expect(readFileSync(targetPath, 'utf8')).toBe('protected\n');
    expect(statSync(targetPath).mode & 0o777).toBe(0o644);
  });

  it('rejects a dangling symlink instead of creating its target', () => {
    const root = makeRoot();
    const targetPath = join(root, 'missing-target');
    const configPath = join(root, 'agent.env');
    symlinkSync(targetPath, configPath);
    const owner = statSync(root);

    expect(() => ensureOwnedRegularFile(configPath, 'LOG_LEVEL=info\n', 0o640, owner.uid, owner.gid))
      .toThrow(/non-regular/);
    expect(() => statSync(targetPath)).toThrow();
  });

  it('secures an existing regular file without overwriting it', () => {
    const root = makeRoot();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, '{"configured":true}\n', { mode: 0o644 });
    const owner = statSync(root);

    expect(ensureOwnedRegularFile(configPath, '{}\n', 0o600, owner.uid, owner.gid))
      .toBe(false);

    expect(readFileSync(configPath, 'utf8')).toBe('{"configured":true}\n');
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('rejects multiply-linked files', () => {
    const root = makeRoot();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, '{}\n', { mode: 0o644 });
    linkSync(configPath, join(root, 'second-link.json'));
    const owner = statSync(root);

    expect(() => ensureOwnedRegularFile(configPath, '{}\n', 0o600, owner.uid, owner.gid))
      .toThrow(/multiply-linked/);
    expect(statSync(configPath).mode & 0o777).toBe(0o644);
  });
});

describe('plugin updater receipt directory setup', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('creates and secures the exact directory through its opened inode', () => {
    const root = mkdtempSync(join(tmpdir(), 'znvault-plugin-receipts-'));
    roots.push(root);
    const directory = join(root, 'receipts');
    const owner = statSync(root);
    ensurePluginUpdaterReceiptDirectory(directory, owner.uid, owner.gid);
    expect(lstatSync(directory).isDirectory()).toBe(true);
    expect(statSync(directory).mode & 0o777).toBe(0o755);
  });

  it('rejects a symlink receipt directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'znvault-plugin-receipts-'));
    roots.push(root);
    const target = join(root, 'target');
    const link = join(root, 'receipts');
    mkdirSync(target);
    symlinkSync(target, link);
    const owner = statSync(root);
    expect(() => ensurePluginUpdaterReceiptDirectory(link, owner.uid, owner.gid))
      .toThrow(/untrusted plugin updater receipt directory/);
  });
});

describe('Payara shared-file setup contract', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'znvault-payara-contract-'));
    roots.push(root);
    return root;
  }

  it('uses a setgid, read-only shared group only on Payara hosts', () => {
    expect(resolveDataDirectoryPolicy(true, 'glassfish')).toEqual({
      group: 'glassfish',
      mode: 0o2750,
    });
    expect(resolveDataDirectoryPolicy(false, 'glassfish')).toEqual({
      group: 'zn-vault-agent',
      mode: 0o750,
    });
  });

  it('creates one 32-byte mutation credential and preserves it idempotently', () => {
    const root = makeRoot();
    const tokenPath = join(root, 'payara-mutation-token');
    const owner = statSync(root);
    const first = Buffer.alloc(32, 0).toString('base64url');
    const second = Buffer.alloc(32, 1).toString('base64url');

    expect(ensurePayaraMutationTokenFile(
      tokenPath,
      owner.uid,
      owner.gid,
      () => first
    )).toBe(true);
    expect(ensurePayaraMutationTokenFile(
      tokenPath,
      owner.uid,
      owner.gid,
      () => second
    )).toBe(false);

    expect(readFileSync(tokenPath, 'utf8')).toBe(`${first}\n`);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('rejects malformed existing mutation credentials without overwriting them', () => {
    const root = makeRoot();
    const tokenPath = join(root, 'payara-mutation-token');
    writeFileSync(tokenPath, 'short\n', { mode: 0o644 });
    const owner = statSync(root);

    expect(() => ensurePayaraMutationTokenFile(
      tokenPath,
      owner.uid,
      owner.gid
    )).toThrow(/exactly 32 random bytes/);
    expect(readFileSync(tokenPath, 'utf8')).toBe('short\n');
  });

  it('rejects oversized existing credentials before reading them as a token', () => {
    const root = makeRoot();
    const tokenPath = join(root, 'payara-mutation-token');
    writeFileSync(tokenPath, 'x'.repeat(1024), { mode: 0o600 });
    const owner = statSync(root);

    expect(() => ensurePayaraMutationTokenFile(
      tokenPath,
      owner.uid,
      owner.gid
    )).toThrow(/oversized managed file/);
  });

  it('rejects symlink and hardlink mutation-token paths', () => {
    const root = makeRoot();
    const owner = statSync(root);
    const validToken = `${'C'.repeat(43)}\n`;
    const target = join(root, 'target');
    const symlink = join(root, 'symlink-token');
    const hardlink = join(root, 'hardlink-token');
    writeFileSync(target, validToken, { mode: 0o600 });
    symlinkSync(target, symlink);
    linkSync(target, hardlink);

    expect(() => ensurePayaraMutationTokenFile(
      symlink,
      owner.uid,
      owner.gid
    )).toThrow(/non-regular/);
    expect(() => ensurePayaraMutationTokenFile(
      hardlink,
      owner.uid,
      owner.gid
    )).toThrow(/multiply-linked/);
    expect(readFileSync(target, 'utf8')).toBe(validToken);
  });

  it('validates canonical base64url rather than only its visible length', () => {
    const canonical = Buffer.alloc(32, 0).toString('base64url');
    expect(() => assertValidPayaraMutationToken(`${canonical}\n`))
      .not.toThrow();
    expect(() => assertValidPayaraMutationToken(`${'A'.repeat(42)}=\n`))
      .toThrow(/exactly 32 random bytes/);
  });
});

describe('atomic validated privileged files', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'znvault-validated-file-'));
    roots.push(root);
    return root;
  }

  it('keeps the prior file when validation rejects the candidate', () => {
    const root = makeRoot();
    const destination = join(root, 'sudoers');
    writeFileSync(destination, 'previous\n', { mode: 0o440 });
    const owner = statSync(root);

    expect(() => installValidatedFileAtomically(
      destination,
      'invalid\n',
      0o440,
      owner.uid,
      owner.gid,
      () => { throw new Error('invalid sudoers'); }
    )).toThrow(/invalid sudoers/);
    expect(readFileSync(destination, 'utf8')).toBe('previous\n');
  });

  it('replaces a symlink atomically instead of following it', () => {
    const root = makeRoot();
    const target = join(root, 'target');
    const destination = join(root, 'sudoers');
    writeFileSync(target, 'protected\n', { mode: 0o644 });
    symlinkSync(target, destination);
    const owner = statSync(root);

    installValidatedFileAtomically(
      destination,
      'validated\n',
      0o440,
      owner.uid,
      owner.gid,
      () => undefined
    );

    expect(lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(readFileSync(destination, 'utf8')).toBe('validated\n');
    expect(readFileSync(target, 'utf8')).toBe('protected\n');
  });
});

describe('optional managed setup files', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes a stale Payara drop-in when Payara is no longer detected', () => {
    const root = mkdtempSync(join(tmpdir(), 'znvault-payara-dropin-'));
    roots.push(root);
    const dropIn = join(root, '20-payara-sudo.conf');
    writeFileSync(dropIn, '[Service]\nNoNewPrivileges=no\n');

    expect(removeManagedFileWhenDisabled(false, dropIn)).toBe(true);
    expect(existsSync(dropIn)).toBe(false);
  });

  it('preserves the Payara drop-in while Payara is detected', () => {
    const root = mkdtempSync(join(tmpdir(), 'znvault-payara-dropin-'));
    roots.push(root);
    const dropIn = join(root, '20-payara-sudo.conf');
    writeFileSync(dropIn, '[Service]\nNoNewPrivileges=no\n');

    expect(removeManagedFileWhenDisabled(true, dropIn)).toBe(false);
    expect(readFileSync(dropIn, 'utf8')).toContain('NoNewPrivileges=no');
  });

  it('detects a plugin in a custom global prefix without duplicating its scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'znvault-custom-prefix-'));
    roots.push(root);
    const pluginDir = join(root, 'lib', 'node_modules', '@zincapp', 'znvault-plugin-payara');
    mkdirSync(pluginDir, { recursive: true });

    expect(isPayaraPluginInstalled([pluginDir])).toBe(true);
    expect(getPayaraPluginCandidates().some((candidate) =>
      candidate.includes('@zincapp/@zincapp/znvault-plugin-payara')
    )).toBe(false);
  });
});

describe('agent service shutdown budget', () => {
  it('uses the absolute npm-linked binary path resolved for this host', () => {
    const unit = buildAgentServiceUnit('/usr/bin/zn-vault-agent');
    expect(unit).toContain('ExecStart=/usr/bin/zn-vault-agent start --health-port 9100');
    expect(unit).not.toContain('ExecStart=/usr/local/bin/zn-vault-agent');
  });

  it('rejects a relative or whitespace-containing executable path', () => {
    expect(() => buildAgentServiceUnit('zn-vault-agent')).toThrow(/Unsafe/);
    expect(() => buildAgentServiceUnit('/usr/bin/zn vault-agent')).toThrow(/Unsafe/);
  });

  it('gives protected Payara mutations 900 seconds to drain', () => {
    expect(buildAgentServiceUnit()).toContain('TimeoutStopSec=900');
    expect(buildAgentServiceUnit()).not.toContain('TimeoutStopSec=30');
  });

  it('runs as a production process while keeping stdout on journald', () => {
    const unit = buildAgentServiceUnit();
    expect(unit).toContain('Environment=NODE_ENV=production');
    expect(unit).toContain('StandardOutput=journal');
  });

  it('provisions a restart-preserved runtime directory for child PID evidence', () => {
    const unit = buildAgentServiceUnit();
    expect(unit).toContain('RuntimeDirectory=zn-vault-agent');
    expect(unit).toContain('RuntimeDirectoryMode=0750');
    expect(unit).toContain('RuntimeDirectoryPreserve=restart');
  });

  it('ships the same 900-second budget in the packaged unit', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const packagedUnit = readFileSync(
      join(testDir, '..', '..', 'deploy', 'systemd', 'zn-vault-agent.service'),
      'utf8'
    );
    expect(packagedUnit).toContain('TimeoutStopSec=900');
    expect(packagedUnit).not.toContain('TimeoutStopSec=30');
  });
});

describe('buildUpdaterUnit', () => {
  it('should be a oneshot unit', () => {
    const unit = buildUpdaterUnit();
    expect(unit).toContain('Type=oneshot');
  });

  it('ExecStart runs the wrapper script (not inline npm)', () => {
    const unit = buildUpdaterUnit();
    expect(unit).toContain('ExecStart=/usr/local/lib/zn-vault-agent/zn-vault-agent-update.sh');
    expect(unit).toContain('/var/lib/zn-vault-agent/.update-trigger /var/lib/zn-vault-agent-updater');
    expect(unit).not.toContain('npm install -g');
  });

  it('runs as root with a dedicated durable state directory', () => {
    const unit = buildUpdaterUnit();
    expect(unit).toContain('User=root');
    expect(unit).toContain('Group=root');
    expect(unit).toContain('StateDirectory=zn-vault-agent-updater');
    expect(unit).toContain('StateDirectoryMode=0755');
  });

  it('delegates restart to the durable wrapper instead of ExecStartPost', () => {
    const unit = buildUpdaterUnit();
    expect(unit).not.toContain('ExecStartPost');
    expect(unit).toMatch(
      /^ExecStart=.* \S*systemctl zn-vault-agent$/m
    );
  });

  it('should document why a root-owned unit exists (INC-2026-06-12-01)', () => {
    const unit = buildUpdaterUnit();
    expect(unit).toContain('INC-2026-06-12-01');
  });

  it('should have a [Unit] and [Service] section', () => {
    const unit = buildUpdaterUnit();
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
  });

  it('should NOT have an [Install] section (path unit activates it instead)', () => {
    const unit = buildUpdaterUnit();
    expect(unit).not.toContain('[Install]');
  });
});

describe('updater path-activation units', () => {
  it('atomically installs the Agent updater while preserving an in-flight trigger', () => {
    const root = mkdtempSync(join(tmpdir(), 'znvault-agent-updater-setup-'));
    const source = join(root, 'bundled-wrapper.sh');
    const destination = join(root, 'installed-wrapper.sh');
    const trigger = join(root, '.update-trigger');
    const record = '2.0.0 latest\n';
    const owner = statSync(root);
    try {
      writeFileSync(source, '#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n', { mode: 0o644 });
      writeFileSync(destination, '#!/usr/bin/env bash\nexit 9\n', { mode: 0o755 });
      writeFileSync(trigger, record, { mode: 0o600 });

      expect(installUpdaterWrapperAtomically(
        source,
        destination,
        trigger,
        undefined,
        owner.uid,
        owner.gid
      )).toBe(true);
      expect(readFileSync(trigger, 'utf8')).toBe(record);
      expect(lstatSync(destination).isFile()).toBe(true);
      expect(statSync(destination).mode & 0o777).toBe(0o755);
      expect(readFileSync(destination, 'utf8')).toContain('set -euo pipefail');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('buildUpdaterPathUnit uses PathExists on the trigger and points at the service', () => {
    const unit = buildUpdaterPathUnit();
    expect(unit).toContain('PathExists=/var/lib/zn-vault-agent/.update-trigger');
    expect(unit).not.toContain('PathModified');
    expect(unit).toContain('Unit=zn-vault-agent-updater.service');
    expect(unit).toContain('WantedBy=paths.target');
  });

  it('has no timer activation in either managed updater unit', () => {
    expect(buildUpdaterPathUnit()).not.toContain('OnCalendar=');
    expect(buildUpdaterUnit()).not.toContain('OnCalendar=');
  });

  it('buildUpdaterUnit ExecStart runs the wrapper script, not inline npm', () => {
    const unit = buildUpdaterUnit();
    expect(unit).toContain('ExecStart=/usr/local/lib/zn-vault-agent/zn-vault-agent-update.sh');
    expect(unit).not.toContain('npm install -g');
    expect(unit).not.toContain('ExecStartPost=');
  });
});

describe('exact Payara plugin updater units', () => {
  it('atomically installs an executable wrapper while preserving trigger and active', () => {
    const root = mkdtempSync(join(tmpdir(), 'znvault-plugin-setup-'));
    const source = join(root, 'bundled-wrapper.sh');
    const destination = join(root, 'installed-wrapper.sh');
    const trigger = join(root, '.plugin-update-trigger');
    const active = join(root, '.plugin-update-active');
    const record = 'v1 11111111-1111-4111-8111-111111111111 2.9.0 3.0.1 2026-01-01T00:00:00.000Z\n';
    const owner = statSync(root);
    try {
      writeFileSync(source, '#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n', { mode: 0o644 });
      writeFileSync(destination, '#!/usr/bin/env bash\nexit 9\n', { mode: 0o755 });
      writeFileSync(trigger, record, { mode: 0o600 });
      writeFileSync(active, record, { mode: 0o600 });

      expect(installUpdaterWrapperAtomically(
        source,
        destination,
        trigger,
        active,
        owner.uid,
        owner.gid
      )).toBe(true);
      expect(readFileSync(trigger, 'utf8')).toBe(record);
      expect(readFileSync(active, 'utf8')).toBe(record);
      expect(lstatSync(destination).isFile()).toBe(true);
      expect(statSync(destination).mode & 0o777).toBe(0o755);
      expect(readFileSync(destination, 'utf8')).toContain('set -euo pipefail');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('delegates fixed trigger+active files to a separate root oneshot', () => {
    const unit = buildPluginUpdaterUnit();
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('User=root');
    expect(unit).toContain('/usr/local/lib/zn-vault-agent/zn-vault-plugin-update.sh');
    expect(unit).toContain('/var/lib/zn-vault-agent/.plugin-update-trigger');
    expect(unit).toContain('/var/lib/zn-vault-agent/.plugin-update-active');
    expect(unit).toContain('StateDirectory=zn-vault-agent-plugin-updater');
    expect(unit).toContain('TimeoutStartSec=10min');
    expect(unit).toContain('StartLimitIntervalSec=10min');
    expect(unit).toContain('StartLimitBurst=6');
    expect(unit).not.toContain('npm install');
  });

  it('never restarts the Agent from the privileged helper', () => {
    const unit = buildPluginUpdaterUnit();
    expect(unit).not.toContain('ExecStartPost');
    expect(unit).not.toContain('systemctl restart');
    expect(unit).not.toContain('try-restart');
  });

  it('uses only event-driven path activation', () => {
    const pathUnit = buildPluginUpdaterPathUnit();
    expect(pathUnit).toContain('PathExists=/var/lib/zn-vault-agent/.plugin-update-trigger');
    expect(pathUnit).toContain('Unit=zn-vault-agent-plugin-updater.service');
    expect(pathUnit).toContain('TriggerLimitIntervalSec=10min');
    expect(pathUnit).toContain('TriggerLimitBurst=6');
    expect(pathUnit).not.toContain('OnCalendar=');
  });
});

describe('buildSudoersFile', () => {
  it('permits the agent user to start the updater unit via sudo systemctl', () => {
    const sudoers = buildSudoersFile(false);
    // The non-root self-update path runs exactly this command; the rule must
    // match it byte-for-byte (absolute systemctl path + unit name).
    expect(sudoers).toContain(
      'zn-vault-agent ALL=(root) NOPASSWD: /usr/bin/systemctl start zn-vault-agent-updater.service'
    );
  });

  it('permits the best-effort npm install fallback (no-unit / dev hosts)', () => {
    const sudoers = buildSudoersFile(false);
    expect(sudoers).toMatch(/zn-vault-agent ALL=\(root\) NOPASSWD: \S*npm install -g @zincapp\/zn-vault-agent/);
  });

  it('targets the zn-vault-agent service user on every rule', () => {
    const sudoers = buildSudoersFile(false);
    const rules = sudoers
      .split('\n')
      .filter((line) => line.includes('NOPASSWD:'));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.startsWith('zn-vault-agent ALL=(root) NOPASSWD:')).toBe(true);
    }
  });
});

describe('buildSudoersFile — Payara awareness', () => {
  it('without Payara: only the base self-update rules (no payara rules)', () => {
    const s = buildSudoersFile(false);
    expect(s).toContain('start zn-vault-agent-updater.service');
    expect(s).toContain('npm install -g @zincapp/zn-vault-agent@latest');
    expect(s).not.toContain('asadmin');
    expect(s).not.toContain('(payara)');
    expect(s).not.toContain('setenv.conf');
  });

  it('with Payara: includes the base rules AND the payara plugin rules', () => {
    const s = buildSudoersFile(true);
    // base rules still present (not clobbered)
    expect(s).toContain('start zn-vault-agent-updater.service');
    // payara rules
    expect(s).toContain('(payara) NOPASSWD: /opt/payara/bin/asadmin *');
    expect(s).toContain('(payara) NOPASSWD: /usr/bin/env *');
    expect(s).toContain('(payara) NOPASSWD: /usr/bin/bash *');
    expect(s).not.toContain('ALL=(root) NOPASSWD: /usr/bin/tee');
    expect(s).not.toContain('ALL=(root) NOPASSWD: /usr/bin/chown');
    expect(s).not.toContain('ALL=(root) NOPASSWD: /usr/bin/chmod');
    expect(s).not.toContain('ALL=(root) NOPASSWD: /usr/bin/kill');
    expect(s).not.toContain('ALL=(root) NOPASSWD: /usr/bin/pkill');
  });
});

describe('buildPayaraDropIn', () => {
  it('re-grants the caps sudo needs and disables NoNewPrivileges', () => {
    const d = buildPayaraDropIn();
    expect(d).toContain('[Service]');
    expect(d).toContain('NoNewPrivileges=no');
    expect(d).toContain('PrivateDevices=no');
    expect(d).toContain('CAP_SETUID');
    expect(d).toContain('CAP_SETGID');
    expect(d).toContain('CAP_AUDIT_WRITE');
    expect(d).toContain('SupplementaryGroups=payara');
  });

  it('binds the agent to the resolved Payara primary group without interpolation', () => {
    expect(buildPayaraDropIn('glassfish')).toContain('SupplementaryGroups=glassfish');
    expect(() => buildPayaraDropIn('payara;id')).toThrow(/Unsafe Payara shared group/);
  });

  it('grants ReadWritePaths for the WAR dir and Payara home (symlink + real target)', () => {
    const d = buildPayaraDropIn();
    const rwLine = d.split('\n').find((l) => l.startsWith('ReadWritePaths='));
    expect(rwLine).toBeDefined();
    expect(rwLine).toContain('/opt/zincapi');
    expect(rwLine).toContain('/opt/payara');
    expect(rwLine).toContain('/opt/payara7');
    // No duplicate path entries.
    const paths = rwLine!.replace('ReadWritePaths=', '').split(' ');
    expect(paths.length).toBe(new Set(paths).size);
  });

  it('lifts the agent memory cap so the spawned Payara JVM can start', () => {
    const d = buildPayaraDropIn();
    // The base unit caps MemoryMax=512M; the agent-spawned 8GB-heap JVM inherits
    // the cgroup, so the drop-in must raise it.
    expect(d).toContain('MemoryHigh=infinity');
    expect(d).toMatch(/MemoryMax=(infinity|\d+[GM])/);
    expect(d).not.toContain('MemoryMax=512M');
  });
});
