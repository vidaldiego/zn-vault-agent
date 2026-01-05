// Path: test/setup.ts

/**
 * Test Environment Setup
 *
 * Configures the test environment and provides global utilities.
 */

import { beforeAll, afterAll } from 'vitest';
import { VaultTestClient, waitForVault } from './helpers/vault-client.js';
import { cleanupAllTests } from './helpers/agent-runner.js';

// Test environment configuration
// Environment variables are set by sdk-test-run.sh:
// - ZNVAULT_BASE_URL: Vault server URL
// - ZNVAULT_TENANT: Test tenant ID (sdk-test)
// - ZNVAULT_TENANT_ADMIN_USERNAME: Tenant admin username (sdk-test/sdk-admin)
// - ZNVAULT_TENANT_ADMIN_PASSWORD: Tenant admin password
// - ZNVAULT_API_KEY: Pre-created API key for testing
export const TEST_ENV = {
  vaultUrl: process.env.ZNVAULT_BASE_URL || 'https://localhost:9443',
  username: process.env.ZNVAULT_TENANT_ADMIN_USERNAME || 'sdk-test/sdk-admin',
  password: process.env.ZNVAULT_TENANT_ADMIN_PASSWORD || 'SdkTest123456#',
  tenantId: process.env.ZNVAULT_TENANT || 'sdk-test',
  insecure: process.env.ZNVAULT_INSECURE === 'true' || true,
};

// Global vault client for test setup
let globalVaultClient: VaultTestClient | null = null;

/**
 * Get the global vault client (creates one if needed)
 */
export async function getVaultClient(): Promise<VaultTestClient> {
  if (!globalVaultClient) {
    globalVaultClient = new VaultTestClient({
      url: TEST_ENV.vaultUrl,
      username: TEST_ENV.username,
      password: TEST_ENV.password,
      insecure: TEST_ENV.insecure,
    });
    await globalVaultClient.login();
  }
  return globalVaultClient;
}

/**
 * Global test setup
 */
beforeAll(async () => {
  // Wait for vault to be ready
  console.log(`Waiting for vault at ${TEST_ENV.vaultUrl}...`);
  try {
    await waitForVault(TEST_ENV.vaultUrl, 30, 1000);
    console.log('Vault is ready');
  } catch (error) {
    console.error('Vault not available. Make sure the test environment is running:');
    console.error('  npm run test:sdk:start  (from zn-vault root)');
    throw error;
  }
}, 60000);

/**
 * Global test teardown
 */
afterAll(() => {
  cleanupAllTests();
  globalVaultClient = null;
});
