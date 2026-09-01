import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(TEST_DIR, '..', '..', 'deploy', 'scripts', 'zn-vault-plugin-update.sh');
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];

interface Fixture {
  root: string;
  data: string;
  receipts: string;
  trigger: string;
  active: string;
  fakeNpm: string;
  fakeFlock: string;
  npmLog: string;
  globalRoot: string;
  env: NodeJS.ProcessEnv;
}

function makeFixture(current = '2.9.0', advertised = '3.0.1'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'znvault-plugin-wrapper-'));
  roots.push(root);
  const data = join(root, 'data');
  const receipts = join(root, 'receipts');
  const bin = join(root, 'bin');
  const globalRoot = join(root, 'global');
  const packageDir = join(globalRoot, '@zincapp', 'znvault-plugin-payara');
  mkdirSync(data, { mode: 0o700 });
  mkdirSync(receipts, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(packageDir, { recursive: true, mode: 0o700 });
  chmodSync(data, 0o700);
  chmodSync(receipts, 0o700);
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ version: current }));
  const fakeNpm = join(bin, 'npm');
  const npmLog = join(root, 'npm.log');
  writeFileSync(fakeNpm, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
if [[ "$1" == root && "$2" == -g ]]; then printf '%s\\n' "$FAKE_GLOBAL_ROOT"; exit 0; fi
if [[ "$1" == view ]]; then
  [[ "\${FAKE_REGISTRY_DOWN:-}" != 1 ]] || exit 69
  printf '%s\\n' "$FAKE_ADVERTISED"
  exit 0
fi
	if [[ "$1" == install && "$2" == -g && "$3" == -- ]]; then
	  target="\${4##*@}"
	  if [[ -n "\${FAKE_REMOVE_THEN_BLOCK_MARKER:-}" && ! -e "\${FAKE_REMOVE_THEN_BLOCK_MARKER}.used" ]]; then
	    : > "\${FAKE_REMOVE_THEN_BLOCK_MARKER}.used"
	    rm -f -- "$FAKE_GLOBAL_ROOT/@zincapp/znvault-plugin-payara/package.json"
	    : > "$FAKE_REMOVE_THEN_BLOCK_MARKER"
	    while true; do sleep 1; done
	  fi
	  printf '{"version":"%s"}\\n' "$target" > "$FAKE_GLOBAL_ROOT/@zincapp/znvault-plugin-payara/package.json"
	  if [[ -n "\${FAKE_BLOCK_MARKER:-}" && ! -e "\${FAKE_BLOCK_MARKER}.used" ]]; then
	    : > "\${FAKE_BLOCK_MARKER}.used"
	    : > "$FAKE_BLOCK_MARKER"
	    while true; do sleep 1; done
	  fi
	  exit 0
	fi
exit 64
`, { mode: 0o700 });
  chmodSync(fakeNpm, 0o700);
  const fakeFlock = join(bin, 'flock');
  writeFileSync(fakeFlock, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
  chmodSync(fakeFlock, 0o700);
  return {
    root,
    data,
    receipts,
    trigger: join(data, '.plugin-update-trigger'),
    active: join(data, '.plugin-update-active'),
    fakeNpm,
    fakeFlock,
    npmLog,
    globalRoot,
    env: {
      ...process.env,
      FAKE_NPM_LOG: npmLog,
      FAKE_GLOBAL_ROOT: globalRoot,
      FAKE_ADVERTISED: advertised,
    },
  };
}

function record(from = '2.9.0', target = '3.0.1'): string {
  return `v1 ${REQUEST_ID} ${from} ${target} 2026-01-01T10:00:00.000Z\n`;
}

function intentRecord(from = '2.9.0', target = '3.0.1'): string {
  return `v1 ${REQUEST_ID} @zincapp/znvault-plugin-payara dr-m4 ${from} ${target} `
    + '2026-01-01T10:00:00.000Z 2026-01-01T10:00:00.001Z\n';
}

function intentPath(fixture: Fixture): string {
  return join(fixture.receipts, `${REQUEST_ID}.intent`);
}

function publish(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function run(
  fixture: Fixture,
  failpoint = ''
): Promise<{ stdout: string; stderr: string }> {
  const uid = String(process.getuid?.() ?? 0);
  return await execFileAsync('/bin/bash', wrapperArgs(fixture, uid, fixture.fakeFlock, failpoint), {
    env: fixture.env,
    encoding: 'utf8',
  });
}

function wrapperArgs(
  fixture: Fixture,
  uid: string,
  flock = fixture.fakeFlock,
  failpoint = ''
): string[] {
  return [
    WRAPPER,
    fixture.trigger,
    fixture.active,
    fixture.receipts,
    fixture.fakeNpm,
    process.execPath,
    uid,
    uid,
    flock,
    failpoint,
  ];
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('root-owned Payara plugin wrapper', () => {
  it('is valid Bash and contains no restart side effect', () => {
    expect(() => execFileSync('/bin/bash', ['-n', WRAPPER])).not.toThrow();
    const source = readFileSync(WRAPPER, 'utf8');
    expect(source).not.toMatch(/systemctl|try-restart|SIGTERM/);
    expect(source).toContain("PACKAGE='@zincapp/znvault-plugin-payara'");
    expect(source).toContain("CHANNEL='dr-m4'");
  });

  it('does not consume or mutate when trigger appears before active', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());
    await expect(run(fixture, 'short_active_wait')).rejects.toBeDefined();
    expect(existsSync(fixture.trigger)).toBe(true);
    expect(existsSync(join(fixture.receipts, `${REQUEST_ID}.receipt`))).toBe(false);
    expect(existsSync(fixture.npmLog)).toBe(false);
  });

  it('keeps the same helper alive until active appears after the Agent restart delay', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());
    let activePublished = false;
    const timer = setTimeout(() => {
      publish(fixture.active, record());
      activePublished = true;
    }, 5_000);

    try {
      await expect(run(fixture)).resolves.toBeDefined();
    } finally {
      clearTimeout(timer);
    }

    expect(activePublished).toBe(true);
    expect(existsSync(fixture.trigger)).toBe(false);
    expect(readFileSync(join(fixture.receipts, `${REQUEST_ID}.receipt`), 'utf8'))
      .toContain(` ${REQUEST_ID} @zincapp/znvault-plugin-payara dr-m4 2.9.0 3.0.1 3.0.1 success `);
    expect(readFileSync(fixture.npmLog, 'utf8')
      .split('\n').filter(line => line.startsWith('install -g'))).toHaveLength(1);
  }, 15_000);

  it('installs exactly the fixed package once after trigger and active match', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());
    publish(fixture.active, record());
    await run(fixture);

    const receipt = readFileSync(join(fixture.receipts, `${REQUEST_ID}.receipt`), 'utf8');
    expect(receipt).toContain(` ${REQUEST_ID} @zincapp/znvault-plugin-payara dr-m4 2.9.0 3.0.1 3.0.1 success `);
    const log = readFileSync(fixture.npmLog, 'utf8');
    expect(log).toContain('view @zincapp/znvault-plugin-payara@dr-m4 version');
    expect(log).toContain('install -g -- @zincapp/znvault-plugin-payara@3.0.1');
    expect(log).not.toContain('@scope/unrelated');
  });

  it('reconciles exact trigger and active publisher links before npm', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());
    publish(fixture.active, record());
    const triggerTemp = `${fixture.trigger}.tmp.777.${REQUEST_ID}`;
    const activeTemp = `${fixture.active}.tmp.777.${REQUEST_ID}`;
    linkSync(fixture.trigger, triggerTemp);
    linkSync(fixture.active, activeTemp);

    await run(fixture);

    expect(existsSync(triggerTemp)).toBe(false);
    expect(existsSync(activeTemp)).toBe(false);
    expect(readFileSync(fixture.npmLog, 'utf8'))
      .toContain('install -g -- @zincapp/znvault-plugin-payara@3.0.1');
  });

  it('rejects an arbitrary major-3 target not resolved by dr-m4 before install', async () => {
    const fixture = makeFixture('2.9.0', '3.0.2');
    publish(fixture.trigger, record('2.9.0', '3.0.1'));
    publish(fixture.active, record('2.9.0', '3.0.1'));
    await expect(run(fixture)).rejects.toBeDefined();
    const log = readFileSync(fixture.npmLog, 'utf8');
    expect(log).not.toContain('install -g');
  });

  it('rejects a downgrade before install', async () => {
    const fixture = makeFixture('3.1.0', '3.0.1');
    publish(fixture.trigger, record('3.1.0', '3.0.1'));
    publish(fixture.active, record('3.1.0', '3.0.1'));
    await expect(run(fixture)).rejects.toBeDefined();
    expect(readFileSync(fixture.npmLog, 'utf8')).not.toContain('install -g');
  });

  it('preserves hyphens in valid prerelease comparison', async () => {
    const fixture = makeFixture('2.9.0', '3.0.0-alpha-beta');
    publish(fixture.trigger, record('2.9.0', '3.0.0-alpha-beta'));
    publish(fixture.active, record('2.9.0', '3.0.0-alpha-beta'));
    await expect(run(fixture)).resolves.toBeDefined();
  });

  it('replays an immutable exact receipt without a second npm install', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());
    publish(fixture.active, record());
    await run(fixture);
    publish(fixture.trigger, record());
    await run(fixture);
    const installs = readFileSync(fixture.npmLog, 'utf8')
      .split('\n')
      .filter(line => line.startsWith('install -g'));
    expect(installs).toHaveLength(1);
  });

  it('reconciles a crash after receipt link without npm number two', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());
    publish(fixture.active, record());
    const uid = String(process.getuid?.() ?? 0);

    await expect(execFileAsync('/bin/bash', wrapperArgs(
      fixture,
      uid,
      fixture.fakeFlock,
      'after_receipt_link'
    ), {
      env: fixture.env,
      encoding: 'utf8',
    })).rejects.toBeDefined();

    const receipt = join(fixture.receipts, `${REQUEST_ID}.receipt`);
    expect(lstatSync(receipt).nlink).toBe(2);
    expect(existsSync(fixture.trigger)).toBe(true);

    await run(fixture);

    expect(lstatSync(receipt).nlink).toBe(1);
    expect(existsSync(fixture.trigger)).toBe(false);
    const installs = readFileSync(fixture.npmLog, 'utf8')
      .split('\n')
      .filter(line => line.startsWith('install -g'));
    expect(installs).toHaveLength(1);
  });

  it('reconciles the exact privileged intent hardlink before the first npm mutation', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());
    publish(fixture.active, record());
    const uid = String(process.getuid?.() ?? 0);

    await expect(execFileAsync('/bin/bash', wrapperArgs(
      fixture,
      uid,
      fixture.fakeFlock,
      'after_intent_link'
    ), {
      env: fixture.env,
      encoding: 'utf8',
    })).rejects.toBeDefined();

    const intent = intentPath(fixture);
    expect(lstatSync(intent).nlink).toBe(2);
    expect(readdirSync(fixture.receipts).filter(name => name.startsWith(`${REQUEST_ID}.intent.tmp.`)))
      .toHaveLength(1);
    expect(readFileSync(fixture.npmLog, 'utf8'))
      .not.toContain('install -g -- @zincapp/znvault-plugin-payara@3.0.1');

    await run(fixture);

    expect(existsSync(intent)).toBe(false);
    expect(readdirSync(fixture.receipts).filter(name => name.startsWith(`${REQUEST_ID}.intent.tmp.`)))
      .toHaveLength(0);
    const log = readFileSync(fixture.npmLog, 'utf8').split('\n');
    expect(log.filter(line => line.startsWith('view '))).toHaveLength(1);
    expect(log.filter(line => line.startsWith('install -g'))).toHaveLength(1);
  });

  it.each([
    {
      condition: 'the registry is unavailable',
      mutateRegistry: (fixture: Fixture): void => { fixture.env.FAKE_REGISTRY_DOWN = '1'; },
    },
    {
      condition: 'the dr-m4 tag has moved',
      mutateRegistry: (fixture: Fixture): void => { fixture.env.FAKE_ADVERTISED = '3.0.2'; },
    },
  ])(
    'recovers a SIGKILL after npm from root evidence when $condition',
    async ({ mutateRegistry }) => {
      const fixture = makeFixture();
      publish(fixture.trigger, record());
      publish(fixture.active, record());

      await expect(run(fixture, 'after_npm')).rejects.toBeDefined();

      const intent = intentPath(fixture);
      const intentState = lstatSync(intent);
      expect(intentState.mode & 0o777).toBe(0o600);
      expect(intentState.uid).toBe(process.getuid?.() ?? 0);
      expect(intentState.nlink).toBe(1);
      expect(existsSync(join(fixture.receipts, `${REQUEST_ID}.receipt`))).toBe(false);
      expect(JSON.parse(readFileSync(
        join(fixture.globalRoot, '@zincapp', 'znvault-plugin-payara', 'package.json'),
        'utf8'
      ))).toEqual({ version: '3.0.1' });

      mutateRegistry(fixture);
      await run(fixture);

      const log = readFileSync(fixture.npmLog, 'utf8').split('\n');
      expect(log.filter(line => line.startsWith('view '))).toHaveLength(1);
      expect(log.filter(line => line.startsWith('install -g'))).toHaveLength(1);
      expect(existsSync(intent)).toBe(false);
      expect(readFileSync(join(fixture.receipts, `${REQUEST_ID}.receipt`), 'utf8'))
        .toContain(' success 2026-01-01T10:00:00.000Z ');
      expect(readFileSync(join(fixture.receipts, `${REQUEST_ID}.receipt`), 'utf8'))
        .toContain(' recovered_install\n');
    }
  );

  it('rejects an adulterated privileged intent before registry or install', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());
    publish(fixture.active, record());
    publish(intentPath(fixture), 'tampered\n');

    await expect(run(fixture)).rejects.toBeDefined();

    const log = readFileSync(fixture.npmLog, 'utf8');
    expect(log).not.toContain('view ');
    expect(log).not.toContain('install -g');
    expect(existsSync(fixture.trigger)).toBe(true);
    expect(existsSync(join(fixture.receipts, `${REQUEST_ID}.receipt`))).toBe(false);
  });

  it('rejects a privileged intent whose exact tuple conflicts with the trigger', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());
    publish(fixture.active, record());
    publish(intentPath(fixture), intentRecord('2.9.0', '3.0.2'));

    await expect(run(fixture)).rejects.toBeDefined();

    const log = readFileSync(fixture.npmLog, 'utf8');
    expect(log).not.toContain('view ');
    expect(log).not.toContain('install -g');
    expect(existsSync(fixture.trigger)).toBe(true);
    expect(existsSync(join(fixture.receipts, `${REQUEST_ID}.receipt`))).toBe(false);
  });

  it('does not treat an installed target as authorized without privileged intent', async () => {
    const fixture = makeFixture('3.0.1', '3.0.1');
    publish(fixture.trigger, record());
    publish(fixture.active, record());

    await expect(run(fixture)).rejects.toBeDefined();

    const log = readFileSync(fixture.npmLog, 'utf8');
    expect(log).toContain('view @zincapp/znvault-plugin-payara@dr-m4 version');
    expect(log).not.toContain('install -g');
    const receipt = readFileSync(join(fixture.receipts, `${REQUEST_ID}.receipt`), 'utf8');
    expect(receipt).toContain(' failure ');
    expect(receipt).toContain(' current_version_mismatch\n');
  });

  it('retries an absent package only from an exact privileged intent without a second registry lookup', async () => {
    const fixture = makeFixture();
    publish(fixture.trigger, record());
    publish(fixture.active, record());
    const uid = String(process.getuid?.() ?? 0);

    await expect(execFileAsync('/bin/bash', wrapperArgs(
      fixture,
      uid,
      fixture.fakeFlock,
      'after_intent_link'
    ), {
      env: fixture.env,
      encoding: 'utf8',
    })).rejects.toBeDefined();

    rmSync(join(fixture.globalRoot, '@zincapp', 'znvault-plugin-payara', 'package.json'));
    fixture.env.FAKE_REGISTRY_DOWN = '1';
    fixture.env.FAKE_ADVERTISED = '3.0.2';

    await run(fixture);

    const log = readFileSync(fixture.npmLog, 'utf8').split('\n');
    expect(log.filter(line => line.startsWith('view '))).toHaveLength(1);
    expect(log.filter(line => line.startsWith('install -g'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(
      join(fixture.globalRoot, '@zincapp', 'znvault-plugin-payara', 'package.json'),
      'utf8'
    ))).toEqual({ version: '3.0.1' });
    expect(existsSync(intentPath(fixture))).toBe(false);
    expect(readFileSync(join(fixture.receipts, `${REQUEST_ID}.receipt`), 'utf8'))
      .toContain(' 3.0.1 success ');
  });

  it('rejects a third installed version under exact intent without registry or install', async () => {
    const fixture = makeFixture('2.9.1', '3.0.2');
    publish(fixture.trigger, record('2.9.0', '3.0.1'));
    publish(fixture.active, record('2.9.0', '3.0.1'));
    publish(intentPath(fixture), intentRecord('2.9.0', '3.0.1'));
    fixture.env.FAKE_REGISTRY_DOWN = '1';

    await expect(run(fixture)).rejects.toBeDefined();

    const log = readFileSync(fixture.npmLog, 'utf8');
    expect(log).not.toContain('view ');
    expect(log).not.toContain('install -g');
    expect(existsSync(intentPath(fixture))).toBe(false);
    expect(existsSync(fixture.trigger)).toBe(false);
    const receipt = readFileSync(join(fixture.receipts, `${REQUEST_ID}.receipt`), 'utf8');
    expect(receipt).toContain(' 2.9.1 failure ');
    expect(receipt).toContain(' current_version_mismatch\n');
  });

  it.runIf(process.platform === 'linux' && existsSync('/usr/bin/flock'))(
    'retries the exact install after SIGKILL leaves the global package absent',
    async () => {
      const fixture = makeFixture();
      const blockMarker = join(fixture.root, 'install-removed-package');
      fixture.env.FAKE_REMOVE_THEN_BLOCK_MARKER = blockMarker;
      publish(fixture.trigger, record());
      publish(fixture.active, record());

      const uid = String(process.getuid?.() ?? 0);
      const child = spawn(
        '/bin/bash',
        wrapperArgs(fixture, uid, '/usr/bin/flock'),
        { env: fixture.env, detached: true, stdio: 'ignore' }
      );
      if (!child.pid) throw new Error('Wrapper process did not start');

      await waitForFile(blockMarker);
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      process.kill(-child.pid, 'SIGKILL');
      await exited;

      expect(existsSync(join(
        fixture.globalRoot,
        '@zincapp',
        'znvault-plugin-payara',
        'package.json'
      ))).toBe(false);
      fixture.env.FAKE_REGISTRY_DOWN = '1';
      fixture.env.FAKE_ADVERTISED = '3.0.2';

      await execFileAsync('/bin/bash', wrapperArgs(fixture, uid, '/usr/bin/flock'), {
        env: fixture.env,
        encoding: 'utf8',
      });

      const log = readFileSync(fixture.npmLog, 'utf8').split('\n');
      expect(log.filter(line => line.startsWith('view '))).toHaveLength(1);
      expect(log.filter(line => line.startsWith('install -g'))).toHaveLength(2);
      expect(JSON.parse(readFileSync(
        join(fixture.globalRoot, '@zincapp', 'znvault-plugin-payara', 'package.json'),
        'utf8'
      ))).toEqual({ version: '3.0.1' });
      expect(existsSync(intentPath(fixture))).toBe(false);
      const receipt = readFileSync(join(fixture.receipts, `${REQUEST_ID}.receipt`), 'utf8');
      expect(receipt).toContain(' success ');
      expect(receipt).toContain(' installed\n');
    }
  );

  it.runIf(process.platform === 'linux' && existsSync('/usr/bin/flock'))(
    'releases the kernel lock after SIGKILL and reconciles without a second install',
    async () => {
      const fixture = makeFixture();
      const blockMarker = join(fixture.root, 'install-blocked');
      fixture.env.FAKE_BLOCK_MARKER = blockMarker;
      publish(fixture.trigger, record());
      publish(fixture.active, record());

      const uid = String(process.getuid?.() ?? 0);
      const child = spawn(
        '/bin/bash',
        wrapperArgs(fixture, uid, '/usr/bin/flock'),
        { env: fixture.env, detached: true, stdio: 'ignore' }
      );
      if (!child.pid) throw new Error('Wrapper process did not start');

      await waitForFile(blockMarker);
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      process.kill(-child.pid, 'SIGKILL');
      await exited;

      fixture.env.FAKE_REGISTRY_DOWN = '1';

      await execFileAsync('/bin/bash', wrapperArgs(fixture, uid, '/usr/bin/flock'), {
        env: fixture.env,
        encoding: 'utf8',
      });

      const installs = readFileSync(fixture.npmLog, 'utf8')
        .split('\n')
        .filter(line => line.startsWith('install -g'));
      expect(installs).toHaveLength(1);
      const views = readFileSync(fixture.npmLog, 'utf8')
        .split('\n')
        .filter(line => line.startsWith('view '));
      expect(views).toHaveLength(1);
      const receipt = readFileSync(join(fixture.receipts, `${REQUEST_ID}.receipt`), 'utf8');
      expect(receipt).toContain(' success ');
      expect(receipt).toContain(' recovered_install\n');
    }
  );
});
