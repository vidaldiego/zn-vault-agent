import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfigDir } from './config/storage.js';
import type { ManagedKeyTargetState } from '../services/managed-key-targets.js';

function statePath(hostConfigId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(hostConfigId)) throw new Error('Invalid host identity');
  return path.join(getConfigDir(), `managed-key-targets-${hostConfigId}.json`);
}
export function loadManagedKeyTargetState(hostConfigId: string): ManagedKeyTargetState | undefined {
  try {
    const file = statePath(hostConfigId); const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) return undefined;
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as ManagedKeyTargetState;
    if (!Array.isArray(value.applied) || value.applied.some(item => typeof item.targetId !== 'string' || typeof item.keyId !== 'string' || !Number.isSafeInteger(item.rotationCount) || item.rotationCount < 0)) return undefined;
    return value;
  } catch { return undefined; }
}
export function saveManagedKeyTargetState(hostConfigId: string, state: ManagedKeyTargetState): void {
  const file = statePath(hostConfigId); const temporary = `${file}.${randomUUID()}.tmp`;
  // Project public metadata explicitly; a material DTO can never be serialized by accident.
  const publicState: ManagedKeyTargetState = { applied: state.applied.map(item => ({ targetId: item.targetId, keyId: item.keyId, rotationCount: item.rotationCount, expiresAt: item.expiresAt, target: item.target ? { id: item.target.id, keyId: item.target.keyId, output: item.target.output, owner: item.target.owner, mode: item.target.mode } : undefined })),
    own: state.own ? { keyId: state.own.keyId, rotationCount: state.own.rotationCount, expiresAt: state.own.expiresAt } : undefined };
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(publicState)); fs.fsyncSync(fd); fs.renameSync(temporary, file); }
  finally { fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch { /* already renamed */ } }
}
