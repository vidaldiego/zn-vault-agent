import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ManagedKeyTarget } from '../types/managed-key-targets.js';

/** No material is persisted outside this tmpfs directory. Each target is one direct child. */
export const MANAGED_KEY_DIRECTORY = '/run/zn-vault-agent/secrets';
function ownerIds(owner: string): { uid: number; gid: number } {
  if (!/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(owner)) throw new Error('Invalid target ownership');
  const [user, group] = owner.split(':');
  const uid = /^\d+$/.test(user) ? Number(user) : Number(execFileSync('id', ['-u', user], { encoding: 'utf8' }).trim());
  const gid = /^\d+$/.test(group) ? Number(group) : Number(execFileSync('getent', ['group', group], { encoding: 'utf8' }).split(':')[2]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 0 || gid < 0) throw new Error('Invalid target ownership');
  return { uid, gid };
}
export class ManagedKeyTargetWriter {
  constructor(private readonly directory = MANAGED_KEY_DIRECTORY) {}
  private check(target: ManagedKeyTarget): { uid: number; gid: number; mode: number } {
    if (path.dirname(target.output) !== this.directory || path.resolve(target.output) !== target.output) throw new Error('Target outside allowed tmpfs directory');
    if (!/^0[46][04]0$/.test(target.mode)) throw new Error('Unsafe target mode');
    const dir = fs.lstatSync(this.directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o022) !== 0 || dir.uid !== process.getuid?.()) throw new Error('Unsafe target directory');
    if (fs.realpathSync(this.directory) !== this.directory) throw new Error('Symlink in target directory');
    return { ...ownerIds(target.owner), mode: parseInt(target.mode, 8) };
  }
  isValid(target: ManagedKeyTarget): boolean {
    try { const ids = this.check(target); const stat = fs.lstatSync(target.output);
      return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.uid === ids.uid && stat.gid === ids.gid && (stat.mode & 0o777) === ids.mode;
    } catch { return false; }
  }
  write(target: ManagedKeyTarget, material: string, isCurrent: () => boolean): void {
    const ids = this.check(target);
    if (!material || !isCurrent()) throw new Error('Target generation unavailable');
    let present = false;
    try { fs.lstatSync(target.output); present = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (present && !this.isValid(target)) throw new Error('Existing target violates custody');
    const temporary = path.join(this.directory, `.managed-key-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, material, 'utf8'); fs.fchownSync(fd, ids.uid, ids.gid); fs.fchmodSync(fd, ids.mode); fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== ids.uid || stat.gid !== ids.gid || (stat.mode & 0o777) !== ids.mode || !isCurrent()) throw new Error('Target custody or generation changed');
      this.check(target);
      if (fs.existsSync(target.output) && !this.isValid(target)) throw new Error('Existing target changed during write');
      fs.renameSync(temporary, target.output);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* Already renamed or never created. */ }
    }
  }
  remove(target: ManagedKeyTarget): void {
    this.check(target);
    try { fs.lstatSync(target.output); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!this.isValid(target)) throw new Error('Refusing to remove a file outside target custody');
    fs.unlinkSync(target.output);
  }
}
