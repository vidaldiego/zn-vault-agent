# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ZnVault Agent (`@zincapp/zn-vault-agent`) is a TypeScript/Node.js daemon that synchronizes TLS certificates and secrets from ZnVault to target servers with zero-downtime deployments. It runs as a systemd service and provides real-time updates via WebSocket, falling back to HTTP polling when unavailable.

### Relationship to ZnVault Server

This agent is part of the ZnVault ecosystem. The parent directory (`../`) contains the main ZnVault server - see `../CLAUDE.md` for server documentation.

```
zn-vault/                    # Parent - Vault server (Fastify, PostgreSQL)
├── src/                     # Server source code
├── zn-vault-agent/          # THIS REPO - Agent for certificate/secret sync
├── zn-vault-sdk-node/       # Node.js SDK
├── zn-vault-sdk-python/     # Python SDK
├── zn-vault-sdk-swift/      # Swift SDK
├── zn-vault-sdk-jvm/        # Kotlin/Java SDK
├── znvault-cli/             # Admin CLI
└── vault-secrets-app/       # macOS app
```

The agent communicates with the vault server via:
- **REST API**: Authentication, certificate/secret fetching
- **WebSocket**: Real-time push notifications for rotations
- **Managed API Keys**: Auto-rotating credentials managed by the server

**Key capabilities:**
- Real-time certificate/secret distribution with atomic deployments
- Exec mode: inject secrets as environment variables into child processes
- Combined mode: daemon + child process management in a single instance
- Managed API keys with automatic rotation
- Plugin system for extensibility
- Prometheus metrics and health endpoints

## Development Commands

```bash
# Install dependencies
npm install

# Build TypeScript to dist/
npm run build

# Development with hot reload
npm run dev

# Type checking only (no emit)
npm run typecheck

# Linting
npm run lint
npm run lint:fix

# Run all tests (unit + integration)
npm test

# Run only unit tests (src/**/*.test.ts)
npm run test:unit

# Run only integration tests (requires running vault)
npm run test:integration

# Run specific test file
npm run test:unit -- src/lib/validation.test.ts
npm run test:integration -- test/integration/auth.test.ts

# Watch mode for unit tests
npm run test:watch

# Coverage report
npm run test:coverage
```

### Integration Test Setup

Integration tests require a running vault instance. From the parent `zn-vault/` directory:

```bash
# Start test environment (creates sdk-test tenant and API keys)
npm run test:sdk:start

# Then run integration tests
cd zn-vault-agent
npm run test:integration
```

Environment variables set by test runner:
- `ZNVAULT_BASE_URL` - Vault server URL
- `ZNVAULT_TENANT` - Test tenant ID (sdk-test)
- `ZNVAULT_TENANT_ADMIN_USERNAME` - Tenant admin user
- `ZNVAULT_TENANT_ADMIN_PASSWORD` - Tenant admin password
- `ZNVAULT_API_KEY` - Pre-created API key for tests

## Architecture

### Source Structure

```
src/
├── index.ts              # CLI entry point (Commander.js)
├── commands/             # CLI command handlers
│   ├── start.ts          # Daemon startup (combined mode support)
│   ├── exec.ts           # One-shot secret injection
│   ├── login.ts          # Authentication setup
│   ├── certs.ts          # Certificate target management
│   ├── secrets.ts        # Secret target management
│   ├── sync.ts           # Manual certificate sync
│   ├── status.ts         # Agent status display
│   └── setup.ts          # systemd installation
├── lib/                  # Core libraries
│   ├── config.ts         # Configuration management and persistence
│   ├── websocket.ts      # WebSocket client for real-time updates (largest file)
│   ├── api.ts            # HTTP API calls to vault
│   ├── deployer.ts       # Certificate deployment with atomic writes
│   ├── secret-deployer.ts # Secret file deployment
│   ├── secret-env.ts     # Secret mapping parsing (alias:, api-key:, literal:)
│   ├── health.ts         # Health/metrics HTTP server (Fastify)
│   ├── logger.ts         # Structured JSON logging (pino)
│   ├── metrics.ts        # Prometheus metrics collection
│   └── validation.ts     # Config validation with detailed errors
├── services/             # Background services
│   ├── managed-key-renewal.ts  # Auto-rotating managed API keys
│   ├── api-key-renewal.ts      # Static API key renewal
│   ├── child-process-manager.ts # Child process lifecycle
│   ├── npm-auto-update.ts      # Automatic self-updates
│   ├── plugin-auto-update.ts   # Plugin version detection
│   ├── degraded-mode-handler.ts # Connection failure handling
│   └── dynamic-secrets/        # Real-time DB credentials
│       ├── handler.ts          # Dynamic secret lifecycle
│       ├── config-store.ts     # In-memory config storage
│       └── db-clients/         # PostgreSQL, MySQL clients
├── plugins/              # Plugin system
│   ├── loader.ts         # Load plugins from npm/local paths
│   ├── context.ts        # Plugin execution context
│   ├── storage.ts        # Plugin configuration persistence
│   └── types.ts          # Plugin interface definitions
└── types/
    └── update.ts         # Update event types
```

### Key Architectural Patterns

1. **Event-Driven**: WebSocket events trigger certificate/secret deployments
2. **Atomic Operations**: Temp file + rename prevents partial deployments
3. **Graceful Degradation**: Falls back from WebSocket to HTTP polling
4. **Plugin Architecture**: Extensible via npm packages with lifecycle hooks
5. **Unified Logging**: JSON structured logs with secret field redaction

### Configuration Flow

Configuration is managed via `conf` package (cross-platform storage):
- System: `/etc/zn-vault-agent/config.json`
- User: `~/.config/zn-vault-agent/config.json`

Environment variables override config file values (`ZNVAULT_*` prefix).

### Secret Mapping Types

The `secret-env.ts` module (modularized in `secret-env/`) parses several mapping formats:

**Individual mappings (`-s/--secret`):**
- `alias:path/to/secret.key` - Fetch from vault secret
- `api-key:name` - Bind to managed API key
- `literal:value` - Pass-through value (no fetch)

**Env file mappings (`-e/--env-file`):**
- `alias:path/to/secret` - Inject all key-value pairs as env vars
- `alias:path/to/secret:PREFIX_` - Inject with prefix applied to all keys
- `uuid` or `uuid:PREFIX_` - Same as above using UUID

**Key files:**
- `src/lib/secret-env/types.ts` - Type definitions (`SecretMapping`, `EnvFileMapping`)
- `src/lib/secret-env/parser.ts` - Parsing functions (`parseSecretMapping`, `parseEnvFileReference`)
- `src/lib/secret-env/builder.ts` - Build env from mappings (`buildSecretEnv`, `buildEnvFromEnvFiles`)

### WebSocket Daemon (`websocket.ts`)

The core daemon module handles:
- Connection with automatic reconnection and backoff
- Certificate and secret change events
- Managed key rotation events
- Child process restart coordination (combined mode)

## Code Standards

### ESLint Configuration

Strict TypeScript rules enforced:
- **No `any`**: All `@typescript-eslint/no-unsafe-*` rules enabled
- **Explicit types**: Return types required on exported functions
- **Nullish handling**: Prefer `??` over `||`, optional chaining required
- **Type imports**: Use `import type` for type-only imports
- **Interfaces over types**: Consistent type definitions
- **Unused vars**: Error (prefix with `_` to ignore intentionally)

### TypeScript Configuration

- Target: ES2022, Module: NodeNext
- Strict mode enabled
- Declaration files generated for npm package

## Testing

### Test Organization

- **Unit tests** (`src/**/*.test.ts`): Co-located with source, test isolated logic
- **Integration tests** (`test/integration/*.test.ts`): Test against live vault

### Integration Test Helpers

- `test/helpers/vault-client.ts` - HTTP client for vault API
- `test/helpers/agent-runner.ts` - Spawn and manage agent processes

### Integration Test Configuration

From `vitest.integration.config.ts`:
- 60s timeout per test
- Parallel test files (forks pool, max 4)
- Sequential tests within files
- 1 retry for flaky network tests

## Release Process

**Publishing is handled automatically by GitHub Actions CI/CD.**

### Steps to Release

1. Update version in `package.json`:
   ```bash
   npm version patch  # or minor/major
   ```

2. Commit the version bump:
   ```bash
   git add package.json package-lock.json
   git commit -m "chore(release): vX.Y.Z"
   ```

3. Create and push tag:
   ```bash
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```

4. GitHub Actions automatically:
   - Runs tests
   - Builds the package
   - Publishes to npm using OIDC authentication

### npm Package

- **Package:** `@zincapp/zn-vault-agent`
- **Registry:** https://www.npmjs.com/package/@zincapp/zn-vault-agent
- **Channels:** `latest` (stable), `beta` (pre-release), `next` (dev builds)

### Verification

```bash
# Check published version
npm view @zincapp/zn-vault-agent version

# Install latest
npm install -g @zincapp/zn-vault-agent
```

### CI/CD Configuration

The GitHub Actions workflow (`.github/workflows/publish.yml`) handles:
- Running tests on PRs
- Publishing to npm on version tags (`v*`)
- OIDC-based npm authentication (provenance enabled)
