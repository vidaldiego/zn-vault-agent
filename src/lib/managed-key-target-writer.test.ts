import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ManagedKeyTargetWriter } from './managed-key-target-writer.js';

let root: string;
const owner = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-key-target-'))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const target = () => ({ id: 'reader', keyId: 'key-reader', output: path.join(root, 'reader'), owner, mode: '0600' });

describe('managed key target file custody', () => {
  it('atomically replaces material with verified owner/mode and no backup', () => {
    const writer = new ManagedKeyTargetWriter(root); const t = target();
    writer.write(t, 'synthetic-first', () => true);
    writer.write(t, 'synthetic-second', () => true);
    expect(fs.readFileSync(t.output, 'utf8')).toBe('synthetic-second');
    expect(fs.statSync(t.output).mode & 0o777).toBe(0o600);
    expect(writer.isValid(t)).toBe(true); expect(fs.readdirSync(root)).toEqual(['reader']);
  });
  it('keeps the prior file when the generation becomes revoked before rename', () => {
    const writer = new ManagedKeyTargetWriter(root); const t = target();
    writer.write(t, 'synthetic-first', () => true);
    expect(() => writer.write(t, 'synthetic-late', () => false)).toThrow();
    expect(fs.readFileSync(t.output, 'utf8')).toBe('synthetic-first');
    expect(fs.readdirSync(root)).toEqual(['reader']);
  });
  it('rejects symlinks and hard links without touching their destination', () => {
    const writer = new ManagedKeyTargetWriter(root); const t = target();
    const other = path.join(root, 'other'); fs.writeFileSync(other, 'preserved', { mode: 0o600 });
    fs.symlinkSync(other, t.output);
    expect(() => writer.write(t, 'synthetic', () => true)).toThrow();
    expect(() => writer.remove(t)).toThrow();
    fs.unlinkSync(t.output); fs.linkSync(other, t.output);
    expect(() => writer.write(t, 'synthetic', () => true)).toThrow();
    expect(fs.readFileSync(other, 'utf8')).toBe('preserved');
  });
  it('refuses to remove a file whose permissions no longer match custody', () => {
    const writer = new ManagedKeyTargetWriter(root); const t = target();
    fs.writeFileSync(t.output, 'preserved', { mode: 0o666 }); fs.chmodSync(t.output, 0o666);
    expect(() => writer.remove(t)).toThrow(); expect(fs.existsSync(t.output)).toBe(true);
  });
  it('keeps the predecessor and removes temporary material when rename fails', () => {
    const writer = new ManagedKeyTargetWriter(root); const t = target(); writer.write(t, 'synthetic-first', () => true);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('rename failed'); });
    try { expect(() => writer.write(t, 'synthetic-new', () => true)).toThrow(); }
    finally { rename.mockRestore(); }
    expect(fs.readFileSync(t.output, 'utf8')).toBe('synthetic-first'); expect(fs.readdirSync(root)).toEqual(['reader']);
  });

  it('does not publish material when exact ownership cannot be applied', () => {
    const writer = new ManagedKeyTargetWriter(root); const t = target(); writer.write(t, 'synthetic-first', () => true);
    const chown = vi.spyOn(fs, 'fchownSync').mockImplementationOnce(() => { throw new Error('ownership denied'); });
    try { expect(() => writer.write(t, 'synthetic-new', () => true)).toThrow(); }
    finally { chown.mockRestore(); }
    expect(fs.readFileSync(t.output, 'utf8')).toBe('synthetic-first'); expect(fs.readdirSync(root)).toEqual(['reader']);
  });

});
