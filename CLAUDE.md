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
- Local HTTP/HTTPS control plane: only `/health`, `/ready`, `/live`, and
  `/metrics` are public. Every other core or plugin route requires the Bearer
  credential from `/etc/zn-vault-agent/payara-mutation-token`; Payara checks the
  same credential again in its inherited route scope. Missing/unsafe token state
  aborts startup. The token value never belongs in argv or env; the optional
  `ZNVAULT_CONTROL_TOKEN_FILE` test/install override carries only its path.
- Scheduler passthrough: authenticated `/scheduler/{quiesce,resume,status}`
  routes forward to znapi's `/internal/scheduler/*` (used by
  `znvault-plugin-payara` for scheduler-aware deploys). **No downstream deploy
  secret** — znapi authorizes the Agent's outbound request on loopback, so the
  Agent sends no `X-Internal-Secret` (changed 2026-06-23; previously read
  `/etc/zincapi/scheduler-deploy-secret`). Configured via `znapiBaseUrl`
  (default `http://127.0.0.1:8080`) in `src/lib/config/types.ts`; implemented in
  `src/lib/scheduler-routes.ts` and registered from `src/lib/health.ts`.

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

**Env file mappings (`-e/--env-secret`):**
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
sudo zn-vault-agent setup --yes
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login --url https://vault.example.com \
  --bootstrap-token zrt_abc123...
sudo systemctl enable --now zn-vault-agent

# Option C: With explicit hostname
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
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
sudo zn-vault-agent setup --yes

# 2. Bootstrap (admin provides token, hostname auto-detected)
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login --url https://vault.example.com \
  --bootstrap-token zrt_abc123...

# Or with explicit hostname:
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login --url https://vault.example.com \
  --bootstrap-token zrt_abc123... \
  --host-name my-unique-server

# 3. Configure locally
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent certs add <cert-id> \
  --name nginx-ssl \
  --fullchain /etc/nginx/ssl/cert.pem \
  --key /etc/nginx/ssl/key.pem \
  --reload "sudo /usr/bin/systemctl reload nginx"

# 4. Start
sudo systemctl enable --now zn-vault-agent
```

**Result:** Agent has local config with targets defined in `/etc/zn-vault-agent/config.json`.
Provision the exact nginx reload command as a separate least-privilege sudoers
rule; never overwrite the setup-managed agent sudoers file.

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

**The tag workflow publishes npm only.** `.github/workflows/ci.yml` owns
push/PR validation. `.github/workflows/publish.yml` owns tag validation and npm
OIDC publication; it does not create a GitHub Release.

### Steps to Release

1. Record the current npm `latest` fence (it must remain the same Agent 1.x
   version), set the exact release version without creating a commit or tag,
   and keep all three version files aligned:
   ```bash
   export AGENT_LATEST_BEFORE="$(npm view @zincapp/zn-vault-agent dist-tags.latest)"
   case "$AGENT_LATEST_BEFORE" in 1.*) ;; *) exit 1 ;; esac
   npm version 2.0.0 --no-git-tag-version
   printf '%s\n' 2.0.0 > VERSION
   ```

2. Before any tag, build and pack the final Agent 2.0.0 and Payara Plugin 3.0.0
   snapshots in their respective repositories. Run the exact paired tarballs
   through the Node.js 22.13/24 smoke:
   ```bash
   # Agent repository
   mkdir -p /tmp/znvault-release
   npm ci && npm run lint && npm run typecheck && npm run test:unit && npm run build
   npm pack --pack-destination /tmp/znvault-release

   # Payara plugin repository
   cd /path/to/znvault-plugin-payara
   npm ci && npm run lint && npm run typecheck && npm run test:unit && npm run build
   npm pack --pack-destination /tmp/znvault-release

   # Back in the Agent repository
   cd /path/to/zn-vault-agent
   ./test/release/tarball-smoke.sh \
     /tmp/znvault-release/zincapp-zn-vault-agent-2.0.0.tgz \
     /tmp/znvault-release/zincapp-znvault-plugin-payara-3.0.0.tgz
   ```

   Before commissioning Agent 2 on an existing Agent 1 host, the legacy
   updater must be inactive and its old two-field trigger must be absent. Both
   are hard NO-GO gates; setup preserves and rejects legacy evidence:
   ```bash
   ! sudo systemctl is-active --quiet zn-vault-agent-updater.service
   sudo test ! -e /var/lib/zn-vault-agent/.update-trigger
   ```

   On a `configFromVault: true` host, an exact globally installed Payara 2.x
   manifest is only a fallback candidate. A reachable Vault remains
   authoritative (`200` replaces the cache and `304` validates it); only an
   authentication, bootstrap, or config-fetch failure selects authenticated
   `UPDATE_REQUIRED` recovery. That process exposes only monitoring and the
   exact Payara updater, clears cached mutation surfaces, and revalidates the
   same installed version before listening. After an exact root-attested 2 -> 3
   install, the next boot requires a full remote `200`, never `304`. If Vault is
   still down, only the matching active + successful root receipt + restart
   marker + installed 3.x target enters `STARTUP_CONFIRMATION_PENDING`; it keeps
   GET at `202`, reloads persisted bootstrap/auth on each 30-second authority
   probe, and requests one graceful restart only after the full config returns.
   Normal remote config must then start Payara 3 before the operation becomes
   terminal. Arbitrary missing, corrupt, 3.x, and future undeclared manifests
   cannot authorize fallback; invalid evidence fails closed only when remote
   authority is unavailable. Release publication is not fleet commissioning.

3. Review and stage the complete already-smoked release snapshot (source,
   tests, workflows, documentation, and version metadata), then commit and
   push exactly that tree. The release may span many previously uncommitted
   files, so staging only the version files is unsafe:
   ```bash
   git status --short
   git diff --check
   git add -A
   git diff --cached --check
   git commit -m "chore(release): v2.0.0"
   git push origin HEAD:main
   ```

4. Wait for `ci.yml` on that exact commit. Only after it is green, create and push one
   annotated tag:
   ```bash
   git tag -a v2.0.0 -m "v2.0.0"
   git push origin v2.0.0
   ```

   Never use `git push --tags`; unrelated local tags may exist.

5. `publish.yml` automatically:
   - Runs full tests in a job that has no OIDC permission
   - Uses a dependent minimal OIDC job with `npm ci --ignore-scripts`
   - Builds and packs once in that job, tests both privileged wrappers from the
     exact tarball, and records its SHA-256
   - Rechecks the hash and publishes that same `.tgz` to npm; it never publishes
     the checkout directory

6. After npm publication succeeds, create the GitHub Release explicitly and
   keep it out of the latest pointer:
   ```bash
   AGENT_GH_LATEST_BEFORE=$(gh api repos/vidaldiego/zn-vault-agent/releases/latest --jq .tag_name)
   gh release create v2.0.0 --verify-tag --generate-notes --latest=false
   ```

7. Verify the npm version, integrity/provenance, unchanged npm 1.x `latest`, and
   unchanged GitHub latest-release pointer.

### npm Package

- **Package:** `@zincapp/zn-vault-agent`
- **Registry:** https://www.npmjs.com/package/@zincapp/zn-vault-agent
- **Channels:** `latest` (stable), `beta` (pre-release), `next` (dev builds),
  `dr-m4` (fenced Agent 2 migration; Agent 2 updater default)
- **Agent 2.x migration fence:** stable 2.x artifacts publish under `dr-m4`.
  Agent 2 accepts and defaults to that channel while periodic update stays
  disabled by default. `latest` remains on Agent 1.x until a separate
  fleet-migration decision with registry and node receipts.

### Verification

```bash
# Check published version
npm view @zincapp/zn-vault-agent@2.0.0 version dist.integrity
npm view @zincapp/zn-vault-agent dist-tags --json
test "$(npm view @zincapp/zn-vault-agent dist-tags.latest)" = "$AGENT_LATEST_BEFORE"
test "$(gh api repos/vidaldiego/zn-vault-agent/releases/latest --jq .tag_name)" = "$AGENT_GH_LATEST_BEFORE"
test "$AGENT_GH_LATEST_BEFORE" != "v2.0.0"
gh release view v2.0.0 --json tagName,isDraft,isPrerelease \
  --jq 'select(.tagName == "v2.0.0" and .isDraft == false and .isPrerelease == false)'

# Install the fenced release by exact version (does not consume latest)
npm install -g @zincapp/zn-vault-agent@2.0.0
```

### CI/CD Configuration

- `.github/workflows/ci.yml`: lint, typecheck, build, and unit tests for pushes
  and pull requests on Node.js 22.13 and 24.
- `.github/workflows/publish.yml`: unprivileged tag/release gates, followed by a
  minimal OIDC job that installs without lifecycle scripts, builds one immutable
  tarball, tests its wrappers, and publishes the same SHA-256-checked artifact.
- Neither workflow creates a GitHub Release; use the explicit `gh release
  create ... --latest=false` step above.

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
sudo journalctl -u zn-vault-agent -o cat --no-pager | grep "Managed API keys tracked"
# Should show: {"totalManagedKeys":N,...}

# Check WebSocket subscription
sudo journalctl -u zn-vault-agent -o cat --no-pager | grep "Subscriptions updated" | tail -1
# Should show: "managedKeys":["your-key-name"]
```

**Workaround (if upgrade not possible):** Restart the agent - it auto-fixes stale API key files on startup.

### Sudo-free self-update (.path activation, 2026-06-22)

The strict agent systemd profile (empty CapabilityBoundingSet + PrivateDevices)
blocks `sudo`, breaking the old `sudo systemctl start updater` path. Self-update
now uses a file trigger: the agent publishes an immutable mode-0600 v1 record
under `/var/lib/zn-vault-agent/.update-trigger`; a root-owned
`zn-vault-agent-updater.path` (PathExists) activates the updater oneshot, whose
ExecStart is `/usr/local/lib/zn-vault-agent/zn-vault-agent-update.sh`. The
wrapper validates exact current/target/channel, retains the trigger through
npm, publishes root-owned terminal evidence, and owns restart/reconciliation;
there is no ExecStartPost. Unprivileged updates fail closed when the `.path`
rail is not active; there is no direct sudo/npm fallback. Agent 2 defaults to
the fenced `dr-m4` channel and also recognizes `latest | beta | next`. Design:
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
- API key file has the old key after rotation
- Logs show "API key written and verified" but file has wrong value
- Config file has the correct new value, but the key file has the old value
- Multiple rotation events logged (duplicate handling)

**Verification:**
```bash
# Compare exact values without printing either credential or a fragment
sudo sh -c '[ "$(cat /var/lib/zn-vault-agent/secrets/ZINC_CONFIG_VAULT_API_KEY)" = "$(jq -r .auth.apiKey /etc/zn-vault-agent/config.json)" ]'
```

**Workaround (if upgrade not possible):** Restart the agent - it auto-fixes stale API key files on startup via `syncManagedKeyFile()`.

### Rail-Detected Rotations Not Propagated to Consumers (Fixed in v1.23.0)

**Issue (2026-07-05 production incident):** When the WebSocket `apikey.rotated`
event was lost, plugin-deployed API key files (payara's
`ZINC_CONFIG_VAULT_API_KEY`) stayed stale for the whole grace period even
though the agent itself kept working — consumers started failing with 401 when
grace expired, and only an agent restart re-rendered the file.

**Root Cause:** The plugin key file had exactly ONE runtime refresh path: the
live WebSocket rotation event (`handleApiKeyRotationEvent` → bind → plugin
`keyRotated` dispatch). The managed-key renewal service's polling safety rails
(scheduled refresh at `nextRotationAt`−30s, grace poll, heartbeat, reconnect)
DID detect the rotation and updated the agent's own credentials
(config + `process.env`), but their `onKeyChanged` callback only reconnected
the WebSocket — no plugin dispatch, no exec env-file update, and (in
disk-config mode) no mutation of the live config object plugins read via
`ctx.config`. The hourly "Secret sync complete ... success: N" poll is
truthful but structurally blind: it only covers `secretTargets`, which the
key file is not part of.

**Fix Location:** `src/lib/key-rotation-propagation.ts` — a single propagator
both channels go through (live config mutation, plugin `keyRotated` dispatch,
exec env-file update, optional child restart, per-key serialized duplicate
suppression, stale-detection guard, retry-on-partial-failure). Wired in
`src/lib/websocket.ts` (`handleApiKeyRotationEvent` + the
`onManagedKeyChanged` callback) and `src/commands/exec.ts` (watch mode). The
renewal service's `onKeyChanged` callback now carries rotation metadata
(`KeyChangeMeta`). Tracked keys BEYOND the agent's own (exec/plugin
`api-key:` mappings) get their polling rail from
`src/services/managed-key/tracked-keys-poller.ts`, which binds each such key
on a per-key schedule and feeds the propagator.

**Symptoms (if running < v1.23.0):**
- Key file value differs from the agent's current managed-key value after a
  rotation, while agent logs show hourly sync success
- Journal shows `Managed key rotated` (source: scheduled/grace_poll/
  heartbeat/reconnect) with NO subsequent plugin `keyRotated` log
- Consumers (e.g. ZincAPI KMS calls) fail with 401 when grace expires

**Verification (v1.23.0+):**
```bash
# Force a rotation, then watch for the propagation log WITHOUT restarting:
sudo journalctl -u zn-vault-agent -o cat --no-pager | grep "Managed key rotation propagated to consumers"
# Confirm the protected key file changed without printing any credential bytes:
sudo stat -c '%y %n' /var/lib/zn-vault-agent/secrets/ZINC_CONFIG_VAULT_API_KEY
```

**Workaround (if upgrade not possible):** Restart the agent after rotations,
or trigger rotations only when a restart window is available.

**Status:** Fixed in v1.23.0, verified in production 2026-07-06 on the
payara-staging fleet (.55–.58): forced rotation propagated to all four key
files in seconds without agent restarts (source `ws_event`), and a
rotation-while-agent-down test recovered at startup (source `scheduled`,
redelivered events deduped).

**Rollout gotchas (payara hosts):** `znvault agent update` needs the target
IP + `znvault ssh config set user sysadmin`; an agent restart bounces Payara
(aggressive-mode startup) and hits a pre-existing 30s plugin `onStart`
timeout mid-deploy that self-heals via the health check ("Plugin recovered
from error state"); `systemctl stop zn-vault-agent` also stops ZincAPI (the
Payara JVM lives in the agent's cgroup).

See `docs/POSTMORTEM-2026-07-05-MANAGED-KEY-ROTATION-PROPAGATION.md` for the
full analysis, rollout record, and follow-ups.

See `docs/TROUBLESHOOTING.md` for more details.
