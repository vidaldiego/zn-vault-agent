// Path: test/fixtures/key-file-plugin.mjs

/**
 * Minimal test plugin that mirrors the znvault-plugin-payara API-key-file
 * semantics: it projects the agent's own managed API key
 * (ctx.config.auth.apiKey) into a file, exactly like the payara plugin's
 * `apiKeyFilePath` + `secrets: { X: "api-key:<name>" }` mode.
 *
 * Used by integration tests and repro scripts for the managed-key rotation
 * propagation bug (2026-07-05 incident): the file must be rewritten whenever
 * the agent learns of a rotated key — via WebSocket event OR via the renewal
 * service's polling rails — without restarting the agent.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {{
 *   filePath: string,
 *   rotationLogPath?: string,
 *   secrets?: Record<string, string>,
 * }} config - `secrets` may contain `api-key:<name>` entries; the plugin does
 *   not resolve them itself, but the agent extracts them to track those keys
 *   for rotation events (mirrors the payara plugin's config shape).
 *   `rotationLogPath` appends one `<keyName>` line per keyRotated
 *   event received — used by tests to observe dispatches for non-own keys.
 */
export default function createKeyFilePlugin(config) {
  if (!config || typeof config.filePath !== 'string' || config.filePath.length === 0) {
    throw new Error('key-file-plugin requires config.filePath');
  }

  /** Write the agent's current API key to the configured file (atomic). */
  function writeKeyFile(ctx, reason) {
    const apiKey = ctx.config.auth?.apiKey;
    if (!apiKey) {
      throw new Error('key-file-plugin: no API key available in agent config');
    }
    const dir = path.dirname(config.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${config.filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tempPath, apiKey, { mode: 0o600 });
    fs.renameSync(tempPath, config.filePath);
    ctx.logger.info(
      { filePath: config.filePath, reason },
      'key-file-plugin: API key written to file'
    );
  }

  return {
    name: 'key-file-plugin',
    version: '1.0.0',

    async onInit(ctx) {
      writeKeyFile(ctx, 'init');
    },

    async onStart(ctx) {
      writeKeyFile(ctx, 'start');
    },

    async onKeyRotated(event, ctx) {
      ctx.logger.info(
        { keyName: event.keyName },
        'key-file-plugin: keyRotated event received'
      );
      if (config.rotationLogPath) {
        fs.mkdirSync(path.dirname(config.rotationLogPath), { recursive: true });
        fs.appendFileSync(config.rotationLogPath, `${event.keyName}\n`);
      }
      writeKeyFile(ctx, 'keyRotated');
    },
  };
}
