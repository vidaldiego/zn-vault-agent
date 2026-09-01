// Fail-closed template reader for secret deployment critical sections.

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export const MAX_TEMPLATE_BYTES = 1024 * 1024;

/**
 * Read a bounded regular file without following symlinks or blocking on a
 * FIFO/device. The platform must expose both hardening flags; silently falling
 * back to a blocking/following open would violate the shared-lock invariant.
 */
export async function readTemplateFile(
  templatePath: string,
  maxBytes = MAX_TEMPLATE_BYTES
): Promise<string> {
  if (
    typeof constants.O_NOFOLLOW !== 'number'
    || typeof constants.O_NONBLOCK !== 'number'
  ) {
    throw new Error('Secure template reads are unsupported on this platform');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Template size limit must be a positive safe integer');
  }

  const handle = await open(
    templatePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error(`Template path is not a regular file: ${templatePath}`);
    }
    if (before.size > maxBytes) {
      throw new Error(
        `Template file exceeds ${maxBytes} byte limit: ${templatePath}`
      );
    }

    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset
      );
      if (bytesRead === 0) {
        throw new Error(`Template file changed during read: ${templatePath}`);
      }
      offset += bytesRead;
    }

    const after = await handle.stat();
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(`Template file changed during read: ${templatePath}`);
    }

    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}
