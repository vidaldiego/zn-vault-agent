# ZN-Vault Agent Guide

Comprehensive documentation for the ZN-Vault Certificate Agent.

## Table of Contents

- [Introduction](#introduction)
- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
- [CLI Commands](#cli-commands)
- [Secrets Sync](#secrets-sync)
- [Exec Mode](#exec-mode)
- [Combined Mode](#combined-mode)
- [WebSocket Protocol](#websocket-protocol)
- [High Availability](#high-availability)
- [Auto-Update System](#auto-update-system)
- [Use Cases](#use-cases)
  - [HAProxy Full Configuration Management](#haproxy-full-configuration-management)
- [Troubleshooting](#troubleshooting)
- [API Reference](#api-reference)
- [API Key Auto-Renewal](#api-key-auto-renewal)
- [Security Considerations](#security-considerations)
- [Best Practices](#best-practices)
- [Development](#development)

## Introduction

The ZN-Vault Agent is a certificate synchronization daemon that automatically keeps local certificate files in sync with certificates stored in the vault. When certificates are rotated or updated, agents are notified in real-time via WebSocket and automatically sync the changes.

### Two Ways to Use

1. **Standalone Agent (`zn-vault-agent`)**: Full-featured daemon with metrics, health endpoints, and systemd integration
2. **CLI Commands (`znvault agent`)**: Configure the agent and run one-time operations

Both share the same config file format and can be used together:
- Use `znvault agent add/remove/list` to configure certificates
- Use `zn-vault-agent start` (or `znvault agent start`) to run the daemon

### Key Features

- **Real-time Synchronization**: WebSocket-based push notifications for instant certificate updates
- **Resilient Connections**: Custom ping/pong heartbeat for dead connection detection
- **Automatic Reconnection**: Fixed-interval reconnection on disconnect
- **Subscription Filtering**: Agents only receive notifications for certificates they're watching
- **Cross-Node Events**: Redis pub/sub ensures events from any vault node reach all agents (HA mode)
- **Reload Hooks**: Run custom commands after certificate updates (e.g., reload HAProxy)
- **State Tracking**: Persistent state tracks synced versions to avoid redundant operations
- **Prometheus Metrics**: Full observability via `/metrics` endpoint
- **Auto-Updates**: Automatic npm-based updates with graceful restarts

### Architecture Overview

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│  Agent Node 1   │       │  Agent Node 2   │       │  Agent Node 3   │
│  (HAProxy)      │       │  (Nginx)        │       │  (Application)  │
└────────┬────────┘       └────────┬────────┘       └────────┬────────┘
         │                         │                         │
         │ WebSocket               │ WebSocket               │ WebSocket
         │                         │                         │
         ▼                         ▼                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         ZN-Vault Cluster                            │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐                        │
│  │ Vault-1  │◄──│  Redis   │──►│ Vault-2  │   (Events distributed  │
│  │          │   │ Pub/Sub  │   │          │    via Redis)          │
│  └──────────┘   └──────────┘   └──────────┘                        │
└─────────────────────────────────────────────────────────────────────┘
```

## Installation

### Prerequisites

1. **Node.js 18+**: Required runtime
2. **Authentication**: API key or user credentials with certificate access

### Option A: npm Install (Recommended)

The quickest way to install on Linux servers:

```bash
# Install globally via npm
npm install -g @zincapp/zn-vault-agent

# Setup systemd service (as root)
sudo zn-vault-agent setup
```

**Requirements:** Node.js 18+ must be pre-installed.

**What `setup` does:**

| Step | Action |
|------|--------|
| 1 | Creates `zn-vault-agent` system user and group |
| 2 | Creates directories: `/etc/zn-vault-agent`, `/var/lib/zn-vault-agent`, `/var/log/zn-vault-agent` |
| 3 | Installs systemd service (enabled but not started) |
| 4 | Creates config template at `/etc/zn-vault-agent/agent.env` |

**What it does NOT do:**
- Configure vault URL or credentials
- Add certificates to sync
- Start the service

**Install specific version or channel:**

```bash
# Install specific version
npm install -g @zincapp/zn-vault-agent@1.3.0

# Install from beta channel
npm install -g @zincapp/zn-vault-agent@beta

# Install from development channel
npm install -g @zincapp/zn-vault-agent@next
```

### Option B: Using znvault CLI

If you have the `znvault` CLI installed, it can configure and start the agent:

```bash
# Install CLI
cd znvault-cli
npm install && npm run build && npm link

# Configure
znvault config set url https://vault.example.com
znvault login -u username -p password

# Initialize agent
znvault agent init
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

# Verify
zn-vault-agent --version
```

## Configuration

### Config File Locations

| Context | Location |
|---------|----------|
| System (root) | `/etc/zn-vault-agent/config.json` |
| User | `~/.config/zn-vault-agent/config.json` |

The agent checks for system config first, then falls back to user config.

### Config Format

```json
{
  "vaultUrl": "https://vault.example.com",
  "tenantId": "my-tenant",
  "auth": {
    "apiKey": "znv_..."
  },
  "insecure": false,
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
  "globalReloadCmd": "/usr/local/bin/reload-all.sh",
  "pollInterval": 3600,
  "verbose": false
}
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `vaultUrl` | - | Vault server URL (required) |
| `tenantId` | - | Tenant ID (required) |
| `auth.apiKey` | - | API key for authentication |
| `auth.username` | - | Username (if not using API key) |
| `auth.password` | - | Password (if not using API key) |
| `insecure` | `false` | Skip TLS certificate verification |
| `targets` | `[]` | List of certificates to sync |
| `globalReloadCmd` | - | Command to run after any certificate update |
| `pollInterval` | `3600` | Seconds between polling (WebSocket fallback) |
| `verbose` | `false` | Enable verbose logging |

### Target Options

| Option | Required | Description |
|--------|----------|-------------|
| `certId` | Yes | Certificate UUID from vault |
| `name` | Yes | Human-readable name for the certificate |
| `outputs` | Yes | Output file paths (see below) |
| `owner` | No | File ownership (`user:group`) |
| `mode` | No | File permissions (default: `0640`) |
| `reloadCmd` | No | Command to run after this cert updates |
| `healthCheckCmd` | No | Health check command (must return 0) |

### Output Options

| Output | Description | Use Case |
|--------|-------------|----------|
| `combined` | cert + key + chain | HAProxy |
| `cert` | Certificate only | General |
| `key` | Private key only | General |
| `chain` | CA chain certificates | General |
| `fullchain` | cert + chain | Nginx |

### Environment Variables

Environment variables override config file values:

| Variable | Description |
|----------|-------------|
| `ZNVAULT_URL` | Vault API URL |
| `ZNVAULT_TENANT_ID` | Tenant ID |
| `ZNVAULT_API_KEY` | API key for authentication |
| `ZNVAULT_USERNAME` | Username for login |
| `ZNVAULT_PASSWORD` | Password for login |
| `ZNVAULT_INSECURE` | Skip TLS verification (`true`/`false`) |
| `ZNVAULT_AGENT_CONFIG_DIR` | Custom config directory |
| `LOG_LEVEL` | Log level: `trace`, `debug`, `info`, `warn`, `error` |
| `LOG_FILE` | Optional log file path |

## CLI Commands

### Using znvault CLI

#### Initialize Configuration

```bash
znvault agent init [options]

Options:
  -c, --config <path>    Config file path
```

Creates a new config file with credentials from the CLI config.

#### Add Certificate

```bash
znvault agent add <cert-id> [options]

Options:
  -n, --name <name>          Human-readable name
  --combined <path>          Output path for combined cert+key+chain
  --cert <path>              Output path for certificate
  --key <path>               Output path for private key
  --chain <path>             Output path for CA chain
  --fullchain <path>         Output path for cert+chain
  --owner <user:group>       File ownership
  --mode <mode>              File permissions (default: 0640)
  --reload <command>         Command to run after cert update
  --health-check <command>   Health check command
  -c, --config <path>        Config file path
```

Example:
```bash
znvault agent add abc123-def456 \
  --name "haproxy-frontend" \
  --combined /etc/haproxy/certs/frontend.pem \
  --owner haproxy:haproxy \
  --reload "systemctl reload haproxy"
```

#### Remove Certificate

```bash
znvault agent remove <cert-id-or-name> [options]

Options:
  -c, --config <path>        Config file path
```

#### List Configured Certificates

```bash
znvault agent list [options]

Options:
  -c, --config <path>        Config file path
  --json                     Output as JSON
```

#### One-Time Sync

```bash
znvault agent sync [options]

Options:
  -c, --config <path>        Config file path
  -s, --state <path>         State file path
  --force                    Force sync even if unchanged
```

#### Start Agent Daemon

```bash
znvault agent start [options]

Options:
  -c, --config <path>        Config file path
  -v, --verbose              Enable verbose logging
  --health-port <port>       Enable health/metrics HTTP server
  --foreground               Run in foreground
```

This command invokes the standalone `zn-vault-agent` daemon.

#### Show Status

```bash
znvault agent status [options]

Options:
  -c, --config <path>        Config file path
  -s, --state <path>         State file path
  --json                     Output as JSON
```

### Using Standalone Agent

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
  --no-restart-on-change     Don't restart on changes
  --restart-delay <ms>       Delay before restart (default: 5000)
  --max-restarts <n>         Max restarts in window (default: 10)
  --restart-window <ms>      Restart count window (default: 300000)
```

Additional commands:
- `zn-vault-agent login` - Configure vault credentials
- `zn-vault-agent add` - Add a certificate
- `zn-vault-agent remove` - Remove a certificate
- `zn-vault-agent list` - List certificates
- `zn-vault-agent sync` - One-time sync
- `zn-vault-agent status` - Show status
- `zn-vault-agent setup` - Install systemd service (requires root)

## Secrets Sync

Beyond certificates, the agent can sync secrets from vault to local files. This enables applications to consume secrets in various formats without code changes.

### Required Permissions

Users syncing secrets need these permissions (typically via a custom role):

| Permission | Description |
|------------|-------------|
| `secret:list` | List available secrets |
| `secret:read:metadata` | Read secret metadata |
| `secret:read:value` | Decrypt secret values |

**Important**: Admin users cannot decrypt secrets (separation of duties). Create a regular user with a role containing these permissions:

```bash
# Create role (as superadmin)
curl -X POST "https://vault.example.com/v1/roles" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "secrets-agent",
    "tenantId": "my-tenant",
    "permissions": ["secret:list", "secret:read:metadata", "secret:read:value"]
  }'

# Assign role to user
curl -X POST "https://vault.example.com/v1/users/{user-id}/roles" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"roleId": "{role-id}", "tenantId": "my-tenant"}'
```

### List Available Secrets

```bash
# List secrets available in vault
zn-vault-agent secret available

# JSON output for scripting
zn-vault-agent secret available --json
```

### Add a Secret Target

Configure a secret to sync to a local file:

```bash
# Basic: Sync to .env file
zn-vault-agent secret add alias:database/credentials \
  --name db-creds \
  --format env \
  --output /etc/myapp/db.env

# With reload command
zn-vault-agent secret add alias:database/credentials \
  --name db-creds \
  --format env \
  --output /etc/myapp/db.env \
  --reload "systemctl restart myapp"

# JSON format
zn-vault-agent secret add alias:app/config \
  --name app-config \
  --format json \
  --output /etc/myapp/config.json

# Extract single key (raw format)
zn-vault-agent secret add alias:api/key \
  --name api-key \
  --format raw \
  --key apiKey \
  --output /etc/myapp/api-key.txt

# Template format
zn-vault-agent secret add alias:database/prod \
  --name db-template \
  --format template \
  --template /etc/myapp/config.tmpl \
  --output /etc/myapp/config.yml
```

**Options:**

| Option | Description |
|--------|-------------|
| `--name, -n` | Local name for this target (required) |
| `--format, -f` | Output format: `env`, `json`, `yaml`, `raw`, `template` (default: env) |
| `--output, -o` | Output file path (required) |
| `--key, -k` | For raw format: specific key to extract |
| `--template, -t` | For template format: path to template file |
| `--prefix, -p` | For env format: prefix for variable names |
| `--owner` | File ownership (e.g., `www-data:www-data`) |
| `--mode` | File permissions (default: `0600`) |
| `--reload` | Command to run after sync |

### Output Formats

**env** - Shell-compatible environment file:
```
HOST="db.example.com"
PORT="5432"
USERNAME="appuser"
PASSWORD="secretpass123"
```

**json** - JSON object:
```json
{
  "host": "db.example.com",
  "port": "5432",
  "username": "appuser",
  "password": "secretpass123"
}
```

**yaml** - YAML document:
```yaml
host: db.example.com
port: "5432"
username: appuser
password: secretpass123
```

**raw** - Single value (use with `--key`):
```
secretpass123
```

**template** - Mustache-style templates:
```yaml
# Template file: /etc/myapp/config.tmpl
database:
  host: {{ host }}
  port: {{ port }}
  credentials:
    user: {{ username }}
    pass: {{ password }}
```

### Sync Secrets

```bash
# Sync all configured targets
zn-vault-agent secret sync

# Sync specific target
zn-vault-agent secret sync --name db-creds

# Force sync (even if up-to-date)
zn-vault-agent secret sync --force
```

### Manage Targets

```bash
# List configured targets
zn-vault-agent secret list

# Remove a target
zn-vault-agent secret remove db-creds

# Force remove (no confirmation)
zn-vault-agent secret remove db-creds --force
```

### Secret Identification

Secrets can be referenced by:

1. **UUID**: `fba03de3-7c0c-4a99-a359-bf1db859affb`
2. **Alias**: `alias:database/credentials` (recommended)

Alias paths support hierarchical organization (e.g., `database/production/main`).

## Exec Mode

Run any command with secrets injected as environment variables. Secrets never touch disk - they exist only in the child process memory.

### Basic Usage

```bash
# Single secret
zn-vault-agent exec \
  -s DB_PASSWORD=alias:database/prod.password \
  -- node server.js

# Multiple secrets
zn-vault-agent exec \
  -s DB_HOST=alias:database/prod.host \
  -s DB_PORT=alias:database/prod.port \
  -s DB_PASSWORD=alias:database/prod.password \
  -- ./start.sh

# Full secret as JSON
zn-vault-agent exec \
  -s CONFIG=alias:app/config \
  -- node app.js
```

### Secret Mapping Format

```
ENV_VAR=secret-id[.key]
```

| Format | Example | Result |
|--------|---------|--------|
| UUID with key | `DB_PASS=abc123.password` | Extracts `password` key |
| Alias with key | `DB_HOST=alias:db/prod.host` | Extracts `host` key |
| Full secret | `CONFIG=alias:app/config` | JSON-encoded entire secret |

### Export to File

Generate an env file without running a command:

```bash
# Export to file (one-shot)
zn-vault-agent exec \
  -s DB_HOST=alias:database/prod.host \
  -s DB_PASSWORD=alias:database/prod.password \
  -o /tmp/db.env

# Then source it
source /tmp/db.env
./my-script.sh
```

### Watch Mode (Continuous Updates)

Use `--watch` with `--output` to keep the env file updated when secrets or managed API keys rotate:

```bash
# Export to file and watch for changes (daemon mode)
zn-vault-agent exec \
  -s VAULT_API_KEY=api-key:my-rotating-key \
  -s DB_PASSWORD=alias:database/prod.password \
  --output /tmp/secrets.env --watch
```

This is especially useful for:
- **Managed API keys** with auto-rotation (on-bind, on-use, scheduled modes)
- **Secrets** that may be updated while your application runs
- **Sidecar patterns** where another process reads the env file

The agent will:
1. Write initial secrets to the env file
2. Connect to vault via WebSocket
3. Update the env file when subscribed secrets/keys rotate
4. Run indefinitely until stopped (SIGTERM/SIGINT)

### Environment Inheritance

```bash
# Inherit current environment (default)
zn-vault-agent exec -s API_KEY=alias:api/key.value -- ./app

# Clean environment (secrets only)
zn-vault-agent exec --no-inherit \
  -s API_KEY=alias:api/key.value \
  -- ./app
```

### Signal Handling

The agent forwards signals to the child process:
- `SIGINT` (Ctrl+C) → Graceful shutdown
- `SIGTERM` → Terminate
- `SIGHUP` → Hangup

Exit code from the child process is preserved.

### Use Cases

**Docker/Container Entrypoint:**
```dockerfile
ENTRYPOINT ["zn-vault-agent", "exec", \
  "-s", "DB_PASSWORD=alias:db/prod.password", \
  "--"]
CMD ["node", "server.js"]
```

**Cron Jobs:**
```bash
# /etc/cron.d/backup
0 2 * * * root zn-vault-agent exec -s AWS_SECRET=alias:aws/backup.secret -- /opt/backup.sh
```

**CI/CD Pipelines:**
```yaml
- name: Deploy
  run: |
    zn-vault-agent exec \
      -s DEPLOY_KEY=alias:deploy/prod.key \
      -- ./deploy.sh
```

**Local Development:**
```bash
# .envrc (with direnv)
eval "$(zn-vault-agent exec -s DB_URL=alias:db/dev.url -e /dev/stdout)"
```

## Combined Mode

Combined mode runs certificate/secret sync AND manages a child process with injected environment variables in a single agent instance. This eliminates the need for two separate services.

### Why Combined Mode?

**Before (2 services):**
```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│ zn-vault-agent.service      │     │ payara.service              │
│ (daemon mode)               │     │ ExecStart: zn-vault-agent   │
│                             │     │   exec -s VAR=secret ...    │
│ • Syncs certificates        │     │   -- payara start           │
│ • Writes to disk            │     │                             │
│ • Watches for changes       │     │ • Injects env vars          │
│ • 1st WebSocket connection  │     │ • Spawns Payara             │
└─────────────────────────────┘     └─────────────────────────────┘
         │                                    │
         └────────── 2 connections ───────────┘
```

**After (combined mode):**
```
┌─────────────────────────────────────────────────────────────────┐
│ zn-vault-agent.service (combined mode)                          │
│                                                                 │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐│
│  │ Daemon Core         │    │ Child Process Manager           ││
│  │                     │    │                                 ││
│  │ • WebSocket conn    │───►│ • Spawn with env vars           ││
│  │ • Cert/secret sync  │    │ • Restart on change             ││
│  │ • Health endpoint   │    │ • Signal forwarding             ││
│  │ • Auto-update       │    │ • Crash recovery                ││
│  └─────────────────────┘    └─────────────────────────────────┘│
│                                        │                        │
│                                        ▼                        │
│                              ┌─────────────────┐                │
│                              │ Payara Process  │                │
│                              │ (with env vars) │                │
│                              └─────────────────┘                │
└─────────────────────────────────────────────────────────────────┘
```

**Benefits:**
- Single WebSocket connection (reduced vault load)
- Automatic child restart when certs or exec secrets change
- Unified health endpoint showing both daemon and child status
- Simpler systemd configuration (one service instead of two)
- Proper signal forwarding to child process

### CLI Usage

```bash
# Combined mode: daemon + exec
zn-vault-agent start \
  --exec "payara start-domain domain1" \
  -s ZINC_CONFIG_USE_VAULT=literal:true \
  -s ZINC_CONFIG_API_KEY=alias:infra/prod.apiKey \
  -s ZINC_CONFIG_SECRET=alias:infra/prod.secretPath \
  --restart-on-change \
  --restart-delay 5000 \
  --health-port 9100
```

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `--exec <command>` | - | Command to execute with secrets |
| `-s, --secret <mapping>` | - | Secret mapping as env var (repeatable) |
| `-sf, --secret-file <mapping>` | - | Secret written to file instead of env var (repeatable) |
| `--secrets-to-files` | `false` | Auto-detect sensitive secrets and write to files |
| `--restart-on-change` | `true` | Restart child on cert/secret changes |
| `--no-restart-on-change` | - | Don't restart on changes |
| `--restart-delay <ms>` | `5000` | Delay before restart (milliseconds) |
| `--max-restarts <n>` | `10` | Max restarts within window |
| `--restart-window <ms>` | `300000` | Restart count window (5 minutes) |

**Secret mapping format:**

```
ENV_VAR=type:value
ENV_VAR=alias:path.key
ENV_VAR=uuid.key
```

| Type | Example | Description |
|------|---------|-------------|
| `literal` | `USE_VAULT=literal:true` | Literal string value |
| `alias` | `API_KEY=alias:db/prod.apiKey` | Vault secret by alias |
| UUID | `PASS=abc123.password` | Vault secret by UUID |
| `api-key` | `KEY=api-key:my-rotating-key` | Managed API key value |

### Secure Mode: Secrets to Files

For security-sensitive deployments, secrets can be written to files instead of environment variables. This prevents secrets from appearing in:
- `/proc/<pid>/environ` (readable by same user)
- `sudo` command logs
- `journald` logs when using systemd
- Process listings (`ps auxe`)

**Use `-sf` for explicit file-based secrets:**

```bash
zn-vault-agent start \
  --exec "python server.py" \
  -s ZINC_CONFIG_USE_VAULT=literal:true \
  -sf VAULT_API_KEY=api-key:my-key \
  -sf AWS_SECRET_ACCESS_KEY=alias:aws.secretKey \
  --health-port 9100
```

The agent will:
1. Create temporary files with `0600` permissions
2. Set `VAULT_API_KEY_FILE` and `AWS_SECRET_ACCESS_KEY_FILE` env vars pointing to the files
3. Your application reads secrets from the file paths

**Use `--secrets-to-files` for automatic detection:**

```bash
zn-vault-agent start \
  --exec "python server.py" \
  -s ZINC_CONFIG_USE_VAULT=literal:true \
  -s VAULT_API_KEY=api-key:my-key \
  -s AWS_SECRET_ACCESS_KEY=alias:aws.secretKey \
  --secrets-to-files \
  --health-port 9100
```

This automatically detects sensitive env var names (containing `KEY`, `SECRET`, `PASSWORD`, `TOKEN`, etc.) and writes them to files.

**Config file format for file-based secrets:**

```json
{
  "exec": {
    "secrets": [
      { "env": "VAULT_API_KEY", "apiKey": "my-key", "outputToFile": true },
      { "env": "AWS_SECRET", "secret": "alias:aws.secretKey", "outputToFile": true }
    ]
  }
}
```

### Config File

Combined mode can also be configured via the config file:

```json
{
  "vaultUrl": "https://vault.example.com",
  "tenantId": "production",
  "auth": { "apiKey": "znv_..." },

  "targets": [
    {
      "certId": "alias:certs/haproxy",
      "name": "haproxy-cert",
      "outputs": { "combined": "/etc/haproxy/certs/frontend.pem" },
      "reloadCmd": "systemctl reload haproxy"
    }
  ],

  "exec": {
    "command": ["payara", "start-domain", "domain1"],
    "secrets": [
      { "env": "ZINC_CONFIG_USE_VAULT", "literal": "true" },
      { "env": "ZINC_CONFIG_API_KEY", "secret": "alias:infra/prod.apiKey" },
      { "env": "ZINC_CONFIG_SECRET", "secret": "alias:infra/prod.secretPath" }
    ],
    "inheritEnv": true,
    "restartOnChange": true,
    "restartDelayMs": 5000,
    "maxRestarts": 10,
    "restartWindowMs": 300000
  }
}
```

When `exec` is configured, the agent will:
1. Start the daemon (cert/secret sync, WebSocket connection)
2. After initial sync, spawn the child process with secrets injected
3. Restart the child when certs or exec secrets change

### Behavior

| Scenario | Behavior |
|----------|----------|
| **Startup** | Sync all certs/secrets → fetch exec secrets → spawn child |
| **Cert changes** | Update file → run reload command → restart child |
| **Secret file changes** | Update file → run reload command → restart child |
| **Exec secret changes** | Fetch new values → restart child with new env |
| **Child crashes** | Wait `restartDelayMs` → respawn (with rate limiting) |
| **SIGTERM received** | Kill child with SIGTERM → wait for exit → shutdown daemon |
| **SIGINT received** | Kill child with SIGINT → wait for exit → shutdown daemon |
| **Max restarts exceeded** | Log error, enter degraded state, keep daemon running |

### Health Status

The `/health` endpoint includes child process status:

```json
{
  "status": "healthy",
  "timestamp": "2025-01-05T12:00:00Z",
  "uptime": 3600,
  "version": "1.4.0",
  "websocket": {
    "certificates": { "connected": true },
    "secrets": { "connected": true }
  },
  "vault": { "url": "https://vault.example.com", "reachable": true },
  "certificates": { "total": 1, "synced": 1, "errors": 0 },
  "secrets": { "total": 2, "synced": 2, "errors": 0 },
  "childProcess": {
    "status": "running",
    "pid": 12345,
    "restartCount": 0,
    "lastStartTime": "2025-01-05T11:00:00Z",
    "lastExitCode": null,
    "lastExitTime": null
  }
}
```

**Child process states:**

| State | Health Impact | Description |
|-------|---------------|-------------|
| `running` | healthy | Child is running normally |
| `starting` | healthy | Child is starting up |
| `restarting` | degraded | Child is restarting |
| `crashed` | degraded | Child crashed, will auto-restart |
| `stopped` | healthy | Child was intentionally stopped |
| `max_restarts_exceeded` | degraded | Too many restarts, auto-restart disabled |

### Systemd Service (Combined Mode)

```ini
[Unit]
Description=ZN-Vault Agent (Combined Mode)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/zn-vault-agent start \
    --health-port 9100 \
    --exec "payara start-domain domain1" \
    -s ZINC_CONFIG_USE_VAULT=literal:true \
    -s ZINC_CONFIG_API_KEY=alias:infra/prod.apiKey \
    --restart-on-change \
    --restart-delay 5000
Restart=always
RestartSec=10
EnvironmentFile=/etc/zn-vault-agent/secrets.env

[Install]
WantedBy=multi-user.target
```

### Migration from 2-Service Setup

**Before (2 services):**

```ini
# /etc/systemd/system/zn-vault-agent.service
[Service]
ExecStart=/usr/local/bin/zn-vault-agent start

# /etc/systemd/system/payara.service
[Service]
ExecStart=/usr/local/bin/zn-vault-agent exec \
    -s ZINC_CONFIG_USE_VAULT=literal:true \
    -s ZINC_CONFIG_API_KEY=alias:infra/prod.apiKey \
    -- payara start-domain domain1
```

**After (combined mode):**

```ini
# /etc/systemd/system/zn-vault-agent.service (replaces both)
[Service]
ExecStart=/usr/local/bin/zn-vault-agent start \
    --exec "payara start-domain domain1" \
    -s ZINC_CONFIG_USE_VAULT=literal:true \
    -s ZINC_CONFIG_API_KEY=alias:infra/prod.apiKey \
    --restart-on-change
```

**Migration steps:**

1. Stop both services:
   ```bash
   sudo systemctl stop payara zn-vault-agent
   ```

2. Update zn-vault-agent.service with combined mode config

3. Disable the old payara service:
   ```bash
   sudo systemctl disable payara
   ```

4. Reload and start:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl start zn-vault-agent
   ```

5. Verify:
   ```bash
   curl http://localhost:9100/health | jq '.childProcess'
   ```

### Crash Recovery

The child process manager implements crash recovery with rate limiting:

1. **On crash**: Wait `restartDelayMs` before restarting
2. **Rate limiting**: Track restarts within `restartWindowMs`
3. **Max restarts**: If `maxRestarts` exceeded within window, enter degraded state
4. **Window reset**: Restart counter resets after window expires
5. **Manual recovery**: Call `/health` to check status, restart daemon to reset

**Example timeline:**

```
T+0s:    Child crashes (restart count: 1)
T+5s:    Auto-restart child
T+10s:   Child crashes (restart count: 2)
T+15s:   Auto-restart child
...
T+50s:   Child crashes (restart count: 11)
         → Max restarts exceeded, enter degraded state
         → Agent continues running, but won't restart child
         → Health endpoint shows "max_restarts_exceeded"

T+300s:  Window expires, restart count resets
         → If daemon is restarted, child will auto-start
```

## WebSocket Protocol

### Connection

Connect to: `wss://vault.example.com/v1/ws/certificates`

Authentication (choose one):
- Query parameter: `?apiKey=znv_...`
- Header: `Authorization: Bearer <jwt-token>`
- Header: `X-API-Key: znv_...`

Subscription (via query parameter):
```
wss://vault.example.com/v1/ws/certificates?subscribe=cert-id-1,cert-id-2
```

### Message Types

#### Client → Server

**Ping** (heartbeat)
```json
{ "type": "ping" }
```

**Subscribe** (add certificates to watch)
```json
{ "type": "subscribe", "certIds": ["uuid-1", "uuid-2"] }
```

**Unsubscribe** (stop watching certificates)
```json
{ "type": "unsubscribe", "certIds": ["uuid-1"] }
```

#### Server → Client

**Connection Established**
```json
{
  "type": "connection_established",
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

**Subscribed** (confirmation)
```json
{
  "type": "subscribed",
  "data": ["uuid-1", "uuid-2"],
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

**Pong** (heartbeat response)
```json
{
  "type": "pong",
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

**Event** (certificate change)
```json
{
  "type": "event",
  "data": {
    "event": "certificate.rotated",
    "certificateId": "uuid-1",
    "fingerprint": "SHA256:...",
    "version": 2,
    "tenantId": "acme",
    "alias": "my-cert",
    "timestamp": "2025-01-15T10:30:00.000Z"
  },
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

**Error**
```json
{
  "type": "error",
  "error": "Authentication required",
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

### Event Types

| Event | Description |
|-------|-------------|
| `certificate.created` | New certificate was created |
| `certificate.rotated` | Certificate was rotated to new version |
| `certificate.deleted` | Certificate was deleted |

### Heartbeat Protocol

The agent implements a custom ping/pong heartbeat:

1. Agent sends `{"type": "ping"}` every 15 seconds
2. Server responds with `{"type": "pong"}`
3. If no pong received within 10 seconds, connection is considered dead
4. Agent terminates connection and reconnects after 5 seconds

This ensures dead connections are detected even when TCP keepalive doesn't trigger.

## High Availability

### Cross-Node Event Distribution

In HA mode with multiple vault nodes, certificate events are distributed via Redis pub/sub:

```
Agent ──► Vault-1 (event occurs)
              │
              ▼
          Redis Pub/Sub (channel: zn-vault:cert-events)
              │
              ├──► Vault-1 ──► (skips, originated here)
              ├──► Vault-2 ──► Agent connected to Vault-2
              └──► Vault-3 ──► Agent connected to Vault-3
```

**How it works:**
1. Certificate operation occurs on any vault node
2. That node broadcasts event to local WebSocket clients
3. That node publishes event to Redis with `originNodeId`
4. Other nodes receive via Redis subscription
5. Other nodes broadcast to their local WebSocket clients
6. Origin node ignores Redis message (already handled locally)

### Agent Resilience

Agents handle node failures gracefully:

```bash
# Agent connects to load balancer
# On disconnect (node failure, network issue):
# 1. Connection closes
# 2. Agent waits 5 seconds
# 3. Agent reconnects (load balancer routes to healthy node)
# 4. Agent re-subscribes to certificates
# 5. Agent syncs any missed updates
```

### Re-subscription on Reconnect

When reconnecting, the agent automatically:
1. Includes subscribed certificate IDs in the WebSocket URL
2. Sends a `subscribe` message as backup
3. Performs a sync to catch any missed updates

## Auto-Update System

The agent automatically updates itself via npm. Updates are checked every 5 minutes by default.

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    zn-vault-agent daemon                     │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │   Main Process   │    │   Auto-Update Service        │   │
│  │   (cert sync)    │    │   - Check npm every 5 min    │   │
│  │                  │    │   - Acquire lock file        │   │
│  │                  │    │   - npm install -g           │   │
│  │                  │    │   - Signal systemd restart   │   │
│  └──────────────────┘    └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    /var/run/zn-vault-agent.update.lock
                    (prevents concurrent updates)
```

1. Agent periodically runs `npm view @zincapp/zn-vault-agent version`
2. If newer version available, acquires lock file (prevents multiple agents updating)
3. Runs `npm install -g @zincapp/zn-vault-agent`
4. Sends SIGTERM to self, systemd restarts with new version
5. Graceful restart preserves configuration and reconnects to vault

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

### Multi-Agent Safety

When multiple agents run on the same host, the lock file mechanism ensures:
- Only one agent performs the update
- Other agents detect the lock and skip updating
- All agents restart when systemd restarts the service
- Stale locks (>10 minutes) are automatically cleaned up

## Use Cases

### HAProxy Certificate Automation

```bash
# Add certificate with combined output for HAProxy
znvault agent add $CERT_ID \
  --name "frontend" \
  --combined /etc/haproxy/certs/frontend.pem \
  --owner haproxy:haproxy \
  --mode 0640 \
  --reload "haproxy -c -f /etc/haproxy/haproxy.cfg && systemctl reload haproxy"

# Start agent
zn-vault-agent start --health-port 9100
```

### Nginx Certificate Automation

```bash
# Add certificate with separate files for Nginx
znvault agent add $CERT_ID \
  --name "api-server" \
  --fullchain /etc/nginx/ssl/api-fullchain.pem \
  --key /etc/nginx/ssl/api.key \
  --reload "nginx -t && systemctl reload nginx"
```

### HAProxy Full Configuration Management

Manage both certificates AND the `haproxy.cfg` configuration file from the vault. This approach stores the entire config file as a secret, enabling centralized configuration management with real-time updates via WebSocket.

#### Option A: Full File as Secret (Raw Format)

Store the entire configuration file as a secret and deploy it directly:

**1. Create the secret in vault:**

```bash
# Store haproxy.cfg content as a secret
curl -X POST "https://vault.example.com/v1/secrets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "haproxy/config",
    "tenantId": "infrastructure",
    "type": "text",
    "data": {
      "content": "global\n    log stdout format raw local0\n    maxconn 4096\n\ndefaults\n    mode http\n    timeout connect 5s\n    timeout client 50s\n    timeout server 50s\n\nfrontend https_front\n    bind *:443 ssl crt /etc/haproxy/certs/\n    default_backend app_servers\n\nbackend app_servers\n    balance roundrobin\n    server app-1 172.16.220.10:8080 check\n    server app-2 172.16.220.11:8080 check\n    server app-3 172.16.220.12:8080 check\n"
    }
  }'
```

**2. Configure the agent:**

```json
{
  "vaultUrl": "https://vault.example.com",
  "tenantId": "infrastructure",
  "auth": { "apiKey": "znv_..." },
  "targets": [
    {
      "certId": "alias:certs/haproxy-frontend",
      "name": "haproxy-cert",
      "outputs": { "combined": "/etc/haproxy/certs/frontend.pem" },
      "owner": "haproxy:haproxy",
      "mode": "0640",
      "reloadCmd": "systemctl reload haproxy",
      "healthCheckCmd": "haproxy -c -f /etc/haproxy/haproxy.cfg"
    }
  ],
  "secretTargets": [
    {
      "secretId": "alias:haproxy/config",
      "name": "haproxy-cfg",
      "format": "raw",
      "key": "content",
      "output": "/etc/haproxy/haproxy.cfg",
      "owner": "root:haproxy",
      "mode": "0644",
      "reloadCmd": "haproxy -c -f /etc/haproxy/haproxy.cfg && systemctl reload haproxy"
    }
  ]
}
```

**3. Add via CLI:**

```bash
# Add certificate target
znvault agent add alias:certs/haproxy-frontend \
  --name haproxy-cert \
  --combined /etc/haproxy/certs/frontend.pem \
  --owner haproxy:haproxy \
  --reload "systemctl reload haproxy" \
  --health-check "haproxy -c -f /etc/haproxy/haproxy.cfg"

# Add config file target
zn-vault-agent secret add alias:haproxy/config \
  --name haproxy-cfg \
  --format raw \
  --key content \
  --output /etc/haproxy/haproxy.cfg \
  --owner root:haproxy \
  --mode 0644 \
  --reload "haproxy -c -f /etc/haproxy/haproxy.cfg && systemctl reload haproxy"
```

#### Option B: Template-Based Configuration

For configs with dynamic values, use a local template with placeholders:

**1. Create template on the HAProxy server** (`/etc/haproxy/haproxy.cfg.tpl`):

```haproxy
global
    log stdout format raw local0
    maxconn {{ maxconn }}

defaults
    mode http
    timeout connect {{ timeout_connect }}
    timeout client {{ timeout_client }}
    timeout server {{ timeout_server }}

frontend https_front
    bind *:443 ssl crt /etc/haproxy/certs/
    default_backend {{ default_backend }}

backend app_servers
    balance {{ balance_algorithm }}
    server app-1 {{ server_1 }}:{{ server_port }} check
    server app-2 {{ server_2 }}:{{ server_port }} check
    server app-3 {{ server_3 }}:{{ server_port }} check
```

**2. Store values as a secret:**

```bash
curl -X POST "https://vault.example.com/v1/secrets" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "haproxy/config-values",
    "tenantId": "infrastructure",
    "type": "generic",
    "data": {
      "maxconn": "4096",
      "timeout_connect": "5s",
      "timeout_client": "50s",
      "timeout_server": "50s",
      "default_backend": "app_servers",
      "balance_algorithm": "roundrobin",
      "server_1": "172.16.220.10",
      "server_2": "172.16.220.11",
      "server_3": "172.16.220.12",
      "server_port": "8080"
    }
  }'
```

**3. Configure template-based deployment:**

```bash
zn-vault-agent secret add alias:haproxy/config-values \
  --name haproxy-cfg \
  --format template \
  --template /etc/haproxy/haproxy.cfg.tpl \
  --output /etc/haproxy/haproxy.cfg \
  --owner root:haproxy \
  --mode 0644 \
  --reload "haproxy -c -f /etc/haproxy/haproxy.cfg && systemctl reload haproxy"
```

#### Comparison: Full File vs Template

| Aspect | Full File (Raw) | Template |
|--------|-----------------|----------|
| **Source of truth** | Entire config in vault | Template on disk, values in vault |
| **Editing** | Edit in vault dashboard/API | Edit template locally, values in vault |
| **Versioning** | Full config versioned in vault | Only values versioned |
| **Flexibility** | Simple, single secret | Can reuse template across environments |
| **Best for** | Small configs, full central control | Large configs, environment-specific values |

#### Deployment Flow

Both approaches follow the same flow when a secret is updated:

```
Vault (secret updated)
  │
  ▼ WebSocket push (instant)
Agent on HAProxy node
  │
  ▼ Fetch updated secret
  │
  ▼ Write to temp file (atomic)
  │
  ▼ Validate: haproxy -c -f /etc/haproxy/haproxy.cfg
  │
  ├─► Success: rename temp → target, reload HAProxy
  │
  └─► Failure: delete temp, log error, alert
```

### Application mTLS

```bash
# Add client certificate for mTLS
znvault agent add $CERT_ID \
  --name "app-mtls" \
  --cert /opt/myapp/certs/client.crt \
  --key /opt/myapp/certs/client.key \
  --chain /opt/myapp/certs/ca-chain.crt \
  --reload "kill -HUP $(cat /var/run/myapp.pid)"
```

### Systemd Service

Create `/etc/systemd/system/zn-vault-agent.service`:

```ini
[Unit]
Description=ZN-Vault Certificate Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/zn-vault-agent start --health-port 9100
Restart=always
RestartSec=10
EnvironmentFile=/etc/zn-vault-agent/secrets.env

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zn-vault-agent
```

## Troubleshooting

### Agent Won't Connect

```bash
# Check authentication
znvault whoami

# Verify certificate exists
znvault certificate get $CERT_ID

# Test WebSocket manually
wscat -c "wss://vault.example.com/v1/ws/certificates?apiKey=$API_KEY" --no-check
```

### Certificates Not Syncing

```bash
# Check agent status
znvault agent status

# Force sync
znvault agent sync --force

# Check health endpoint (if enabled)
curl http://localhost:9100/health
```

### WebSocket Disconnecting

- Check network connectivity to vault
- Verify API key is valid and not expired
- Check vault server logs for auth errors
- Agent will auto-reconnect with fixed interval

### Reload Command Failing

```bash
# Test command manually
/usr/local/bin/reload-services.sh

# Check permissions
ls -la /usr/local/bin/reload-services.sh

# Check agent logs
journalctl -u zn-vault-agent -f
```

### Debug Mode

For detailed logging:
```bash
LOG_LEVEL=debug zn-vault-agent start
```

## API Reference

### Certificate WebSocket Endpoint

**URL**: `GET /v1/ws/certificates`

**Query Parameters**:
| Parameter | Description |
|-----------|-------------|
| `subscribe` | Comma-separated list of certificate IDs |
| `apiKey` | API key for authentication |

**Headers**:
| Header | Description |
|--------|-------------|
| `Authorization` | Bearer token for JWT authentication |
| `X-API-Key` | API key for authentication |

### Health Endpoints

When started with `--health-port`:

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

## API Key Auto-Renewal

The agent automatically renews API keys before they expire, eliminating the need for manual key rotation.

### How It Works

1. **Check Frequency**: Every 24 hours, the agent checks key expiration via `GET /auth/api-keys/self`
2. **Renewal Threshold**: If the key expires within 30 days, rotation is initiated
3. **Atomic Rotation**: Calls `POST /auth/api-keys/self/rotate` to get a new key
4. **Config Update**: New key is saved atomically to config file
5. **Immediate Invalidation**: Old key is immediately invalidated by the vault

### Log Output

```
{"level":"info","msg":"Starting API key renewal service","checkIntervalHours":24,"renewalThresholdDays":30}
{"level":"info","msg":"API key status","expiresInDays":25,"isExpiringSoon":true}
{"level":"info","msg":"API key expiring soon, initiating rotation","expiresInDays":25,"threshold":30}
{"level":"info","msg":"API key rotated successfully","newPrefix":"znv_abc1"}
{"level":"info","msg":"Config file updated with new API key"}
```

### Requirements

- API key must have permission to call the self-rotate endpoint (all API keys have this by default)
- Config file must be writable by the agent process
- Agent daemon must be running (renewal only happens while daemon is active)

### Manual Renewal

If the daemon runs intermittently, you can check key status manually:

```bash
# Check key status
curl -sk https://vault.example.com/auth/api-keys/self \
  -H "X-API-Key: znv_..." | jq '.expiresInDays, .isExpiringSoon'

# Manually rotate if needed
curl -sk -X POST https://vault.example.com/auth/api-keys/self/rotate \
  -H "X-API-Key: znv_..." \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Security Considerations

1. **API Key Scope**: Use API keys with minimal required permissions (`certificate:read:metadata`, `certificate:read:value`)
2. **API Key Expiration**: Set expiration to 365 days max - the agent will auto-renew before expiry
3. **IP Allowlist**: Restrict API keys to specific server IPs for additional security
4. **File Permissions**: Private keys are written with `0600`, certificates with `0640`
5. **TLS Verification**: In production, avoid `insecure: true` - use proper CA certificates
6. **Reload Commands**: Ensure reload scripts are owned by root with restricted write access
7. **State Files**: State files may contain certificate metadata - protect accordingly
8. **Credentials**: Use `secrets.env` file with `0600` permissions, not config file

## Best Practices

1. **Use Dedicated Service Account**: Create a dedicated user/API key for agent authentication
2. **Monitor Agent Health**: Set up monitoring for agent process and WebSocket connection
3. **Test Reload Commands**: Verify reload commands work before deploying agents
4. **Plan for Failures**: Agents handle disconnections gracefully, but ensure critical services can handle brief cert unavailability
5. **Backup State**: Back up agent state files as part of disaster recovery
6. **Version Lock**: Use specific certificate IDs rather than aliases to avoid unexpected updates
7. **Enable Metrics**: Use `--health-port` for observability in production

## Development

### Building from Source

```bash
git clone https://github.com/vidaldiego/zn-vault-agent.git
cd zn-vault-agent
npm install
npm run build
npm test
```

### Project Structure

```
zn-vault-agent/
├── src/
│   ├── commands/        # CLI command handlers
│   ├── services/        # Core services (sync, websocket, auto-update)
│   ├── lib/             # Shared utilities
│   └── types/           # TypeScript type definitions
├── test/
│   ├── unit/            # Unit tests
│   └── integration/     # Integration tests
├── deploy/
│   ├── install.sh       # Local installation script
│   ├── systemd/         # Systemd service files
│   └── logrotate.d/     # Log rotation config
└── .github/workflows/   # CI/CD pipelines
```

### Release Process

Releases use GitHub Actions with npm OIDC trusted publishing:

```bash
# 1. Update version
npm version patch  # or minor/major

# 2. Push with tags
git push && git push --tags
```

GitHub Actions automatically:
1. Runs tests on Node.js 18, 20, 22
2. Builds the package
3. Publishes to npm with provenance attestation
4. Tags pre-releases as `beta` or `next`

### Local Testing

```bash
# Build and link locally
npm run build
npm link

# Test the CLI
zn-vault-agent --help

# Run with debug logging
LOG_LEVEL=debug zn-vault-agent start
```
