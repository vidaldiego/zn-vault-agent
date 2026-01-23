// Path: src/lib/auth/bootstrap.ts
// Bootstrap token exchange for one-command agent deployment

import os from 'node:os';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentConfig } from '../config/types.js';
import { logger } from '../logger.js';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = join(__dirname, '..', '..', '..', 'package.json');
let VERSION = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
  VERSION = pkg.version ?? '0.0.0';
} catch {
  // Ignore error, use default version
}

/**
 * System info sent during registration
 */
interface SystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  agentVersion: string;
  cpus: number;
  memory: number;
}

/**
 * Registration response from vault
 */
export interface RegistrationResult {
  apiKey: string;
  agentId: string;
  managedKeyName: string | null;
  tenantId: string;
  hostConfigId: string;
  configVersion: number;
}

/**
 * Gather system information for registration
 */
function gatherSystemInfo(): SystemInfo {
  return {
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    agentVersion: VERSION,
    cpus: os.cpus().length,
    memory: os.totalmem(),
  };
}

/**
 * Exchange bootstrap token for API key via registration endpoint.
 *
 * This is called on first startup when the config contains a bootstrapToken
 * but no apiKey. The token is exchanged for an API key which is then
 * persisted to the config file.
 *
 * @param config - Agent config with bootstrapToken
 * @returns Registration result with API key and agent info
 * @throws Error if registration fails
 */
export async function exchangeBootstrapToken(
  config: AgentConfig
): Promise<RegistrationResult> {
  const { vaultUrl, hostname, auth, insecure } = config;

  if (!auth?.bootstrapToken) {
    throw new Error('No bootstrap token in config');
  }

  if (!hostname) {
    throw new Error('Hostname is required for bootstrap registration');
  }

  const systemInfo = gatherSystemInfo();

  logger.info(
    { hostname, vaultUrl },
    'Registering agent with vault server...'
  );

  const url = new URL(`/v1/hosts/${encodeURIComponent(hostname)}/register`, vaultUrl);

  const requestBody = JSON.stringify({
    hostname,
    systemInfo,
  });

  // Prepare request options
  const requestOptions: https.RequestOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody),
      'Authorization': `Bearer ${auth.bootstrapToken}`,
      'User-Agent': `zn-vault-agent/${VERSION}`,
    },
    // Handle self-signed certs in dev environments
    rejectUnauthorized: !insecure,
  };

  const response = await makeHttpsRequest(url, requestOptions, requestBody);

  if (response.statusCode !== 200) {
    let errorMessage = `Registration failed with status ${response.statusCode}`;
    try {
      const errorBody = JSON.parse(response.body) as { error?: string; message?: string };
      if (errorBody.error) {
        errorMessage = errorBody.error;
      } else if (errorBody.message) {
        errorMessage = errorBody.message;
      }
    } catch {
      // Use status-based message
    }
    throw new Error(errorMessage);
  }

  const result = JSON.parse(response.body) as RegistrationResult;

  logger.info(
    {
      agentId: result.agentId,
      tenantId: result.tenantId,
      hostConfigId: result.hostConfigId,
      managedKeyName: result.managedKeyName,
    },
    'Agent registration successful'
  );

  return result;
}

/**
 * Check if the config needs bootstrap registration
 */
export function needsBootstrapRegistration(config: AgentConfig): boolean {
  // Has bootstrap token but no API key
  return !!(config.auth?.bootstrapToken && !config.auth?.apiKey);
}

/**
 * Update config with registration result
 * Returns a new config object (does not mutate input)
 */
export function applyRegistrationResult(
  config: AgentConfig,
  result: RegistrationResult
): AgentConfig {
  return {
    ...config,
    tenantId: result.tenantId,
    auth: {
      // Copy any existing auth fields (except bootstrapToken)
      ...Object.fromEntries(
        Object.entries(config.auth ?? {}).filter(([key]) => key !== 'bootstrapToken')
      ),
      // Set the new API key
      apiKey: result.apiKey,
    },
    agentId: result.agentId,
    hostConfigId: result.hostConfigId,
    // NOTE: Don't set configVersion here. The version should only be set
    // AFTER the agent fetches and applies the actual config content.
    // Setting it here would cause the first fetch to return 304 (not modified)
    // even though the agent doesn't have the config yet.
    configVersion: undefined,
    managedKeyName: result.managedKeyName ?? undefined,
  };
}

/**
 * Simple HTTPS request helper (no external dependencies)
 */
function makeHttpsRequest(
  url: URL,
  options: https.RequestOptions,
  body?: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: res.statusCode ?? 500,
          body: responseBody,
        });
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (body) {
      req.write(body);
    }

    req.end();
  });
}
