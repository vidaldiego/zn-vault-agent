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
- Scheduler passthrough: `/scheduler/{quiesce,resume,status}` routes forward to znapi's `/internal/scheduler/*` (used by `znvault-plugin-payara` for scheduler-aware deploys). **No deploy secret** — znapi's `/internal/scheduler/*` filter authorizes on loopback (the agent posts to `127.0.0.1`), so the agent sends no `X-Internal-Secret` and requires no provisioned secret file (changed 2026-06-23; previously read `/etc/zincapi/scheduler-deploy-secret` and 500'd when absent). Configured via the single `znapiBaseUrl` field (default `http://127.0.0.1:8080`) — a top-level `AgentConfig` field in `src/lib/config/types.ts`. Implemented in `src/lib/scheduler-routes.ts`, registered from `src/lib/health.ts`.

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

## Helping Users Configure Agents

**This section is for AI assistants helping users set up agents.**

### Decision Tree: Which Approach?

When a user asks about configuring an agent, first determine their use case:

```
Q1: Are you deploying multiple servers with the same role?
    (e.g., 3 HAProxy nodes, 5 app servers, auto-scaling group)

    YES → PATH A: Host Templates + Config-from-Vault
    NO  → Q2

Q2: Are you deploying a single unique server?
    (e.g., one database server, one monitoring server)

    YES → PATH B: Bootstrap Token + Local Config
    NO  → Q3

Q3: Are you just running a command with secrets? (no daemon needed)
    (e.g., CI/CD pipeline, one-off script, container entrypoint)

    YES → PATH C: Exec Mode (One-Shot)
```

### Path A: Host Templates (Fleet/Multiple Servers)

**When to use:** Multiple identical servers pulling same config.

**Admin steps (vault side):**
```bash
# 1. Create host template with managed key
znvault host create haproxy-prod --managed-key haproxy-key

# 2. Configure the template
znvault host config haproxy-prod --edit
# Or: znvault host config haproxy-prod --import config.json

# 3. Generate bootstrap token (one per server)
znvault host token haproxy-prod
# Output: zrt_abc123...
```

**Server steps (hostname auto-detected, or use --host-name to override):**
```bash
# Option A: One-command bootstrap
curl -fsSL https://vault.example.com/v1/hosts/bootstrap.sh | \
  BOOTSTRAP_TOKEN=zrt_abc123... bash

# Option B: Manual (hostname auto-detected)
npm install -g @zincapp/zn-vault-agent
sudo zn-vault-agent setup
zn-vault-agent login --url https://vault.example.com \
  --bootstrap-token zrt_abc123...
sudo systemctl enable --now zn-vault-agent

# Option C: With explicit hostname
zn-vault-agent login --url https://vault.example.com \
  --bootstrap-token zrt_abc123... \
  --host-name haproxy-prod-01
```

**Result:** Agent has `configFromVault: true` and pulls config from template.

### Path B: Bootstrap Token + Local Config (Single Server)

**When to use:** Unique server that doesn't share config with others.

```bash
# 1. Install
npm install -g @zincapp/zn-vault-agent
sudo zn-vault-agent setup

# 2. Bootstrap (admin provides token, hostname auto-detected)
zn-vault-agent login --url https://vault.example.com \
  --bootstrap-token zrt_abc123...

# Or with explicit hostname:
zn-vault-agent login --url https://vault.example.com \
  --bootstrap-token zrt_abc123... \
  --host-name my-unique-server

# 3. Configure locally
zn-vault-agent certs add <cert-id> \
  --name nginx-ssl \
  --fullchain /etc/nginx/ssl/cert.pem \
  --key /etc/nginx/ssl/key.pem \
  --reload "systemctl reload nginx"

# 4. Start
sudo systemctl enable --now zn-vault-agent
```

**Result:** Agent has local config with targets defined in `/etc/zn-vault-agent/config.json`.

### Path C: Exec Mode (One-Shot)

**When to use:** Scripts, CI/CD, containers - no daemon needed.

```bash
# Basic: inject secrets and run command
zn-vault-agent exec \
  --url https://vault.example.com \
  --api-key znv_abc123... \
  -s DB_PASSWORD=alias:db/prod.password \
  -- ./deploy.sh

# With env file (inject all key-value pairs from secret)
zn-vault-agent exec \
  -e alias:env/production \
  -- python app.py

# Mixed: secrets + managed API key + literal
zn-vault-agent exec \
  -s DB_PASSWORD=alias:db/prod.password \
  -s VAULT_KEY=api-key:my-managed-key \
  -s ENV=literal:production \
  -- ./start.sh
```

**No config file needed** - everything via CLI args or env vars.

### Common Mistakes to Avoid

1. **Don't mix approaches:** Either use `configFromVault: true` OR local config, not both.

2. **Don't skip bootstrap tokens:** Using raw API keys is less secure. Bootstrap tokens:
   - Are one-time use
   - Expire in 1 hour
   - Automatically bind to managed keys

3. **Don't forget the tenant:** If using API key directly (not bootstrap), the agent auto-detects tenant from the key via `/auth/api-keys/self`.

4. **Don't confuse host template with config file:**
   - Host template = config stored ON VAULT SERVER
   - Config file = config stored ON AGENT SERVER

5. **Check auto-detected hostname:** The agent uses `os.hostname()` by default. If your machine hostname doesn't match your naming convention, use `--host-name` to override:
   ```bash
   # Uses machine hostname (auto-detected)
   zn-vault-agent login --url ... --bootstrap-token zrt_...

   # Override with explicit hostname
   zn-vault-agent login --url ... --bootstrap-token zrt_... --host-name my-server-01
   ```

6. **Secret mapping syntax:**
   - `alias:path/to/secret.field` - specific field
   - `alias:path/to/secret` - entire secret as JSON
   - `api-key:key-name` - managed API key
   - `literal:value` - pass-through

### Key Relationships

```
Bootstrap Token ─────► Managed API Key ─────► Host Template
     │                      │                      │
     │ (one-time)          │ (auto-rotation)      │ (config source)
     │                      │                      │
     ▼                      ▼                      ▼
  Agent Registration    Agent Auth           Agent Config
     │                      │                      │
     └──────────────────────┼──────────────────────┘
                            │
                      Agent Runtime
```

### Detailed Reference

See `docs/CONFIGURATION_GUIDE.md` for:
- Complete configuration schema
- Full examples for each path
- Troubleshooting guide
- Common patterns (auto-scaling, blue-green, etc.)

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

## Known Issues & Important Fixes

### Plugin Managed Key Tracking (Fixed in v1.20.12)

**Issue:** In daemon mode with plugins, managed API key rotation events were not dispatched to plugins. This caused plugins like `znvault-plugin-payara` to have stale API key files after key rotation.

**Root Cause:** The rotation event handler in `websocket.ts` only checked `execManagedKeyNames` which was populated only in exec mode. In daemon mode, this array was empty, so all rotation events were ignored.

**Fix Location:** `src/lib/websocket.ts` - Created `allManagedKeyNames` array that combines:
- Exec mode managed keys
- Plugin `api-key:` secrets extracted from plugin configs
- Agent's own managed key (`config.managedKey.name`)

**Symptoms (if running < v1.20.12):**
- WebSocket subscriptions show `managedKeys: []` (empty)
- Logs show "Received rotation event for untracked managed key"
- Plugin's `onKeyRotated` hook never called
- API key files become stale, causing authentication errors

**Verification:**
```bash
# Check logs for proper tracking (v1.20.12+)
grep "Managed API keys tracked" /var/log/zn-vault-agent/agent.log
# Should show: {"totalManagedKeys":N,...}

# Check WebSocket subscription
grep "Subscriptions updated" /var/log/zn-vault-agent/agent.log | tail -1
# Should show: "managedKeys":["your-key-name"]
```

**Workaround (if upgrade not possible):** Restart the agent - it auto-fixes stale API key files on startup.

### Sudo-free self-update (.path activation, 2026-06-22)

The strict agent systemd profile (empty CapabilityBoundingSet + PrivateDevices)
blocks `sudo`, breaking the old `sudo systemctl start updater` path. Self-update
now uses a file trigger: the agent atomically creates
`/var/lib/zn-vault-agent/.update-trigger` ("<version> <channel>"); a root-owned
`zn-vault-agent-updater.path` (PathExists) activates the updater oneshot, whose
ExecStart is `/usr/local/lib/zn-vault-agent/zn-vault-agent-update.sh` (reads +
DELETES the trigger, validates, `npm install -g @pkg@<target>`); ExecStartPost
`try-restart`s the agent on success only. The sudo path remains as a fallback
for un-migrated hosts. Channels: `latest | beta | next`. Design:
`docs/superpowers/specs/2026-06-22-sudo-free-agent-self-update-design.md`.

### Plugin Config Race Condition (Fixed in v1.20.14)

**Issue:** Even with v1.20.12/v1.20.13, plugins could still write stale API keys due to a race condition. Plugins read `ctx.config.auth.apiKey` before the in-memory config object was updated.

**Root Cause:** In `websocket.ts`, `handleApiKeyRotationEvent` called `updateManagedKey()` which:
1. Loads a **NEW** config object from disk via `loadConfig()`
2. Updates the new object
3. Saves it back to disk

But this **NEVER updated** `agentInternals.config` (the in-memory object that plugins read via `ctx.config`). So plugins read the OLD key from the stale in-memory object.

**Fix Location:** `src/lib/websocket.ts` - Added direct mutation of the live `config` object BEFORE calling `updateManagedKey()`:
```typescript
// CRITICAL: Mutate the LIVE config object directly
config.auth.apiKey = newKey;
if (config.managedKey) {
  config.managedKey.nextRotationAt = bindResponse.nextRotationAt;
  // ... other metadata
}
// Then persist to disk
updateManagedKey(newKey, {...});
```

**Symptoms (if running < v1.20.14):**
- API key file has old key prefix after rotation
- Logs show "API key written and verified" but file has wrong value
- Config FILE has correct (new) prefix, but key file has old prefix
- Multiple rotation events logged (duplicate handling)

**Verification:**
```bash
# Compare key file prefix with config prefix - they should match
echo "File:   $(head -c 16 /var/lib/zn-vault-agent/secrets/ZINC_CONFIG_VAULT_API_KEY)..."
echo "Config: $(cat /etc/zn-vault-agent/config.json | jq -r '.auth.apiKey[:16]')..."
```

**Workaround (if upgrade not possible):** Restart the agent - it auto-fixes stale API key files on startup via `syncManagedKeyFile()`.

See `docs/TROUBLESHOOTING.md` for more details.
