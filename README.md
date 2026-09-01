# ZnVault Certificate Agent

Real-time certificate distribution agent for ZnVault. Automatically syncs TLS certificates from your vault to target servers with zero-downtime deployments.

## 🚀 Which Approach Should I Use?

> **📖 For detailed guidance, see [docs/CONFIGURATION_GUIDE.md](docs/CONFIGURATION_GUIDE.md)**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Deploying MULTIPLE servers with the SAME role? (e.g., 3 HAProxy nodes)    │
│                                                                             │
│     YES ──► HOST TEMPLATES + CONFIG-FROM-VAULT                              │
│             One template in vault, all agents pull from it                  │
│             See: docs/CONFIGURATION_GUIDE.md → "PATH A"                     │
│                                                                             │
│     NO ──► Deploying a SINGLE unique server?                                │
│                                                                             │
│        YES ──► BOOTSTRAP TOKEN + LOCAL CONFIG                               │
│                Secure provisioning, config stored on server                 │
│                See: docs/CONFIGURATION_GUIDE.md → "PATH B"                  │
│                                                                             │
│        NO ──► Just running a COMMAND with secrets? (no daemon)              │
│                                                                             │
│           YES ──► EXEC MODE (One-Shot)                                      │
│                   No config file, inject secrets and run                    │
│                   See: docs/CONFIGURATION_GUIDE.md → "PATH C"               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### TL;DR Quick Start

**Path A - Fleet/Multiple Servers (Recommended for production):**
```bash
# Admin: Create host template
znvault host create haproxy-prod --managed-key haproxy-key
znvault host config haproxy-prod --edit  # Add targets, secrets

# Admin: Generate bootstrap token
znvault host token haproxy-prod
# Output: zrt_abc123...

# On each server (hostname auto-detected, or use --host-name to override):
npm install -g @zincapp/zn-vault-agent
sudo zn-vault-agent setup --yes
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login --url https://vault.example.com \
  --bootstrap-token zrt_abc123...

# Or one-command bootstrap:
curl -fsSL https://vault.example.com/v1/hosts/bootstrap.sh | \
  BOOTSTRAP_TOKEN=zrt_abc123... bash
```

**Path B - Single Server:**
```bash
npm install -g @zincapp/zn-vault-agent
sudo zn-vault-agent setup --yes
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login --url https://vault.example.com --bootstrap-token zrt_...
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent certs add <cert-id> --combined /etc/ssl/znvault/haproxy-frontend.pem
sudo systemctl enable --now zn-vault-agent
```

**Path C - One-Shot Command:**
```bash
zn-vault-agent exec \
  -s DB_PASSWORD=alias:db/prod.password \
  -s API_KEY=api-key:my-managed-key \
  -- ./my-script.sh
```

---

## Features

### Certificate Sync
- **Real-time updates**: WebSocket connection for instant certificate rotation
- **Fallback polling**: Periodic sync when WebSocket is unavailable
- **Atomic deployments**: Uses temp files and rename for safe updates
- **Automatic rollback**: Reverts on reload or health check failure
- **Multiple output formats**: Combined (HAProxy), separate cert/key/chain, fullchain (Nginx)

### Secret Sync
- **File output formats**: `.env`, JSON, YAML, raw value, or custom templates
- **Automatic sync**: Keep local secret files in sync with vault
- **Reload hooks**: Run commands after secrets are updated

### Exec Mode
- **Zero-config injection**: Run any command with secrets as environment variables
- **Secure file mode**: Write secrets to files instead of env vars (prevents log exposure)
- **No disk persistence**: Secrets stored on tmpfs, never touch disk
- **Signal forwarding**: Graceful shutdown of child processes

### Combined Mode (NEW)
- **Daemon + Exec**: Single instance handles both cert sync and child process management
- **Auto-restart**: Child process restarts automatically when certs or secrets change
- **Crash recovery**: Automatic restart with rate limiting on child crashes
- **Unified health**: Single health endpoint showing daemon and child status

### General
- **Prometheus metrics**: Full observability via `/metrics` endpoint
- **Graceful shutdown**: Completes in-flight deployments before exit
- **Structured logging**: JSON logs with sensitive field redaction
- **Auto-updates**: Automatic npm-based updates with graceful restarts
- **API key auto-renewal**: Automatic rotation before expiry

## Authentication

The agent supports three authentication methods:

### Bootstrap Token (Recommended for Production)

The most secure way to provision new agents. A one-time registration token is used to bind the agent to a managed API key with automatic rotation.

```bash
# 1. Admin creates a host template with managed key and generates a bootstrap token
znvault host create my-server --managed-key my-server-key
znvault host token my-server
# Output: zrt_abc123... (one-time use, expires in 1h)

# 2. Pass token to new server via cloud-init, Ansible, etc.

# 3. Agent bootstraps with the token (hostname auto-detected)
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login --url https://vault.example.com \
  --bootstrap-token zrt_abc123...

# Or with explicit hostname:
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login --url https://vault.example.com \
  --bootstrap-token zrt_abc123... \
  --host-name my-server-01
```

**Benefits:**
- No static credentials to manage
- Token is consumed immediately (one-time use)
- Agent automatically uses managed key with auto-rotation
- Short TTL (max 24h) limits exposure window
- Agent is linked to host template for centralized config management
- Hostname auto-detected from machine (use `--host-name` to override)

### Managed API Key

If you already have a managed API key, the agent auto-detects it and enables auto-rotation:

```bash
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login --url https://vault.example.com \
  --api-key znv_abc123...
# Agent detects managed key, retrieves tenant, and binds automatically
```

### Static API Key (Not Recommended)

For development or testing only. Static keys don't auto-rotate and require manual renewal:

```bash
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login --url https://vault.example.com \
  --api-key znv_abc123...
# Warning displayed recommending managed keys
```

## Quick Start

### Option A: npm Install (Recommended)

The fastest way to install on Linux servers:

```bash
# Install globally via npm
npm install -g @zincapp/zn-vault-agent

# Setup systemd service (as root)
sudo zn-vault-agent setup --yes
```

For an Agent 1 → Agent 2 commissioning, first prove the legacy updater is
inactive and no old trigger remains. Either failing command is a NO-GO; setup
will preserve and reject incompatible trigger evidence rather than deleting it:

```bash
! sudo systemctl is-active --quiet zn-vault-agent-updater.service
sudo test ! -e /var/lib/zn-vault-agent/.update-trigger
```

If `configFromVault: true` has no authoritative local plugin declaration and
the exact global Payara package is still 2.x, Agent 2 records it only as a
recovery candidate. A reachable Vault still wins (`200` replaces the cache;
`304` validates it). Only an authentication, bootstrap, or config-fetch failure
opens the authenticated `UPDATE_REQUIRED` plane. This keeps the exact 2 -> 3
updater reachable during a Vault outage without importing the legacy plugin,
starting Payara, or letting stale disk state override Vault.

After the root helper has installed the exact requested 3.x artifact, startup
confirmation remains pending until that plugin actually starts. The next boot
requires a complete Vault `200` (never `304`). If Vault is still unavailable,
only the exact active operation + matching successful root receipt + restart
marker + installed target manifest opens `STARTUP_CONFIRMATION_PENDING`; its
authenticated GET stays `202` while a 30-second probe retries persisted
bootstrap/auth and full config authority without restart-looping. One graceful
restart is requested after a full `200`, and GET becomes `200` only after the
normal remote config loads Payara 3 and its startup hook succeeds. Arbitrary
missing, corrupt, 3.x, or future undeclared manifests cannot authorize either
fallback. Publishing Agent 2 and Plugin 3 does not commission them on a
production node.

**Requirements:** Node.js 22.13.0 or newer must be installed. The package
manager enforces the same minimum through `engines.node`.

**What `setup` does:**

1. Creates `zn-vault-agent` system user/group
2. Creates directories: `/etc/zn-vault-agent/`, `/var/lib/zn-vault-agent/`, `/var/log/zn-vault-agent/`
3. Installs systemd service (enabled but not started)
4. Creates config template at `/etc/zn-vault-agent/agent.env`
5. Creates `/etc/zn-vault-agent/config.json` as `zn-vault-agent`, mode `0600`
6. Creates the local mutation-plane credential at
   `/etc/zn-vault-agent/payara-mutation-token` as `zn-vault-agent`, mode `0600`;
   an existing valid credential is never overwritten and its value is never printed
7. Installs and starts the root-owned updater `.path` watcher plus its wrapper
8. Installs a validated `NOPASSWD` sudoers fragment for the bounded updater command
9. On detected Payara hosts only, changes `/var/lib/zn-vault-agent` to
   `zn-vault-agent:<Payara-primary-group>` mode `2750`, adds the Agent account to
   that group, and installs a systemd drop-in carrying the same supplementary
   group. This lets Payara read `0640` API-key rotations without granting it write
   access to the Agent state directory.
10. On detected Payara hosts only, the same drop-in permits sudo to the Payara
    account, grants the required `/opt` write paths, and lifts the base unit's
    memory cap for the Payara JVM

`--yes` skips the interactive summary, not these installation effects. The
updater watcher does not enable application auto-update by itself; that still
requires the explicit auto-update configuration.

For every systemd installation, run persistent commands such as `login`,
`certs add`, and `secret add` with this prefix (later abbreviated examples
assume it):

```bash
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent <command>
```

Using a different identity is rejected once the service-owned config exists,
preventing a configuration that systemd would not read.

**Install specific version or channel:**

```bash
npm install -g @zincapp/zn-vault-agent@2.0.0     # Specific version
npm install -g @zincapp/zn-vault-agent@beta      # Beta channel
npm install -g @zincapp/zn-vault-agent@next      # Development
```

After installation, configure and start:

```bash
# 1. Configure the agent (RECOMMENDED: bootstrap token)
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login --url https://vault.example.com \
  --bootstrap-token zrt_abc123...

# 2. Add certificate to sync
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent certs add <cert-id> \
  --name "haproxy-frontend" \
  --combined /etc/ssl/znvault/haproxy-frontend.pem \
  --reload "sudo /usr/bin/systemctl reload haproxy"

# 3. Start service
sudo systemctl start zn-vault-agent
```

**Alternative: API key authentication**

```bash
# If you have a managed or static API key instead of a bootstrap token
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login --url https://vault.example.com \
  --api-key znv_abc123...
```

The reload command requires a separately managed, least-privilege sudoers rule
for exactly `/usr/bin/systemctl reload haproxy`. Do not overwrite the
setup-managed `/etc/sudoers.d/zn-vault-agent` file.

### Option B: Using znvault CLI

If you already have the `znvault` CLI installed:

```bash
# Configure CLI (if not already done)
znvault config set url https://vault.example.com
znvault login -u admin -p 'password'

# Initialize agent config (uses CLI credentials)
znvault agent init

# Add a certificate to sync
znvault agent add <cert-id> \
  --name "haproxy-frontend" \
  --combined /etc/haproxy/certs/frontend.pem \
  --reload "systemctl reload haproxy"

# Test sync (one-time)
znvault agent sync

# Start the daemon
znvault agent start
```

### Option C: Build from Source

For development or customization:

```bash
# Build from source
cd zn-vault-agent
npm install
npm run build

# Install system-wide (as root)
sudo ./deploy/install.sh

# Configure
sudo vim /etc/zn-vault-agent/config.json

# Start
zn-vault-agent start --health-port 9100
```

## Authentication

The agent supports two authentication methods. **API key authentication is strongly recommended** for production deployments.

### API Key Authentication (Recommended)

API keys are more secure than passwords because:
- They can be scoped to only the permissions the agent needs
- They can be restricted by IP address
- They don't require storing user passwords
- They can be rotated independently of user credentials

#### Required Permissions

The agent needs only **two permissions** to function:

| Permission | Description |
|------------|-------------|
| `certificate:read:metadata` | View certificate metadata (expiry, fingerprint) |
| `certificate:read:value` | Decrypt and download certificate data |

#### Creating an API Key

```bash
# 1. Login to vault as admin
TOKEN=$(curl -sk -X POST https://vault.example.com/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"..."}' | jq -r '.accessToken')

# 2. Create a limited-scope API key for the agent
curl -sk -X POST https://vault.example.com/auth/api-keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "cert-agent-prod-server1",
    "expiresInDays": 365,
    "scope": "limited",
    "allowedPermissions": [
      "certificate:read:metadata",
      "certificate:read:value"
    ],
    "ipAllowlist": ["10.0.0.0/8"]
  }'

# Response includes the API key (shown only once!)
# {
#   "key": "znv_abc123...",
#   "message": "⚠️  Save this key - it will not be shown again!"
# }
```

#### Via Dashboard

In the ZnVault dashboard:
1. Navigate to **Settings** → **API Keys**
2. Click **Create API Key**
3. Set name: `cert-agent-<hostname>`
4. Set scope: **Limited**
5. Select permissions: `certificate:read:metadata`, `certificate:read:value`
6. Add IP allowlist if desired
7. Set expiration (max 365 days recommended)
8. **Save the key immediately** - it won't be shown again!

#### Security Best Practices

1. **Use limited scope**: Only grant the two required permissions
2. **Add IP allowlist**: Restrict to your server's IP or network CIDR
3. **Set expiration**: Use 365 days max, the agent will auto-renew
4. **One key per server**: Create unique keys for each agent instance
5. **Store securely**: Use `secrets.env` with `0600` permissions

#### Automatic API Key Renewal

The agent automatically renews API keys before they expire:

- **Check frequency**: Every 24 hours
- **Renewal threshold**: 30 days before expiry
- **What happens**:
  1. Agent checks key expiration via `GET /auth/api-keys/self`
  2. If expiring within 30 days, calls `POST /auth/api-keys/self/rotate`
  3. New key is saved atomically to config file
  4. Old key is immediately invalidated

**Log output during renewal:**
```
{"level":"info","msg":"API key status","expiresInDays":25,"isExpiringSoon":true}
{"level":"info","msg":"API key expiring soon, initiating rotation"}
{"level":"info","msg":"API key rotated successfully"}
{"level":"info","msg":"Config file updated with new API key"}
```

**Note**: The renewal service only runs when the daemon is active. For environments where the daemon runs intermittently, consider checking key status via `znvault agent status` and rotating manually if needed.

### Managed API Keys (Recommended)

Managed API keys provide **automatic rotation** handled by the vault server. When you use a managed API key, the agent automatically detects it and handles rotation seamlessly.

#### How It Works

1. **Auto-Detection**: During `login`, the agent calls `/auth/api-keys/self` to check if the key is managed
2. **Automatic Binding**: If managed, the agent binds to get the current key value and rotation metadata
3. **Background Renewal**: The daemon automatically refreshes the key before each rotation
4. **WebSocket Reconnection**: When the key rotates, the agent reconnects with the new key

#### Rotation Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| `scheduled` | Key rotates on a fixed schedule (e.g., every 24h) | Production services with predictable restarts |
| `on-use` | Key rotates after first use, then stays stable | Services that start infrequently |
| `on-bind` | Each bind returns a fresh key | Short-lived processes, CI/CD |

#### Creating a Managed API Key

```bash
# Via znvault CLI
znvault apikey create \
  --name "agent-prod-server1" \
  --tenant my-tenant \
  --managed \
  --rotation-mode scheduled \
  --rotation-interval 24h \
  --grace-period 5m \
  --permissions certificate:read:metadata,certificate:read:value

# Via API
curl -sk -X POST https://vault.example.com/auth/api-keys \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "agent-prod-server1",
    "permissions": ["certificate:read:metadata", "certificate:read:value"],
    "managed": {
      "rotationMode": "scheduled",
      "rotationInterval": "24h",
      "gracePeriod": "5m"
    }
  }'
```

#### Using Managed Keys with the Agent

```bash
# Just use the API key - agent auto-detects it's managed and retrieves tenant
zn-vault-agent login \
  --url https://vault.example.com \
  --api-key znv_managed_key_123...

# Output shows managed key was detected:
# ✓ Connection successful!
# ✓ Configuration saved to: /etc/zn-vault-agent/config.json
# ✓ Found 5 certificate(s) in vault
# ✓ Tenant: my-tenant
# ✓ Managed API key detected and bound
# ✓ Managed key: agent-prod-server1 (rotates: 1/6/2026, 10:00 AM)
#   Auto-rotation enabled - key will refresh before expiration
```

#### Grace Period

When a managed key rotates, both the old and new keys work during the **grace period** (default: 5 minutes). This ensures zero-downtime during rotation:

```
Time ──────────────────────────────────────────────────────────>

      │◄─── Rotation ───►│
      │                   │
Key A ████████████████████░░░░░░░░  (grace period - both work)
Key B                     ████████████████████████████████████

      │                   │
   rotation          grace expires
    event            (old key invalid)
```

#### Log Output During Rotation

```json
{"level":"info","msg":"Managed key refresh scheduled","refreshInMinutes":55,"refreshAt":"2026-01-06T09:55:00Z"}
{"level":"info","msg":"Binding to managed key","name":"agent-prod-server1"}
{"level":"info","msg":"Managed key rotated","nextRotationAt":"2026-01-07T10:00:00Z","source":"scheduled"}
{"level":"info","msg":"Managed key changed, reconnecting WebSocket"}
```

#### Benefits Over Static Keys

| Feature | Static API Key | Managed API Key |
|---------|---------------|-----------------|
| Rotation | Manual (agent self-rotate) | Automatic (vault-managed) |
| Grace Period | None (immediate invalidation) | Configurable overlap |
| Audit Trail | Key rotation events | Full rotation history |
| Coordination | Single agent | Multiple agents can share |
| Expiration Handling | Agent must self-rotate | Vault handles expiration |

#### Key Persistence & Recovery

When using managed keys, the agent automatically persists new keys to the config file after each rotation. This ensures seamless recovery after restarts:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     AGENT RESTART RECOVERY FLOW                          │
└─────────────────────────────────────────────────────────────────────────┘

1. SYSTEMD STARTS AGENT
   └── Reads /etc/zn-vault-agent/config.json
       └── Contains: auth.apiKey + managedKey.name

2. BIND TO MANAGED KEY
   │   POST /auth/api-keys/managed/{name}/bind
   │   Auth: Bearer <stored-api-key>
   │   └── Returns current valid key (same or rotated)
   │
   ▼
3. UPDATE CONFIG (if key changed)
   │   config.json: auth.apiKey = <new-key>
   │
   ▼
4. SYNC CERTIFICATES & SECRETS
   │   Compare fingerprints/versions, sync if changed
   │
   ▼
5. START CHILD PROCESS (if exec mode)
   │   Inject secrets as env vars or files
   │
   ▼
6. CONNECT WEBSOCKET
   │   Subscribe to real-time rotation events
   │
   ▼
7. SCHEDULE NEXT REFRESH
       ├── Proactive: 30s before nextRotationAt
       └── Safety poll: 50% into grace period
```

**What's stored in config.json:**

```json
{
  "auth": {
    "apiKey": "znv_current_valid_key..."   // Actual key value (updated on rotation)
  },
  "managedKey": {
    "name": "my-service-key",              // Key name (never changes)
    "rotationMode": "scheduled",
    "nextRotationAt": "2026-01-08T20:00:00Z"
  }
}
```

**Recovery scenarios:**

| Scenario | Behavior |
|----------|----------|
| Normal restart | Binds with stored key, gets current key, continues |
| Restart after rotation | Stored key still valid (grace period), gets new key |
| Restart after grace expired | Stored key is the new key (was persisted), works |
| Vault unreachable | Uses cached certs/secrets, retries bind with backoff |

**Log output during restart recovery:**
```json
{"level":"info","msg":"Starting ZnVault Agent"}
{"level":"info","msg":"Using managed API key mode"}
{"level":"info","msg":"Binding to managed key","name":"my-service-key"}
{"level":"info","msg":"Managed key bound","nextRotationAt":"2026-01-08T20:00:00Z"}
{"level":"info","msg":"WebSocket connected"}
{"level":"info","msg":"Managed key refresh scheduled","refreshInMinutes":55}
```

The agent is **stateless** - it can restart at any time and recover automatically by binding to get the current valid key.

### Agent + SDK Integration (for Applications)

When your application uses `zn-vault-sdk-node` alongside the agent, you can have the agent write the managed API key to a file that the SDK reads automatically. This enables:

- **Automatic key rotation**: Agent rotates the key, SDK picks up the new key
- **No environment variable exposure**: Key stays in a file, not in process environment
- **Cross-process coordination**: Multiple applications can share the same key file

#### Configuration

**1. Configure the agent to write the key file:**

Add `managedKey.filePath` to your agent config (`/etc/zn-vault-agent/config.json`):

```json
{
  "vaultUrl": "https://vault.example.com",
  "auth": { "apiKey": "znv_..." },
  "managedKey": {
    "name": "my-app-key",
    "filePath": "/var/lib/zn-vault-agent/.config/zn-vault-agent-nodejs/api-key",
    "fileOwner": "zn-vault-agent:app-group",
    "fileMode": "0640"
  }
}
```

| Field | Description |
|-------|-------------|
| `filePath` | Where to write the API key (absolute path) |
| `fileOwner` | File ownership as `user:group` (requires root or matching user) |
| `fileMode` | File permissions (e.g., `0640` for owner read/write, group read) |

**2. Configure your application to read from the file:**

Set the SDK environment variable to point to the same file:

```bash
# In your application's systemd service or env file
ZINC_CONFIG_VAULT_API_KEY_FILE=/var/lib/zn-vault-agent/.config/zn-vault-agent-nodejs/api-key
```

The SDK's `ZnVaultClient.fromEnv()` will automatically read from this file and refresh when the key rotates.

#### Permission Requirements

The application user must be able to read the key file. Options:

1. **Add application user to agent's group** (recommended):
   ```bash
   sudo usermod -aG zn-vault-agent myapp-user
   ```

2. **Use a shared group** in `fileOwner`:
   ```json
   {
     "managedKey": {
       "fileOwner": "zn-vault-agent:shared-secrets",
       "fileMode": "0640"
     }
   }
   ```

3. **Use more permissive mode** (less secure):
   ```json
   {
     "managedKey": {
       "fileMode": "0644"
     }
   }
   ```

#### Config-from-Vault Mode

When using **config-from-vault** (host templates), the vault provides `managedKey.name` but doesn't know your local filesystem. You must set `filePath`, `fileOwner`, and `fileMode` in your **local** config file:

```json
// /etc/zn-vault-agent/config.json (local config)
{
  "vaultUrl": "https://vault.example.com",
  "hostName": "my-server",
  "managedKey": {
    "filePath": "/var/lib/zn-vault-agent/.config/zn-vault-agent-nodejs/api-key",
    "fileOwner": "zn-vault-agent:zn-vault-agent",
    "fileMode": "0640"
  }
}
```

The agent merges local settings with vault config, so vault-provided fields (`name`, `nextRotationAt`, etc.) are combined with your local file settings.

#### Verification

Check that the key file is being written:

```bash
# Verify file exists and has correct permissions
ls -la /var/lib/zn-vault-agent/.config/zn-vault-agent-nodejs/api-key
# Should show: -rw-r----- 1 zn-vault-agent app-group ... api-key

# Verify your app user can read it
sudo -u myapp-user cat /var/lib/zn-vault-agent/.config/zn-vault-agent-nodejs/api-key
# Should output: znv_...

# Check agent health for managed key status
curl -s http://localhost:9100/health | jq '.managedKey'
```

### Password Authentication (Development Only)

Password auth stores credentials in the config file. **Not recommended for production.**

```json
{
  "auth": {
    "username": "agent-user",
    "password": "..."
  }
}
```

## Connection Modes

The agent supports two connection modes. **WebSocket is recommended** for production deployments.

### WebSocket Mode (Recommended)

WebSocket provides real-time push notifications when certificates or secrets are rotated:

```json
{
  "websocket": true,
  "pollInterval": 3600
}
```

**Benefits:**
- **Instant updates**: Receives certificate/secret changes immediately
- **Lower latency**: No waiting for poll interval
- **Efficient**: Single persistent connection vs repeated HTTP requests
- **Disconnect alerts**: Server monitors connection health and can alert on disconnect

**When WebSocket is unavailable**, the agent falls back to polling automatically.

### Polling Mode

Polling periodically checks for updates via HTTP requests:

```json
{
  "pollInterval": 3600
}
```

Use polling when:
- WebSocket connections are blocked by firewall
- Updates are infrequent and immediate sync isn't critical
- Minimizing persistent connections is required

### Recommended Configuration

For most deployments, enable both WebSocket and polling as fallback:

```json
{
  "vaultUrl": "https://vault.example.com",
  "tenantId": "my-tenant",
  "auth": {
    "apiKey": "znv_abc123..."
  },
  "websocket": true,
  "pollInterval": 3600,
  "targets": [...]
}
```

## Configuration

Both `znvault agent` CLI and the standalone daemon share the same config file.

### Config File Locations

| Context | Location |
|---------|----------|
| System (root) | `/etc/zn-vault-agent/config.json` |
| User | `~/.config/zn-vault-agent/config.json` |

### Config Format

```json
{
  "vaultUrl": "https://vault.example.com",
  "tenantId": "my-tenant",
  "auth": {
    "apiKey": "znv_abc123..."
  },
  "targets": [
    {
      "certId": "uuid-of-certificate",
      "name": "haproxy-frontend",
      "outputs": {
        "combined": "/etc/haproxy/certs/frontend.pem"
      },
      "owner": "haproxy:haproxy",
      "mode": "0640",
      "reloadCmd": "systemctl reload haproxy",
      "healthCheckCmd": "curl -sf http://localhost:8080/health"
    }
  ],
  "pollInterval": 3600,
  "insecure": false,

  "znapiBaseUrl": "http://127.0.0.1:8080"
}
```

| Config field | Default | Description |
|---|---|---|
| `znapiBaseUrl` | `http://127.0.0.1:8080` | Base URL of the local znapi instance, used by `/scheduler/*` passthrough routes. No secret is required — znapi authorizes `/internal/scheduler/*` on loopback. |

### Environment Variables

Environment variables override config file values:

| Variable | Description |
|----------|-------------|
| `ZNVAULT_URL` | Vault server URL |
| `ZNVAULT_TENANT_ID` | Tenant ID |
| `ZNVAULT_API_KEY` | API key (preferred) |
| `ZNVAULT_USERNAME` | Username for password auth |
| `ZNVAULT_PASSWORD` | Password for password auth |
| `ZNVAULT_INSECURE` | Skip TLS verification (`true`/`false`) |
| `ZNVAULT_AGENT_CONFIG_DIR` | Custom config directory |
| `LOG_LEVEL` | Log level: `trace`, `debug`, `info`, `warn`, `error` |
| `LOG_FILE` | Optional file mirror for JSON logs; journald remains enabled |

> **Note:** `znapiBaseUrl` is a config-file field only (no env-var override). Set it in `config.json` when deploying nodes that run znapi alongside the agent.

### Output Formats

| Output | Description | Use Case |
|--------|-------------|----------|
| `combined` | cert + key + chain | HAProxy |
| `cert` | Certificate only | General |
| `key` | Private key only | General |
| `chain` | CA chain certificates | General |
| `fullchain` | cert + chain | Nginx |

## Commands

### Standalone Agent (`zn-vault-agent`)

| Command | Description |
|---------|-------------|
| `start` | Start the daemon |
| `login` | Configure vault credentials |
| `add <cert-id>` | Add a certificate to sync |
| `remove <cert-id>` | Remove a certificate |
| `list` | List configured certificates |
| `sync` | Manual one-time sync |
| `status` | Show sync status |
| `secret add <id>` | Add a secret to sync |
| `secret remove <name>` | Remove a secret target |
| `secret list` | List configured secrets |
| `secret sync` | Sync all secrets |
| `exec` | Run command with secrets as env vars |
| `setup` | Install systemd service (requires root) |

```bash
zn-vault-agent start [options]

Options:
  -v, --verbose              Enable debug logging
  --health-port <port>       Enable health/metrics HTTP server
  --validate                 Validate config before starting
  --auto-update              Enable automatic updates
  --exec <command>           Command to execute (combined mode)
  -s, --secret <mapping>     Secret mapping for exec (repeatable)
  -e, --env-secret <ref>     Inject all vars from env secret (repeatable)
  --restart-on-change        Restart child on cert/secret changes
  --restart-delay <ms>       Delay before restart (default: 5000)
  --max-restarts <n>         Max restarts in window (default: 10)
  --restart-window <ms>      Restart count window (default: 300000)
```

## Secret Sync

Sync secrets from vault to local files in various formats.

> **Note**: Requires a user with `secret:read:value` permission. Admin users cannot decrypt secrets (separation of duties). See [GUIDE.md](docs/GUIDE.md#required-permissions) for role setup.

### Add a Secret Target

```bash
# Sync to .env file
zn-vault-agent secret add alias:db/credentials \
  --format env \
  --output /etc/myapp/secrets.env \
  --reload "systemctl restart myapp"

# Sync to JSON file
zn-vault-agent secret add alias:app/config \
  --format json \
  --output /etc/myapp/config.json

# Extract single value
zn-vault-agent secret add alias:api/key \
  --format raw \
  --key apiKey \
  --output /etc/myapp/api-key.txt

# Use template
zn-vault-agent secret add alias:db/prod \
  --format template \
  --template /etc/myapp/config.tmpl \
  --output /etc/myapp/config.yml
```

### Output Formats

| Format | Description | Example Output |
|--------|-------------|----------------|
| `env` | Environment file | `DB_HOST="localhost"` |
| `json` | JSON object | `{"host": "localhost"}` |
| `yaml` | YAML document | `host: localhost` |
| `raw` | Single value (requires `--key`) | `localhost` |
| `template` | Custom template with `{{ key }}` placeholders | (based on template) |

### Sync Secrets

```bash
# Sync all configured secrets
zn-vault-agent secret sync

# Sync specific target
zn-vault-agent secret sync --name db-credentials
```

## Exec Mode

Run any command with secrets injected as environment variables. Secrets never touch disk.

> **Note**: Same permission requirements as Secret Sync - requires `secret:read:value` permission.

### Basic Usage

```bash
# Single secret
zn-vault-agent exec \
  -s DB_PASSWORD=alias:db/prod.password \
  -- node server.js

# Multiple secrets
zn-vault-agent exec \
  -s DB_HOST=alias:db/prod.host \
  -s DB_PASSWORD=alias:db/prod.password \
  -s API_KEY=alias:api/key.value \
  -- ./start.sh

# Entire secret as JSON
zn-vault-agent exec \
  -s CONFIG=alias:app/config \
  -- node -e "console.log(JSON.parse(process.env.CONFIG))"

# Use a managed API key (auto-rotating)
zn-vault-agent exec \
  -s VAULT_API_KEY=api-key:my-service-key \
  -- ./my-app

# Mix secrets, managed keys, and literal values
zn-vault-agent exec \
  -s DB_PASSWORD=alias:db/prod.password \
  -s VAULT_KEY=api-key:my-managed-key \
  -s ENV_NAME=literal:production \
  -- ./start.sh
```

### Env File Injection (`-e/--env-secret`)

Inject **all key-value pairs** from a secret as environment variables in a single command. This is ideal for secrets that contain multiple environment variables.

```bash
# Single env file - injects all key-value pairs as env vars
zn-vault-agent exec -e alias:env/production -- python app.py

# Multiple env files (later overrides earlier)
zn-vault-agent exec -e alias:env/base -e alias:env/prod -- ./start.sh

# With prefix (all vars get APP_ prefix)
zn-vault-agent exec -e alias:env/production:APP_ -- node server.js

# Mixed: env files + individual mappings (individual mappings win)
zn-vault-agent exec \
  -e alias:env/base \
  -s DB_PASSWORD=alias:db/creds.password \
  -- ./start.sh
```

#### Env File Format

| Format | Description | Example |
|--------|-------------|---------|
| `alias:path/to/secret` | All key-value pairs as env vars | `-e alias:env/prod` |
| `alias:path/to/secret:PREFIX_` | All vars with prefix | `-e alias:env/prod:APP_` |
| `uuid` | UUID reference | `-e abc123-def456` |
| `uuid:PREFIX_` | UUID with prefix | `-e abc123:DB_` |

#### How It Works

Given a secret at `alias:env/production` with data:
```json
{
  "DB_HOST": "localhost",
  "DB_PORT": "5432",
  "DB_USER": "app"
}
```

Running:
```bash
zn-vault-agent exec -e alias:env/production -- printenv
```

Results in environment:
```
DB_HOST=localhost
DB_PORT=5432
DB_USER=app
```

With prefix:
```bash
zn-vault-agent exec -e alias:env/production:APP_ -- printenv
```

Results in:
```
APP_DB_HOST=localhost
APP_DB_PORT=5432
APP_DB_USER=app
```

#### Precedence Rules

1. **Multiple env files**: Later files override earlier ones
2. **Individual mappings (`-s`)**: Always override env file values
3. **Literals**: Treated as individual mappings

```bash
# If alias:env/base has DB_HOST=base-host
# and alias:env/prod has DB_HOST=prod-host
# Result: DB_HOST=prod-host (later wins)
zn-vault-agent exec -e alias:env/base -e alias:env/prod -- printenv

# If alias:env/prod has DB_HOST=prod-host
# and -s sets DB_HOST explicitly
# Result: DB_HOST=override (individual wins)
zn-vault-agent exec -e alias:env/prod -s DB_HOST=literal:override -- printenv
```

### Individual Mapping Formats (`-s/--secret`)

| Format | Description | Example |
|--------|-------------|---------|
| `alias:path/to/secret` | Entire secret as JSON | `CONFIG=alias:app/config` |
| `alias:path/to/secret.key` | Specific field from secret | `DB_PASS=alias:db/creds.password` |
| `uuid.key` | UUID with specific field | `DB_PASS=abc123.password` |
| `api-key:name` | Managed API key (binds and gets current value) | `VAULT_KEY=api-key:my-key` |
| `literal:value` | Literal value (no vault fetch) | `ENV=literal:production` |

#### Managed API Keys (`api-key:`)

Managed API keys are auto-rotating keys created in the vault. When you use `api-key:name`:

1. The agent calls the vault's `/auth/api-keys/managed/:name/bind` endpoint
2. Returns the current key value based on rotation mode (scheduled, on-use, on-bind)
3. The key is injected as an environment variable

This is useful for applications that need to authenticate with the vault themselves:

```bash
# Your app gets a fresh vault API key at startup
zn-vault-agent exec \
  -s ZINC_CONFIG_VAULT_API_KEY=api-key:my-app-key \
  -- ./my-app
```

#### Literal Values (`literal:`)

Literal values are passed through without any vault fetch. Useful for:
- Static configuration values
- Feature flags
- Environment identifiers

```bash
zn-vault-agent exec \
  -s DEBUG=literal:true \
  -s ENV=literal:production \
  -- ./my-app
```

### Export to File

```bash
# Write secrets to env file (one-shot)
zn-vault-agent exec \
  -s DB_PASSWORD=alias:db/prod.password \
  -s VAULT_KEY=api-key:my-key \
  -s ENV=literal:prod \
  -o /tmp/secrets.env
```

### Watch Mode

Keep the env file updated when secrets or managed API keys rotate:

```bash
# Export to file and watch for changes (daemon mode)
zn-vault-agent exec \
  -s VAULT_API_KEY=api-key:my-rotating-key \
  -s DB_PASSWORD=alias:db/prod.password \
  --output /tmp/secrets.env --watch
```

The agent will:
1. Write initial secrets to the env file
2. Connect via WebSocket for rotation events
3. Update the env file when subscribed secrets/keys rotate
4. Run indefinitely until stopped (SIGTERM/SIGINT)

## Combined Mode

Run the daemon (cert/secret sync) AND manage a child process with injected secrets in a single instance. This eliminates the need for two separate services.

### Quick Start

```bash
# Combined mode: daemon + exec in one
zn-vault-agent start \
  --exec "payara start-domain domain1" \
  -s ZINC_CONFIG_USE_VAULT=literal:true \
  -F ZINC_CONFIG_API_KEY=api-key:my-managed-key \
  -F AWS_SECRET_ACCESS_KEY=alias:example/aws-secret-key \
  --restart-on-change \
  --health-port 9100
```

### Benefits

- **Single WebSocket connection** to vault (reduced load)
- **Automatic child restart** when certs or exec secrets change
- **Unified health endpoint** showing both daemon and child status
- **Simpler systemd config** (one service instead of two)
- **Signal forwarding** to child process
- **Crash recovery** with rate limiting

### Secure File Mode (v1.6.8+)

For sensitive secrets, use `-F` (`--secret-file`) instead of `-s` to prevent credential exposure in logs:

```bash
# Sensitive secrets via file (recommended for production)
zn-vault-agent start \
  --exec "python server.py" \
  -s CONFIG_ENV=literal:production \
  -F API_KEY=api-key:my-key \
  -F DB_PASSWORD=alias:db.password \
  --health-port 9100
```

**How it works:**
- Secrets are written to `/run/zn-vault-agent/secrets/<ENV_NAME>` (tmpfs, 0600 permissions)
- Child receives `ENV_NAME_FILE=/path/to/secret` instead of `ENV_NAME=<secret-value>`
- Secrets never appear in journald, sudo logs, or `ps aux`

**Auto-detection:**
```bash
# Automatically use file mode for vars matching *PASSWORD*, *SECRET*, *API_KEY*, etc.
zn-vault-agent start \
  --exec "python server.py" \
  -s API_KEY=api-key:my-key \
  --secrets-to-files \
  --health-port 9100
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--exec <cmd>` | - | Command to execute with secrets |
| `-s <mapping>` | - | Secret as env var (visible in logs) |
| `-F, --secret-file <mapping>` | - | Secret as file (secure, never in logs) |
| `--secrets-to-files` | false | Auto-detect sensitive vars for file mode |
| `--restart-on-change` | true | Restart child on changes |
| `--restart-delay <ms>` | 5000 | Delay before restart |
| `--max-restarts <n>` | 10 | Max restarts in window |
| `--restart-window <ms>` | 300000 | Restart count reset window (5 min) |

See [Combined Mode in GUIDE.md](docs/GUIDE.md#combined-mode) for complete documentation.

### CLI Commands (`znvault agent`)

The CLI provides the same configuration commands:

| Command | Description |
|---------|-------------|
| `znvault agent init` | Initialize agent config (uses CLI credentials) |
| `znvault agent add <cert-id>` | Add a certificate to sync |
| `znvault agent remove <id-or-name>` | Remove a certificate |
| `znvault agent list` | List configured certificates |
| `znvault agent sync` | One-time sync (for testing) |
| `znvault agent start` | Start the daemon (invokes `zn-vault-agent`) |
| `znvault agent status` | Show sync status |

## Health & Metrics

When started with `--health-port`, the agent exposes:

| Endpoint | Method | Access | Description |
|----------|--------|--------|-------------|
| `/health` | GET | Public | JSON health status |
| `/ready` | GET | Public | Readiness probe (Kubernetes) |
| `/live` | GET | Public | Liveness probe |
| `/metrics` | GET | Public | Prometheus metrics |
| `/scheduler/quiesce` | POST | Bearer | Scheduler quiesce passthrough (see below) |
| `/scheduler/status` | GET | Bearer | Scheduler status passthrough |
| `/scheduler/resume` | POST | Bearer | Scheduler resume passthrough |

Those four monitoring paths are the complete public allowlist on both HTTP and
HTTPS. Every other path—including agent/plugin version and update routes,
scheduler passthroughs, unknown paths, and every `/plugins/<name>/...` route—
requires `Authorization: Bearer <credential>`. `setup` creates the shared
credential at `/etc/zn-vault-agent/payara-mutation-token` as a private `0600`
file; a missing or unsafe file aborts daemon startup. The Payara namespace also
checks the same credential in its inherited plugin guard.

The token value must stay out of argv, environment values, logs, shell history,
and temporary files. Supported plugin CLI commands read the private file
directly. A bespoke client must do the same inside its process and construct the
Authorization header only in memory. `ZNVAULT_CONTROL_TOKEN_FILE`, when used by
an isolated installer or test, carries a file **path**, never the credential.

### Scheduler Passthrough Routes

The `/scheduler/*` routes forward requests to the local znapi instance's `/internal/scheduler/*` endpoints. They are used by `znvault-plugin-payara` during scheduler-aware deploys to quiesce (drain in-flight jobs), verify drain, and resume the scheduler after the WAR is deployed.

**No downstream deploy secret.** The inbound Agent `/scheduler/*` route still
requires the local control-plane Bearer credential described above. After that
check, znapi's `/internal/scheduler/*` filter authorizes the Agent's outbound
request purely on loopback (`127.0.0.1`). The Agent therefore sends no
`X-Internal-Secret`; `znapiBaseUrl` is the only downstream configuration.
(Before 2026-06-23 the Agent read `/etc/zincapi/scheduler-deploy-secret` and
returned `500 "deploy secret unreadable"` when it was absent.) It still sends
`X-Internal-Origin: deploy` as audit context, which znapi ignores for
authorization.

**Error responses:**

| Condition | HTTP | Body |
|-----------|------|------|
| znapi unreachable | 502 | `{ "error": "failed to reach znapi", "message": "..." }` |
| znapi returns 404 (old version) | 200 | `{ "available": false, "reason": "znapi-internal-scheduler-not-found" }` |
| All other znapi responses | proxied | proxied as-is |

The 200 + `{ "available": false, "reason": "znapi-internal-scheduler-not-found" }` shape is the **capability-missing contract** the plugin keys off: when znapi lacks the internal scheduler endpoint (old version → 404), the agent signals this non-fatally so the plugin can skip quiesce and proceed with the deploy rather than treating it as a hard failure.

### Prometheus Metrics

```
# Counters
znvault_agent_sync_total{status,cert_name}
znvault_agent_sync_failures_total{cert_name,reason}
znvault_agent_websocket_reconnects_total
znvault_agent_api_requests_total{method,status}

# Gauges
znvault_agent_connected
znvault_agent_certs_tracked
znvault_agent_last_sync_timestamp{cert_name}
znvault_agent_cert_expiry_days{cert_id,cert_name}

# Histograms
znvault_agent_sync_duration_seconds{cert_name}
znvault_agent_api_request_duration_seconds{method}
```

## TLS/HTTPS Configuration

The agent can expose its health/metrics endpoints over HTTPS using TLS certificates. There are two modes:

HTTPS uses the same route allowlist and the same local control-plane credential
as HTTP; enabling TLS does not make control or plugin routes public.

### Auto-Managed TLS (Recommended)

Let the vault issue and manage TLS certificates automatically:

```bash
# Enable auto-managed TLS
zn-vault-agent tls enable

# The agent will:
# 1. Request a TLS certificate from vault on startup
# 2. Start HTTPS server on port 9443
# 3. Auto-renew certificate before expiry
# 4. Hot-reload certificate without restart
```

**Requirements:**
- Agent must be registered with vault (has agentId)
- Tenant must have a CA assigned for `agent-tls` purpose
- Agent needs permission to request certificates

### Manual TLS

Use your own certificate files:

```bash
# Enable with explicit certificate paths
zn-vault-agent tls enable \
  --cert-path /etc/ssl/agent.crt \
  --key-path /etc/ssl/agent.key
```

### TLS Commands

| Command | Description |
|---------|-------------|
| `tls enable` | Enable TLS for HTTPS health server |
| `tls disable` | Disable TLS |
| `tls status` | Show TLS configuration and certificate status |
| `tls ca` | Fetch CA certificate for client verification |

### TLS Options

```bash
zn-vault-agent tls enable [options]

Options:
  -p, --port <port>          HTTPS port (default: 9443)
  -r, --renew-days <days>    Renew certificate before expiry (default: 7)
  --keep-http                Keep HTTP server alongside HTTPS (default: true)
  --no-keep-http             Disable HTTP when HTTPS is enabled
  --cert-path <path>         Path to TLS certificate (manual mode)
  --key-path <path>          Path to TLS private key (manual mode)
```

### Configuration File

TLS can also be configured in `config.json`:

```json
{
  "vaultUrl": "https://vault.example.com",
  "tenantId": "my-tenant",
  "auth": { "apiKey": "znv_..." },
  "tls": {
    "enabled": true,
    "httpsPort": 9443,
    "renewBeforeDays": 7,
    "keepHttpServer": true
  },
  "targets": [...]
}
```

For manual mode, add certificate paths:

```json
{
  "tls": {
    "enabled": true,
    "certPath": "/etc/ssl/agent.crt",
    "keyPath": "/etc/ssl/agent.key",
    "httpsPort": 9443
  }
}
```

### CLI Options

TLS can also be enabled via command line when starting the daemon:

```bash
# Enable auto-managed TLS
zn-vault-agent start --tls --health-port 9100

# With custom HTTPS port
zn-vault-agent start --tls --tls-https-port 8443 --health-port 9100

# With manual certificate paths
zn-vault-agent start \
  --tls \
  --tls-cert /etc/ssl/agent.crt \
  --tls-key /etc/ssl/agent.key \
  --health-port 9100

# HTTPS only (no HTTP)
zn-vault-agent start --tls --no-tls-keep-http
```

### Verifying HTTPS Connections

After enabling TLS, you can verify using curl:

```bash
# Fetch the CA certificate for verification
zn-vault-agent tls ca --raw > /tmp/agent-ca.crt

# Connect with CA verification
curl --cacert /tmp/agent-ca.crt https://agent-host:9443/health

# Or skip verification for testing
curl -k https://agent-host:9443/health
```

### TLS Status

Check TLS configuration and certificate status:

```bash
zn-vault-agent tls status

# Output:
# TLS Configuration
#
#   Status:      enabled
#   Mode:        auto-managed (vault-issued certificate)
#   HTTPS Port:  9443
#   HTTP Server: enabled
#   Auto-Renew:  7 days before expiry
#
# Certificate Status
#   Cert ID:     abc12345...
#   Expires:     4/26/2026 (82 days)
#   Renewed:     1/26/2026, 10:00:00 AM
#   Last Check:  1/26/2026, 5:00:00 PM
#
# Runtime
#   Manager:     running
#   Cert Path:   /var/lib/zn-vault-agent/tls/agent-001.crt
#   Key Path:    /var/lib/zn-vault-agent/tls/agent-001.key
```

## Plugin System

The agent supports plugins that extend functionality without modifying core code. Plugins can:

- Register HTTP routes on the health server
- React to certificate/secret deployment events
- Add custom health checks
- Respond to child process events

### Installing Plugins

Add plugins to your `config.json`:

```json
{
  "vaultUrl": "https://vault.example.com",
  "tenantId": "my-tenant",
  "auth": { "apiKey": "znv_..." },
  "plugins": [
    {
      "package": "@zincapp/znvault-plugin-payara",
      "config": {
        "payaraHome": "/opt/payara",
        "domain": "domain1",
        "user": "payara",
        "warPath": "/opt/app/MyApp.war",
        "appName": "MyApp"
      }
    }
  ]
}
```

Then install the plugin package:

```bash
sudo npm install -g @zincapp/znvault-plugin-payara@^3
```

Agent 2.x requires Payara plugin `>=3.0.0 <4.0.0` because both processes must
use the same ownership-safe mutation lock protocol. On an existing Payara
host, stage plugin 3 first and Agent 2 second without restarting the service
between installs, then verify the compatible pair together. Agent 2 fails
closed before importing a Payara 2.x or unverified future-major entrypoint.

### Available Plugins

| Plugin | Package | Description |
|--------|---------|-------------|
| Payara | `@zincapp/znvault-plugin-payara` | WAR diff deployment, Payara lifecycle management |

### Plugin Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `package` | string | npm package name |
| `path` | string | Local file path (alternative to package) |
| `config` | object | Plugin-specific configuration |
| `enabled` | boolean | Enable/disable plugin (default: true) |

### Plugin Routes

Plugins register HTTP routes under `/plugins/<name>/`. For example, the Payara plugin registers:

- `GET /plugins/payara/status` - Payara status
- `GET /plugins/payara/hashes` - WAR file hashes for diff deployment
- `POST /plugins/payara/deploy` - Apply WAR changes

All plugin routes require the local Bearer credential. Payara applies a second,
inherited guard using the same token file, so a request must pass both the Agent
control-plane gate and the plugin namespace gate before body parsing or handler
execution.

### Plugin Health

Plugin health is included in the `/health` endpoint:

```json
{
  "status": "healthy",
  "plugins": [
    {
      "name": "payara",
      "status": "healthy",
      "details": {
        "domain": "domain1",
        "running": true,
        "healthy": true
      }
    }
  ]
}
```

### Writing Plugins

Plugins export a factory function that returns an `AgentPlugin` object:

```typescript
import type { AgentPlugin, PluginContext } from '@zincapp/zn-vault-agent/plugins';

export default function createMyPlugin(config: MyConfig): AgentPlugin {
  return {
    name: 'my-plugin',
    version: '1.0.0',

    async onInit(ctx: PluginContext) {
      ctx.logger.info('Initializing...');
    },

    async onStart(ctx: PluginContext) {
      ctx.logger.info('Starting...');
    },

    async routes(fastify, ctx) {
      fastify.get('/status', async () => ({ ok: true }));
    },

    async onCertificateDeployed(event, ctx) {
      ctx.logger.info({ certId: event.certId }, 'Certificate deployed');
    },

    async healthCheck(ctx) {
      return { name: 'my-plugin', status: 'healthy' };
    },
  };
}
```

Plugin types are exported from `@zincapp/zn-vault-agent/plugins`.

## Systemd Installation

```bash
# Install via npm
npm install -g @zincapp/zn-vault-agent

# Setup systemd (as root)
sudo zn-vault-agent setup --yes

# Configure the same system path and identity used by the service
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent login --url https://vault.example.com \
  --api-key znv_abc123...

# Enable and start
sudo systemctl enable --now zn-vault-agent

# View logs
journalctl -u zn-vault-agent -f
```

### File Locations

| Path | Description |
|------|-------------|
| Output of `command -v zn-vault-agent` | Agent binary; `setup` records this absolute path in the generated unit |
| `/etc/zn-vault-agent/config.json` | Main configuration |
| `/etc/zn-vault-agent/secrets.env` | Sensitive credentials |
| `/var/lib/zn-vault-agent/` | State directory |
| `/var/log/zn-vault-agent/` | Log files |

## Troubleshooting

### Agent won't start

```bash
# Check configuration
sudo -u zn-vault-agent -H env ZNVAULT_AGENT_CONFIG_DIR=/etc/zn-vault-agent \
  zn-vault-agent start --validate

# Check logs
journalctl -u zn-vault-agent -n 50

# Test vault connectivity
curl -k https://your-vault/v1/health
```

### Certificates not syncing

```bash
# Check sync status
znvault agent status

# Force manual sync
znvault agent sync --force

# Check health endpoint
curl http://localhost:9100/health
```

### WebSocket disconnects

- Check network connectivity to vault
- Verify API key is valid
- Check vault server logs for auth errors
- Agent will auto-reconnect with exponential backoff

### Permission denied

```bash
# Check file ownership
ls -la /etc/ssl/znvault/

# Ensure agent can write
sudo chown zn-vault-agent:zn-vault-agent /etc/ssl/znvault/

# Check reload command permissions
# Agent runs as zn-vault-agent user, may need sudo rules
```

### API Key Expired or Invalid

If the agent shows "401 Unauthorized" errors, the API key may have expired or been rotated
while the agent was offline:

```bash
# Check agent logs for 401 errors
journalctl -u zn-vault-agent | grep -i "401\|Unauthorized\|RECOVERY REQUIRED"

# Create a new API key in the vault dashboard or CLI, then reconfigure
zn-vault-agent login --url https://vault.example.com \
  --api-key znv_your_new_key_here

# Restart the agent
sudo systemctl restart zn-vault-agent
```

### Syscall Filter Errors (SIGSYS)

If the agent crashes immediately with `signal=SYS` or `status=31`, the systemd syscall filter
may be too restrictive for your Node.js version.

> **Note**: v1.6.12+ disables SystemCallFilter by default. Upgrade to fix this issue:
> ```bash
> sudo npm install -g @zincapp/zn-vault-agent@latest
> # Regenerate the unit with the npm-linked binary path on this host.
> sudo zn-vault-agent setup --yes
> ```

**For older versions**, disable the syscall filter manually:

```bash
# Check for syscall violations
dmesg | grep -i seccomp
journalctl -k | grep audit

# Edit the service file to disable syscall filtering
sudo systemctl edit zn-vault-agent

# Add this override:
[Service]
SystemCallFilter=
SystemCallArchitectures=

# Reload and restart
sudo systemctl daemon-reload
sudo systemctl restart zn-vault-agent
```

## Auto-Update

The agent supports periodic updates via npm, but periodic agent and plugin
auto-update are **disabled by default**. When explicitly enabled, updates are
checked every 5 minutes by default.

### How It Works

1. The agent periodically resolves the configured exact npm dist-tag (Agent 2
   defaults to `dr-m4`).
2. If a newer version is available, it atomically publishes a mode-0600,
   no-replace v1 update trigger.
3. The systemd `.path` unit activates the sandbox-external updater oneshot,
   which runs `npm install -g @zincapp/zn-vault-agent` as root.
4. The wrapper retains the trigger through npm, persists terminal evidence,
   and asks systemd to restart the agent; receipt replay closes crash windows.
5. Runtime locking and the no-replace trigger handoff prevent overlap.

### Configuration

Agent and plugin auto-update are independent opt-ins. Enable either one
explicitly with `true` or `1`:

```bash
# In /etc/zn-vault-agent/agent.env:
AUTO_UPDATE=true                  # Agent periodic updates (default: false)
AUTO_UPDATE_INTERVAL=300          # Check interval in seconds (default: 300)
AUTO_UPDATE_CHANNEL=dr-m4         # Agent channel: latest, beta, next, dr-m4 (default: dr-m4)

PLUGIN_AUTO_UPDATE=true           # Plugin periodic updates (default: false)
PLUGIN_AUTO_UPDATE_INTERVAL=300   # Check interval in seconds (default: 300)
PLUGIN_AUTO_UPDATE_CHANNEL=latest # Channel: latest, beta, next (default: latest)
```

Set either enable flag to `false` or `0` to disable it explicitly. The CLI can
also force the periodic checkers off:

```bash
zn-vault-agent start --no-auto-update --no-plugin-auto-update
```

### Manual Updates

```bash
# Check for updates
npm outdated -g @zincapp/zn-vault-agent

# Update manually
npm update -g @zincapp/zn-vault-agent

# Install specific version
npm install -g @zincapp/zn-vault-agent@2.0.0
```

### Update Channels (npm dist-tags)

| Channel | Command | Description |
|---------|---------|-------------|
| `latest` | `npm install -g @zincapp/zn-vault-agent@latest` | Production releases |
| `beta` | `npm install -g @zincapp/zn-vault-agent@beta` | Pre-release testing |
| `next` | `npm install -g @zincapp/zn-vault-agent@next` | Development builds |
| `dr-m4` | `npm install -g @zincapp/zn-vault-agent@dr-m4` | Fenced Agent 2.x migration |

Agent 2.x is a coordinated migration with Payara plugin 3.x. Its exact stable
artifacts publish under the temporary `dr-m4` dist-tag, which is the Agent 2
updater default while periodic update remains opt-in. This leaves `latest` on
Agent 1.x and causes no implicit rollout. Manual update requests must carry the
caller UUID, exact current version, and exact target resolved from `dr-m4`;
promoting to `latest` is a separate fleet decision with before/after receipts.

## Security Considerations

### Authentication
1. **Use API keys**: Always use API keys with limited scope in production
2. **Scope permissions**: Only grant `certificate:read:metadata` and `certificate:read:value`
3. **IP allowlisting**: Restrict API key usage to specific server IPs
4. **Rotate annually**: Set expiration to 365 days and rotate before expiry

### Credentials Storage
5. **Use secrets.env**: Store `ZNVAULT_API_KEY` in `/etc/zn-vault-agent/secrets.env`
6. **File permissions**: `secrets.env` should be `0600` owned by `zn-vault-agent`
7. **Never commit**: Keep credentials out of version control

### Runtime Security
8. **Reload commands**: Run with minimal privileges (use `sudo` rules if needed)
9. **TLS verification**: Never use `insecure: true` in production
10. **Network isolation**: Agent only needs outbound HTTPS to vault

### Example secrets.env

```bash
# /etc/zn-vault-agent/secrets.env
# Permissions: 0600, Owner: zn-vault-agent:zn-vault-agent
ZNVAULT_API_KEY=znv_abc123...
```

## Documentation

For comprehensive documentation including:
- WebSocket protocol details
- High availability (HA) setup
- Cross-node event distribution
- Advanced troubleshooting

See the [Agent Guide](docs/GUIDE.md).

## Development

```bash
npm install
npm run dev          # Development with hot reload
npm run build        # Build
npm run typecheck    # Type check
npm run lint         # Lint
npm test             # Test
npm run test:coverage
```

## Releases

GitHub Actions splits CI from publication. `.github/workflows/ci.yml` validates
pushes and pull requests. The tag-triggered `.github/workflows/publish.yml`
publishes the npm package with OIDC provenance; it does **not** create a GitHub
Release. The GitHub Release is a separate, explicit operator step.

### CI Pipeline

On every push to `main` or pull request, `.github/workflows/ci.yml` runs:
- Linting and type checking
- Build verification
- Unit tests on Node.js 22.13 and 24

### Publishing to npm

Before tagging Agent 2.0.0, pack the exact Agent 2.0.0 and Payara Plugin 3.0.0
artifacts and run the cross-package smoke against both Node.js 22.13 and 24:

```bash
# Capture the npm fence before any tag exists; this must print a 1.x version
export AGENT_LATEST_BEFORE="$(npm view @zincapp/zn-vault-agent dist-tags.latest)"
case "$AGENT_LATEST_BEFORE" in 1.*) ;; *) exit 1 ;; esac

# Set the Agent release version without creating a commit or tag
npm version 2.0.0 --no-git-tag-version
printf '%s\n' 2.0.0 > VERSION

# Build/package each final release snapshot (in its own repository)
mkdir -p /tmp/znvault-release
npm ci && npm run lint && npm run typecheck && npm run test:unit && npm run build
npm pack --pack-destination /tmp/znvault-release

cd /path/to/znvault-plugin-payara
npm ci && npm run lint && npm run typecheck && npm run test:unit && npm run build
npm pack --pack-destination /tmp/znvault-release

cd /path/to/zn-vault-agent
./test/release/tarball-smoke.sh \
  /tmp/znvault-release/zincapp-zn-vault-agent-2.0.0.tgz \
  /tmp/znvault-release/zincapp-znvault-plugin-payara-3.0.0.tgz
```

Only after that exact paired-tarball smoke passes:

```bash
# 1. Review and commit the complete already-smoked snapshot, including every
#    source, test, workflow, documentation, and version-metadata change
git status --short
git diff --check
git add -A
git diff --cached --check
git diff --cached --stat
git commit -m "chore(release): v2.0.0"
git push origin HEAD:main

# 2. Wait for CI on that exact commit, then create/push one annotated tag
git tag -a v2.0.0 -m "v2.0.0"
git push origin v2.0.0

# 3. After publish.yml succeeds, record the existing latest pointer and create
#    the non-latest GitHub Release manually
AGENT_GH_LATEST_BEFORE=$(gh api repos/vidaldiego/zn-vault-agent/releases/latest --jq .tag_name)
gh release create v2.0.0 --verify-tag --generate-notes --latest=false
```

Never use `git push --tags`. Record `npm view @zincapp/zn-vault-agent
dist-tags.latest` before tagging; it must be a 1.x version. After publication,
verify the exact package and prove that neither npm nor GitHub moved a latest
pointer:

```bash
npm view @zincapp/zn-vault-agent@2.0.0 version dist.integrity
npm view @zincapp/zn-vault-agent dist-tags --json
test "$(npm view @zincapp/zn-vault-agent dist-tags.latest)" = "$AGENT_LATEST_BEFORE"
test "$(gh api repos/vidaldiego/zn-vault-agent/releases/latest --jq .tag_name)" = "$AGENT_GH_LATEST_BEFORE"
test "$AGENT_GH_LATEST_BEFORE" != "v2.0.0"
gh release view v2.0.0 --json tagName,isDraft,isPrerelease \
  --jq 'select(.tagName == "v2.0.0" and .isDraft == false and .isPrerelease == false)'
```

`AGENT_LATEST_BEFORE` is the recorded pre-tag 1.x value. A mismatch is a
release NO-GO, not something to repair by moving tags during the same run.
The tag workflow keeps full tests in an unprivileged job. Its minimal OIDC job
uses `npm ci --ignore-scripts`, builds and packs once, exercises both privileged
wrappers from that tarball, records its SHA-256, and passes that exact unchanged
`.tgz` path to `npm publish`; it never publishes the checkout directory.

**Available channels (npm dist-tags):**

| Tag | Purpose | Install Command |
|-----|---------|-----------------|
| `latest` | Stable releases | `npm install -g @zincapp/zn-vault-agent` |
| `beta` | Pre-release testing | `npm install -g @zincapp/zn-vault-agent@beta` |
| `next` | Development builds | `npm install -g @zincapp/zn-vault-agent@next` |
| `dr-m4` | Fenced Agent 2.x migration artifacts; Agent 2 updater default | `npm install -g @zincapp/zn-vault-agent@dr-m4` |

Pre-release versions (e.g., `2.1.0-beta.1`) are automatically tagged as `beta` or `next`.
Stable Agent 2.x versions publish under `dr-m4`, leaving `latest` unchanged;
promotion requires a separate verified fleet-migration decision and receipts.

### Release Recovery

npm publication is performed only by the tag-triggered GitHub Actions workflow
with OIDC provenance. If it fails, correct the cause and re-run that workflow
for the exact existing tag; do not publish a locally built or stale `dist/`
directory with `npm publish`. Create the GitHub Release only after npm
publication and the fenced dist-tag checks succeed.

## License

MIT
