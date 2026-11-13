import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const harness = vi.hoisted(() => ({
  config: { vaultUrl: 'https://vault.test', tenantId: 'tenant', auth: { apiKey: 'synthetic-own' },
    targets: [{ certId: 'certificate', name: 'certificate', outputs: {} }], secretTargets: [],
    managedKey: { name: 'agent', filePath: '/synthetic-own-file' } },
  sync: vi.fn(async () => ({ synced: true, wasOutOfSync: false })),
  cert: vi.fn(async () => ({ success: true })),
  bind: vi.fn(async () => ({ id: 'key-agent', name: 'agent', key: 'synthetic-own', prefix: '[REDACTED]', rotationMode: 'scheduled', gracePeriod: '', permissions: [], expiresAt: new Date(Date.now() + 31536000000).toISOString(), nextRotationAt: new Date(Date.now() + 1000).toISOString() })),
}));
vi.mock('./config.js', () => ({ loadConfig: () => harness.config, isManagedKeyMode: () => true, syncManagedKeyFile: harness.sync, updateManagedKey: vi.fn(), setConfigInMemory: vi.fn(), fetchConfigFromVault: vi.fn() }));
vi.mock('./deployer.js', () => ({ deployCertificate: harness.cert, deployAllCertificates: async () => [await harness.cert()] }));
vi.mock('./api.js', () => ({ bindManagedApiKey: harness.bind, getSecretMetadata: vi.fn() }));
vi.mock('./health.js', () => ({ startHealthServer: vi.fn(), stopHealthServer: vi.fn(), startHTTPSHealthServer: vi.fn(), stopHTTPSHealthServer: vi.fn(), reloadHTTPSCertificate: vi.fn(), updateCertStatus: vi.fn(), updateSecretStatus: vi.fn(), setChildProcessManager: vi.fn(), setPluginAutoUpdateService: vi.fn(), setNpmAutoUpdateService: vi.fn(), setManagedKeyTargetsHealth: vi.fn() }));
vi.mock('./logger.js', () => { const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }; return { metricsLogger: logger, wsLogger: logger, createLogger: () => logger, flushLogs: vi.fn(), setupLogRotation: vi.fn() }; });
vi.mock('../services/tls-certificate-manager.js', () => ({ isTLSEnabled: () => false, onCertificateUpdated: vi.fn(), ensureCertificateReady: vi.fn(), stopTLSCertificateManager: vi.fn() }));
vi.mock('../services/degraded-mode-handler.js', () => ({ initDegradedModeHandler: vi.fn(), handleDegradedConnection: vi.fn(), handleReprovisionAvailable: vi.fn(), cleanupDegradedModeHandler: vi.fn(), setAgentId: vi.fn() }));
vi.mock('../services/dynamic-secrets/index.js', () => ({ initializeDynamicSecrets: vi.fn(), isDynamicSecretsEnabled: () => false, cleanupDynamicSecrets: vi.fn() }));
vi.mock('../utils/startup-cleanup.js', () => ({ cleanupOrphanedFiles: vi.fn(), extractTargetDirectories: () => [] }));
vi.mock('./secret-deployer.js', () => ({ deploySecret: vi.fn(), deployAllSecrets: vi.fn(), findSecretTarget: vi.fn(), findSecretRefreshTargets: vi.fn(), listSecretRefreshTargets: () => [] }));
vi.mock('./websocket/index.js', () => ({
  getIsShuttingDown: () => false, setShuttingDown: vi.fn(),
  createUnifiedWebSocketClient: () => ({ connect: vi.fn(), disconnect: vi.fn(), isConnected: () => true,
    onTargetEvent: vi.fn(), onReady: vi.fn(), acknowledgeTarget: vi.fn(), onDegradedConnection: vi.fn(), onReprovisionAvailable: vi.fn(),
    onCertificateEvent: vi.fn(), onSecretEvent: vi.fn(), onUpdateEvent: vi.fn(), onApiKeyRotationEvent: vi.fn(), onHostConfigEvent: vi.fn(), onConnect: vi.fn(), onDisconnect: vi.fn(), onError: vi.fn() }),
}));
vi.mock('../services/child-process-manager.js', () => ({ ChildProcessManager: class {} }));
vi.mock('../plugins/loader.js', () => ({ createPluginLoader: vi.fn(), clearPluginLoader: vi.fn() }));
import { startDaemon } from './websocket.js';
import { stopManagedKeyRenewal } from '../services/managed-key-renewal.js';
let handlers: { interrupt: unknown[]; terminate: unknown[] };
beforeEach(() => { vi.useFakeTimers(); handlers = { interrupt: process.listeners('SIGINT'), terminate: process.listeners('SIGTERM') }; });
afterEach(() => { stopManagedKeyRenewal(); vi.useRealTimers(); for (const handler of process.listeners('SIGINT')) if (!handlers.interrupt.includes(handler)) process.off('SIGINT', handler); for (const handler of process.listeners('SIGTERM')) if (!handlers.terminate.includes(handler)) process.off('SIGTERM', handler); });
describe('daemon update delivery without data discovery timers', () => {
  it('does only initial reads while time advances without server events', async () => {
    await startDaemon({ healthPort: 0 });
    expect(harness.cert).toHaveBeenCalledTimes(1); expect(harness.sync).toHaveBeenCalledTimes(1); expect(harness.bind).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7200000);
    expect(harness.cert).toHaveBeenCalledTimes(1); expect(harness.sync).toHaveBeenCalledTimes(1); expect(harness.bind).toHaveBeenCalledTimes(1);
  });
});
