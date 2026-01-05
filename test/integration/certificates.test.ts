// Path: test/integration/certificates.test.ts

/**
 * Certificate Management Integration Tests
 *
 * Tests for certificate listing, adding, syncing, and removal.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { AgentRunner, createTempOutputDir } from '../helpers/agent-runner.js';
import { VaultTestClient, generateTestCertificate } from '../helpers/vault-client.js';
import { TEST_ENV, getVaultClient } from '../setup.js';

describe('Certificate Management', () => {
  let agent: AgentRunner;
  let vault: VaultTestClient;
  let testApiKey: { id: string; key: string } | null = null;
  let testCert: { id: string; name: string } | null = null;
  let outputDir: string;

  beforeAll(async () => {
    vault = await getVaultClient();

    // Create test API key
    testApiKey = await vault.createApiKey({
      name: 'cert-test-key',
      expiresInDays: 1,
      permissions: [
        'certificate:read:metadata',
        'certificate:read:value',
      ],
      tenantId: TEST_ENV.tenantId,
    });

    // Create test certificate using new API format
    const { certPem, keyPem } = generateTestCertificate();
    const combinedPem = certPem + '\n' + keyPem;
    testCert = await vault.createCertificate({
      clientId: TEST_ENV.tenantId,
      alias: 'test-certificate',
      certificateData: Buffer.from(combinedPem).toString('base64'),
      certificateType: 'PEM',
    });
  });

  afterAll(async () => {
    // Clean up test resources
    if (testCert) {
      try {
        await vault.deleteCertificate(testCert.id);
      } catch { /* ignore */ }
    }
    if (testApiKey) {
      try {
        await vault.deleteApiKey(testApiKey.id);
      } catch { /* ignore */ }
    }
  });

  beforeEach(async () => {
    const testId = `cert-${Date.now()}`;
    agent = new AgentRunner(testId);
    agent.setup();
    outputDir = createTempOutputDir(testId);

    // Login before each test
    await agent.login({
      url: TEST_ENV.vaultUrl,
      tenantId: TEST_ENV.tenantId,
      apiKey: testApiKey!.key,
      insecure: TEST_ENV.insecure,
    });
  });

  afterEach(() => {
    agent?.cleanup();
  });

  describe('Listing Certificates', () => {
    it('CERT-01: should list available certificates from vault', async () => {
      const result = await agent.availableCertificates();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('test-certificate');
    });

    it('CERT-07: should list configured certificate targets', async () => {
      // First add a target
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'my-cert',
        output: resolve(outputDir, 'cert.pem'),
      });

      const result = await agent.listCertificates();

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('my-cert');
    });
  });

  describe('Adding Certificate Targets', () => {
    it('CERT-02: should add certificate target with combined format', async () => {
      const outputPath = resolve(outputDir, 'combined.pem');

      const result = await agent.addCertificate({
        certId: testCert!.id,
        name: 'combined-cert',
        output: outputPath,
        format: 'combined',
      });

      expect(result.exitCode).toBe(0);

      // Verify config was updated
      const config = agent.readConfig();
      expect(config?.targets).toHaveLength(1);
      expect(config?.targets?.[0]).toMatchObject({
        certId: testCert!.id,
        name: 'combined-cert',
      });
    });

    it('CERT-03: should add certificate target with separate files', async () => {
      const certPath = resolve(outputDir, 'cert-only.pem');

      const result = await agent.addCertificate({
        certId: testCert!.id,
        name: 'cert-only',
        output: certPath,
        format: 'cert',
      });

      expect(result.exitCode).toBe(0);

      const config = agent.readConfig();
      expect(config?.targets).toContainEqual(
        expect.objectContaining({
          name: 'cert-only',
        })
      );
    });

    it('should add certificate with mode and owner options', async () => {
      const outputPath = resolve(outputDir, 'with-perms.pem');

      const result = await agent.addCertificate({
        certId: testCert!.id,
        name: 'with-perms',
        output: outputPath,
        mode: '0640',
        // Note: owner requires running as root, skipped in tests
      });

      expect(result.exitCode).toBe(0);

      const config = agent.readConfig();
      const target = config?.targets?.find((t: any) => t.name === 'with-perms');
      expect(target?.mode).toBe('0640');
    });
  });

  describe('Syncing Certificates', () => {
    it('CERT-04: should sync certificate to file system', async () => {
      const outputPath = resolve(outputDir, 'synced.pem');

      // Add target
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'sync-test',
        output: outputPath,
        format: 'combined',
      });

      // Sync
      const result = await agent.sync();

      expect(result.exitCode).toBe(0);
      expect(existsSync(outputPath)).toBe(true);

      // Verify content is valid PEM
      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('-----BEGIN CERTIFICATE-----');
      expect(content).toContain('-----BEGIN PRIVATE KEY-----');
    });

    it('CERT-05: should set correct file permissions', async () => {
      const outputPath = resolve(outputDir, 'perms-test.pem');

      await agent.addCertificate({
        certId: testCert!.id,
        name: 'perms-test',
        output: outputPath,
        mode: '0600',
      });

      await agent.sync();

      expect(existsSync(outputPath)).toBe(true);

      const stats = statSync(outputPath);
      // Check permissions (last 3 octal digits)
      const mode = (stats.mode & 0o777).toString(8);
      expect(mode).toBe('600');
    });

    it('CERT-08: should detect fingerprint changes and re-sync', async () => {
      const outputPath = resolve(outputDir, 'fingerprint-test.pem');

      await agent.addCertificate({
        certId: testCert!.id,
        name: 'fingerprint-test',
        output: outputPath,
      });

      // First sync
      const result1 = await agent.sync();
      expect(result1.exitCode).toBe(0);

      // Second sync (should detect no changes)
      const result2 = await agent.sync();
      expect(result2.exitCode).toBe(0);
      // Output should indicate no changes needed
      expect(result2.stdout.toLowerCase()).toMatch(/no changes|up to date|already synced/);
    });

    it('should support dry-run mode', async () => {
      const outputPath = resolve(outputDir, 'dryrun.pem');

      await agent.addCertificate({
        certId: testCert!.id,
        name: 'dryrun-test',
        output: outputPath,
      });

      const result = await agent.sync({ dryRun: true });

      expect(result.exitCode).toBe(0);
      // File should NOT be created in dry-run
      expect(existsSync(outputPath)).toBe(false);
    });

    it('should sync specific target by name', async () => {
      const output1 = resolve(outputDir, 'target1.pem');
      const output2 = resolve(outputDir, 'target2.pem');

      await agent.addCertificate({
        certId: testCert!.id,
        name: 'target1',
        output: output1,
      });

      await agent.addCertificate({
        certId: testCert!.id,
        name: 'target2',
        output: output2,
      });

      // Sync only target1
      const result = await agent.sync({ name: 'target1' });

      expect(result.exitCode).toBe(0);
      expect(existsSync(output1)).toBe(true);
      expect(existsSync(output2)).toBe(false);
    });
  });

  describe('Removing Certificate Targets', () => {
    it('CERT-07: should remove certificate target', async () => {
      const outputPath = resolve(outputDir, 'to-remove.pem');

      // Add target
      await agent.addCertificate({
        certId: testCert!.id,
        name: 'to-remove',
        output: outputPath,
      });

      // Verify it was added
      let config = agent.readConfig();
      expect(config?.targets?.find((t: any) => t.name === 'to-remove')).toBeDefined();

      // Remove
      const result = await agent.removeCertificate('to-remove');

      expect(result.exitCode).toBe(0);

      // Verify it was removed
      config = agent.readConfig();
      expect(config?.targets?.find((t: any) => t.name === 'to-remove')).toBeUndefined();
    });

    it('should fail to remove non-existent target', async () => {
      const result = await agent.removeCertificate('does-not-exist');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain('not found');
    });
  });

  describe('Error Handling', () => {
    it('should fail with invalid certificate ID', async () => {
      const outputPath = resolve(outputDir, 'invalid.pem');

      await agent.addCertificate({
        certId: 'invalid-uuid',
        name: 'invalid-test',
        output: outputPath,
      });

      const result = await agent.sync();

      // Should complete but report error
      expect(result.stderr.toLowerCase()).toMatch(/not found|invalid|error/);
    });

    it('should fail if output directory does not exist and cannot be created', async () => {
      const result = await agent.addCertificate({
        certId: testCert!.id,
        name: 'bad-path',
        output: '/root/cannot/create/this.pem',
      });

      // Should either fail during add or during sync
      if (result.exitCode === 0) {
        const syncResult = await agent.sync();
        expect(syncResult.exitCode).not.toBe(0);
      }
    });
  });
});
