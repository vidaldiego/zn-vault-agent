// Path: src/lib/control-plane-auth.ts

import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

export const DEFAULT_CONTROL_PLANE_TOKEN_FILE =
  '/etc/zn-vault-agent/payara-mutation-token';

const CONTROL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_CONTROL_TOKEN_FILE_BYTES = 256;

export interface ControlPlaneAuthenticator {
  authenticate(authorizationHeader: string | undefined): boolean;
}

function authorizationDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf-8').digest();
}

/**
 * Load the local control-plane credential through a no-follow file descriptor.
 * The secret remains in process memory and is never returned as a string.
 */
export function loadControlPlaneAuthenticator(
  tokenFile = process.env.ZNVAULT_CONTROL_TOKEN_FILE
    ?? DEFAULT_CONTROL_PLANE_TOKEN_FILE
): ControlPlaneAuthenticator {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const nonBlock = fs.constants.O_NONBLOCK ?? 0;
  const fd = fs.openSync(tokenFile, fs.constants.O_RDONLY | noFollow | nonBlock);

  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error('Control-plane token must be one regular, non-linked file');
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error('Control-plane token file must not grant group or other access');
    }
    if (stats.size <= 0 || stats.size > MAX_CONTROL_TOKEN_FILE_BYTES) {
      throw new Error('Control-plane token file has an invalid size');
    }

    const raw = fs.readFileSync(fd, 'utf-8');
    const token = raw.trim();
    if (!CONTROL_TOKEN_PATTERN.test(token)) {
      throw new Error('Control-plane token must be 32 random base64url bytes');
    }
    const expectedDigest = authorizationDigest(`Bearer ${token}`);

    return {
      authenticate(authorizationHeader: string | undefined): boolean {
        // Hash both complete header values to a fixed width before comparing.
        // This avoids token-length/content branches while still rejecting
        // missing, malformed, prefixed, or suffixed credentials exactly.
        const observed = typeof authorizationHeader === 'string'
          ? authorizationHeader
          : '';
        const matches = timingSafeEqual(
          authorizationDigest(observed),
          expectedDigest
        );
        return typeof authorizationHeader === 'string' && matches;
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}
