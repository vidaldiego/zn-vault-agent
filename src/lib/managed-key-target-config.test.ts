import { describe, it, expect } from 'vitest';
import { validateConfig } from './validation.js';
import type { AgentConfig } from './config.js';

function config(output: string): AgentConfig {
  return {
    vaultUrl: 'https://vault.test', tenantId: 'tenant-a', auth: { apiKey: 'synthetic-agent-key' },
    agentId: 'agent-a', hostConfigId: 'host-a', configVersion: 14, targets: [],
    secretTargets: [{ name: 'legacy', secretId: 'legacy', format: 'raw', output }],
    managedKeyTargets: [{ id: 'reader', keyId: 'key-reader', output, owner: '501:20', mode: '0640' }],
  } as AgentConfig;
}

describe('managed key target configuration authority', () => {
  it('rejects a target output also written by an opaque secret target', () => {
    const result = validateConfig(config('/run/zn-vault-agent/secrets/reader'));
    expect(result.valid).toBe(false);
    expect(result.errors.some(error => error.field.includes('managedKeyTargets'))).toBe(true);
  });
  it('rejects key material outside the agent tmpfs directory', () => {
    const input = config('/etc/reader'); input.secretTargets = [];
    expect(validateConfig(input).valid).toBe(false);
  });
});
