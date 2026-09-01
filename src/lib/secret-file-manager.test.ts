import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretFileManager } from './secret-file-manager.js';

describe('SecretFileManager signal ownership', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves SIGINT and SIGTERM ownership to the daemon', () => {
    const root = mkdtempSync(join(tmpdir(), 'znvault-secret-files-'));
    const processOn = vi.spyOn(process, 'on').mockReturnValue(process);

    try {
      new SecretFileManager(join(root, 'secrets')).initialize();

      expect(processOn).toHaveBeenCalledWith('exit', expect.any(Function));
      expect(processOn).not.toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(processOn).not.toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
