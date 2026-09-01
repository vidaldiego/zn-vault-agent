import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const AGENT_PACKAGE = '@zincapp/zn-vault-agent';
const PLUGIN_PACKAGE = '@zincapp/znvault-plugin-payara';
const EXPECTED_AGENT_VERSION = process.env.EXPECTED_AGENT_VERSION ?? '2.0.0';
const EXPECTED_PLUGIN_VERSION = process.env.EXPECTED_PLUGIN_VERSION ?? '3.0.0';

function packagePath(root, packageName, ...segments) {
  return join(root, 'node_modules', ...packageName.split('/'), ...segments);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function assertPrivateSubpath(specifier) {
  try {
    await import(specifier);
  } catch (error) {
    assert.equal(
      error?.code,
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
      `${specifier} failed for an unexpected reason: ${error?.message ?? error}`
    );
    return;
  }
  assert.fail(`${specifier} unexpectedly bypassed the package export boundary`);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

async function waitForFakeJava(pid, instanceRootArgument) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const [comm, commandLine] = await Promise.all([
        readFile(`/proc/${pid}/comm`, 'utf8'),
        readFile(`/proc/${pid}/cmdline`, 'utf8'),
      ]);
      if (comm.trim() === 'java' && commandLine.split('\0').includes(instanceRootArgument)) {
        return;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error('Fake Payara JVM did not expose its exact procfs identity');
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolvePromise => {
    let timer;
    const onExit = () => {
      child.removeListener('exit', onExit);
      clearTimeout(timer);
      resolvePromise(true);
    };
    child.once('exit', onExit);
    timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolvePromise(false);
    }, timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

async function terminateProcessGroup(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
    return;
  }

  if (!(await waitForChildExit(child, 2_000))) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
    assert.ok(await waitForChildExit(child, 2_000), 'Fake Payara process group did not exit');
  }
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolvePromise, reject) => {
    server.close(error => error ? reject(error) : resolvePromise());
  });
}

const [agentTarball, pluginTarball] = process.argv.slice(2);
assert.ok(agentTarball && pluginTarball, 'Expected agent and plugin tarball paths');
assert.equal(process.platform, 'linux', 'Lifecycle smoke requires Linux procfs');

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
assert.ok(nodeMajor === 22 || nodeMajor === 24, `Unexpected Node.js ${process.versions.node}`);
if (nodeMajor === 22) {
  assert.ok(nodeMinor >= 13, `Node.js ${process.versions.node} is below the 22.13 release floor`);
}

const installRoot = process.cwd();
const agentManifestPath = packagePath(installRoot, AGENT_PACKAGE, 'package.json');
const pluginManifestPath = packagePath(installRoot, PLUGIN_PACKAGE, 'package.json');
const [agentManifest, pluginManifest] = await Promise.all([
  readJson(agentManifestPath),
  readJson(pluginManifestPath),
]);

assert.equal(agentManifest.name, AGENT_PACKAGE);
assert.equal(agentManifest.version, EXPECTED_AGENT_VERSION);
assert.equal(agentManifest.engines?.node, '>=22.13.0');
assert.equal(pluginManifest.name, PLUGIN_PACKAGE);
assert.equal(pluginManifest.version, EXPECTED_PLUGIN_VERSION);
assert.equal(pluginManifest.engines?.node, '>=22.13.0');
assert.equal(pluginManifest.peerDependencies?.[AGENT_PACKAGE], '>=2.0.0 <3');
assert.equal(pluginManifest.peerDependenciesMeta?.[AGENT_PACKAGE]?.optional, true);

const packagedPluginWrapper = packagePath(
  installRoot,
  AGENT_PACKAGE,
  'deploy',
  'scripts',
  'zn-vault-plugin-update.sh'
);
const packagedPluginService = packagePath(
  installRoot,
  AGENT_PACKAGE,
  'deploy',
  'systemd',
  'zn-vault-agent-plugin-updater.service'
);
const packagedPluginPath = packagePath(
  installRoot,
  AGENT_PACKAGE,
  'deploy',
  'systemd',
  'zn-vault-agent-plugin-updater.path'
);
assert.equal(spawnSync('/bin/bash', ['-n', packagedPluginWrapper]).status, 0);
assert.match(await readFile(packagedPluginService, 'utf8'), /ExecStart=.*zn-vault-plugin-update\.sh/);
assert.doesNotMatch(await readFile(packagedPluginService, 'utf8'), /ExecStartPost/);
assert.match(await readFile(packagedPluginPath, 'utf8'), /PathExists=.*\.plugin-update-trigger/);

const agentPlugins = await import(`${AGENT_PACKAGE}/plugins`);
const pluginModule = await import(PLUGIN_PACKAGE);
const pluginCliModule = await import(`${PLUGIN_PACKAGE}/cli`);
assert.equal(typeof agentPlugins.PluginLoader, 'function');
assert.equal(typeof agentPlugins.createPluginLoader, 'function');
assert.equal(typeof pluginModule.default, 'function');
assert.equal(typeof pluginCliModule.createPayaraCLIPlugin, 'function');
assert.equal(pluginCliModule.createPayaraCLIPlugin().version, EXPECTED_PLUGIN_VERSION);
await assertPrivateSubpath(`${AGENT_PACKAGE}/plugins/loader`);
await assertPrivateSubpath(`${PLUGIN_PACKAGE}/payara-manager`);

const agentBin = resolve(dirname(agentManifestPath), agentManifest.bin['zn-vault-agent']);
const agentVersionOutput = execFileSync(process.execPath, [agentBin, '--version'], {
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: '1' },
}).trim();
assert.equal(agentVersionOutput, EXPECTED_AGENT_VERSION);

const fixtureRoot = await mkdtemp(join(tmpdir(), 'znvault-payara-release-'));
const domain = 'release-smoke-domain';
const appName = 'ReleaseSmokeApp';
const payaraHome = join(fixtureRoot, 'payara');
const domainRoot = join(payaraHome, 'glassfish', 'domains', domain);
const asadminPath = join(payaraHome, 'bin', 'asadmin');
const commandLogPath = join(fixtureRoot, 'asadmin.log');
const warPath = join(fixtureRoot, 'release-smoke.war');
const controlTokenPath = join(fixtureRoot, 'payara-mutation-token');
const sharedLockPath = '/var/lib/zn-vault-agent/znvault-deploy.lock';
const previousControlTokenPath = process.env.ZNVAULT_CONTROL_TOKEN_FILE;
let fakeJava;
let loader;
let agentHealthModule;

const healthServer = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ status: 'healthy', appName }));
});

try {
  await Promise.all([
    mkdir(join(payaraHome, 'bin'), { recursive: true }),
    mkdir(join(domainRoot, 'applications'), { recursive: true }),
    mkdir('/var/lib/zn-vault-agent', { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(warPath, 'release-smoke-war\n', { mode: 0o600 });
  const controlToken = randomBytes(32).toString('base64url');
  assert.equal(controlToken.length, 43);
  await writeFile(controlTokenPath, `${controlToken}\n`, { mode: 0o600 });
  await chmod(controlTokenPath, 0o600);
  const controlTokenStats = await stat(controlTokenPath);
  assert.equal(controlTokenStats.mode & 0o777, 0o600);
  assert.equal(controlTokenStats.size, 44);

  for (const flag of ['--env-secret', '-e']) {
    const probe = spawnSync(
      process.execPath,
      [agentBin, 'exec', flag, 'alias:example/missing', '--', 'true'],
      {
        encoding: 'utf8',
        timeout: 5_000,
        env: {
          ...process.env,
          ZNVAULT_AGENT_CONFIG_DIR: join(fixtureRoot, 'flag-probe-config'),
          NO_COLOR: '1',
        },
      }
    );
    assert.equal(probe.status, 1, `${flag} did not reach the packaged agent parser`);
    assert.match(probe.stderr, /Not configured\. Run: zn-vault-agent login/);
    assert.doesNotMatch(probe.stderr, /^node:/m, `${flag} was consumed by the Node runtime`);
  }

  const asadminScript = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${shellQuote(commandLogPath)}
command_name=''
for argument in "$@"; do
  case "$argument" in
    list-domains|uptime|list-applications|list-application-refs)
      command_name="$argument"
      break
      ;;
  esac
done
case "$command_name" in
  list-domains)
    printf '%s running\\n' ${shellQuote(domain)}
    ;;
  uptime)
    printf '%s\\n' 'Uptime: 0 days, 0 hours, 0 minutes, 1 seconds, Total milliseconds: 1000'
    ;;
  list-applications)
    printf '%s <web>\\n' ${shellQuote(appName)}
    ;;
  list-application-refs)
    printf '%s\\n' ${shellQuote(appName)}
    ;;
  *)
    printf 'Unsupported mock asadmin command: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`;
  await writeFile(asadminPath, asadminScript, { mode: 0o700 });
  await chmod(asadminPath, 0o700);

  await new Promise((resolvePromise, reject) => {
    healthServer.once('error', reject);
    healthServer.listen(0, '127.0.0.1', resolvePromise);
  });
  const healthAddress = healthServer.address();
  assert.ok(healthAddress && typeof healthAddress === 'object');
  const healthEndpoint = `http://127.0.0.1:${healthAddress.port}/service-status`;

  const instanceRootArgument = `-Dcom.sun.aas.instanceRoot=${domainRoot}`;
  fakeJava = spawn(
    '/bin/bash',
    [
      '-c',
      "printf '%s' java > /proc/self/comm; trap 'exit 0' TERM INT; while :; do sleep 60 & wait $!; done",
      'java',
      instanceRootArgument,
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'inherit'] }
  );
  assert.ok(fakeJava.pid, 'Failed to start fake Payara JVM');
  await waitForFakeJava(fakeJava.pid, instanceRootArgument);

  const config = {
    vaultUrl: 'http://127.0.0.1:1',
    tenantId: 'release-smoke',
    auth: {},
    targets: [],
    secretTargets: [],
    plugins: [{
      package: PLUGIN_PACKAGE,
      config: {
        payaraHome,
        domain,
        user: process.env.USER ?? 'node',
        warPath,
        appName,
        healthEndpoint,
        healthCheckTimeout: 2_000,
        operationTimeout: 5_000,
        postStartDelay: 0,
        validateAsadmin: true,
      },
    }],
  };

  loader = new agentPlugins.PluginLoader(
    { config, childProcessManager: null },
    {
      globalNodeModulesDir: join(installRoot, 'node_modules'),
      skipNpmDiscovery: true,
    }
  );

  await loader.loadPlugins(config);
  assert.equal(loader.getPlugin('payara')?.version, EXPECTED_PLUGIN_VERSION);
  assert.equal(loader.getPluginStatus('payara'), 'loaded');

  // Only the credential path enters the test environment. The token itself
  // stays in its private fixture file and in-process request memory.
  process.env.ZNVAULT_CONTROL_TOKEN_FILE = controlTokenPath;
  await loader.initializePlugins();
  assert.equal(loader.getPluginStatus('payara'), 'initialized');

  await loader.startPlugins();
  const pluginStatus = loader.getAllPluginStatuses().find(entry => entry.name === 'payara');
  assert.deepEqual(pluginStatus, { name: 'payara', status: 'running', error: undefined });

  // Plugin startup is intentionally observational. A persistent Payara-owned
  // application starts fenced as unverified; the public health hook must not
  // acquire the mutation lock or promote readiness by itself.
  const observedHealth = (await loader.collectHealthStatus()).find(entry => entry.name === 'payara');
  assert.ok(observedHealth, 'Payara plugin did not contribute health');
  assert.equal(observedHealth.status, 'degraded', JSON.stringify(observedHealth));
  assert.equal(observedHealth.details?.startupReconciliation, 'complete');
  assert.equal(observedHealth.details?.processCount, 1);
  assert.equal(observedHealth.details?.bootDeployment?.phase, 'payara-booting');
  assert.equal(observedHealth.details?.bootDeployment?.readiness, 'unverified');

  // Exercise the packaged Agent HTTP guard plus the plugin's inherited inner
  // guard. Import by absolute tarball path without widening package exports.
  agentHealthModule = await import(pathToFileURL(
    packagePath(installRoot, AGENT_PACKAGE, 'dist', 'lib', 'health.js')
  ).href);
  const agentControlServer = await agentHealthModule.startHealthServer(
    0,
    loader,
    '127.0.0.1'
  );
  const agentControlAddress = agentControlServer.server.address();
  assert.ok(agentControlAddress && typeof agentControlAddress === 'object');
  const agentControlBaseUrl = `http://127.0.0.1:${agentControlAddress.port}`;

  const observedPublicHealthResponse = await fetch(`${agentControlBaseUrl}/health`);
  // This isolated loader fixture does not install a full Agent config, so the
  // root envelope remains honestly unhealthy/503. The embedded Payara status
  // still proves that the public request did not promote its boot fence.
  assert.equal(observedPublicHealthResponse.status, 503);
  const observedPublicHealth = await observedPublicHealthResponse.json();
  assert.equal(observedPublicHealth.status, 'unhealthy');
  assert.equal(
    observedPublicHealth.plugins?.find(entry => entry.name === 'payara')?.status,
    'degraded'
  );

  const unauthenticatedPluginResponse = await fetch(
    `${agentControlBaseUrl}/plugins/payara/status`
  );
  assert.equal(unauthenticatedPluginResponse.status, 401);
  assert.deepEqual(await unauthenticatedPluginResponse.json(), {
    error: 'CONTROL_PLANE_AUTH_REQUIRED',
    message: 'A valid local control-plane credential is required',
  });

  const authenticatedPluginResponse = await fetch(
    `${agentControlBaseUrl}/plugins/payara/status`,
    { headers: { Authorization: `Bearer ${controlToken}` } }
  );
  assert.equal(authenticatedPluginResponse.status, 200);
  const authenticatedPluginStatus = await authenticatedPluginResponse.json();
  assert.equal(authenticatedPluginStatus.domain, domain);
  assert.equal(authenticatedPluginStatus.pluginVersion, EXPECTED_PLUGIN_VERSION);
  assert.equal(authenticatedPluginStatus.running, true);
  assert.equal(authenticatedPluginStatus.healthy, true);
  assert.equal(authenticatedPluginStatus.appDeployed, true);
  assert.equal(authenticatedPluginStatus.bootDeployment?.phase, 'ready');
  assert.equal(authenticatedPluginStatus.bootDeployment?.readiness, 'health-verified');
  assert.equal(authenticatedPluginStatus.bootDeployment?.owner, 'payara');
  assert.equal(authenticatedPluginStatus.bootDeployment?.runtimeListed, true);
  assert.equal(authenticatedPluginStatus.bootDeployment?.mutationOutcomeUnknown, false);

  // The authenticated request invalidates the old public snapshot and promotes
  // only after exact runtime inventory plus the configured 2xx health endpoint.
  const publicHealthResponse = await fetch(`${agentControlBaseUrl}/health`);
  assert.equal(publicHealthResponse.status, 503);
  const publicHealth = await publicHealthResponse.json();
  assert.equal(publicHealth.status, 'unhealthy');
  const publicPayaraHealth = publicHealth.plugins?.find(entry => entry.name === 'payara');
  assert.equal(publicPayaraHealth?.status, 'healthy', JSON.stringify(publicPayaraHealth));
  assert.equal(publicPayaraHealth?.details?.bootDeployment?.phase, 'ready');
  assert.equal(publicPayaraHealth?.details?.bootDeployment?.readiness, 'health-verified');

  const health = (await loader.collectHealthStatus()).find(entry => entry.name === 'payara');
  assert.ok(health, 'Payara plugin did not preserve health after authenticated readiness promotion');
  assert.equal(health.status, 'healthy', JSON.stringify(health));
  assert.equal(health.details?.startupReconciliation, 'complete');
  assert.equal(health.details?.processCount, 1);
  assert.equal(health.details?.bootDeployment?.phase, 'ready');
  assert.equal(health.details?.bootDeployment?.readiness, 'health-verified');

  const lockStats = await stat(sharedLockPath).catch(error => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  assert.equal(lockStats, undefined, 'Shared mutation lock remained after startup');

  const commandLog = await readFile(commandLogPath, 'utf8');
  for (const commandName of [
    'list-domains',
    'uptime',
    'list-applications',
    'list-application-refs',
  ]) {
    assert.match(commandLog, new RegExp(`(^|\\n).*${commandName}`));
  }

  await loader.stopPlugins();
  assert.equal(loader.getPluginStatus('payara'), 'stopped');

  const receipt = {
    node: process.versions.node,
    agent: {
      version: agentManifest.version,
      sha256: await sha256(agentTarball),
    },
    plugin: {
      version: pluginManifest.version,
      sha256: await sha256(pluginTarball),
      peerAgent: pluginManifest.peerDependencies[AGENT_PACKAGE],
    },
    loader: 'running_then_stopped',
    execFlags: ['--env-secret', '-e'],
    controlPlane: {
      publicHealth: publicHealthResponse.status,
      unauthenticatedPlugin: unauthenticatedPluginResponse.status,
      authenticatedPlugin: authenticatedPluginResponse.status,
    },
    payaraMock: {
      exactProcessCount: health.details.processCount,
      bootPhase: health.details.bootDeployment.phase,
      health: health.status,
    },
  };
  console.log(JSON.stringify(receipt));
} finally {
  if (agentHealthModule) {
    await agentHealthModule.stopHealthServer().catch(() => undefined);
  }
  if (loader?.getPluginStatus('payara') === 'running') {
    await loader.stopPlugins().catch(() => undefined);
  }
  await closeServer(healthServer).catch(() => undefined);
  if (fakeJava) await terminateProcessGroup(fakeJava).catch(() => undefined);
  if (previousControlTokenPath === undefined) {
    delete process.env.ZNVAULT_CONTROL_TOKEN_FILE;
  } else {
    process.env.ZNVAULT_CONTROL_TOKEN_FILE = previousControlTokenPath;
  }
  await rm(fixtureRoot, { recursive: true, force: true });
}
