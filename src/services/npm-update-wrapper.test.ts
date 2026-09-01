import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WRAPPER = process.env.WRAPPER_UNDER_TEST
  ?? join(TEST_DIR, '..', '..', 'deploy', 'scripts', 'zn-vault-agent-update.sh');
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const roots: string[] = [];

interface Fixture {
  root: string;
  data: string;
  state: string;
  trigger: string;
  fakeNpm: string;
  fakeFlock: string;
  fakeSystemctl: string;
  npmLog: string;
  restartLog: string;
  globalRoot: string;
  env: NodeJS.ProcessEnv;
}

function makeFixture(current = '1.3.0', advertised = '1.4.0'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'znvault-agent-wrapper-'));
  roots.push(root);
  const data = join(root, 'data');
  const state = join(root, 'state');
  const bin = join(root, 'bin');
  const globalRoot = join(root, 'global');
  const packageDir = join(globalRoot, '@zincapp', 'zn-vault-agent');
  mkdirSync(data, { mode: 0o750 });
  mkdirSync(state, { mode: 0o755 });
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(packageDir, { recursive: true, mode: 0o755 });
  chmodSync(data, 0o750);
  chmodSync(state, 0o755);
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ version: current }));

  const fakeNpm = join(bin, 'npm');
  const fakeFlock = join(bin, 'flock');
  const fakeSystemctl = join(bin, 'systemctl');
  const npmLog = join(root, 'npm.log');
  const restartLog = join(root, 'restart.log');
  writeFileSync(fakeNpm, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
if [[ "$1" == root && "$2" == -g ]]; then printf '%s\\n' "$FAKE_GLOBAL_ROOT"; exit 0; fi
if [[ "$1" == view ]]; then
  [[ -z "\${FAKE_VIEW_FAIL:-}" ]] || exit 65
  printf '%s\\n' "$FAKE_ADVERTISED"
  exit 0
fi
if [[ "$1" == install && "$2" == -g && "$3" == -- ]]; then
	  [[ -f "$FAKE_TRIGGER" && -f "$FAKE_STATE/active.state" ]] || exit 70
	  printf '%s\\n' retained-during-install >> "$FAKE_NPM_LOG"
	  target="\${4##*@}"
	  if [[ -n "\${FAKE_REMOVE_THEN_BLOCK_MARKER:-}" && ! -e "\${FAKE_REMOVE_THEN_BLOCK_MARKER}.used" ]]; then
	    : > "\${FAKE_REMOVE_THEN_BLOCK_MARKER}.used"
	    rm -f -- "$FAKE_GLOBAL_ROOT/@zincapp/zn-vault-agent/package.json"
	    : > "$FAKE_REMOVE_THEN_BLOCK_MARKER"
	    while true; do sleep 1; done
	  fi
	  printf '{"version":"%s"}\\n' "$target" > "$FAKE_GLOBAL_ROOT/@zincapp/zn-vault-agent/package.json"
  if [[ -n "\${FAKE_BLOCK_MARKER:-}" ]]; then
    : > "$FAKE_BLOCK_MARKER"
    while true; do sleep 1; done
  fi
  if [[ -n "\${FAKE_INSTALL_SLEEP:-}" ]]; then sleep "$FAKE_INSTALL_SLEEP"; fi
  exit 0
fi
exit 64
`, { mode: 0o700 });
  chmodSync(fakeNpm, 0o700);
  writeFileSync(fakeFlock, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
  chmodSync(fakeFlock, 0o700);
  writeFileSync(fakeSystemctl, `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == try-restart && "$2" == zn-vault-agent ]] || exit 64
printf '%s\\n' "$*" >> "$FAKE_RESTART_LOG"
`, { mode: 0o700 });
  chmodSync(fakeSystemctl, 0o700);
  return {
    root,
    data,
    state,
    trigger: join(data, '.update-trigger'),
    fakeNpm,
    fakeFlock,
    fakeSystemctl,
    npmLog,
    restartLog,
    globalRoot,
    env: {
      ...process.env,
      FAKE_NPM_LOG: npmLog,
      FAKE_GLOBAL_ROOT: globalRoot,
      FAKE_ADVERTISED: advertised,
      FAKE_TRIGGER: join(data, '.update-trigger'),
      FAKE_STATE: state,
      FAKE_RESTART_LOG: restartLog,
    },
  };
}

function record(current = '1.3.0', target = '1.4.0', channel = 'latest'): string {
  return `v1 ${REQUEST_ID} ${current} ${target} ${channel} 2026-01-01T10:00:00.000Z\n`;
}

function publish(file: string, content: string, mode = 0o600): void {
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
}

function wrapperArgs(
  fixture: Fixture,
  flock = fixture.fakeFlock,
  failpoint = ''
): string[] {
  const uid = String(process.getuid?.() ?? 0);
  return [
    WRAPPER,
    fixture.trigger,
    fixture.state,
    fixture.fakeNpm,
    process.execPath,
    fixture.fakeSystemctl,
    'zn-vault-agent',
    uid,
    uid,
    flock,
    failpoint,
  ];
}

async function run(
  fixture: Fixture,
  flock = fixture.fakeFlock,
  failpoint = ''
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync('/bin/bash', wrapperArgs(fixture, flock, failpoint), {
    env: fixture.env,
    encoding: 'utf8',
  });
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function installCount(fixture: Fixture): number {
  if (!existsSync(fixture.npmLog)) return 0;
  return readFileSync(fixture.npmLog, 'utf8')
    .split('\n')
    .filter(line => line.startsWith('install -g -- ')).length;
}

function restartCount(fixture: Fixture): number {
  if (!existsSync(fixture.restartLog)) return 0;
  return readFileSync(fixture.restartLog, 'utf8').trim().split('\n').filter(Boolean).length;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('root-owned Agent self-update wrapper', () => {
  it('reaches composite terminal only after receipt, restart, and evidence cleanup', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());

    await run(fixture);

    expect(installCount(fixture)).toBe(1);
    expect(restartCount(fixture)).toBe(1);
    expect(readFileSync(fixture.npmLog, 'utf8')).toContain('retained-during-install');
    expect(existsSync(fixture.trigger)).toBe(false);
    expect(existsSync(join(fixture.state, 'active.state'))).toBe(false);
    const receipt = join(fixture.state, `${REQUEST_ID}.receipt`);
    expect(lstatSync(receipt).mode & 0o777).toBe(0o644);
    expect(readFileSync(receipt, 'utf8')).toContain(
      ` ${REQUEST_ID} @zincapp/zn-vault-agent latest 1.3.0 1.4.0 1.4.0 success `
    );
  });

  it('rejects symlink and wrong-mode triggers before npm', async () => {
    const symlinkFixture = makeFixture();
    const target = join(symlinkFixture.data, 'request');
    publish(target, record());
    symlinkSync(target, symlinkFixture.trigger);
    await expect(run(symlinkFixture)).rejects.toBeDefined();
    expect(installCount(symlinkFixture)).toBe(0);

    const modeFixture = makeFixture();
    publish(modeFixture.trigger, record());
    chmodSync(modeFixture.trigger, 0o644);
    await expect(run(modeFixture)).rejects.toBeDefined();
    expect(installCount(modeFixture)).toBe(0);
  });

  it('rejects a multiply-linked trigger before npm', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());
    linkSync(fixture.trigger, join(fixture.data, 'second-link'));
    await expect(run(fixture)).rejects.toBeDefined();
    expect(installCount(fixture)).toBe(0);
  });

  it('reconciles the exact publisher temp left after trigger link commit', async () => {
    const fixture = makeFixture();
    const temp = `${fixture.trigger}.tmp.123.55555555-5555-4555-8555-555555555555`;
    publish(temp, record());
    linkSync(temp, fixture.trigger);

    await run(fixture);

    expect(installCount(fixture)).toBe(1);
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(fixture.trigger)).toBe(false);
  });

  it.runIf((process.getuid?.() ?? -1) === 0)('rejects a wrong-owner trigger before npm', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());
    chownSync(fixture.trigger, 1, 1);
    await expect(run(fixture)).rejects.toBeDefined();
    expect(installCount(fixture)).toBe(0);
  });

  it('executes a force reinstall when current equals target and no active state exists', async () => {
    const fixture = makeFixture('1.4.0', '1.4.0');
    publish(fixture.trigger, record('1.4.0', '1.4.0'));
    await run(fixture);
    expect(installCount(fixture)).toBe(1);
  });

  it('recovers active+installed target without registry availability or npm number two', async () => {
    const fixture = makeFixture('1.4.0', '1.4.0');
    const request = record('1.3.0', '1.4.0');
    publish(fixture.trigger, request);
    publish(join(fixture.state, 'active.state'), request, 0o644);
    fixture.env.FAKE_VIEW_FAIL = '1';

    await run(fixture);

    expect(installCount(fixture)).toBe(0);
    expect(readFileSync(fixture.npmLog, 'utf8')).not.toContain('view ');
    expect(restartCount(fixture)).toBe(1);
    expect(existsSync(fixture.trigger)).toBe(false);
    expect(readFileSync(join(fixture.state, `${REQUEST_ID}.receipt`), 'utf8'))
      .toContain(' recovered_install\n');
  });

  it('resumes an exact active install when a prior npm attempt left the package absent', async () => {
    const fixture = makeFixture();
    const request = record();
    publish(fixture.trigger, request);
    publish(join(fixture.state, 'active.state'), request, 0o644);
    rmSync(join(fixture.globalRoot, '@zincapp', 'zn-vault-agent', 'package.json'));
    fixture.env.FAKE_VIEW_FAIL = '1';
    fixture.env.FAKE_ADVERTISED = '9.9.9';

    await run(fixture);

    expect(installCount(fixture)).toBe(1);
    expect(readFileSync(fixture.npmLog, 'utf8')).not.toContain('view ');
    expect(restartCount(fixture)).toBe(1);
    expect(JSON.parse(readFileSync(
      join(fixture.globalRoot, '@zincapp', 'zn-vault-agent', 'package.json'),
      'utf8'
    ))).toEqual({ version: '1.4.0' });
    expect(existsSync(join(fixture.state, 'active.state'))).toBe(false);
    expect(existsSync(fixture.trigger)).toBe(false);
    expect(readFileSync(join(fixture.state, `${REQUEST_ID}.receipt`), 'utf8'))
      .toContain(' installed\n');
  });

  it('rejects a third installed version under active state without registry or install', async () => {
    const fixture = makeFixture('1.3.1', '9.9.9');
    const request = record('1.3.0', '1.4.0');
    publish(fixture.trigger, request);
    publish(join(fixture.state, 'active.state'), request, 0o644);
    fixture.env.FAKE_VIEW_FAIL = '1';

    await expect(run(fixture)).rejects.toBeDefined();

    const log = readFileSync(fixture.npmLog, 'utf8');
    expect(log).not.toContain('view ');
    expect(log).not.toContain('install -g');
    expect(restartCount(fixture)).toBe(0);
    expect(existsSync(join(fixture.state, 'active.state'))).toBe(false);
    expect(existsSync(fixture.trigger)).toBe(false);
    const receipt = readFileSync(join(fixture.state, `${REQUEST_ID}.receipt`), 'utf8');
    expect(receipt).toContain(' 1.3.1 failure ');
    expect(receipt).toContain(' current_version_mismatch\n');
  });

  it('replays a success receipt to complete restart and evidence cleanup without npm number two', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());
    await run(fixture);
    publish(fixture.trigger, record());
    await run(fixture);
    expect(installCount(fixture)).toBe(1);
    expect(restartCount(fixture)).toBe(2);
    expect(existsSync(fixture.trigger)).toBe(false);
  });

  it('replays a failure receipt with installed none and clears evidence without npm or restart', async () => {
    const fixture = makeFixture();
    const request = record();
    publish(fixture.trigger, request);
    publish(join(fixture.state, 'active.state'), request, 0o644);
    writeFileSync(
      join(fixture.state, `${REQUEST_ID}.receipt`),
      `v1 ${REQUEST_ID} @zincapp/zn-vault-agent latest 1.3.0 1.4.0 none failure ` +
        '2026-01-01T10:00:00.000Z 2026-01-01T10:00:00.000Z ' +
        '2026-01-01T10:00:01.000Z npm_install_failed\n',
      { mode: 0o644 }
    );
    chmodSync(join(fixture.state, `${REQUEST_ID}.receipt`), 0o644);

    await expect(run(fixture)).rejects.toBeDefined();

    expect(installCount(fixture)).toBe(0);
    expect(restartCount(fixture)).toBe(0);
    expect(existsSync(join(fixture.state, 'active.state'))).toBe(false);
    expect(existsSync(fixture.trigger)).toBe(false);
  });

  it.each(['after_receipt', 'after_restart', 'after_clear'] as const)(
    'reconciles crash failpoint %s with one npm, restart, and no orphaned state',
    async (failpoint) => {
      const fixture = makeFixture();
      publish(fixture.trigger, record());

      await expect(run(fixture, fixture.fakeFlock, failpoint)).rejects.toBeDefined();
      expect(installCount(fixture)).toBe(1);
      // A success receipt alone is not terminal while either durable request
      // inode remains; replay still owes restart/cleanup.
      expect(existsSync(fixture.trigger)).toBe(true);

      await run(fixture);

      expect(installCount(fixture)).toBe(1);
      expect(restartCount(fixture)).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(fixture.state, 'active.state'))).toBe(false);
      expect(existsSync(fixture.trigger)).toBe(false);
    }
  );

  it.each([
    { failpoint: 'after_active_link', installsBeforeReplay: 0 },
    { failpoint: 'after_receipt_link', installsBeforeReplay: 1 },
  ] as const)(
    'reconciles nlink=2 record crash $failpoint without duplicate npm or leftover temp',
    async ({ failpoint, installsBeforeReplay }) => {
      const fixture = makeFixture();
      publish(fixture.trigger, record());

      await expect(run(fixture, fixture.fakeFlock, failpoint)).rejects.toBeDefined();
      expect(installCount(fixture)).toBe(installsBeforeReplay);
      expect(existsSync(fixture.trigger)).toBe(true);

      await run(fixture);

      expect(installCount(fixture)).toBe(1);
      expect(restartCount(fixture)).toBeGreaterThanOrEqual(1);
      expect(existsSync(fixture.trigger)).toBe(false);
      expect(existsSync(join(fixture.state, 'active.state'))).toBe(false);
      expect(readdirSync(fixture.state).some(name => name.includes('.tmp.'))).toBe(false);
      expect(lstatSync(join(fixture.state, `${REQUEST_ID}.receipt`)).nlink).toBe(1);
    }
  );

  it.runIf(process.platform === 'linux' && existsSync('/usr/bin/sudo'))(
    'publishes active identity 0644 so an unrelated non-root uid can read it',
    async () => {
      const fixture = makeFixture();
      publish(fixture.trigger, record());

      await expect(run(fixture, fixture.fakeFlock, 'after_active_link')).rejects.toBeDefined();
      const active = join(fixture.state, 'active.state');
      const activeState = lstatSync(active);
      expect(activeState.mode & 0o777).toBe(0o644);
      expect(activeState.mode & 0o004).toBe(0o004);

      // The production owner is root while the Agent is unprivileged. The
      // fixture uses the invoking uid for wrapper trust, so exercise the same
      // Unix permission boundary with the unrelated `nobody` account.
      chmodSync(fixture.root, 0o755);
      chmodSync(fixture.data, 0o755);
      chmodSync(fixture.state, 0o755);
      expect(() => execFileSync(
        '/usr/bin/sudo',
        [
          '-n', '-u', 'nobody', process.execPath, '-e',
          "require('node:fs').readFileSync(process.argv[1], 'utf8')",
          active,
        ],
        { stdio: 'pipe' }
      )).not.toThrow();
    }
  );

  it.runIf(process.platform === 'linux' && existsSync('/usr/bin/flock'))(
    'admits exactly one of two concurrent helpers under flock',
    async () => {
      const fixture = makeFixture();
      fixture.env.FAKE_INSTALL_SLEEP = '1';
      publish(fixture.trigger, record());
      const results = await Promise.allSettled([
        run(fixture, '/usr/bin/flock'),
        run(fixture, '/usr/bin/flock'),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(installCount(fixture)).toBe(1);
    }
  );

  it.runIf(process.platform === 'linux' && existsSync('/usr/bin/flock'))(
    'recovers after SIGKILL postinstall without a second npm invocation',
    async () => {
      const fixture = makeFixture();
      const blockMarker = join(fixture.root, 'postinstall-blocked');
      fixture.env.FAKE_BLOCK_MARKER = blockMarker;
      publish(fixture.trigger, record());
      const child = spawn('/bin/bash', wrapperArgs(fixture, '/usr/bin/flock'), {
        env: fixture.env,
        detached: true,
        stdio: 'ignore',
      });
      if (!child.pid) throw new Error('Wrapper process did not start');
      await waitForFile(blockMarker);
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      process.kill(-child.pid, 'SIGKILL');
      await exited;

      delete fixture.env.FAKE_BLOCK_MARKER;
      await run(fixture, '/usr/bin/flock');

      expect(installCount(fixture)).toBe(1);
      expect(existsSync(fixture.trigger)).toBe(false);
      const receipt = readFileSync(join(fixture.state, `${REQUEST_ID}.receipt`), 'utf8');
      expect(receipt).toContain(' success ');
      expect(receipt).toContain(' recovered_install\n');
    }
  );

  it.runIf(process.platform === 'linux' && existsSync('/usr/bin/flock'))(
    'retries the exact Agent install after SIGKILL leaves the global package absent',
    async () => {
      const fixture = makeFixture();
      const blockMarker = join(fixture.root, 'install-removed-package');
      fixture.env.FAKE_REMOVE_THEN_BLOCK_MARKER = blockMarker;
      publish(fixture.trigger, record());
      const child = spawn('/bin/bash', wrapperArgs(fixture, '/usr/bin/flock'), {
        env: fixture.env,
        detached: true,
        stdio: 'ignore',
      });
      if (!child.pid) throw new Error('Wrapper process did not start');
      await waitForFile(blockMarker);
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      process.kill(-child.pid, 'SIGKILL');
      await exited;

      expect(existsSync(join(
        fixture.globalRoot,
        '@zincapp',
        'zn-vault-agent',
        'package.json'
      ))).toBe(false);
      fixture.env.FAKE_VIEW_FAIL = '1';
      fixture.env.FAKE_ADVERTISED = '9.9.9';

      await run(fixture, '/usr/bin/flock');

      expect(installCount(fixture)).toBe(2);
      expect(readFileSync(fixture.npmLog, 'utf8')
        .split('\n').filter(line => line.startsWith('view '))).toHaveLength(1);
      expect(restartCount(fixture)).toBe(1);
      expect(JSON.parse(readFileSync(
        join(fixture.globalRoot, '@zincapp', 'zn-vault-agent', 'package.json'),
        'utf8'
      ))).toEqual({ version: '1.4.0' });
      expect(existsSync(join(fixture.state, 'active.state'))).toBe(false);
      expect(existsSync(fixture.trigger)).toBe(false);
      const receipt = readFileSync(join(fixture.state, `${REQUEST_ID}.receipt`), 'utf8');
      expect(receipt).toContain(' success ');
      expect(receipt).toContain(' installed\n');
    }
  );

  it('is valid Bash and explicitly uses the hardened primitives', () => {
    expect(() => execFileSync('/bin/bash', ['-n', WRAPPER])).not.toThrow();
    const source = readFileSync(WRAPPER, 'utf8');
    expect(source).toContain('O_NOFOLLOW');
    expect(source).toContain('fs.linkSync(temp, file)');
    expect(source).toContain('"$FLOCK_BIN" -n 9');
  });
});
