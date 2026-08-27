// Path: src/commands/setup.test.ts
// Unit tests for the setup command's systemd-unit content builders.

import { describe, it, expect } from 'vitest';
import { buildUpdaterUnit, buildSudoersFile, buildUpdaterPathUnit, buildPayaraDropIn } from './setup.js';

describe('buildUpdaterUnit', () => {
  it('should be a oneshot unit', () => {
    const unit = buildUpdaterUnit();
    expect(unit).toContain('Type=oneshot');
  });

  it('ExecStart runs the wrapper script (not inline npm)', () => {
    const unit = buildUpdaterUnit();
    expect(unit).toContain('ExecStart=/usr/local/lib/zn-vault-agent/zn-vault-agent-update.sh');
    expect(unit).not.toContain('npm install -g');
  });

  it('should try-restart the agent in ExecStartPost', () => {
    const unit = buildUpdaterUnit();
    expect(unit).toMatch(
      /^ExecStartPost=\S*systemctl try-restart zn-vault-agent$/m
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
    expect(unit).toContain('ExecStartPost=');
    expect(unit).toContain('try-restart zn-vault-agent');
  });
});

describe('buildSudoersFile', () => {
  it('permits the agent user to start the updater unit via sudo systemctl', () => {
    const sudoers = buildSudoersFile();
    // The non-root self-update path runs exactly this command; the rule must
    // match it byte-for-byte (absolute systemctl path + unit name).
    expect(sudoers).toContain(
      'zn-vault-agent ALL=(root) NOPASSWD: /usr/bin/systemctl start zn-vault-agent-updater.service'
    );
  });

  it('permits the best-effort npm install fallback (no-unit / dev hosts)', () => {
    const sudoers = buildSudoersFile();
    expect(sudoers).toMatch(/zn-vault-agent ALL=\(root\) NOPASSWD: \S*npm install -g @zincapp\/zn-vault-agent/);
  });

  it('targets the zn-vault-agent service user on every rule', () => {
    const sudoers = buildSudoersFile();
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
    expect(s).toContain('/usr/bin/tee /opt/payara/glassfish/domains/*/config/setenv.conf');
    expect(s).toContain('/usr/bin/chown payara\\:payara /opt/payara/glassfish/domains/*/config/setenv.conf');
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
