// Path: zn-vault-agent/src/lib/websocket.ts
// WebSocket client for real-time certificate and secret updates (unified mode)
// This file re-exports from the websocket/ module and provides the startDaemon function

import {
  loadConfig,
  syncManagedKeyFile,
  setConfigInMemory,
  fetchConfigFromVault,
  type ExecConfig,
  type AgentConfig,
} from './config.js';
import { deployCertificate, deployAllCertificates } from './deployer.js';
import { deploySecret, deployAllSecrets, findSecretTarget } from './secret-deployer.js';
import { wsLogger as log } from './logger.js';
import { metrics, initializeMetrics } from './metrics.js';
import {
  startHealthServer,
  stopHealthServer,
  updateCertStatus,
  updateSecretStatus,
  setChildProcessManager,
  setPluginAutoUpdateService,
  setNpmAutoUpdateService,
} from './health.js';
import { flushLogs, setupLogRotation } from './logger.js';
import type { PluginAutoUpdateService } from '../services/plugin-auto-update.js';
import type { NpmAutoUpdateService } from '../services/npm-auto-update.js';
import { startApiKeyRenewal, stopApiKeyRenewal } from '../services/api-key-renewal.js';
import {
  startManagedKeyRenewal,
  stopManagedKeyRenewal,
  onKeyChanged as onManagedKeyChanged,
} from '../services/managed-key-renewal.js';
import { isManagedKeyMode } from './config.js';
import { ChildProcessManager } from '../services/child-process-manager.js';
import {
  extractSecretIds,
  extractApiKeyNames,
  parseSecretMappingFromConfig,
  updateEnvFile,
  findEnvVarsForApiKey,
  type SecretMapping,
} from './secret-env.js';
import { bindManagedApiKey } from './api.js';
import {
  createPluginLoader,
  clearPluginLoader,
  type PluginLoader,
} from '../plugins/loader.js';
import type {
  CertificateDeployedEvent,
  SecretDeployedEvent,
  SecretChangedEvent,
  KeyRotatedEvent,
  ChildProcessEvent,
} from '../plugins/types.js';
import {
  initDegradedModeHandler,
  handleDegradedConnection,
  handleReprovisionAvailable,
  cleanupDegradedModeHandler,
  setAgentId,
} from '../services/degraded-mode-handler.js';
import {
  initializeDynamicSecrets,
  isDynamicSecretsEnabled,
  cleanupDynamicSecrets,
} from '../services/dynamic-secrets/index.js';
import {
  cleanupOrphanedFiles,
  extractTargetDirectories,
} from '../utils/startup-cleanup.js';

// Re-export types and client from websocket module
export type {
  CertificateEvent,
  SecretEvent,
  AgentUpdateEvent,
  ApiKeyRotationEvent,
  HostConfigEvent,
  DegradedReason,
  DegradedConnectionInfo,
  ReprovisionEvent,
  UnifiedAgentEvent,
  UnifiedWebSocketClient,
} from './websocket/index.js';

export {
  createUnifiedWebSocketClient,
  setShuttingDown,
  getIsShuttingDown,
} from './websocket/index.js';

// Import for internal use
import {
  createUnifiedWebSocketClient,
  setShuttingDown,
  getIsShuttingDown,
} from './websocket/index.js';
import type {
  CertificateEvent,
  SecretEvent,
  ApiKeyRotationEvent,
  HostConfigEvent,
} from './websocket/index.js';

// Track active deployments for graceful shutdown
let activeDeployments = 0;

// Signal handler references for proper cleanup (prevents memory leak on restart)
let sigintHandler: (() => void) | null = null;
let sigtermHandler: (() => void) | null = null;

/**
 * Remove signal handlers to prevent memory leak on daemon restart.
 */
function cleanupSignalHandlers(): void {
  if (sigintHandler) {
    process.off('SIGINT', sigintHandler);
    sigintHandler = null;
  }
  if (sigtermHandler) {
    process.off('SIGTERM', sigtermHandler);
    sigtermHandler = null;
  }
}

/**
 * Set up signal handlers for graceful shutdown.
 * Removes any existing handlers first to prevent accumulation.
 */
function setupSignalHandlers(shutdownFn: (signal: string) => Promise<void>): void {
  // Clean up any existing handlers first
  cleanupSignalHandlers();

  // Create new handlers
  sigintHandler = () => {
    shutdownFn('SIGINT').catch((e: unknown) => {
      log.error({ err: e }, 'Shutdown error');
    });
  };
  sigtermHandler = () => {
    shutdownFn('SIGTERM').catch((e: unknown) => {
      log.error({ err: e }, 'Shutdown error');
    });
  };

  // Register handlers
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);
}

/**
 * Start the agent daemon with unified WebSocket connection
 */
export async function startDaemon(options: {
  verbose?: boolean;
  healthPort?: number;
  exec?: ExecConfig;
  pluginAutoUpdateService?: PluginAutoUpdateService | null;
  npmAutoUpdateService?: NpmAutoUpdateService | null;
  configFromVault?: boolean;
} = {}): Promise<void> {
  const config = loadConfig();
  const secretTargets = config.secretTargets ?? [];

  // Initialize plugin loader
  let pluginLoader: PluginLoader | null = null;

  // Initialize metrics
  initializeMetrics();

  // Setup log rotation handler
  setupLogRotation();

  // Clean up orphaned temp and old backup files from previous crashed deployments
  // This prevents disk space leaks from interrupted atomic writes
  const targetDirectories = extractTargetDirectories(
    config.targets.map(t => ({ outputs: t.outputs })),
    secretTargets
  );
  if (targetDirectories.length > 0) {
    const cleanupStats = cleanupOrphanedFiles(targetDirectories);
    if (cleanupStats.tempFilesRemoved > 0 || cleanupStats.backupFilesRemoved > 0) {
      log.info({
        tempFilesRemoved: cleanupStats.tempFilesRemoved,
        backupFilesRemoved: cleanupStats.backupFilesRemoved,
      }, 'Startup cleanup: removed orphaned files');
    }
  }

  // Initialize dynamic secrets service if enabled
  if (isDynamicSecretsEnabled()) {
    initializeDynamicSecrets();
    log.info('Dynamic secrets capability enabled');
  }

  // CRITICAL: Verify and sync managed key file before doing anything else
  // This ensures apps that read from file always have the correct key
  // By default, sync failure blocks startup (MANAGED_KEY_SYNC_REQUIRED=true)
  const managedKeySyncRequired = process.env.MANAGED_KEY_SYNC_REQUIRED !== 'false';

  if (config.managedKey?.filePath) {
    const syncResult = syncManagedKeyFile();
    if (syncResult.wasOutOfSync) {
      if (syncResult.synced) {
        log.warn({
          filePath: config.managedKey.filePath,
        }, 'Managed key file was out of sync - auto-fixed on startup');
      } else {
        log.error({
          filePath: config.managedKey.filePath,
          error: syncResult.error,
        }, 'CRITICAL: Managed key file sync failed');

        // Block startup if sync is required (default behavior)
        if (managedKeySyncRequired) {
          throw new Error(`Managed key file sync failed: ${syncResult.error ?? 'unknown error'}. Set MANAGED_KEY_SYNC_REQUIRED=false to continue anyway.`);
        }
        log.warn('Continuing despite sync failure (MANAGED_KEY_SYNC_REQUIRED=false)');
      }
    } else {
      log.info({
        filePath: config.managedKey.filePath,
      }, 'Managed key file verified - in sync');
    }
  }

  // Extract exec secret IDs and managed API key names for WebSocket subscription
  let execSecretIds: string[] = [];
  let execManagedKeyNames: string[] = [];
  let execSecretMappings: (SecretMapping & { literal?: string })[] = [];
  const execOutputFile = options.exec?.envFile; // Output file path for env file mode

  if (options.exec) {
    execSecretMappings = options.exec.secrets.map(parseSecretMappingFromConfig);
    execSecretIds = extractSecretIds(execSecretMappings);
    execManagedKeyNames = extractApiKeyNames(execSecretMappings);
  }

  log.info({
    vault: config.vaultUrl,
    certTargets: config.targets.length,
    secretTargets: secretTargets.length,
    execSecrets: execSecretIds.length,
    execManagedKeys: execManagedKeyNames.length,
    execCommand: options.exec?.command.join(' '),
  }, 'Starting ZnVault Agent');

  // Initialize child process manager if exec config provided
  let childManager: ChildProcessManager | null = null;
  if (options.exec) {
    childManager = new ChildProcessManager(options.exec);

    // Register with health module for status reporting
    setChildProcessManager(childManager);

    childManager.on('started', (pid) => {
      log.info({ pid }, 'Child process started');
    });

    childManager.on('stopped', (code, signal) => {
      log.info({ code, signal }, 'Child process stopped');
    });

    childManager.on('restarting', (reason) => {
      log.info({ reason }, 'Restarting child process');
    });

    childManager.on('maxRestartsExceeded', () => {
      log.error('Child process max restarts exceeded, entering degraded state');
    });

    childManager.on('error', (err) => {
      log.error({ err }, 'Child process error');
    });
  }

  // Initialize plugin system if plugins are configured
  const pluginConfigs = (config as AgentConfig & { plugins?: unknown[] }).plugins;
  if (pluginConfigs && pluginConfigs.length > 0) {
    log.info({ pluginCount: pluginConfigs.length }, 'Initializing plugin system');

    pluginLoader = createPluginLoader(
      {
        config,
        childProcessManager: childManager,
        restartChild: childManager ? (reason: string) => childManager.restart(reason) : undefined,
      },
      {
        pluginDir: process.env.ZNVAULT_AGENT_PLUGIN_DIR,
      }
    );

    try {
      // Load plugins from config
      await pluginLoader.loadPlugins(config);

      // Initialize plugins
      await pluginLoader.initializePlugins();

      log.info({ plugins: pluginLoader.getAllPluginStatuses() }, 'Plugins initialized');
    } catch (err) {
      log.error({ err }, 'Failed to initialize plugins');
      // Continue running agent without plugins
    }

    // Wire up child process events to plugins - use .catch() for error handling in event callbacks
    if (childManager) {
      childManager.on('started', (pid: number) => {
        const event: ChildProcessEvent = { type: 'started', pid };
        pluginLoader?.dispatchEvent('childProcess', event).catch((err: unknown) => {
          log.error({ err, type: 'started' }, 'Plugin failed to handle childProcess event');
        });
      });

      childManager.on('stopped', (code: number | null, signal: string | null) => {
        const event: ChildProcessEvent = {
          type: 'stopped',
          exitCode: code ?? undefined,
          signal: signal ?? undefined,
        };
        pluginLoader?.dispatchEvent('childProcess', event).catch((err: unknown) => {
          log.error({ err, type: 'stopped' }, 'Plugin failed to handle childProcess event');
        });
      });

      childManager.on('restarting', (reason: string) => {
        const event: ChildProcessEvent = { type: 'restarting', reason };
        pluginLoader?.dispatchEvent('childProcess', event).catch((err: unknown) => {
          log.error({ err, type: 'restarting' }, 'Plugin failed to handle childProcess event');
        });
      });

      childManager.on('maxRestartsExceeded', () => {
        const event: ChildProcessEvent = { type: 'max_restarts' };
        pluginLoader?.dispatchEvent('childProcess', event).catch((err: unknown) => {
          log.error({ err, type: 'max_restarts' }, 'Plugin failed to handle childProcess event');
        });
      });
    }
  }

  // Register plugin auto-update service with health module for HTTP endpoints
  if (options.pluginAutoUpdateService) {
    setPluginAutoUpdateService(options.pluginAutoUpdateService);
  }

  // Register npm auto-update service with health module for agent version/update endpoints
  if (options.npmAutoUpdateService) {
    setNpmAutoUpdateService(options.npmAutoUpdateService);
  }

  // Start health server if port specified (pass plugin loader for routes and health aggregation)
  if (options.healthPort) {
    try {
      await startHealthServer(options.healthPort, pluginLoader ?? undefined);
    } catch (err) {
      log.error({ err }, 'Failed to start health server');
    }
  }

  // Update tracked metrics
  metrics.setCertsTracked(config.targets.length);

  // Create unified WebSocket client with exec secret IDs and managed key names
  const unifiedClient = createUnifiedWebSocketClient(execSecretIds, execManagedKeyNames);

  // Initialize degraded mode handler
  initDegradedModeHandler({
    onCredentialsUpdated: (newKey) => {
      log.info({ keyPrefix: newKey.substring(0, 8) }, 'Credentials updated via reprovision, reconnecting');
      // Reconnect with new credentials
      unifiedClient.disconnect();
      setTimeout(() => {
        if (!getIsShuttingDown()) {
          unifiedClient.connect();
        }
      }, 500);
    },
    onStateChanged: (isDegraded, reason) => {
      if (isDegraded) {
        log.warn({ reason }, 'Agent entered degraded mode');
      } else {
        log.info('Agent exited degraded mode');
      }
    },
  });

  // Handle degraded connection notifications
  unifiedClient.onDegradedConnection((info) => {
    handleDegradedConnection(info);
  });

  // Handle reprovision available notifications
  unifiedClient.onReprovisionAvailable((expiresAt) => {
    handleReprovisionAvailable(expiresAt);
  });

  // Handle certificate events
  async function handleCertificateEvent(event: CertificateEvent): Promise<void> {
    if (getIsShuttingDown()) {
      log.debug({ event: event.event }, 'Ignoring certificate event during shutdown');
      return;
    }

    const target = config.targets.find(t => t.certId === event.certificateId);
    if (target) {
      activeDeployments++;
      try {
        log.info({ name: target.name, event: event.event }, 'Processing certificate event');
        const result = await deployCertificate(target, true);

        if (result.success) {
          log.info({ name: target.name, fingerprint: result.fingerprint }, 'Certificate deployed');

          // Dispatch plugin event - await with error handling
          if (pluginLoader) {
            const certEvent: CertificateDeployedEvent = {
              certId: target.certId,
              name: target.name,
              paths: target.outputs,
              fingerprint: result.fingerprint ?? '',
              expiresAt: '', // Would need cert parsing for this
              commonName: '', // Would need cert parsing for this
              isUpdate: true,
            };
            try {
              await pluginLoader.dispatchEvent('certificateDeployed', certEvent);
            } catch (pluginErr) {
              log.error({ err: pluginErr, certId: target.certId }, 'Plugin failed to handle certificateDeployed event');
            }
          }

          // Restart child process if configured
          if (childManager && options.exec?.restartOnChange) {
            await childManager.restart('certificate rotated');
          }
        } else {
          log.error({ name: target.name, error: result.message }, 'Certificate deployment failed');
        }
      } finally {
        activeDeployments--;
      }
    } else {
      log.debug({ certId: event.certificateId }, 'Received event for untracked certificate');
    }
  }

  unifiedClient.onCertificateEvent((event) => {
    handleCertificateEvent(event).catch((err: unknown) => {
      log.error({ err }, 'Error handling certificate event');
    });
  });

  // Handle secret events
  async function handleSecretEvent(event: SecretEvent): Promise<void> {
    if (getIsShuttingDown()) {
      log.debug({ event: event.event }, 'Ignoring secret event during shutdown');
      return;
    }

    // Dispatch secretChanged event to plugins (before deployment)
    if (pluginLoader) {
      const valueChanged = event.event === 'secret.updated' || event.event === 'secret.rotated';
      const secretChangedEvent: SecretChangedEvent = {
        secretId: event.secretId,
        alias: event.alias,
        version: event.version,
        valueChanged,
        changedAt: event.timestamp,
      };
      try {
        await pluginLoader.dispatchEvent('secretChanged', secretChangedEvent);
      } catch (pluginErr) {
        log.error({ err: pluginErr, secretId: event.secretId }, 'Plugin failed to handle secretChanged event');
      }
    }

    let deployedSecretTarget = false;
    let isExecSecret = false;

    // Check if this is a secret target (file deployment)
    const target = findSecretTarget(event.secretId) ?? findSecretTarget(event.alias);
    if (target) {
      activeDeployments++;
      try {
        log.info({ name: target.name, event: event.event, version: event.version }, 'Processing secret event');
        const result = await deploySecret(target, true);

        if (result.success) {
          log.info({ name: target.name, version: result.version }, 'Secret deployed');
          deployedSecretTarget = true;

          // Dispatch plugin event - await with error handling
          if (pluginLoader) {
            const secretEvent: SecretDeployedEvent = {
              secretId: target.secretId,
              alias: event.alias,
              name: target.name,
              path: target.output,
              format: target.format,
              version: result.version ?? event.version,
              isUpdate: true,
            };
            try {
              await pluginLoader.dispatchEvent('secretDeployed', secretEvent);
            } catch (pluginErr) {
              log.error({ err: pluginErr, secretId: target.secretId }, 'Plugin failed to handle secretDeployed event');
            }
          }
        } else {
          log.error({ name: target.name, error: result.message }, 'Secret deployment failed');
        }
      } finally {
        activeDeployments--;
      }
    }

    // Check if this is an exec secret (for child process)
    if (execSecretIds.includes(event.secretId) || execSecretIds.includes(event.alias)) {
      isExecSecret = true;
    }

    // Restart child process if:
    // 1. A secret target was deployed and restartOnChange is true, OR
    // 2. An exec secret was updated
    if (childManager && options.exec?.restartOnChange) {
      if (deployedSecretTarget || isExecSecret) {
        const reason = isExecSecret ? 'exec secret updated' : 'secret file updated';
        await childManager.restart(reason);
      }
    }

    if (!target && !isExecSecret) {
      log.debug({ secretId: event.secretId, alias: event.alias }, 'Received event for untracked secret');
    }
  }

  unifiedClient.onSecretEvent((event) => {
    handleSecretEvent(event).catch((err: unknown) => {
      log.error({ err }, 'Error handling secret event');
    });
  });

  // Handle update events
  unifiedClient.onUpdateEvent((event) => {
    log.info({ version: event.version, channel: event.channel }, 'Update available');
    // Auto-update handling is done by auto-update service
  });

  // Handle API key rotation events
  async function handleApiKeyRotationEvent(event: ApiKeyRotationEvent): Promise<void> {
    if (getIsShuttingDown()) {
      log.debug({ event: event.event }, 'Ignoring API key rotation event during shutdown');
      return;
    }

    // Check if this key is one we're using
    if (!execManagedKeyNames.includes(event.apiKeyName)) {
      log.debug({ keyName: event.apiKeyName }, 'Received rotation event for untracked managed key');
      return;
    }

    log.info({
      keyName: event.apiKeyName,
      newPrefix: event.newPrefix,
      graceExpiresAt: event.graceExpiresAt,
      reason: event.reason,
    }, 'Processing managed API key rotation event');

    activeDeployments++;
    try {
      // Fetch the new key via bind
      const bindResponse = await bindManagedApiKey(event.apiKeyName);
      const newKey = bindResponse.key;

      log.info({
        keyName: event.apiKeyName,
        keyPrefix: newKey.substring(0, 8),
      }, 'Fetched new API key value');

      // Dispatch plugin event - CRITICAL: await with error handling
      // Previously this was fire-and-forget which could cause silent failures
      if (pluginLoader) {
        const keyEvent: KeyRotatedEvent = {
          keyName: event.apiKeyName,
          newPrefix: event.newPrefix,
          graceExpiresAt: event.graceExpiresAt,
          nextRotationAt: bindResponse.nextRotationAt,
          rotationMode: event.rotationMode,
        };
        try {
          await pluginLoader.dispatchEvent('keyRotated', keyEvent);
          log.debug({ keyName: event.apiKeyName }, 'Plugin keyRotated event dispatched successfully');
        } catch (pluginErr) {
          log.error({
            err: pluginErr,
            keyName: event.apiKeyName,
          }, 'Plugin failed to handle keyRotated event');
          // Continue processing - plugin failure should not block key rotation
        }
      }

      // Update env file if using output file mode
      if (execOutputFile) {
        // Find which env var(s) map to this API key
        const envVars = findEnvVarsForApiKey(execSecretMappings, event.apiKeyName);

        for (const envVar of envVars) {
          try {
            updateEnvFile(execOutputFile, envVar, newKey);
            log.info({
              keyName: event.apiKeyName,
              envVar,
              filePath: execOutputFile,
            }, 'Updated env file with rotated API key');
          } catch (err) {
            log.error({
              err,
              keyName: event.apiKeyName,
              envVar,
              filePath: execOutputFile,
            }, 'Failed to update env file with rotated API key');
          }
        }
      }

      // Restart child process if configured to restart on changes
      if (childManager && options.exec?.restartOnChange) {
        await childManager.restart(`managed API key '${event.apiKeyName}' rotated`);
      }
    } catch (err) {
      log.error({
        err,
        keyName: event.apiKeyName,
      }, 'Failed to process API key rotation event');
    } finally {
      activeDeployments--;
    }
  }

  unifiedClient.onApiKeyRotationEvent((event) => {
    handleApiKeyRotationEvent(event).catch((err: unknown) => {
      log.error({ err }, 'Error handling API key rotation event');
    });
  });

  // Handle host config update events (config-from-vault mode)
  async function handleHostConfigEvent(event: HostConfigEvent): Promise<void> {
    if (getIsShuttingDown()) {
      log.debug({ event: event.event }, 'Ignoring host config event during shutdown');
      return;
    }

    // Only process if in config-from-vault mode
    if (!options.configFromVault) {
      log.debug({ hostname: event.hostname }, 'Ignoring host config event (not in config-from-vault mode)');
      return;
    }

    log.info({
      hostname: event.hostname,
      version: event.version,
      force: event.force,
    }, 'Processing host config update event');

    try {
      // Fetch the latest config from vault
      const result = await fetchConfigFromVault({
        vaultUrl: config.vaultUrl,
        apiKey: config.auth.apiKey ?? '',
        insecure: config.insecure,
        agentId: config.agentId,
        hostConfigId: config.hostConfigId,
        configVersion: event.force ? undefined : config.configVersion,
      });

      if (!result.success) {
        log.error({ error: result.error }, 'Failed to fetch updated config from vault');
        return;
      }

      if (!result.modified) {
        log.debug({ version: result.version }, 'Config not modified, skipping reload');
        return;
      }

      if (result.config) {
        // Update in-memory config (preserving local auth)
        const updatedConfig = {
          ...result.config,
          auth: config.auth,
          agentId: config.agentId,
        };
        setConfigInMemory(updatedConfig);

        log.info({
          version: result.version,
          targets: updatedConfig.targets?.length ?? 0,
          secretTargets: updatedConfig.secretTargets?.length ?? 0,
        }, 'Config reloaded from vault');

        // TODO: In a future enhancement, we could:
        // - Restart plugins if plugin config changed
        // - Re-sync certificates if targets changed
        // - Re-sync secrets if secretTargets changed
        // For now, we just log that the config was updated.
        // A full restart may be required for changes to take effect.
      }
    } catch (err) {
      log.error({ err }, 'Failed to process host config update event');
    }
  }

  // Only register handler if in config-from-vault mode
  if (options.configFromVault) {
    unifiedClient.onHostConfigEvent((event) => {
      handleHostConfigEvent(event).catch((err: unknown) => {
        log.error({ err }, 'Error handling host config event');
      });
    });
    log.info('Config-from-vault mode: subscribed to host config updates');
  }

  unifiedClient.onConnect((agentId) => {
    log.info({ agentId }, 'Connected to vault');
    // Store agent ID for degraded mode handling
    setAgentId(agentId);
  });

  unifiedClient.onDisconnect((reason) => {
    log.warn({ reason }, 'Disconnected from vault');
  });

  unifiedClient.onError((err) => {
    log.error({ err }, 'WebSocket error');
  });

  // Start API key renewal service (managed or standard)
  if (isManagedKeyMode()) {
    log.info('Using managed API key mode');

    // Set up callback for when managed key changes
    onManagedKeyChanged((newKey) => {
      log.info({ newKeyPrefix: newKey.substring(0, 8) }, 'Managed key changed, reconnecting WebSocket');
      // Reconnect WebSocket with new key
      unifiedClient.disconnect();
      // Small delay to allow config to be saved
      setTimeout(() => {
        if (!getIsShuttingDown()) {
          unifiedClient.connect();
        }
      }, 500);
    });

    // Start managed key renewal service and AWAIT initial bind
    // This ensures the key is rotated BEFORE we connect WebSocket or start child process
    try {
      await startManagedKeyRenewal();
    } catch (err) {
      log.error({ err }, 'Failed to start managed key renewal service');
    }
  } else {
    // Use standard API key renewal
    const allowStaticKey = process.env.ALLOW_STATIC_KEY === 'true';
    if (!allowStaticKey) {
      log.warn(
        {},
        'SECURITY WARNING: Using static API key. Managed keys are recommended for production. ' +
          'To suppress this warning, set ALLOW_STATIC_KEY=true or migrate to a managed key.'
      );
    }
    startApiKeyRenewal();
  }

  // Connect unified WebSocket
  unifiedClient.connect();

  // Start plugins (after WebSocket is connecting but before initial sync)
  if (pluginLoader) {
    try {
      await pluginLoader.startPlugins();
      log.info({ plugins: pluginLoader.getAllPluginStatuses() }, 'Plugins started');
    } catch (err) {
      log.error({ err }, 'Failed to start plugins');
    }
  }

  // Initial sync - certificates
  if (config.targets.length > 0) {
    log.info('Performing initial certificate sync');
    const certResults = await deployAllCertificates(false);
    const certSuccess = certResults.filter(r => r.success).length;
    const certErrors = certResults.filter(r => !r.success).length;
    updateCertStatus(certSuccess, certErrors);
    log.info({ total: certResults.length, success: certSuccess, errors: certErrors }, 'Certificate sync complete');
  }

  // Initial sync - secrets
  if (secretTargets.length > 0) {
    log.info('Performing initial secret sync');
    const secretResults = await deployAllSecrets(false);
    const secretSuccess = secretResults.filter(r => r.success).length;
    const secretErrors = secretResults.filter(r => !r.success).length;
    updateSecretStatus(secretSuccess, secretErrors);
    log.info({ total: secretResults.length, success: secretSuccess, errors: secretErrors }, 'Secret sync complete');
  }

  // Start child process after initial sync (if exec mode)
  if (childManager) {
    log.info('Starting child process');
    try {
      await childManager.start();
    } catch (err) {
      log.error({ err }, 'Failed to start child process');
      // Continue running daemon even if child fails to start
    }
  }

  // Set up polling interval as fallback
  const pollInterval = (config.pollInterval ?? 3600) * 1000;

  const poll = async (): Promise<void> => {
    if (getIsShuttingDown()) return;

    log.debug('Starting periodic poll');

    // Poll certificates
    for (const target of config.targets) {
      if (getIsShuttingDown()) break;

      try {
        const result = await deployCertificate(target, false);
        if (result.fingerprint !== target.lastFingerprint) {
          log.info({ name: target.name, message: result.message }, 'Certificate updated during poll');
        }
      } catch (err) {
        log.error({ name: target.name, err }, 'Error polling certificate');
      }
    }

    // Poll secrets
    for (const target of secretTargets) {
      if (getIsShuttingDown()) break;

      try {
        const result = await deploySecret(target, false);
        if (result.version !== target.lastVersion) {
          log.info({ name: target.name, message: result.message }, 'Secret updated during poll');
        }
      } catch (err) {
        log.error({ name: target.name, err }, 'Error polling secret');
      }
    }
  };

  const pollTimer = setInterval(() => {
    poll().catch((e: unknown) => { log.error({ err: e }, 'Poll error'); });
  }, pollInterval);

  // Periodic managed key file sync check (every 60 seconds)
  // This catches cases where the file is overwritten/corrupted mid-run
  let keySyncTimer: NodeJS.Timeout | null = null;
  if (config.managedKey?.filePath) {
    const KEY_SYNC_INTERVAL = 60_000; // 60 seconds
    const managedKeyFilePath = config.managedKey.filePath;

    keySyncTimer = setInterval(() => {
      if (getIsShuttingDown()) return;

      const syncResult = syncManagedKeyFile();
      if (syncResult.wasOutOfSync) {
        if (syncResult.synced) {
          log.warn({
            filePath: managedKeyFilePath,
          }, 'Periodic check: Managed key file was out of sync - auto-fixed');
        } else {
          log.error({
            filePath: managedKeyFilePath,
            error: syncResult.error,
          }, 'Periodic check: CRITICAL - Managed key file sync failed');
        }
      }
      // Don't log on success - too noisy
    }, KEY_SYNC_INTERVAL);

    log.info({ intervalMs: KEY_SYNC_INTERVAL }, 'Periodic managed key file sync check enabled');
  }

  // Graceful shutdown handler
  const shutdown = async (signal: string): Promise<void> => {
    if (getIsShuttingDown()) {
      log.warn('Shutdown already in progress');
      return;
    }

    setShuttingDown(true);
    log.info({ signal }, 'Shutting down');

    // Clean up signal handlers to prevent memory leak
    cleanupSignalHandlers();

    // Stop accepting new events
    clearInterval(pollTimer);
    if (keySyncTimer) clearInterval(keySyncTimer);
    unifiedClient.disconnect();

    // Stop API key renewal service (managed or standard)
    if (isManagedKeyMode()) {
      stopManagedKeyRenewal();
    } else {
      stopApiKeyRenewal();
    }

    // Cleanup degraded mode handler
    cleanupDegradedModeHandler();

    // Cleanup dynamic secrets
    if (isDynamicSecretsEnabled()) {
      await cleanupDynamicSecrets();
      log.info('Dynamic secrets cleaned up');
    }

    // Stop plugins
    if (pluginLoader) {
      try {
        await pluginLoader.stopPlugins();
        clearPluginLoader();
        log.info('Plugins stopped');
      } catch (err) {
        log.warn({ err }, 'Error stopping plugins');
      }
    }

    // Stop child process first (it needs to exit before we can)
    if (childManager) {
      log.info('Stopping child process');
      try {
        await childManager.stop();
        log.info('Child process stopped');
      } catch (err) {
        log.error({ err }, 'Error stopping child process');
      }
    }

    // Wait for active deployments to complete (max 30 seconds)
    const startTime = Date.now();
    while (activeDeployments > 0 && Date.now() - startTime < 30000) {
      log.info({ active: activeDeployments }, 'Waiting for active deployments');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (activeDeployments > 0) {
      log.warn({ active: activeDeployments }, 'Forcing shutdown with active deployments');
    }

    // Stop health server
    await stopHealthServer();

    // Flush logs
    await flushLogs();

    log.info('Shutdown complete');
    process.exit(0);
  };

  // Handle shutdown signals (using tracked handlers to prevent memory leak)
  setupSignalHandlers(shutdown);

  log.info({ pollInterval: config.pollInterval ?? 3600 }, 'Agent running. Press Ctrl+C to stop.');
}
