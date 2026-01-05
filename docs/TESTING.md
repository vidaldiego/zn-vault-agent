# ZN-Vault Agent Testing Documentation

This document describes the comprehensive testing infrastructure for the ZN-Vault Agent.

## Overview

The agent test suite consists of two layers:

1. **Unit Tests** (`src/**/*.test.ts`) - Fast, isolated tests for individual modules
2. **Integration Tests** (`test/integration/**/*.test.ts`) - End-to-end tests against a live vault

## Test Structure

```
zn-vault-agent/
├── src/
│   └── **/*.test.ts              # Unit tests (co-located with source)
├── test/
│   ├── setup.ts                  # Global test configuration
│   ├── helpers/
│   │   ├── agent-runner.ts       # CLI execution helper
│   │   └── vault-client.ts       # Vault API client for test setup
│   └── integration/
│       ├── auth.test.ts          # Authentication tests
│       ├── certificates.test.ts  # Certificate management tests
│       ├── secrets.test.ts       # Secret management tests
│       ├── exec.test.ts          # Exec mode tests
│       ├── daemon.test.ts        # Daemon mode tests
│       ├── websocket.test.ts     # WebSocket tests
│       └── update.test.ts        # Update system tests
├── vitest.config.ts              # Unit test configuration
└── vitest.integration.config.ts  # Integration test configuration
```

## Running Tests

### Unit Tests

```bash
# Run all unit tests
npm run test:unit

# Run with watch mode
npm run test:watch

# Run with coverage
npm run test:coverage
```

### Integration Tests

Integration tests require a running vault server.

#### Option 1: Use the SDK test environment (recommended)

From the `zn-vault` root directory:

```bash
# Start the test environment
./scripts/sdk-test-env.sh

# In another terminal, run agent integration tests
cd zn-vault-agent
npm run test:integration
```

#### Option 2: Manual setup

```bash
# 1. Start vault server on port 9443
cd ../zn-vault
DATABASE_URL="postgres://..." npm run dev

# 2. Set environment variables
export ZNVAULT_TEST_URL=https://localhost:9443
export ZNVAULT_TEST_USERNAME=admin
export ZNVAULT_TEST_PASSWORD=Admin123456#
export ZNVAULT_TEST_TENANT=agent-test
export ZNVAULT_INSECURE=true

# 3. Run integration tests
cd zn-vault-agent
npm run test:integration
```

### All Tests

```bash
npm run test:all
```

## Test Categories

### AUTH - Authentication Tests (`auth.test.ts`)

| Test ID | Description |
|---------|-------------|
| AUTH-01 | Login with valid API key |
| AUTH-02 | Login with valid username/password |
| AUTH-03 | Fail login with invalid API key |
| AUTH-04 | Fail login with invalid password |
| AUTH-09 | Accept all required flags in non-interactive mode |
| - | Reject invalid URL format |
| - | Reject empty tenant ID |
| - | Show configuration after login |
| - | Output JSON with --json flag |

### CERT - Certificate Management Tests (`certificates.test.ts`)

| Test ID | Description |
|---------|-------------|
| CERT-01 | List available certificates from vault |
| CERT-02 | Add certificate target with combined format |
| CERT-03 | Add certificate target with separate files |
| CERT-04 | Sync certificate to file system |
| CERT-05 | Set correct file permissions |
| CERT-07 | List configured certificate targets |
| CERT-07 | Remove certificate target |
| CERT-08 | Detect fingerprint changes and re-sync |
| - | Add certificate with mode and owner options |
| - | Support dry-run mode |
| - | Sync specific target by name |
| - | Fail with invalid certificate ID |
| - | Fail if output directory cannot be created |
| - | Fail to remove non-existent target |

### SEC - Secret Management Tests (`secrets.test.ts`)

| Test ID | Description |
|---------|-------------|
| SEC-01 | Add secret target with JSON format |
| SEC-02 | Add secret target with env format |
| SEC-03 | Add secret target with YAML format |
| SEC-04 | Add secret target with raw format and key |
| SEC-05 | Sync secret to JSON file |
| SEC-06 | Sync secret to env file |
| SEC-07 | Sync secret to YAML file |
| SEC-08 | Sync single key with raw format |
| SEC-09 | Remove secret target |
| - | Add secret with env prefix |
| - | Add secret with mode option |
| - | Apply env prefix during sync |
| - | Set correct file permissions |
| - | Sync specific target by name |
| - | List configured secret targets |
| - | Fail to remove non-existent target |
| - | Fail with invalid secret ID |
| - | Fail with missing key for raw format |

### EXEC - Exec Mode Tests (`exec.test.ts`)

| Test ID | Description |
|---------|-------------|
| EXEC-01 | Inject secret as environment variable |
| EXEC-02 | Inject multiple keys from same secret |
| EXEC-03 | Inject from multiple secrets |
| EXEC-04 | Load mappings from env file |
| - | Inject entire secret as JSON |
| - | Combine env file and inline mappings |
| - | Pass exit code from child process |
| - | Handle command with arguments |
| - | Pass stdout from child process |
| - | Pass stderr from child process |
| - | Not expose secrets in error messages |
| - | Not inherit parent environment secrets |
| - | Fail with invalid secret alias |
| - | Fail with invalid key path |
| - | Fail with malformed mapping |
| - | Handle missing env file gracefully |
| - | Handle secrets with special characters |
| - | Handle secrets with newlines |

### DAEMON - Daemon Mode Tests (`daemon.test.ts`)

| Test ID | Description |
|---------|-------------|
| DAEMON-01 | Start daemon and expose health endpoint |
| DAEMON-02 | Sync certificates on startup |
| DAEMON-03 | Stop gracefully on SIGTERM |
| DAEMON-04 | Return detailed health information |
| DAEMON-05 | Expose Prometheus metrics when enabled |
| DAEMON-06 | Sync periodically based on poll interval |
| DAEMON-07 | Detect certificate rotation and re-sync |
| DAEMON-08 | Continue running after sync errors |
| - | Return readiness status |
| - | Return liveness status |
| - | Track sync metrics |
| - | Recover from temporary network issues |
| - | Use custom health port |
| - | Accept poll interval configuration |

### WS - WebSocket Tests (`websocket.test.ts`)

| Test ID | Description |
|---------|-------------|
| WS-01 | Establish WebSocket connection on daemon start |
| WS-02 | Reconnect after connection loss |
| WS-03 | Show WebSocket status in health endpoint |
| WS-04 | Receive push notification on certificate rotation |
| WS-05 | Handle multiple push notifications |
| WS-06 | Maintain health during connection issues |
| WS-07 | Continue polling when WebSocket unavailable |
| WS-08 | Authenticate WebSocket with API key |
| WS-09 | Handle token refresh during long connections |
| WS-10 | Handle malformed messages gracefully |
| WS-11 | Process sync commands from vault |
| WS-12 | Track WebSocket connection metrics |
| WS-13 | Track message metrics |

### UPDATE - Update System Tests (`update.test.ts`)

| Test ID | Description |
|---------|-------------|
| UPDATE-01 | Check for updates from vault |
| UPDATE-02 | Check specific channel |
| UPDATE-03 | Show current update status |
| - | Support beta channel |
| - | Support dev channel |
| - | Reject invalid channel |
| - | Display current version |
| - | Include version in status output |
| - | Handle network timeout gracefully |
| - | Retry on transient failures |
| - | Handle missing authentication |
| - | Handle expired API key |
| - | Respect auto-update settings |
| - | Download updates without applying in dry-run |

## Test Helpers

### AgentRunner (`test/helpers/agent-runner.ts`)

Provides a programmatic interface to execute agent CLI commands:

```typescript
import { AgentRunner, createTempOutputDir } from '../helpers/agent-runner.js';

const agent = new AgentRunner('test-id');
agent.setup();

// Login
await agent.login({
  url: 'https://localhost:9443',
  tenantId: 'my-tenant',
  apiKey: 'znv_...',
  insecure: true,
});

// Add certificate target
await agent.addCertificate({
  certId: 'uuid',
  name: 'my-cert',
  output: '/path/to/cert.pem',
  format: 'combined',
});

// Sync
await agent.sync();

// Read config
const config = agent.readConfig();

// Cleanup
agent.cleanup();
```

### VaultTestClient (`test/helpers/vault-client.ts`)

Provides API access to vault for test setup:

```typescript
import { VaultTestClient, generateTestCertificate } from '../helpers/vault-client.js';

const vault = new VaultTestClient({
  url: 'https://localhost:9443',
  username: 'admin',
  password: 'password',
  insecure: true,
});

await vault.login();

// Create test certificate
const { certPem, keyPem } = generateTestCertificate();
const cert = await vault.createCertificate({
  name: 'test-cert',
  tenantId: 'my-tenant',
  certPem,
  keyPem,
});

// Create test secret
const secret = await vault.createSecret({
  alias: 'test/secret',
  tenantId: 'my-tenant',
  type: 'credential',
  data: { username: 'user', password: 'pass' },
});

// Create API key
const apiKey = await vault.createApiKey({
  name: 'test-key',
  expiresInDays: 1,
  scope: 'limited',
  allowedPermissions: ['certificate:read:*'],
  tenantId: 'my-tenant',
});

// Cleanup
await vault.deleteCertificate(cert.id);
await vault.deleteSecret(secret.id);
await vault.deleteApiKey(apiKey.id);
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ZNVAULT_TEST_URL` | `https://localhost:9443` | Vault server URL |
| `ZNVAULT_TEST_USERNAME` | `admin` | Test user username |
| `ZNVAULT_TEST_PASSWORD` | `Admin123456#` | Test user password |
| `ZNVAULT_TEST_TENANT` | `agent-test` | Test tenant ID |
| `ZNVAULT_INSECURE` | `true` | Skip TLS verification |

## CI Integration

Agent tests run in GitHub Actions as part of the test workflow:

1. **Prerequisites**: E2E tests must pass first
2. **Setup**: Starts vault server with test database
3. **Execution**: Runs unit and integration tests
4. **Artifacts**: Test results uploaded for review

See `.github/workflows/test.yml` for the complete CI configuration.

## Writing New Tests

### Adding a Unit Test

Create a `.test.ts` file next to the source file:

```typescript
// src/lib/parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseConfig } from './parser.js';

describe('parseConfig', () => {
  it('should parse valid JSON', () => {
    const result = parseConfig('{"key": "value"}');
    expect(result.key).toBe('value');
  });
});
```

### Adding an Integration Test

Create a test file in `test/integration/`:

```typescript
// test/integration/my-feature.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { AgentRunner, createTempOutputDir } from '../helpers/agent-runner.js';
import { VaultTestClient } from '../helpers/vault-client.js';
import { TEST_ENV, getVaultClient } from '../setup.js';

describe('My Feature', () => {
  let agent: AgentRunner;
  let vault: VaultTestClient;
  let outputDir: string;

  beforeAll(async () => {
    vault = await getVaultClient();
    // Create test resources...
  });

  afterAll(async () => {
    // Cleanup test resources...
  });

  beforeEach(async () => {
    const testId = `my-feature-${Date.now()}`;
    agent = new AgentRunner(testId);
    agent.setup();
    outputDir = createTempOutputDir(testId);

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

  it('should do something', async () => {
    const result = await agent.run(['my-command']);
    expect(result.exitCode).toBe(0);
  });
});
```

## Troubleshooting

### Tests fail with "Vault not available"

Ensure the vault server is running:
```bash
curl -sk https://localhost:9443/v1/health
```

### Tests timeout

Increase timeout in vitest config or individual tests:
```typescript
it('slow test', async () => {
  // ...
}, 60000); // 60 second timeout
```

### Certificate generation fails

Ensure OpenSSL is installed:
```bash
openssl version
```

### WebSocket tests are flaky

WebSocket tests may be timing-sensitive. Adjust wait times or use polling:
```typescript
// Wait for condition with polling
for (let i = 0; i < 30; i++) {
  if (await checkCondition()) break;
  await new Promise(r => setTimeout(r, 500));
}
```
