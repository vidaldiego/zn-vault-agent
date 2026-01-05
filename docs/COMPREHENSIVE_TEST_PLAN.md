# ZN-Vault Agent - Comprehensive Test Plan

This document outlines a complete testing strategy for the zn-vault-agent, covering all features and capabilities.

## Test Environment Setup

### Prerequisites
- ZN-Vault server running in test mode (port 9443)
- Test tenant with certificates and secrets created
- API key with appropriate permissions
- Docker for isolated testing

### Quick Start
```bash
# From zn-vault root directory
npm run test:sdk:start

# This starts:
# - PostgreSQL test container
# - Vault server on port 9443
# - Creates test tenant and test data
```

---

## Test Matrix

### 1. Authentication Tests (`test/auth.test.ts`)

| Test Case | Description | Priority |
|-----------|-------------|----------|
| AUTH-01 | Login with valid API key | Critical |
| AUTH-02 | Login with valid username/password | Critical |
| AUTH-03 | Login fails with invalid API key | Critical |
| AUTH-04 | Login fails with invalid password | Critical |
| AUTH-05 | API key auto-renewal before expiry | High |
| AUTH-06 | API key renewal updates config file | High |
| AUTH-07 | Token refresh on expiry (password auth) | Medium |
| AUTH-08 | Interactive login prompts | Medium |
| AUTH-09 | Non-interactive login with flags | Medium |

### 2. Certificate Management Tests (`test/certificates.test.ts`)

| Test Case | Description | Priority |
|-----------|-------------|----------|
| CERT-01 | List available certificates | Critical |
| CERT-02 | Add certificate target (combined format) | Critical |
| CERT-03 | Add certificate target (separate files) | Critical |
| CERT-04 | Sync certificate to file system | Critical |
| CERT-05 | Verify file permissions (0640) | Critical |
| CERT-06 | Verify file ownership (user:group) | Critical |
| CERT-07 | Remove certificate target | High |
| CERT-08 | Fingerprint change detection | High |
| CERT-09 | Reload command execution on sync | High |
| CERT-10 | Health check after sync | High |
| CERT-11 | Rollback on health check failure | High |
| CERT-12 | Backup file creation | Medium |
| CERT-13 | Atomic write (no partial files) | Medium |
| CERT-14 | PEM bundle parsing (multi-cert) | Medium |
| CERT-15 | Private key extraction (RSA/EC/PKCS8) | Medium |
| CERT-16 | Chain extraction from bundle | Medium |
| CERT-17 | Fullchain output format | Medium |

### 3. Secret Management Tests (`test/secrets.test.ts`)

| Test Case | Description | Priority |
|-----------|-------------|----------|
| SEC-01 | List available secrets | Critical |
| SEC-02 | Add secret target (env format) | Critical |
| SEC-03 | Add secret target (json format) | Critical |
| SEC-04 | Add secret target (yaml format) | High |
| SEC-05 | Add secret target (raw format) | High |
| SEC-06 | Add secret target (template format) | High |
| SEC-07 | Sync secret to file system | Critical |
| SEC-08 | Verify file permissions (0600) | Critical |
| SEC-09 | Remove secret target | High |
| SEC-10 | Version change detection | High |
| SEC-11 | Reload command after sync | High |
| SEC-12 | Template variable substitution | Medium |
| SEC-13 | Env format escaping (quotes, newlines) | Medium |
| SEC-14 | YAML proper quoting | Medium |

### 4. Exec Mode Tests (`test/exec.test.ts`)

| Test Case | Description | Priority |
|-----------|-------------|----------|
| EXEC-01 | Run command with single secret | Critical |
| EXEC-02 | Run command with multiple secrets | Critical |
| EXEC-03 | Secret mapping: alias:path format | Critical |
| EXEC-04 | Secret mapping: alias:path.key format | Critical |
| EXEC-05 | Secret mapping: UUID format | High |
| EXEC-06 | Secret mapping: UUID.key format | High |
| EXEC-07 | Environment inheritance | High |
| EXEC-08 | Signal forwarding (SIGINT) | High |
| EXEC-09 | Signal forwarding (SIGTERM) | High |
| EXEC-10 | Exit code propagation | High |
| EXEC-11 | --env-file mode | Medium |
| EXEC-12 | Secrets not in logs | Critical |

### 5. WebSocket Tests (`test/websocket.test.ts`)

| Test Case | Description | Priority |
|-----------|-------------|----------|
| WS-01 | Connect to /v1/ws/agent | Critical |
| WS-02 | Subscribe to certificate updates | Critical |
| WS-03 | Subscribe to secret updates | Critical |
| WS-04 | Receive certificate.rotated event | Critical |
| WS-05 | Receive secret.updated event | Critical |
| WS-06 | Heartbeat/ping every 30s | High |
| WS-07 | Reconnect on disconnect | High |
| WS-08 | Exponential backoff (max 60s) | High |
| WS-09 | Update subscriptions dynamically | Medium |
| WS-10 | Graceful disconnect | Medium |
| WS-11 | Multi-subscription handling | Medium |

### 6. Daemon Mode Tests (`test/daemon.test.ts`)

| Test Case | Description | Priority |
|-----------|-------------|----------|
| DAEMON-01 | Start daemon with health port | Critical |
| DAEMON-02 | Health endpoint /health | Critical |
| DAEMON-03 | Readiness probe /ready | Critical |
| DAEMON-04 | Liveness probe /live | Critical |
| DAEMON-05 | Metrics endpoint /metrics | High |
| DAEMON-06 | Graceful shutdown (SIGTERM) | Critical |
| DAEMON-07 | Graceful shutdown (SIGINT) | High |
| DAEMON-08 | WebSocket connection maintained | High |
| DAEMON-09 | Fallback polling on WS failure | High |
| DAEMON-10 | Multiple certificate targets | High |
| DAEMON-11 | Mixed cert + secret targets | High |

### 7. Auto-Update Tests (`test/update.test.ts`)

| Test Case | Description | Priority |
|-----------|-------------|----------|
| UPDATE-01 | Check for updates (stable channel) | High |
| UPDATE-02 | Check for updates (beta channel) | Medium |
| UPDATE-03 | Update status command | High |
| UPDATE-04 | Update config command | Medium |
| UPDATE-05 | Maintenance window respect | Medium |
| UPDATE-06 | WebSocket update notification | Medium |

### 8. Error Handling Tests (`test/errors.test.ts`)

| Test Case | Description | Priority |
|-----------|-------------|----------|
| ERR-01 | Network connection refused | High |
| ERR-02 | DNS resolution failure | High |
| ERR-03 | Request timeout | High |
| ERR-04 | 401 Unauthorized response | Critical |
| ERR-05 | 403 Forbidden response | Critical |
| ERR-06 | 404 Not Found response | High |
| ERR-07 | 500 Server Error (retry) | High |
| ERR-08 | 429 Rate Limited (backoff) | High |
| ERR-09 | Invalid certificate ID | High |
| ERR-10 | Permission denied on file write | High |
| ERR-11 | Disk full | Medium |
| ERR-12 | Parent directory missing | Medium |

### 9. Configuration Tests (`test/config.test.ts`)

| Test Case | Description | Priority |
|-----------|-------------|----------|
| CFG-01 | Load config from default path | High |
| CFG-02 | Load config from custom path | High |
| CFG-03 | Environment variable overrides | High |
| CFG-04 | ZNVAULT_URL override | High |
| CFG-05 | ZNVAULT_API_KEY override | High |
| CFG-06 | ZNVAULT_INSECURE override | Medium |
| CFG-07 | Config validation errors | High |
| CFG-08 | Add target persists to config | High |
| CFG-09 | Remove target persists to config | High |
| CFG-10 | Status command shows config | Medium |

### 10. Metrics Tests (`test/metrics.test.ts`)

| Test Case | Description | Priority |
|-----------|-------------|----------|
| MET-01 | sync_total counter increments | High |
| MET-02 | sync_failures_total on error | High |
| MET-03 | websocket_reconnects_total | Medium |
| MET-04 | api_requests_total | Medium |
| MET-05 | connected gauge (0/1) | High |
| MET-06 | certs_tracked gauge | Medium |
| MET-07 | last_sync_timestamp gauge | Medium |
| MET-08 | cert_expiry_days gauge | High |
| MET-09 | sync_duration_seconds histogram | Medium |
| MET-10 | Prometheus format export | High |

---

## Integration Test Scenarios

### Scenario 1: Full Certificate Lifecycle
```
1. Start vault test environment
2. Create test certificate in vault
3. Agent: login
4. Agent: add certificate target
5. Agent: sync
6. Verify file created with correct content
7. Rotate certificate in vault
8. Agent receives WebSocket notification
9. Agent syncs new certificate
10. Verify file updated
11. Agent: remove target
12. Cleanup
```

### Scenario 2: Full Secret Lifecycle
```
1. Start vault test environment
2. Create test secret in vault
3. Agent: login
4. Agent: secret add (env format)
5. Agent: secret sync
6. Verify file created with correct format
7. Update secret in vault
8. Agent receives WebSocket notification
9. Agent syncs new secret version
10. Verify file updated
11. Agent: secret remove
12. Cleanup
```

### Scenario 3: Daemon with Multiple Targets
```
1. Start vault test environment
2. Create multiple certificates and secrets
3. Agent: login
4. Agent: add multiple certificate targets
5. Agent: add multiple secret targets
6. Agent: start --health-port 8080
7. Verify WebSocket connected
8. Verify all targets synced
9. Check /health endpoint
10. Check /metrics endpoint
11. Rotate one certificate
12. Verify only that target re-synced
13. SIGTERM daemon
14. Verify graceful shutdown
15. Cleanup
```

### Scenario 4: Exec Mode Security
```
1. Start vault test environment
2. Create secret with sensitive data
3. Agent: login
4. Agent: exec --map DB_PASSWORD=alias:db/creds.password -- printenv
5. Verify DB_PASSWORD in output
6. Verify no secrets logged
7. Agent: exec with SIGINT
8. Verify child process terminates
9. Cleanup
```

### Scenario 5: Failover & Recovery
```
1. Start vault test environment
2. Agent: login and start daemon
3. Verify WebSocket connected
4. Stop vault server
5. Verify reconnection attempts (exponential backoff)
6. Restart vault server
7. Verify reconnection success
8. Verify polling fallback works
9. Cleanup
```

### Scenario 6: API Key Renewal
```
1. Start vault test environment
2. Create API key with 25-day expiry (below 30-day threshold)
3. Agent: login with API key
4. Trigger renewal check
5. Verify new API key in config
6. Verify old key invalidated
7. Cleanup
```

---

## Test Implementation Structure

```
zn-vault-agent/
├── test/
│   ├── setup.ts              # Test environment setup/teardown
│   ├── helpers/
│   │   ├── vault-client.ts   # Vault API helper for test data setup
│   │   ├── agent-runner.ts   # CLI execution helper
│   │   └── file-utils.ts     # File verification helpers
│   │
│   ├── unit/
│   │   ├── config.test.ts
│   │   ├── validation.test.ts
│   │   ├── deployer.test.ts
│   │   ├── secret-deployer.test.ts
│   │   ├── pem-parser.test.ts
│   │   └── metrics.test.ts
│   │
│   ├── integration/
│   │   ├── auth.test.ts
│   │   ├── certificates.test.ts
│   │   ├── secrets.test.ts
│   │   ├── exec.test.ts
│   │   ├── websocket.test.ts
│   │   ├── daemon.test.ts
│   │   └── update.test.ts
│   │
│   └── e2e/
│       ├── full-lifecycle.test.ts
│       ├── failover.test.ts
│       └── security.test.ts
```

---

## Test Data Requirements

### Certificates Needed
| Name | Type | Purpose |
|------|------|---------|
| `test-cert-rsa` | RSA 2048 | Basic RSA certificate |
| `test-cert-ec` | EC P-256 | Elliptic curve certificate |
| `test-cert-chain` | RSA + chain | Certificate with CA chain |
| `test-cert-expiring` | RSA | Certificate expiring in 7 days |

### Secrets Needed
| Alias | Type | Content |
|-------|------|---------|
| `alias:test/simple` | credential | `{username, password}` |
| `alias:test/complex` | generic | Nested JSON object |
| `alias:test/multiline` | generic | Value with newlines |
| `alias:test/special` | generic | Value with quotes/special chars |

### API Keys Needed
| Name | Scope | Permissions |
|------|-------|-------------|
| `agent-full` | limited | `certificate:*`, `secret:read:*` |
| `agent-certs-only` | limited | `certificate:*` |
| `agent-secrets-only` | limited | `secret:read:*` |
| `agent-expiring` | limited | Created with 25-day expiry |

---

## Running Tests

### All Tests
```bash
cd zn-vault-agent
npm test
```

### Specific Test Suite
```bash
npm test -- test/integration/certificates.test.ts
```

### With Coverage
```bash
npm run test:coverage
```

### Against Live Environment
```bash
ZNVAULT_TEST_URL=https://vault.example.com \
ZNVAULT_TEST_API_KEY=znv_xxx \
npm test
```

---

## CI Integration

### GitHub Actions Workflow
```yaml
agent-tests:
  name: Agent Integration Tests
  runs-on: ubuntu-latest
  needs: [lint-and-typecheck]
  services:
    postgres:
      image: postgres:16-alpine
      # ... postgres config

  steps:
    - uses: actions/checkout@v4

    - name: Setup Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'

    - name: Install vault dependencies
      run: npm ci

    - name: Build vault
      run: npm run build

    - name: Start vault test server
      run: npm run test:sdk:start &
      env:
        DATABASE_URL: postgres://...

    - name: Wait for vault
      run: ./scripts/wait-for-vault.sh

    - name: Install agent dependencies
      working-directory: zn-vault-agent
      run: npm ci

    - name: Build agent
      working-directory: zn-vault-agent
      run: npm run build

    - name: Run agent tests
      working-directory: zn-vault-agent
      run: npm test
      env:
        ZNVAULT_TEST_URL: https://localhost:9443
        ZNVAULT_INSECURE: 'true'
```

---

## Success Criteria

| Metric | Target |
|--------|--------|
| Test Coverage | > 80% |
| Critical Tests Pass | 100% |
| High Priority Tests Pass | 100% |
| Medium Priority Tests Pass | > 95% |
| Integration Tests Pass | 100% |
| E2E Tests Pass | 100% |

---

## Appendix: Test Helpers

### VaultTestClient
```typescript
class VaultTestClient {
  async createCertificate(name: string, opts?: CertOpts): Promise<Certificate>;
  async rotateCertificate(id: string): Promise<Certificate>;
  async deleteCertificate(id: string): Promise<void>;

  async createSecret(alias: string, data: object): Promise<Secret>;
  async updateSecret(id: string, data: object): Promise<Secret>;
  async deleteSecret(id: string): Promise<void>;

  async createApiKey(opts: ApiKeyOpts): Promise<{ key: string; id: string }>;
  async deleteApiKey(id: string): Promise<void>;
}
```

### AgentRunner
```typescript
class AgentRunner {
  async login(opts: LoginOpts): Promise<void>;
  async addCert(certId: string, opts: AddCertOpts): Promise<void>;
  async sync(): Promise<SyncResult>;
  async startDaemon(opts: DaemonOpts): Promise<DaemonHandle>;
  async exec(command: string[], secrets: string[]): Promise<ExecResult>;
}
```

### FileVerifier
```typescript
class FileVerifier {
  async exists(path: string): Promise<boolean>;
  async content(path: string): Promise<string>;
  async permissions(path: string): Promise<string>;
  async owner(path: string): Promise<{ user: string; group: string }>;
  async isValidPem(path: string): Promise<boolean>;
}
```
