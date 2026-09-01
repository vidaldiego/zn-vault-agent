import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runReloadCommand } from './reload-command.js';
import { executeHealthCheck } from '../lib/deployer.js';
import { withSharedMutationLock } from '../lib/shared-mutation-lock.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe('runReloadCommand', () => {
  it('reports a successful terminal process group', async () => {
    const result = await runReloadCommand('printf reload-ok');

    expect(result).toMatchObject({
      success: true,
      stdout: 'reload-ok',
      exitCode: 0,
      timedOut: false,
    });
  });

  it('does not report a non-zero reload as successful', async () => {
    const result = await runReloadCommand('printf reload-failed >&2; exit 17');

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(17);
    expect(result.stderr).toBe('reload-failed');
    expect(result.timedOut).toBe(false);
  });

  it('kills a TERM-resistant descendant before reporting timeout', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'znvault-reload-group-'));
    temporaryDirectories.push(directory);
    const descendantPidPath = path.join(directory, 'descendant.pid');

    const result = await runReloadCommand(
      `trap '' TERM; (trap '' TERM; while :; do sleep 1; done) & echo $! > "${descendantPidPath}"; wait`,
      { timeoutMs: 500, terminationGraceMs: 150 }
    );

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.message).toContain('timed out');

    const descendantPid = Number((await readFile(descendantPidPath, 'utf8')).trim());
    expect(Number.isInteger(descendantPid)).toBe(true);
    expect(() => process.kill(descendantPid, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' })
    );
  });

  it('keeps the shared lock until a resistant health-check group is terminal', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'znvault-health-group-'));
    temporaryDirectories.push(directory);
    const lockPath = path.join(directory, 'znvault-deploy.lock');
    const descendantPidPath = path.join(directory, 'health-descendant.pid');

    const healthy = await withSharedMutationLock(
      'certificate',
      async () => executeHealthCheck(
        `trap '' TERM; (trap '' TERM; while :; do sleep 1; done) & echo $! > "${descendantPidPath}"; wait`,
        500
      ),
      lockPath
    );

    expect(healthy).toBe(false);
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const descendantPid = Number((await readFile(descendantPidPath, 'utf8')).trim());
    expect(() => process.kill(descendantPid, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' })
    );
  });
});
