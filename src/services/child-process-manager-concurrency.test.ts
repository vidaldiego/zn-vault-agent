import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_SECRET_ID = '11111111-1111-4111-8111-111111111111';
const HARNESS_SOURCE = String.raw`
import { existsSync, writeFileSync } from 'node:fs';
import http from 'node:http';

const mode = process.argv[2];

if (mode === 'target') {
  if (process.env.TEST_SECRET !== 'fetched') process.exit(71);
  const url = new URL('/spawn', process.env.TEST_CONTROL_URL);
  const body = JSON.stringify({ pid: process.pid });
  const request = http.request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  }, response => {
    response.resume();
    if ((response.statusCode ?? 500) >= 300) process.exit(72);
    response.once('end', () => {
      writeFileSync(process.env.TARGET_STARTED_FILE, String(process.pid), {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
    });
  });
  request.on('error', () => process.exit(73));
  request.end(body);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  setTimeout(() => process.exit(74), 15_000).unref();
  setInterval(() => {}, 1_000);
} else if (mode === 'manager') {
  const { ChildProcessManager } = await import(process.env.MANAGER_MODULE_URL);
  process.send?.({ type: 'ready' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('go timeout')), 10_000);
    process.once('message', message => {
      if (message !== 'go') return;
      clearTimeout(timer);
      resolve();
    });
  });

  const manager = new ChildProcessManager({
    command: [process.execPath, process.env.TSX_CLI, process.env.HARNESS_PATH, 'target'],
    secrets: [{ env: 'TEST_SECRET', secret: '${TEST_SECRET_ID}.value' }],
    inheritEnv: true,
    restartOnChange: false,
  }, { forwardTerminationSignals: false });
  manager.on('error', () => {});

  try {
    await manager.start();
    const targetDeadline = Date.now() + 10_000;
    while (!existsSync(process.env.TARGET_STARTED_FILE) && Date.now() < targetDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!existsSync(process.env.TARGET_STARTED_FILE)) {
      throw new Error('target readiness timed out');
    }
    await manager.stop();
    process.exitCode = 0;
  } catch {
    process.exitCode = 2;
  }
} else {
  process.exitCode = 70;
}
`;

interface ManagedProcess {
  child: ChildProcess;
  stderr: string[];
}

function waitForReady(processInfo: ManagedProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const { child, stderr } = processInfo;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`manager readiness timed out: ${stderr.join('')}`));
    }, 10_000);
    const onMessage = (message: unknown): void => {
      if ((message as { type?: string } | null)?.type !== 'ready') return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`manager exited before ready (${code}): ${stderr.join('')}`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function waitForExit(processInfo: ManagedProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const { child, stderr } = processInfo;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`manager exit timed out: ${stderr.join('')}`));
    }, 15_000);
    const onExit = (code: number | null): void => {
      cleanup();
      resolve(code);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

describe('ChildProcessManager cross-process reservation', () => {
  it('allows only one stale-owner reclaimer to fetch secrets and spawn', async () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'znvault-child-owner-race-'));
    const configDir = path.join(fixtureRoot, 'config');
    const childPidFile = path.join(fixtureRoot, 'child.pid');
    const reservationFile = path.join(fixtureRoot, 'child.owner');
    const claimFile = `${reservationFile}.claim`;
    const targetStartedFile = path.join(fixtureRoot, 'target.started');
    const harnessPath = path.join(fixtureRoot, 'race-harness.mjs');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');
    const managerModuleUrl = pathToFileURL(
      path.join(repoRoot, 'src/services/child-process-manager.ts')
    ).href;
    const processes: ManagedProcess[] = [];
    const spawnedTargetPids = new Set<number>();
    let secretFetchCount = 0;
    let spawnCount = 0;

    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(harnessPath, HARNESS_SOURCE, { mode: 0o600 });
    writeFileSync(reservationFile, `${JSON.stringify({
      version: 1,
      ownerToken: '00000000-0000-4000-8000-000000000009',
      managerPid: 2_147_483_647,
      capturedAt: '2026-09-01T00:00:00.000Z',
      identity: { kind: 'unsupported-platform', platform: process.platform },
    })}\n`, { mode: 0o600 });

    const server = createServer((request, response) => {
      if (request.method === 'POST'
        && request.url === `/v1/secrets/${TEST_SECRET_ID}/decrypt`
      ) {
        request.resume();
        secretFetchCount++;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          id: TEST_SECRET_ID,
          alias: 'reservation-race',
          type: 'opaque',
          version: 1,
          data: { value: 'fetched' },
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/spawn') {
        spawnCount++;
        let body = '';
        request.on('data', chunk => { body += String(chunk); });
        request.on('end', () => {
          const pid = (JSON.parse(body) as { pid: number }).pid;
          spawnedTargetPids.add(pid);
          response.writeHead(204);
          response.end();
        });
        return;
      }
      request.resume();
      response.writeHead(404);
      response.end();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server has no TCP port');
      const controlUrl = `http://127.0.0.1:${address.port}`;
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        CHILD_PID_FILE: childPidFile,
        ZNVAULT_AGENT_CONFIG_DIR: configDir,
        ZNVAULT_URL: controlUrl,
        ZNVAULT_API_KEY: 'test-api-key',
        LOG_LEVEL: 'fatal',
        MANAGER_MODULE_URL: managerModuleUrl,
        TSX_CLI: tsxCli,
        HARNESS_PATH: harnessPath,
        TEST_CONTROL_URL: controlUrl,
        TARGET_STARTED_FILE: targetStartedFile,
      };

      for (let index = 0; index < 2; index++) {
        const child = spawn(process.execPath, [tsxCli, harnessPath, 'manager'], {
          cwd: repoRoot,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        const stderr: string[] = [];
        child.stderr?.on('data', chunk => stderr.push(String(chunk)));
        child.stdout?.resume();
        processes.push({ child, stderr });
      }

      await Promise.all(processes.map(waitForReady));
      const exitPromises = processes.map(waitForExit);
      for (const { child } of processes) child.send?.('go');
      const exitCodes = (await Promise.all(exitPromises)).sort();

      expect(exitCodes).toEqual([0, 2]);
      expect(secretFetchCount).toBe(1);
      expect(spawnCount).toBe(1);
      expect(existsSync(claimFile)).toBe(false);
      expect(existsSync(reservationFile)).toBe(false);
      expect(existsSync(childPidFile)).toBe(false);
      expect(statSync(fixtureRoot).isDirectory()).toBe(true);
    } finally {
      for (const { child } of processes) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      for (const pid of spawnedTargetPids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Best-effort cleanup: the normal success path has already reaped it.
        }
      }
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 25_000);
});
