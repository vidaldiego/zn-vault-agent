// Path: src/plugins/context.ts
// Plugin context implementation - provides safe access to agent internals

import { EventEmitter } from 'node:events';
import { createLogger } from '../lib/logger.js';
import { getSecret as apiGetSecret, decryptCertificate } from '../lib/api.js';
import type {
  PluginContext,
  SecretValue,
  CertificateContent,
} from './types.js';
import type { AgentInternals } from './loader.js';
import type { PluginLoader } from './loader.js';
import { getPluginStorage } from './storage.js';
import type { CertTarget, SecretTarget } from '../lib/config.js';

/**
 * Inter-plugin event emitter (singleton)
 */
const pluginEventEmitter = new EventEmitter();
pluginEventEmitter.setMaxListeners(50); // Support many plugins

/**
 * Create a plugin context for a specific plugin
 */
export function createPluginContext(
  pluginName: string,
  agentInternals: AgentInternals,
  _loader: PluginLoader
): PluginContext {
  const logger = createLogger({ module: `plugin:${pluginName}` });

  return {
    logger,

    // Read-only config snapshot
    get config() {
      return Object.freeze({ ...agentInternals.config });
    },

    get vaultUrl() {
      return agentInternals.config.vaultUrl;
    },

    get tenantId() {
      return agentInternals.config.tenantId;
    },

    /**
     * Fetch a secret from vault by alias or ID
     */
    async getSecret(aliasOrId: string): Promise<SecretValue> {
      logger.debug({ aliasOrId }, 'Plugin fetching secret');

      const decrypted = await apiGetSecret(aliasOrId);

      return {
        id: decrypted.id,
        alias: decrypted.alias,
        data: decrypted.data,
        version: decrypted.version,
        type: decrypted.type,
      };
    },

    /**
     * Get certificate content by ID or name
     */
    async getCertificate(certIdOrName: string): Promise<CertificateContent> {
      logger.debug({ certIdOrName }, 'Plugin fetching certificate');

      // Find cert ID from targets if name given
      let certId = certIdOrName;
      const target = agentInternals.config.targets.find(t => t.name === certIdOrName || t.certId === certIdOrName);
      if (target) {
        certId = target.certId;
      }

      // Decrypt certificate from vault
      const decrypted = await decryptCertificate(certId, 'plugin-access');

      // Parse PEM to extract components
      const certData = decrypted.certificateData;
      const parts = parsePemBundle(certData);

      return {
        id: decrypted.id,
        name: target?.name ?? certId,
        certificate: parts.certificate,
        privateKey: parts.privateKey,
        chain: parts.chain,
        fullchain: parts.fullchain,
        fingerprint: decrypted.fingerprintSha256,
        expiresAt: '', // Would need to parse from cert
        commonName: '', // Would need to parse from cert
      };
    },

    /**
     * Get configured certificate targets
     */
    getCertTargets(): CertTarget[] {
      return agentInternals.config.targets;
    },

    /**
     * Get configured secret targets
     */
    getSecretTargets(): SecretTarget[] {
      return agentInternals.config.secretTargets ?? [];
    },

    /**
     * Request child process restart
     */
    async restartChild(reason: string): Promise<void> {
      if (agentInternals.restartChild) {
        logger.info({ reason }, 'Plugin requesting child restart');
        await agentInternals.restartChild(reason);
      } else {
        logger.debug('restartChild called but no exec mode configured');
      }
    },

    /**
     * Get current child process state
     */
    getChildState() {
      if (agentInternals.childProcessManager) {
        return agentInternals.childProcessManager.getState();
      }
      return null;
    },

    /**
     * Emit custom event to other plugins
     */
    emit(event: string, data: unknown): void {
      const eventName = `plugin:${event}`;
      logger.debug({ event: eventName }, 'Plugin emitting event');
      pluginEventEmitter.emit(eventName, data);
    },

    /**
     * Listen for custom events from other plugins
     */
    on(event: string, handler: (data: unknown) => void): void {
      const eventName = `plugin:${event}`;
      pluginEventEmitter.on(eventName, handler);
    },

    /**
     * Remove event listener
     */
    off(event: string, handler: (data: unknown) => void): void {
      const eventName = `plugin:${event}`;
      pluginEventEmitter.off(eventName, handler);
    },

    /**
     * Plugin-specific persistent storage
     */
    storage: getPluginStorage(pluginName),
  };
}

/**
 * Parse a PEM bundle into components
 */
function parsePemBundle(pemData: string): {
  certificate: string;
  privateKey: string;
  chain?: string;
  fullchain?: string;
} {
  const blocks: string[] = [];
  const regex = /-----BEGIN ([^-]+)-----[\s\S]*?-----END \1-----/g;
  let match;

  while ((match = regex.exec(pemData)) !== null) {
    blocks.push(match[0]);
  }

  let certificate = '';
  let privateKey = '';
  const chainCerts: string[] = [];

  for (const block of blocks) {
    if (block.includes('CERTIFICATE')) {
      if (!certificate) {
        certificate = block;
      } else {
        chainCerts.push(block);
      }
    } else if (block.includes('PRIVATE KEY')) {
      privateKey = block;
    }
  }

  const chain = chainCerts.length > 0 ? chainCerts.join('\n') : undefined;
  const fullchain = chain ? `${certificate}\n${chain}` : certificate;

  return { certificate, privateKey, chain, fullchain };
}

/**
 * Get the inter-plugin event emitter (for testing)
 */
export function getPluginEventEmitter(): EventEmitter {
  return pluginEventEmitter;
}

/**
 * Clear all plugin event listeners (for testing)
 */
export function clearPluginEventListeners(): void {
  pluginEventEmitter.removeAllListeners();
}
