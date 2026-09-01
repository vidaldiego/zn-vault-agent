import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../logger.js', () => ({ execLogger: loggerSpies }));

import { updateEnvFile } from './env-file.js';

describe('env-file credential output safety', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'znvault-env-log-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes the exact value to the protected file but no fragment to logs', () => {
    const canary = 'znv_env-file-canary-DO-NOT-LOG';
    const outputPath = path.join(tempDir, 'agent.env');

    updateEnvFile(outputPath, 'VAULT_API_KEY', canary);

    expect(fs.readFileSync(outputPath, 'utf8')).toContain(canary);
    const serializedLogs = JSON.stringify(
      Object.values(loggerSpies).map((spy) => spy.mock.calls)
    );
    expect(serializedLogs).not.toContain(canary);
    expect(serializedLogs).not.toContain(canary.substring(0, 8));
  });
});
