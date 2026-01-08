# ZN-Vault Certificate Agent

Real-time certificate distribution agent for ZN-Vault. Automatically syncs TLS certificates from your vault to target servers with zero-downtime deployments.

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

## Quick Start

### Option A: npm Install (Recommended)

The fastest way to install on Linux servers:

```bash
# Install globally via npm
npm install -g @zincapp/zn-vault-agent

# Setup systemd service (as root)
sudo zn-vault-agent setup
```

**Requirements:** Node.js 18+ must be installed.

**What `setup` does:**

1. Creates `zn-vault-agent` system user/group
2. Creates directories: `/etc/zn-vault-agent/`, `/var/lib/zn-vault-agent/`, `/var/log/zn-vault-agent/`
3. Installs systemd service (enabled but not started)
4. Creates config template at `/etc/zn-vault-agent/agent.env`

**Install specific version or channel:**

```bash
npm install -g @zincapp/zn-vault-agent@1.3.0     # Specific version
npm install -g @zincapp/zn-vault-agent@beta      # Beta channel
npm install -g @zincapp/zn-vault-agent@next      # Development
```

After installation, configure and start:

```bash
# 1. Configure the agent
zn-vault-agent login --url https://vault.example.com \
  --tenant my-tenant --api-key znv_abc123...

# 2. Add certificate to sync
zn-vault-agent certs add <cert-id> \
  --name "haproxy-frontend" \
  --combined /etc/haproxy/certs/frontend.pem \
  --reload "systemctl reload haproxy"

# 3. Start service
sudo systemctl start zn-vault-agent
```

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

In the ZN-Vault dashboard:
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
{"level":"info","msg":"API key rotated successfully","newPrefix":"znv_abc1"}
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
# Just use the API key - agent auto-detects it's managed
zn-vault-agent login \
  --url https://vault.example.com \
  --tenant my-tenant \
  --api-key znv_managed_key_123...

# Output shows managed key was detected:
# ✓ Connection successful!
# ✓ Configuration saved to: /etc/zn-vault-agent/config.json
# ✓ Found 5 certificate(s) in vault
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
{"level":"info","msg":"Managed key rotated","oldPrefix":"znv_abc1","newPrefix":"znv_xyz9","nextRotationAt":"2026-01-07T10:00:00Z"}
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
  "insecure": false
}
```

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
| `LOG_FILE` | Optional log file path |

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

### Mapping Formats

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
  -sf ZINC_CONFIG_API_KEY=api-key:my-managed-key \
  -sf AWS_SECRET_ACCESS_KEY=alias:infra/prod.awsSecretKey \
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

For sensitive secrets, use `-sf` (secret-file) instead of `-s` to prevent credential exposure in logs:

```bash
# Sensitive secrets via file (recommended for production)
zn-vault-agent start \
  --exec "python server.py" \
  -s CONFIG_ENV=literal:production \
  -sf API_KEY=api-key:my-key \
  -sf DB_PASSWORD=alias:db.password \
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
| `-sf <mapping>` | - | Secret as file (secure, never in logs) |
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

| Endpoint | Description |
|----------|-------------|
| `/health` | JSON health status |
| `/ready` | Readiness probe (Kubernetes) |
| `/live` | Liveness probe |
| `/metrics` | Prometheus metrics |

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

## Systemd Installation

```bash
# Install via npm
npm install -g @zincapp/zn-vault-agent

# Setup systemd (as root)
sudo zn-vault-agent setup

# Configure
zn-vault-agent login --url https://vault.example.com \
  --tenant my-tenant --api-key znv_abc123...

# Enable and start
sudo systemctl enable --now zn-vault-agent

# View logs
journalctl -u zn-vault-agent -f
```

### File Locations

| Path | Description |
|------|-------------|
| `/usr/local/bin/zn-vault-agent` | Agent binary |
| `/etc/zn-vault-agent/config.json` | Main configuration |
| `/etc/zn-vault-agent/secrets.env` | Sensitive credentials |
| `/var/lib/zn-vault-agent/` | State directory |
| `/var/log/zn-vault-agent/` | Log files |

## Troubleshooting

### Agent won't start

```bash
# Check configuration
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

# Create a new API key (requires admin access to vault)
znvault api-key create agent-recovery --tenant <tenant> \
  --permissions "certificate:read:value,certificate:read:metadata,certificate:list"

# Update the agent config with the new key
sudo jq '.auth.apiKey = "znv_your_new_key_here"' \
  /etc/zn-vault-agent/config.json > /tmp/config.json && \
  sudo mv /tmp/config.json /etc/zn-vault-agent/config.json

# Set correct permissions and restart
sudo chown zn-vault-agent:zn-vault-agent /etc/zn-vault-agent/config.json
sudo chmod 600 /etc/zn-vault-agent/config.json
sudo systemctl restart zn-vault-agent
```

### Syscall Filter Errors (SIGSYS)

If the agent crashes immediately with `signal=SYS` or `status=31`, the systemd syscall filter
may be too restrictive for your Node.js version.

> **Note**: v1.6.12+ disables SystemCallFilter by default. Upgrade to fix this issue:
> ```bash
> sudo npm install -g @zincapp/zn-vault-agent@latest
> sudo cp /usr/lib/node_modules/@zincapp/zn-vault-agent/deploy/systemd/zn-vault-agent.service /etc/systemd/system/
> sudo systemctl daemon-reload
> sudo systemctl restart zn-vault-agent
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

The agent automatically updates itself via npm. Updates are checked every 5 minutes by default.

### How It Works

1. Agent periodically checks `npm view @zincapp/zn-vault-agent version`
2. If a newer version is available, it runs `npm install -g @zincapp/zn-vault-agent`
3. Agent sends SIGTERM to itself, systemd restarts with new version
4. Lock file prevents multiple agents from updating simultaneously

### Configuration

Auto-update is **enabled by default**. Configure via environment variables:

```bash
# In /etc/zn-vault-agent/agent.env:
AUTO_UPDATE=true           # Enable/disable (default: true)
AUTO_UPDATE_INTERVAL=300   # Check interval in seconds (default: 300)
AUTO_UPDATE_CHANNEL=latest # Channel: latest, beta, next (default: latest)
```

Or disable via CLI flag:

```bash
zn-vault-agent start --no-auto-update
```

### Manual Updates

```bash
# Check for updates
npm outdated -g @zincapp/zn-vault-agent

# Update manually
npm update -g @zincapp/zn-vault-agent

# Install specific version
npm install -g @zincapp/zn-vault-agent@1.3.0
```

### Update Channels (npm dist-tags)

| Channel | Command | Description |
|---------|---------|-------------|
| `latest` | `npm install -g @zincapp/zn-vault-agent@latest` | Production releases |
| `beta` | `npm install -g @zincapp/zn-vault-agent@beta` | Pre-release testing |
| `next` | `npm install -g @zincapp/zn-vault-agent@next` | Development builds |

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

This package uses GitHub Actions for CI/CD with npm's OIDC trusted publishing.

### CI Pipeline

On every push to `main` or pull request:
- Linting and type checking
- Build verification
- Unit tests on Node.js 18, 20, 22

### Publishing to npm

Releases are automated via git tags:

```bash
# 1. Bump version in package.json
npm version patch   # or minor/major

# 2. Push changes and tag
git push && git push --tags

# GitHub Actions will automatically:
# - Run tests
# - Build the package
# - Publish to npm with provenance
```

**Available channels (npm dist-tags):**

| Tag | Purpose | Install Command |
|-----|---------|-----------------|
| `latest` | Stable releases | `npm install -g @zincapp/zn-vault-agent` |
| `beta` | Pre-release testing | `npm install -g @zincapp/zn-vault-agent@beta` |
| `next` | Development builds | `npm install -g @zincapp/zn-vault-agent@next` |

Pre-release versions (e.g., `1.3.0-beta.1`) are automatically tagged as `beta` or `next`.

### Manual Release (if needed)

```bash
npm login
npm publish --access public
```

## License

MIT
