# ZnVault Agent Configuration Guide

This guide helps you choose the right configuration approach and understand the key concepts.

> Once an agent is running, see
> [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) for fleet health
> checks, the `lastSync` persistence quirk, persistent-vs-ephemeral
> state, and server-side inspection commands.

## Quick Start: Choose Your Path

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    WHICH APPROACH SHOULD I USE?                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Are you deploying MULTIPLE servers with the SAME role?                     │
│  (e.g., 3 HAProxy nodes, 5 app servers)                                     │
│                                                                             │
│     YES ──► PATH A: Host Templates + Config-from-Vault (Recommended)        │
│             - One template in vault, many agents pull from it               │
│             - Centralized management, push config updates                   │
│             - Best for: fleets, auto-scaling, identical servers             │
│                                                                             │
│     NO ──► Are you running a SINGLE unique server?                          │
│                                                                             │
│        YES ──► PATH B: Bootstrap Token + Local Config                       │
│                - Secure provisioning with one-time token                    │
│                - Config stored on the server                                │
│                - Best for: unique servers, simple setups                    │
│                                                                             │
│        NO ──► Are you just running a COMMAND with secrets?                  │
│               (no daemon needed)                                            │
│                                                                             │
│           YES ──► PATH C: Exec Mode (One-Shot)                              │
│                   - No config file needed                                   │
│                   - Inject secrets and run command                          │
│                   - Best for: CI/CD, scripts, containers                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Concepts

Before diving into the paths, understand these core concepts:

### The Three Things an Agent Needs

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  1. AUTHENTICATION     How does the agent prove its identity?               │
│     ───────────────                                                         │
│     • Bootstrap Token  → One-time token, exchanged for API key (BEST)       │
│     • Managed API Key  → Auto-rotating key managed by vault                 │
│     • Static API Key   → Manual rotation required (NOT recommended)         │
│                                                                             │
│  2. CONFIGURATION      What certificates/secrets should it sync?            │
│     ─────────────                                                           │
│     • Config-from-Vault → Agent pulls config from vault server              │
│     • Local Config File → Config stored in /etc/zn-vault-agent/config.json  │
│                                                                             │
│  3. OPERATION MODE     How does the agent run?                              │
│     ──────────────                                                          │
│     • Daemon           → Continuous sync with WebSocket/polling             │
│     • Exec             → Run command once with secrets injected             │
│     • Combined         → Daemon + managed child process                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### How the Pieces Connect

```
                              VAULT SERVER
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐       │
│  │  HOST TEMPLATE   │    │   MANAGED KEY    │    │ BOOTSTRAP TOKEN  │       │
│  │  "haproxy-prod"  │◄───│  "haproxy-key"   │◄───│    zrt_abc...    │       │
│  │                  │    │                  │    │   (one-time)     │       │
│  │  targets: [...]  │    │  rotates: 24h    │    │   expires: 1h    │       │
│  │  secrets: [...]  │    │  grace: 5min     │    │                  │       │
│  └────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘       │
│           │                       │                       │                 │
└───────────┼───────────────────────┼───────────────────────┼─────────────────┘
            │                       │                       │
            │ (pulls config)        │ (binds to get key)    │ (exchanges for key)
            │                       │                       │
            ▼                       ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AGENT                                          │
│                                                                             │
│  1. Agent starts with bootstrap token                                       │
│  2. Exchanges token → receives API key + hostConfigId                       │
│  3. Binds to managed key → receives current key value                       │
│  4. Pulls config from host template (if configFromVault: true)              │
│  5. Syncs certificates and secrets                                          │
│  6. Connects WebSocket for real-time updates                                │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## PATH A: Host Templates + Config-from-Vault

**Best for:** Multiple identical servers, auto-scaling groups, fleet management

### Overview

With this approach:
- Admin creates ONE host template in vault
- MANY agents pull configuration from that template
- Config changes are pushed to all agents automatically

### Step 1: Create Host Template (Admin, one time)

```bash
# Create a host template with a linked managed key
znvault host create haproxy-prod \
  --managed-key haproxy-prod-key \
  --tenant my-tenant

# Output:
# ✓ Host template created: haproxy-prod
# ✓ Managed API key created: haproxy-prod-key
```

### Step 2: Configure the Template (Admin)

```bash
# Edit the template configuration
znvault host config haproxy-prod --edit
```

Or create a JSON file and import it:

```json
{
  "targets": [
    {
      "certId": "uuid-of-certificate",
      "name": "frontend-ssl",
      "outputs": {
        "combined": "/etc/haproxy/certs/frontend.pem"
      },
      "owner": "haproxy:haproxy",
      "mode": "0640",
      "reloadCmd": "systemctl reload haproxy"
    }
  ],
  "secretTargets": [
    {
      "secretId": "alias:haproxy/stats-password",
      "name": "stats-creds",
      "format": "env",
      "output": "/etc/haproxy/secrets.env"
    }
  ],
  "pollInterval": 3600
}
```

```bash
znvault host config haproxy-prod --import haproxy-config.json
```

### Step 3: Generate Bootstrap Token (Admin, per server)

```bash
# Generate a one-time token for provisioning
znvault host token haproxy-prod

# Output:
# Bootstrap token (expires in 1 hour):
# zrt_a1b2c3d4e5f6...
#
# Install command:
# curl -fsSL https://vault.example.com/v1/hosts/bootstrap.sh | \
#   BOOTSTRAP_TOKEN='<token>' bash
```

### Step 4: Bootstrap Agent (On target server)

**Option A: One-command bootstrap**
```bash
curl -fsSL https://vault.example.com/v1/hosts/bootstrap.sh | \
  BOOTSTRAP_TOKEN='<token>' bash
```

**Option B: Manual setup**

All persistent commands in systemd recipes must run as the service identity
against the system config directory; abbreviated examples later in this guide
assume the same prefix:

```bash
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent <command>
```

```bash
# Install agent
npm install -g @zincapp/zn-vault-agent
sudo zn-vault-agent setup --yes

# Bootstrap with token (hostname auto-detected from machine)
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login \
  --url https://vault.example.com \
  --bootstrap-token zrt_a1b2c3d4...

# Or with explicit hostname
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login \
  --url https://vault.example.com \
  --bootstrap-token zrt_a1b2c3d4... \
  --host-name haproxy-prod-01

# Start daemon
sudo systemctl enable --now zn-vault-agent
```

**Note:** The `--host-name` flag is optional. If not specified, the agent uses the machine's hostname (from `os.hostname()`). Use `--host-name` to override when the machine hostname doesn't match your naming convention.

### What Happens During Bootstrap

```
1. Agent receives bootstrap token: zrt_abc123...

2. Agent calls: POST /v1/hosts/{hostname}/register
   Body: { "token": "zrt_abc123..." }

3. Vault responds:
   {
     "apiKey": "znv_xyz789...",        ← Fresh API key
     "agentId": "agent-001",           ← Unique agent ID
     "hostConfigId": "haproxy-prod",   ← Links to host template
     "managedKeyName": "haproxy-key",  ← For auto-rotation
     "tenantId": "my-tenant"
   }

4. Agent saves to config.json:
   {
     "vaultUrl": "https://vault.example.com",
     "auth": { "apiKey": "znv_xyz789..." },
     "configFromVault": true,           ← Enables config pull
     "hostConfigId": "haproxy-prod",
     "agentId": "agent-001",
     "managedKey": { "name": "haproxy-key" }
   }

5. Agent pulls config from host template (targets, secrets, plugins)

6. Agent syncs certificates and secrets

7. Agent connects WebSocket for real-time updates
```

### Pushing Config Updates

When you update the host template, all connected agents receive the new config:

```bash
# Edit the template
znvault host config haproxy-prod --edit

# Or sync immediately (doesn't wait for poll)
znvault host sync haproxy-prod
```

Agents receive a `HostConfigUpdated` event via WebSocket and pull the new config.

---

## PATH B: Bootstrap Token + Local Config

**Best for:** Unique servers, simple setups, servers that don't share config

### Overview

With this approach:
- Admin creates a managed key and bootstrap token
- Agent bootstraps and gets an API key
- Configuration is stored locally on the server

### Step 1: Create Managed Key (Admin)

```bash
znvault apikey create \
  --name server1-key \
  --tenant my-tenant \
  --managed \
  --rotation-mode scheduled \
  --rotation-interval 24h \
  --permissions certificate:read:metadata,certificate:read:value
```

### Step 2: Generate Bootstrap Token (Admin)

```bash
znvault agent token create --managed-key server1-key

# Output:
# zrt_a1b2c3d4e5f6...
```

### Step 3: Bootstrap Agent (On server)

```bash
# Install
npm install -g @zincapp/zn-vault-agent
sudo zn-vault-agent setup --yes

# Bootstrap
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login \
  --url https://vault.example.com \
  --bootstrap-token zrt_a1b2c3d4...
```

### Step 4: Configure Locally

```bash
# Add certificates to sync
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent certs add <cert-id> \
  --name nginx-ssl \
  --fullchain /etc/ssl/znvault/nginx-cert.pem \
  --key /etc/ssl/znvault/nginx-key.pem \
  --reload "sudo /usr/bin/systemctl reload nginx"

# Add secrets to sync (optional)
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent secret add alias:example/app-config \
  --format json \
  --output /var/lib/zn-vault-agent/myapp-config.json \
  --reload "sudo /usr/bin/systemctl restart myapp"
```

Provision each exact reload/restart command as its own least-privilege sudoers
fragment, validate it with `visudo -cf`, and never overwrite the
setup-managed `/etc/sudoers.d/zn-vault-agent` file. The example output paths
remain inside the base unit's allowed write paths.

### Step 5: Start Daemon

```bash
sudo systemctl enable --now zn-vault-agent
```

### Resulting Config File

```json
{
  "vaultUrl": "https://vault.example.com",
  "tenantId": "my-tenant",
  "auth": {
    "apiKey": "znv_xyz789..."
  },
  "managedKey": {
    "name": "server1-key",
    "rotationMode": "scheduled",
    "nextRotationAt": "2026-01-31T10:00:00Z"
  },
  "targets": [
    {
      "certId": "uuid-of-cert",
      "name": "nginx-ssl",
      "outputs": {
        "fullchain": "/etc/nginx/ssl/cert.pem",
        "key": "/etc/nginx/ssl/key.pem"
      },
      "reloadCmd": "systemctl reload nginx"
    }
  ],
  "secretTargets": [
    {
      "secretId": "alias:app/config",
      "name": "app-config",
      "format": "json",
      "output": "/etc/myapp/config.json",
      "reloadCmd": "systemctl restart myapp"
    }
  ]
}
```

---

## PATH C: Exec Mode (One-Shot)

**Best for:** CI/CD pipelines, scripts, containers, one-time commands

### Overview

With this approach:
- No daemon, no config file
- Secrets are fetched, injected as environment variables, command runs
- Process exits when command completes

### Basic Usage

```bash
# Single secret
zn-vault-agent exec \
  --url https://vault.example.com \
  --api-key znv_abc123... \
  -s DB_PASSWORD=alias:db/prod.password \
  -- node server.js

# Multiple secrets
zn-vault-agent exec \
  -s DB_HOST=alias:db/prod.host \
  -s DB_PASSWORD=alias:db/prod.password \
  -s API_KEY=api-key:my-managed-key \
  -- ./deploy.sh
```

### Secret Mapping Types

| Type | Format | Description |
|------|--------|-------------|
| Vault Secret | `alias:path/to/secret.field` | Specific field from a secret |
| Vault Secret | `alias:path/to/secret` | Entire secret as JSON |
| Managed Key | `api-key:key-name` | Binds and gets current key value |
| Literal | `literal:value` | Pass-through value (no fetch) |

### Env File Injection

Inject ALL key-value pairs from a secret as environment variables:

```bash
# If secret at alias:env/prod contains:
# { "DB_HOST": "localhost", "DB_PORT": "5432", "DB_USER": "app" }

zn-vault-agent exec -e alias:env/prod -- printenv
# Output:
# DB_HOST=localhost
# DB_PORT=5432
# DB_USER=app

# With prefix:
zn-vault-agent exec -e alias:env/prod:APP_ -- printenv
# Output:
# APP_DB_HOST=localhost
# APP_DB_PORT=5432
# APP_DB_USER=app
```

### Combined with Daemon (Combined Mode)

Run daemon AND child process in a single instance:

```bash
zn-vault-agent start \
  --exec "python server.py" \
  -s DB_PASSWORD=alias:db.password \
  -F API_KEY=api-key:my-key \
  --restart-on-change \
  --health-port 9100
```

- `-s`: Secret as environment variable (visible in logs)
- `-F`, `--secret-file`: Secret as FILE (prevents log exposure, recommended for sensitive values)

---

## Configuration Reference

### Minimal Configs for Each Path

**Path A: Config-from-Vault**
```json
{
  "vaultUrl": "https://vault.example.com",
  "auth": { "apiKey": "znv_..." },
  "configFromVault": true,
  "hostConfigId": "haproxy-prod"
}
```

**Path B: Local Config**
```json
{
  "vaultUrl": "https://vault.example.com",
  "tenantId": "my-tenant",
  "auth": { "apiKey": "znv_..." },
  "targets": [...],
  "secretTargets": [...]
}
```

**Path C: Exec Mode**
```bash
# No config file - pass options via CLI or environment variables
ZNVAULT_URL=https://vault.example.com \
ZNVAULT_API_KEY=znv_... \
zn-vault-agent exec -s SECRET=alias:path.key -- ./command
```

### Full Configuration Schema

```typescript
interface AgentConfig {
  // === REQUIRED ===
  vaultUrl: string;                    // Vault server URL
  auth: {
    apiKey?: string;                   // API key (recommended)
    bootstrapToken?: string;           // One-time registration token
    username?: string;                 // Username (not recommended)
    password?: string;                 // Password (not recommended)
  };

  // === IDENTIFICATION ===
  tenantId?: string;                   // Auto-detected from API key if omitted
  hostname?: string;                   // For bootstrap registration
  agentId?: string;                    // Assigned during registration

  // === CONFIG SOURCE ===
  configFromVault?: boolean;           // Pull config from vault (default: false)
  hostConfigId?: string;               // Host template ID
  configVersion?: number;              // Last known config version

  // === MANAGED KEY ===
  managedKey?: {
    name: string;                      // Key name in vault
    rotationMode?: 'scheduled' | 'on-use' | 'on-bind';
    nextRotationAt?: string;           // ISO timestamp
    graceExpiresAt?: string;
  };

  // === CERTIFICATE TARGETS ===
  targets: Array<{
    certId: string;                    // Certificate ID or alias
    name: string;                      // Human-readable name
    outputs: {
      combined?: string;               // cert + key (HAProxy)
      cert?: string;                   // Certificate only
      key?: string;                    // Private key only
      chain?: string;                  // CA chain
      fullchain?: string;              // cert + chain (Nginx)
    };
    owner?: string;                    // user:group
    mode?: string;                     // e.g., "0640"
    reloadCmd?: string;                // Run after deployment
    healthCheckCmd?: string;           // Verify deployment
  }>;

  // === SECRET TARGETS ===
  secretTargets?: Array<{
    secretId: string;                  // alias:path or UUID
    name: string;
    format: 'env' | 'json' | 'yaml' | 'raw' | 'template' | 'none';
    output?: string;                   // File path
    key?: string;                      // For raw format
    templatePath?: string;             // For template format
    envPrefix?: string;                // For env format
    owner?: string;
    mode?: string;
    reloadCmd?: string;
  }>;

  // === EXEC (COMBINED MODE) ===
  exec?: {
    command: string[];
    secrets: Array<{
      envVar: string;
      source: string;                  // alias:, api-key:, or literal:
      toFile?: boolean;                // Write to file instead of env
    }>;
    inheritEnv?: boolean;              // Default: true
    restartOnChange?: boolean;         // Default: true
    restartDelayMs?: number;           // Default: 5000
    maxRestarts?: number;              // Default: 10
    restartWindowMs?: number;          // Default: 300000
  };

  // === CONNECTION ===
  pollInterval?: number;               // Seconds, default: 3600
  insecure?: boolean;                  // Skip TLS verification (dev only!)
  caCertPath?: string;                 // Custom CA certificate

  // === TLS (HEALTH SERVER) ===
  tls?: {
    enabled: boolean;
    certPath?: string;                 // Manual mode
    keyPath?: string;                  // Manual mode
    httpsPort?: number;                // Default: 9443
    renewBeforeDays?: number;          // Default: 7
    keepHttpServer?: boolean;          // Default: true
  };

  // === PLUGINS ===
  plugins?: Array<{
    package?: string;                  // npm package name
    path?: string;                     // Local file path
    config?: object;                   // Plugin-specific config
    enabled?: boolean;                 // Default: true
  }>;

  // === MISC ===
  globalReloadCmd?: string;            // Default reload for all targets
  verbose?: boolean;
}
```

### Environment Variables

Environment variables override config file values:

| Variable | Description |
|----------|-------------|
| `ZNVAULT_URL` | Vault server URL |
| `ZNVAULT_TENANT_ID` | Tenant ID |
| `ZNVAULT_API_KEY` | API key |
| `ZNVAULT_INSECURE` | Skip TLS verification (`true`/`false`) |
| `ZNVAULT_AGENT_CONFIG_DIR` | Custom config directory |
| `ZNVAULT_CONTROL_TOKEN_FILE` | Token-file path override for isolated tests/install roots; never the token value |
| `LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error` |
| `LOG_FILE` | Optional file mirror; journald logging remains enabled |
| `AUTO_UPDATE` | Enable auto-updates (`true`/`false`) |
| `AUTO_UPDATE_INTERVAL` | Check interval in seconds |
| `AUTO_UPDATE_CHANNEL` | `latest`, `beta`, `next`, `dr-m4` (Agent 2 default: `dr-m4`) |

Production setup creates `/etc/zn-vault-agent/payara-mutation-token` as the
service user with mode `0600`. The daemon fails closed if it cannot safely load
that file. Only `/health`, `/ready`, `/live`, and `/metrics` are public; every
other HTTP/HTTPS route requires its Bearer value, and Payara plugin routes check
the same value again. Do not copy the credential into argv, environment values,
logs, shell history, or temporary files.

---

## Troubleshooting

### Which config model am I using?

```bash
# Check config file
cat /etc/zn-vault-agent/config.json | jq '.configFromVault'

# If true  → Config-from-Vault (Path A)
# If false/null → Local Config (Path B)
```

### Is my agent registered with a host template?

```bash
cat /etc/zn-vault-agent/config.json | jq '{hostConfigId, agentId, managedKey}'
```

### Why isn't my agent getting config updates?

1. Check `configFromVault` is `true`
2. Check WebSocket is connected: `curl http://localhost:9100/health | jq .websocket`
3. Check config version: `znvault host get <template-name> --json | jq .version`
4. Compare with agent: `cat /etc/zn-vault-agent/config.json | jq .configVersion`

### How do I switch from local config to config-from-vault?

1. Create host template: `znvault host create <name> --managed-key <key>`
2. Import current config: `znvault host config <name> --import /etc/zn-vault-agent/config.json`
3. Update agent config:
   ```bash
   sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
     zn-vault-agent login --url https://vault.example.com --bootstrap-token <new-token>
   # Or manually set configFromVault: true
   ```

---

## Common Patterns

### Pattern: Auto-Scaling Group

```
1. Create ONE host template: "app-server-pool"
2. Configure targets/secrets in template
3. In launch template/cloud-init:
   - Install agent
   - Bootstrap with fresh token (generate per-instance)
   - Start daemon
4. All instances pull same config from template
```

### Pattern: Blue-Green Deployment

```
1. Create TWO host templates: "app-blue", "app-green"
2. Bootstrap blue instances with blue template
3. Bootstrap green instances with green template
4. Update certs in active template → automatic rollout
```

### Pattern: Secrets-Only (No Certificates)

```bash
# Local config with no certificate targets
zn-vault-agent secret add alias:app/config \
  --format json \
  --output /etc/myapp/config.json

# Start daemon
zn-vault-agent start --health-port 9100
```

### Pattern: Container Sidecar

```yaml
# docker-compose.yml
services:
  app:
    image: myapp
    environment:
      - CONFIG_FILE=/secrets/config.json
    volumes:
      - secrets:/secrets:ro

  vault-agent:
    image: node:22.13-alpine
    command: npx @zincapp/zn-vault-agent start --health-port 9100
    environment:
      - ZNVAULT_URL=https://vault.example.com
      - ZNVAULT_API_KEY=${VAULT_API_KEY}
    volumes:
      - secrets:/secrets
      - ./agent-config.json:/etc/zn-vault-agent/config.json

volumes:
  secrets:
```

---

## Summary: Decision Matrix

| Criteria | Path A: Host Templates | Path B: Local Config | Path C: Exec Mode |
|----------|----------------------|---------------------|-------------------|
| **Best for** | Fleets, identical servers | Unique servers | Scripts, CI/CD |
| **Config location** | Vault server | Local file | CLI arguments |
| **Push updates** | Yes (WebSocket) | No (manual edit) | N/A |
| **Daemon required** | Yes | Yes | No |
| **Setup complexity** | Medium (admin + server) | Low (server only) | Lowest |
| **Scalability** | Excellent | Per-server | Per-invocation |

**When in doubt, use Path A (Host Templates)** - it's the most flexible and scalable approach.
