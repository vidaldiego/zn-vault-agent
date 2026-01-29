// Path: src/services/tls-certificate-manager.test.ts

/**
 * TLS Certificate Manager Unit Tests
 *
 * Tests the TLS certificate lifecycle: auto-fetch, renewal, and hot-reload.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Mock the dependencies before importing the module
vi.mock('../lib/config.js', () => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('../lib/api.js', () => ({
  requestAgentTLSCertificate: vi.fn(),
  renewAgentTLSCertificate: vi.fn(),
  getAgentTLSCertificate: vi.fn(),
  activateAgentTLSCertificate: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../lib/metrics.js', () => ({
  registerCounter: vi.fn(),
  registerGauge: vi.fn(),
  incCounter: vi.fn(),
  setGauge: vi.fn(),
}));

// Import mocked modules
import { loadConfig, saveConfig } from '../lib/config.js';
import {
  requestAgentTLSCertificate,
  renewAgentTLSCertificate,
  getAgentTLSCertificate,
  activateAgentTLSCertificate,
} from '../lib/api.js';
import type { AgentTLSCertificateResponse } from '../lib/api.js';

// Import the module under test after mocks
import {
  isTLSEnabled,
  getTLSConfig,
  ensureCertificateReady,
  startTLSCertificateManager,
  stopTLSCertificateManager,
  forceRenewal,
  getTLSManagerStatus,
  onCertificateUpdated,
} from './tls-certificate-manager.js';

// =============================================================================
// Test Fixtures
// =============================================================================

const MOCK_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIBkTCB+wIJAKHBfpj0VtIbMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBnRl
c3RDQTAeFw0yNDAxMDEwMDAwMDBaFw0yNTAxMDEwMDAwMDBaMBExDzANBgNVBAMM
BmFnZW50MTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABJm/jQYv8FHlMn4rKxYK
qVr+L5dF1FfVdZnGsqPqANIVr3LbGq6RjXkWLbBz0N9CFm0k7G+q9LKBQ5wnJMHz
w9OjUDBOMB0GA1UdDgQWBBRLqJqXXXXXXXXXXXXXXXXXXXXXXTAfBgNVHSMEGDAW
gBRLqJqXXXXXXXXXXXXXXXXXXXXXXTAMBgNVHRMEBTADAQH/MA0GCSqGSIb3DQEB
CwUAA0EAZl9X1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP
-----END CERTIFICATE-----
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MqSOyrKJGDxfkWqh
0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MqSOyrKJGDxfkWqhxxxxxxxxxxxxxxxx
0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MqSOyrKJGDxfkWqhyyyyyyyyyyyyyyyy
-----END RSA PRIVATE KEY-----`;

const MOCK_CERT_RESPONSE: AgentTLSCertificateResponse = {
  agentTlsCertId: 'tls-cert-001',
  certificate: MOCK_CERTIFICATE_PEM,
  hostname: 'agent-1.example.com',
  expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days
};

const MOCK_ACTIVATION_RESPONSE = {
  activated: true,
  activatedAt: new Date().toISOString(),
};

// =============================================================================
// Test Suite
// =============================================================================

describe('TLS Certificate Manager', () => {
  let tempDir: string;
  let certPath: string;
  let keyPath: string;

  // Create temp directory for test certificates
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();

    // Create temp directory for cert files
    tempDir = mkdtempSync(join(tmpdir(), 'tls-cert-test-'));
    certPath = join(tempDir, 'agent.crt');
    keyPath = join(tempDir, 'agent.key');

    // Reset service state
    stopTLSCertificateManager();
  });

  afterEach(() => {
    stopTLSCertificateManager();
    vi.useRealTimers();

    // Cleanup temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ===========================================================================
  // isTLSEnabled Tests
  // ===========================================================================

  describe('isTLSEnabled', () => {
    it('should return false when TLS is not configured', () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'key' },
        targets: [],
      } as ReturnType<typeof loadConfig>);

      expect(isTLSEnabled()).toBe(false);
    });

    it('should return false when TLS is explicitly disabled', () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'key' },
        targets: [],
        tls: { enabled: false },
      } as ReturnType<typeof loadConfig>);

      expect(isTLSEnabled()).toBe(false);
    });

    it('should return true when TLS is enabled', () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'key' },
        targets: [],
        tls: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      expect(isTLSEnabled()).toBe(true);
    });
  });

  // ===========================================================================
  // getTLSConfig Tests
  // ===========================================================================

  describe('getTLSConfig', () => {
    it('should return default paths based on agent ID', () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'key' },
        targets: [],
        agentId: 'agent-123',
        tls: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const config = getTLSConfig();

      expect(config.certPath).toBe('/var/lib/zn-vault-agent/tls/agent-123.crt');
      expect(config.keyPath).toBe('/var/lib/zn-vault-agent/tls/agent-123.key');
      expect(config.httpsPort).toBe(9443);
      expect(config.keepHttpServer).toBe(true);
      expect(config.renewBeforeDays).toBe(7);
    });

    it('should use custom paths when provided', () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'key' },
        targets: [],
        agentId: 'agent-123',
        tls: {
          enabled: true,
          certPath: '/custom/path/cert.pem',
          keyPath: '/custom/path/key.pem',
          httpsPort: 8443,
          keepHttpServer: false,
          renewBeforeDays: 14,
        },
      } as ReturnType<typeof loadConfig>);

      const config = getTLSConfig();

      expect(config.certPath).toBe('/custom/path/cert.pem');
      expect(config.keyPath).toBe('/custom/path/key.pem');
      expect(config.httpsPort).toBe(8443);
      expect(config.keepHttpServer).toBe(false);
      expect(config.renewBeforeDays).toBe(14);
    });

    it('should use "unknown" for agent ID when not set', () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'key' },
        targets: [],
        tls: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const config = getTLSConfig();

      expect(config.certPath).toBe('/var/lib/zn-vault-agent/tls/unknown.crt');
      expect(config.keyPath).toBe('/var/lib/zn-vault-agent/tls/unknown.key');
    });
  });

  // ===========================================================================
  // ensureCertificateReady Tests
  // ===========================================================================

  describe('ensureCertificateReady', () => {
    it('should return null when TLS is not enabled', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'key' },
        targets: [],
        tls: { enabled: false },
      } as ReturnType<typeof loadConfig>);

      const result = await ensureCertificateReady();

      expect(result).toBeNull();
      expect(requestAgentTLSCertificate).not.toHaveBeenCalled();
    });

    it('should return null when no agent ID and no API key', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: {},
        targets: [],
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      const result = await ensureCertificateReady();

      expect(result).toBeNull();
      expect(requestAgentTLSCertificate).not.toHaveBeenCalled();
    });

    it('should use existing certificates when no credentials but files exist', async () => {
      // Create existing cert files
      writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----');
      writeFileSync(keyPath, '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----');

      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: {},
        targets: [],
        tls: { enabled: true, certPath, keyPath, httpsPort: 9443, keepHttpServer: true },
      } as ReturnType<typeof loadConfig>);

      const result = await ensureCertificateReady();

      expect(result).not.toBeNull();
      expect(result?.certPath).toBe(certPath);
      expect(result?.keyPath).toBe(keyPath);
      expect(result?.httpsPort).toBe(9443);
      expect(result?.keepHttpServer).toBe(true);
      expect(requestAgentTLSCertificate).not.toHaveBeenCalled();
    });

    it('should fetch certificate from vault when agent has API key', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath, httpsPort: 9443, keepHttpServer: true },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(requestAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      const result = await ensureCertificateReady();

      expect(requestAgentTLSCertificate).toHaveBeenCalledWith('agent-001', {
        hostname: undefined,
      });
      expect(activateAgentTLSCertificate).toHaveBeenCalledWith('agent-001', 'tls-cert-001');
      expect(saveConfig).toHaveBeenCalled();

      expect(result).not.toBeNull();
      expect(result?.certPath).toBe(certPath);
      expect(result?.keyPath).toBe(keyPath);
    });

    it('should pass hostname when configured', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        hostname: 'my-server.example.com',
        tls: { enabled: true, certPath, keyPath, httpsPort: 9443, keepHttpServer: true },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(requestAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      await ensureCertificateReady();

      expect(requestAgentTLSCertificate).toHaveBeenCalledWith('agent-001', {
        hostname: 'my-server.example.com',
      });
    });

    it('should wait for certificate to be ready with timeout', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath, httpsPort: 9443, keepHttpServer: true },
      } as ReturnType<typeof loadConfig>);

      // Simulate certificate request failure
      vi.mocked(requestAgentTLSCertificate).mockRejectedValue(new Error('Network error'));

      // Use real timers for this test since we need actual waiting behavior
      vi.useRealTimers();

      const startTime = Date.now();
      const result = await ensureCertificateReady();
      const elapsed = Date.now() - startTime;

      // Should timeout after ~30 seconds (give some buffer)
      expect(result).toBeNull();
      expect(elapsed).toBeGreaterThanOrEqual(29000);
      expect(elapsed).toBeLessThan(35000);
    }, 40000); // Increase test timeout

    it('should return immediately when certificate files already exist', async () => {
      // Pre-create certificate files
      writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----');
      writeFileSync(keyPath, '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----');

      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: {
          enabled: true,
          certPath,
          keyPath,
          httpsPort: 9443,
          keepHttpServer: true,
          certExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
      } as ReturnType<typeof loadConfig>);

      const result = await ensureCertificateReady();

      expect(result).not.toBeNull();
      // Should not fetch new cert since files exist and aren't expired
      // (though it will check with vault for expiry info)
    });

    it('should invoke certificate update callback after fetching', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath, httpsPort: 9443, keepHttpServer: true },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(requestAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      const callback = vi.fn();
      onCertificateUpdated(callback);

      await ensureCertificateReady();

      expect(callback).toHaveBeenCalledWith(certPath, keyPath);
    });
  });

  // ===========================================================================
  // startTLSCertificateManager Tests
  // ===========================================================================

  describe('startTLSCertificateManager', () => {
    it('should not start when TLS is disabled', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'key' },
        targets: [],
        tls: { enabled: false },
      } as ReturnType<typeof loadConfig>);

      await startTLSCertificateManager();

      const status = getTLSManagerStatus();
      expect(status.isRunning).toBe(false);
      expect(requestAgentTLSCertificate).not.toHaveBeenCalled();
    });

    it('should start and fetch certificate when no cert exists', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(requestAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      await startTLSCertificateManager();

      const status = getTLSManagerStatus();
      expect(status.isRunning).toBe(true);
      expect(requestAgentTLSCertificate).toHaveBeenCalledWith('agent-001', { hostname: undefined });
    });

    it('should not start twice', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(requestAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      await startTLSCertificateManager();
      await startTLSCertificateManager();

      // Should only request once
      expect(requestAgentTLSCertificate).toHaveBeenCalledTimes(1);
    });

    it('should load expiry from config on start', async () => {
      const certExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      // Pre-create certificate files
      writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----');
      writeFileSync(keyPath, '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----');

      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: {
          enabled: true,
          certPath,
          keyPath,
          certExpiresAt: certExpiry,
          agentTlsCertId: 'tls-cert-123',
        },
      } as ReturnType<typeof loadConfig>);

      await startTLSCertificateManager();

      const status = getTLSManagerStatus();
      expect(status.certExpiresAt).toBe(certExpiry);
      expect(status.agentTlsCertId).toBe('tls-cert-123');
    });
  });

  // ===========================================================================
  // stopTLSCertificateManager Tests
  // ===========================================================================

  describe('stopTLSCertificateManager', () => {
    it('should stop the manager and reset state', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(requestAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      await startTLSCertificateManager();
      expect(getTLSManagerStatus().isRunning).toBe(true);

      stopTLSCertificateManager();

      const status = getTLSManagerStatus();
      expect(status.isRunning).toBe(false);
      expect(status.certExpiresAt).toBeNull();
      expect(status.lastCheckAt).toBeNull();
    });

    it('should clear certificate update callback', async () => {
      const callback = vi.fn();
      onCertificateUpdated(callback);

      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(requestAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      await startTLSCertificateManager();
      stopTLSCertificateManager();

      // Start again and verify callback is not called
      vi.mocked(requestAgentTLSCertificate).mockClear();
      await startTLSCertificateManager();

      // Callback should not be invoked since it was cleared
      expect(callback).toHaveBeenCalledTimes(1); // Only from first start
    });
  });

  // ===========================================================================
  // forceRenewal Tests
  // ===========================================================================

  describe('forceRenewal', () => {
    it('should return null when TLS is disabled', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'key' },
        targets: [],
        tls: { enabled: false },
      } as ReturnType<typeof loadConfig>);

      const result = await forceRenewal();

      expect(result).toBeNull();
      expect(renewAgentTLSCertificate).not.toHaveBeenCalled();
    });

    it('should renew certificate when TLS is enabled', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(renewAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      const result = await forceRenewal();

      expect(renewAgentTLSCertificate).toHaveBeenCalledWith('agent-001');
      expect(activateAgentTLSCertificate).toHaveBeenCalledWith('agent-001', 'tls-cert-001');
      expect(result).not.toBeNull();
      expect(result?.agentTlsCertId).toBe('tls-cert-001');
    });

    it('should handle renewal failure gracefully', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(renewAgentTLSCertificate).mockRejectedValue(new Error('Network error'));

      const result = await forceRenewal();

      expect(result).toBeNull();
    });
  });

  // ===========================================================================
  // getTLSManagerStatus Tests
  // ===========================================================================

  describe('getTLSManagerStatus', () => {
    it('should return initial status when not started', () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true },
      } as ReturnType<typeof loadConfig>);

      const status = getTLSManagerStatus();

      expect(status.isRunning).toBe(false);
      expect(status.tlsEnabled).toBe(true);
      expect(status.certExpiresAt).toBeNull();
      expect(status.daysUntilExpiry).toBeNull();
      expect(status.lastCheckAt).toBeNull();
      expect(status.lastRenewalAt).toBeNull();
      expect(status.agentTlsCertId).toBeNull();
    });

    it('should return running status after start', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(requestAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      await startTLSCertificateManager();

      const status = getTLSManagerStatus();

      expect(status.isRunning).toBe(true);
      expect(status.certExpiresAt).not.toBeNull();
      expect(status.daysUntilExpiry).toBeGreaterThan(85); // ~90 days
      expect(status.lastCheckAt).not.toBeNull();
      expect(status.lastRenewalAt).not.toBeNull();
      expect(status.agentTlsCertId).toBe('tls-cert-001');
    });

    it('should include cert paths in status', () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath: '/custom/cert.pem', keyPath: '/custom/key.pem' },
      } as ReturnType<typeof loadConfig>);

      const status = getTLSManagerStatus();

      expect(status.certPath).toBe('/custom/cert.pem');
      expect(status.keyPath).toBe('/custom/key.pem');
    });
  });

  // ===========================================================================
  // onCertificateUpdated Callback Tests
  // ===========================================================================

  describe('onCertificateUpdated', () => {
    it('should invoke callback when certificate is fetched', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(requestAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      const callback = vi.fn();
      onCertificateUpdated(callback);

      await startTLSCertificateManager();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(certPath, keyPath);
    });

    it('should invoke callback when certificate is renewed', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(renewAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      const callback = vi.fn();
      onCertificateUpdated(callback);

      await forceRenewal();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(certPath, keyPath);
    });

    it('should allow replacing the callback', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(renewAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      onCertificateUpdated(callback1);
      onCertificateUpdated(callback2); // Replace

      await forceRenewal();

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Certificate Auto-Renewal Tests
  // ===========================================================================

  describe('Certificate Auto-Renewal', () => {
    it('should not request new cert when existing cert is valid', async () => {
      const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

      // Pre-create certificate files
      writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----');
      writeFileSync(keyPath, '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----');

      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: {
          enabled: true,
          certPath,
          keyPath,
          certExpiresAt: futureExpiry,
          renewBeforeDays: 7,
        },
      } as ReturnType<typeof loadConfig>);

      await startTLSCertificateManager();

      // Should not request or renew since cert is valid for 30 days (> 7 days threshold)
      expect(requestAgentTLSCertificate).not.toHaveBeenCalled();
      expect(renewAgentTLSCertificate).not.toHaveBeenCalled();
    });

    it('should renew cert when approaching expiry', async () => {
      const nearExpiry = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days

      // Pre-create certificate files
      writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----');
      writeFileSync(keyPath, '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----');

      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: {
          enabled: true,
          certPath,
          keyPath,
          certExpiresAt: nearExpiry,
          renewBeforeDays: 7, // Renew when < 7 days until expiry
        },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(renewAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      await startTLSCertificateManager();

      // Should renew since cert expires in 3 days (< 7 days threshold)
      expect(renewAgentTLSCertificate).toHaveBeenCalledWith('agent-001');
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('Error Handling', () => {
    it('should handle certificate request failure gracefully', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(requestAgentTLSCertificate).mockRejectedValue(new Error('Vault unreachable'));

      await startTLSCertificateManager();

      // Should still be running despite failure
      const status = getTLSManagerStatus();
      expect(status.isRunning).toBe(true);
      expect(status.certExpiresAt).toBeNull(); // No cert obtained
    });

    it('should handle activation failure gracefully', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(requestAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockRejectedValue(new Error('Activation failed'));

      // Should not throw, just log error
      await expect(startTLSCertificateManager()).resolves.not.toThrow();
    });

    it('should return null for renewal when agent ID is not set', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        // No agentId
        tls: { enabled: true, certPath, keyPath },
      } as ReturnType<typeof loadConfig>);

      const result = await forceRenewal();

      expect(result).toBeNull();
      expect(renewAgentTLSCertificate).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Integration Tests
  // ===========================================================================

  describe('Integration', () => {
    it('should complete full certificate lifecycle: request -> use -> renew', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        hostname: 'my-server.local',
        tls: { enabled: true, certPath, keyPath, httpsPort: 9443, keepHttpServer: false },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(requestAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(renewAgentTLSCertificate).mockResolvedValue({
        ...MOCK_CERT_RESPONSE,
        agentTlsCertId: 'tls-cert-002', // New cert ID after renewal
      });
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      const updateCallback = vi.fn();
      onCertificateUpdated(updateCallback);

      // 1. Start manager - should request initial cert
      await startTLSCertificateManager();

      expect(requestAgentTLSCertificate).toHaveBeenCalledWith('agent-001', {
        hostname: 'my-server.local',
      });
      expect(updateCallback).toHaveBeenCalledTimes(1);

      const status1 = getTLSManagerStatus();
      expect(status1.isRunning).toBe(true);
      expect(status1.agentTlsCertId).toBe('tls-cert-001');

      // 2. Force renewal
      await forceRenewal();

      expect(renewAgentTLSCertificate).toHaveBeenCalledWith('agent-001');
      expect(updateCallback).toHaveBeenCalledTimes(2); // Called again after renewal

      const status2 = getTLSManagerStatus();
      expect(status2.agentTlsCertId).toBe('tls-cert-002');

      // 3. Stop manager
      stopTLSCertificateManager();

      const status3 = getTLSManagerStatus();
      expect(status3.isRunning).toBe(false);
    });

    it('should work with ensureCertificateReady for daemon startup', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        vaultUrl: 'https://vault.example.com',
        tenantId: 'test',
        auth: { apiKey: 'znv_test_key' },
        targets: [],
        agentId: 'agent-001',
        tls: { enabled: true, certPath, keyPath, httpsPort: 8443, keepHttpServer: true },
      } as ReturnType<typeof loadConfig>);

      vi.mocked(requestAgentTLSCertificate).mockResolvedValue(MOCK_CERT_RESPONSE);
      vi.mocked(activateAgentTLSCertificate).mockResolvedValue(MOCK_ACTIVATION_RESPONSE);

      // Simulate daemon startup
      const tlsReady = await ensureCertificateReady();

      expect(tlsReady).not.toBeNull();
      expect(tlsReady?.certPath).toBe(certPath);
      expect(tlsReady?.keyPath).toBe(keyPath);
      expect(tlsReady?.httpsPort).toBe(8443);
      expect(tlsReady?.keepHttpServer).toBe(true);

      // TLS manager should be running
      const status = getTLSManagerStatus();
      expect(status.isRunning).toBe(true);

      // Cleanup
      stopTLSCertificateManager();
    });
  });
});
