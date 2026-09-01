import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const wrapperArgument = process.argv[2];
assert.ok(wrapperArgument, 'Expected the extracted updater wrapper path');
const wrapper = resolve(wrapperArgument);
const packagedDeployDirectory = resolve(wrapper, '..', '..');
const packagedService = join(
  packagedDeployDirectory,
  'systemd',
  'zn-vault-agent-plugin-updater.service'
);
const packagedPath = join(
  packagedDeployDirectory,
  'systemd',
  'zn-vault-agent-plugin-updater.path'
);
const packageName = '@zincapp/znvault-plugin-payara';
const requestId = '77777777-7777-4777-8777-777777777777';
const record = `v1 ${requestId} 2.9.0 3.0.1 2026-01-01T00:00:00.000Z\n`;
const root = await mkdtemp(join(tmpdir(), 'znvault-packaged-updater-'));

try {
  const data = join(root, 'data');
  const receipts = join(root, 'receipts');
  const bin = join(root, 'bin');
  const globalRoot = join(root, 'global');
  const packageDirectory = join(globalRoot, '@zincapp', 'znvault-plugin-payara');
  const trigger = join(data, '.plugin-update-trigger');
  const active = join(data, '.plugin-update-active');
  const fakeNpm = join(bin, 'npm');
  const fakeFlock = join(bin, 'flock');
  const npmLog = join(root, 'npm.log');
  const intent = join(receipts, `${requestId}.intent`);

  await Promise.all([
    mkdir(data, { mode: 0o700 }),
    mkdir(receipts, { mode: 0o700 }),
    mkdir(bin, { mode: 0o700 }),
    mkdir(packageDirectory, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(join(packageDirectory, 'package.json'), '{"version":"2.9.0"}\n');
  await writeFile(fakeNpm, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
if [[ "$#" -eq 2 && "$1" == root && "$2" == -g ]]; then
  printf '%s\\n' "$FAKE_GLOBAL_ROOT"
  exit 0
fi
if [[ "$#" -eq 3 && "$1" == view && "$2" == '@zincapp/znvault-plugin-payara@dr-m4' && "$3" == version ]]; then
  [[ "\${FAKE_REGISTRY_DOWN:-}" != 1 ]] || exit 69
  printf '%s\\n' '3.0.1'
  exit 0
fi
if [[ "$#" -eq 4 && "$1" == install && "$2" == -g && "$3" == -- && "$4" == '@zincapp/znvault-plugin-payara@3.0.1' ]]; then
  printf '%s\\n' '{"version":"3.0.1"}' > "$FAKE_GLOBAL_ROOT/@zincapp/znvault-plugin-payara/package.json"
  exit 0
fi
exit 64
`);
  await writeFile(fakeFlock, '#!/usr/bin/env bash\nexit 0\n');
  await Promise.all([chmod(fakeNpm, 0o700), chmod(fakeFlock, 0o700)]);

  const uid = String(process.getuid?.() ?? 0);
  const args = [
    wrapper,
    trigger,
    active,
    receipts,
    fakeNpm,
    process.execPath,
    uid,
    uid,
    fakeFlock,
  ];
  const env = {
    ...process.env,
    FAKE_NPM_LOG: npmLog,
    FAKE_GLOBAL_ROOT: globalRoot,
  };

  execFileSync('/bin/bash', ['-n', wrapper]);
  const [serviceUnit, pathUnit] = await Promise.all([
    readFile(packagedService, 'utf8'),
    readFile(packagedPath, 'utf8'),
  ]);
  assert.match(serviceUnit, /^StartLimitIntervalSec=10min$/m);
  assert.match(serviceUnit, /^StartLimitBurst=6$/m);
  assert.match(serviceUnit, /^TimeoutStartSec=10min$/m);
  assert.match(pathUnit, /^TriggerLimitIntervalSec=10min$/m);
  assert.match(pathUnit, /^TriggerLimitBurst=6$/m);

  await writeFile(trigger, record, { mode: 0o600 });
  await link(trigger, `${trigger}.tmp.777.${requestId}`);
  const interruptedHelper = execFileAsync(
    '/bin/bash',
    [...args, 'after_npm'],
    { env, encoding: 'utf8' }
  ).then(
    () => null,
    error => error
  );
  // Simulate the normal Agent service restart window. The same root helper
  // must still be waiting, rather than failing/retriggering into rate limits.
  await new Promise(resolvePromise => setTimeout(resolvePromise, 5_000));
  await writeFile(active, record, { mode: 0o600 });
  await link(active, `${active}.tmp.777.${requestId}`);
  assert.ok(
    await interruptedHelper,
    'Extracted wrapper failpoint must SIGKILL after delayed active and exact npm install'
  );
  const intentState = await stat(intent);
  assert.equal(intentState.mode & 0o777, 0o600, 'Privileged intent must be mode 0600');
  assert.equal(intentState.uid, Number(uid), 'Privileged intent must have the configured root owner');
  assert.equal(intentState.nlink, 1, 'Committed privileged intent must have one link');
  env.FAKE_REGISTRY_DOWN = '1';
  execFileSync('/bin/bash', args, { env, stdio: 'pipe' });
  assert.equal((await stat(active)).nlink, 1, 'Extracted wrapper must reconcile active nlink=2');
  await assert.rejects(stat(intent), { code: 'ENOENT' });

  // Exercise immutable terminal replay from the extracted artifact as well.
  await writeFile(trigger, record, { mode: 0o600 });
  execFileSync('/bin/bash', args, { env, stdio: 'pipe' });

  const log = await readFile(npmLog, 'utf8');
  assert.equal(
    log.split('\n').filter(line => line.startsWith('install -g')).length,
    1,
    'Extracted wrapper must install exactly once across exact replay'
  );
  assert.equal(
    log.split('\n').filter(line => line.startsWith('view ')).length,
    1,
    'Extracted wrapper must recover without a second registry lookup'
  );
  assert.match(log, /^view @zincapp\/znvault-plugin-payara@dr-m4 version$/m);
  assert.match(log, /^install -g -- @zincapp\/znvault-plugin-payara@3\.0\.1$/m);
  assert.doesNotMatch(log, /unrelated|@latest|@beta|@next/);

  const receipt = await readFile(join(receipts, `${requestId}.receipt`), 'utf8');
  assert.match(
    receipt,
    new RegExp(`^v1 ${requestId} ${packageName.replace('/', '\\/')} dr-m4 2\\.9\\.0 3\\.0\\.1 3\\.0\\.1 success `)
  );
  assert.match(receipt, / recovered_install\n$/);
} finally {
  await rm(root, { recursive: true, force: true });
}
