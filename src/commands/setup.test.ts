// Path: src/commands/setup.test.ts
// Unit tests for the setup command's systemd-unit content builders.

import { describe, it, expect } from 'vitest';
import { buildUpdaterUnit } from './setup.js';

describe('buildUpdaterUnit', () => {
  it('should be a oneshot unit', () => {
    const unit = buildUpdaterUnit();
    expect(unit).toContain('Type=oneshot');
  });

  it('should install @zincapp/zn-vault-agent@latest via npm in ExecStart', () => {
    const unit = buildUpdaterUnit();
    expect(unit).toMatch(
      /^ExecStart=\S*npm install -g @zincapp\/zn-vault-agent@latest$/m
    );
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

  it('should NOT be enabled/started (no [Install] section)', () => {
    const unit = buildUpdaterUnit();
    expect(unit).not.toContain('[Install]');
    expect(unit).not.toContain('WantedBy=');
  });
});
