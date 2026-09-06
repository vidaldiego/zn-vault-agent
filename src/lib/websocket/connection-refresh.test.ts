import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    vaultUrl: 'https://vault.test',
    auth: { apiKey: 'test-only-key' },
    targets: [],
    secretTargets: [{
      secretId: 'alias:app/runtime-env',
      refreshOn: [
        'alias:credentials/openai',
        'alias:credentials/openai',
        'alias:credentials/mistral',
      ],
      name: 'runtime-env',
      format: 'env',
      output: '/run/app/runtime.env',
    }],
  })),
}));

vi.mock('../../services/dynamic-secrets/index.js', () => ({
  getDynamicSecretsCapabilities: () => [],
}));

import { buildWebSocketUrl } from './connection.js';

describe('referenced secret subscriptions', () => {
  it('subscribes to parent, refresh dependencies, and exec secrets once', () => {
    const url = new URL(buildWebSocketUrl([
      'alias:exec/secret',
      'alias:credentials/openai',
      '00000000-0000-4000-8000-000000000001',
    ]));
    expect(url.searchParams.get('secretIds')?.split(',')).toEqual([
      'app/runtime-env',
      'credentials/openai',
      'credentials/mistral',
      'exec/secret',
      '00000000-0000-4000-8000-000000000001',
    ]);
  });
});
