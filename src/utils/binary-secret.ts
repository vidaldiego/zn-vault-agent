import fs from 'node:fs';
import path from 'node:path';
import { chownSafeAsync } from './shell.js';
import { validateOutputPath } from './path.js';

/** Decode only canonical, padded RFC 4648 Base64. Never include input in errors. */
export function decodeBase64Secret(data: Record<string, unknown>, key?: string): Buffer {
  if (!key) throw new Error('Key is required for Base64 binary output');
  const value = data[key];
  if (typeof value !== 'string' || value.length === 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Base64 binary input must be a non-empty canonical Base64 string');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error('Base64 binary input must be canonical Base64');
  }
  return decoded;
}

/** Validate additive target encoding before any file write or reload. */
export function validateSecretEncoding(format: string, encoding?: string, key?: string): void {
  if (encoding === undefined) return;
  if (encoding !== 'base64' || format !== 'raw' || !key) {
    throw new Error('Secret encoding requires raw format, base64 encoding and a key');
  }
}

/** Publish binary bytes only after exact permissions and requested ownership succeed. */
export async function writeBinarySecretFile(filePath: string, content: Buffer, owner?: string, mode?: string): Promise<void> {
  validateOutputPath(filePath);
  const permissions = mode ?? '0600';
  if (!/^0[0-7]{3}$/.test(permissions)) throw new Error('Invalid binary output permissions');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp.${process.pid}`;
  let created = false;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try {
      fs.writeFileSync(descriptor, content);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(temporary, parseInt(permissions, 8));
    // Non-root service users can set their own uid and a supplementary group.
    // Ownership failure must retain the previous consumer file and version.
    if (owner) await chownSafeAsync(temporary, owner);
    fs.renameSync(temporary, filePath);
  } finally {
    if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
