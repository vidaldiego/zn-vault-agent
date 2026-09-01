import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishSelfUpdateTriggerAtomically } from './npm-auto-update.js';

const roots: string[] = [];

function fixture(): { root: string; trigger: string } {
  const root = mkdtempSync(join(tmpdir(), 'znvault-self-publish-'));
  roots.push(root);
  chmodSync(root, 0o700);
  return { root, trigger: join(root, '.update-trigger') };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('self-update trigger publisher', () => {
  it('publishes one complete 0600 single-link inode and removes its unique temp', () => {
    const { root, trigger } = fixture();
    const content = 'v1 33333333-3333-4333-8333-333333333333 1.3.0 1.4.0 latest 2026-01-01T10:00:00.000Z\n';

    publishSelfUpdateTriggerAtomically(
      trigger,
      content,
      '11111111-1111-4111-8111-111111111111'
    );

    expect(readFileSync(trigger, 'utf8')).toBe(content);
    const state = statSync(trigger);
    expect(state.mode & 0o777).toBe(0o600);
    expect(state.nlink).toBe(1);
    expect(readdirSync(root)).toEqual(['.update-trigger']);
  });

  it('admits exactly one publisher and never replaces the committed request', () => {
    const { root, trigger } = fixture();
    const first = 'v1 33333333-3333-4333-8333-333333333333 1.3.0 1.4.0 latest 2026-01-01T10:00:00.000Z\n';
    const second = 'v1 44444444-4444-4444-8444-444444444444 1.3.0 1.5.0 latest 2026-01-01T10:00:01.000Z\n';
    const outcomes: string[] = [];

    for (const [content, nonce] of [
      [first, '11111111-1111-4111-8111-111111111111'],
      [second, '22222222-2222-4222-8222-222222222222'],
    ] as const) {
      try {
        publishSelfUpdateTriggerAtomically(trigger, content, nonce);
        outcomes.push('admitted');
      } catch {
        outcomes.push('rejected');
      }
    }

    expect(outcomes).toEqual(['admitted', 'rejected']);
    expect(readFileSync(trigger, 'utf8')).toBe(first);
    expect(readdirSync(root)).toEqual(['.update-trigger']);
  });

  it('preserves a pre-existing trigger byte-for-byte on EEXIST', () => {
    const { root, trigger } = fixture();
    const existing = 'existing-request\n';
    writeFileSync(trigger, existing, { mode: 0o600 });
    chmodSync(trigger, 0o600);

    expect(() => publishSelfUpdateTriggerAtomically(
      trigger,
      'replacement\n',
      '33333333-3333-4333-8333-333333333333'
    ))
      .toThrow();

    expect(readFileSync(trigger, 'utf8')).toBe(existing);
    expect(readdirSync(root)).toEqual(['.update-trigger']);
  });

  it.each([
    'after-link',
    'after-first-dir-fsync',
    'after-temp-unlink',
    'after-second-dir-fsync',
  ] as const)('returns admitted UUID after post-commit fault %s', (failpoint) => {
    const { root, trigger } = fixture();
    const content = 'v1 33333333-3333-4333-8333-333333333333 2.0.0 2.0.1 dr-m4 2026-09-01T03:00:00.000Z\n';

    expect(() => publishSelfUpdateTriggerAtomically(
      trigger,
      content,
      '11111111-1111-4111-8111-111111111111',
      (point) => {
        if (point === failpoint) throw new Error(`fault:${point}`);
      }
    )).not.toThrow();

    expect(readFileSync(trigger, 'utf8')).toBe(content);
    expect(statSync(trigger).nlink).toBe(1);
    expect(readdirSync(root)).toEqual(['.update-trigger']);
  });

  it('rejects a same-byte replacement that is not the original published inode', () => {
    const { trigger } = fixture();
    const content = 'v1 33333333-3333-4333-8333-333333333333 2.0.0 2.0.1 dr-m4 2026-09-01T03:00:00.000Z\n';

    expect(() => publishSelfUpdateTriggerAtomically(
      trigger,
      content,
      '11111111-1111-4111-8111-111111111111',
      (point) => {
        if (point !== 'after-link') return;
        unlinkSync(trigger);
        writeFileSync(trigger, content, { mode: 0o600 });
        chmodSync(trigger, 0o600);
        throw new Error('replacement race');
      }
    )).toThrow('replacement race');

    expect(readFileSync(trigger, 'utf8')).toBe(content);
    expect(statSync(trigger).nlink).toBe(1);
  });
});
