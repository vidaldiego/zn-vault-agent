#!/bin/bash
# ZnVault Certificate Agent Installation Script
#
# Usage:
#   sudo ./install.sh           # Install from local build
#   sudo ./install.sh --npm     # Install from npm registry
#   sudo ./install.sh --uninstall
#
# For production, prefer: npm install -g @zincapp/zn-vault-agent

set -e

# Configuration
INSTALL_DIR="/usr/local/bin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "This script must be run as root"
        exit 1
    fi
}

check_node() {
    if ! command -v node &> /dev/null; then
        log_error "Node.js is required but not installed"
        log_info "Install Node.js 18+ and try again"
        exit 1
    fi

    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        log_error "Node.js 18+ is required (found v$NODE_VERSION)"
        exit 1
    fi

    log_info "Found Node.js $(node -v)"
}

uninstall() {
    log_info "Uninstalling ZnVault Certificate Agent..."

    # Use the agent's setup --uninstall if available
    if command -v zn-vault-agent &> /dev/null; then
        zn-vault-agent setup --uninstall --yes || true
    else
        # Manual cleanup
        systemctl stop zn-vault-agent.service 2>/dev/null || true
        systemctl disable zn-vault-agent.service 2>/dev/null || true
        rm -f /etc/systemd/system/zn-vault-agent.service
        systemctl daemon-reload
    fi

    # Remove binary if installed from local
    rm -f "$INSTALL_DIR/zn-vault-agent"
    rm -rf /opt/zn-vault-agent

    # Uninstall npm global if exists
    npm uninstall -g @zincapp/zn-vault-agent 2>/dev/null || true

    log_warn "Configuration preserved in /etc/zn-vault-agent/"
    log_warn "Data preserved in /var/lib/zn-vault-agent/"
    log_warn "User zn-vault-agent not removed"

    log_info "Uninstallation complete"
    exit 0
}

install_from_npm() {
    log_info "Installing from npm registry..."
    npm install -g @zincapp/zn-vault-agent

    log_info "Running setup..."
    zn-vault-agent setup --yes
}

install_from_local() {
    log_info "Installing from local build..."

    # Check if build exists
    if [ ! -f "$SCRIPT_DIR/../dist/index.js" ]; then
        log_error "Build not found. Run 'npm run build' first."
        exit 1
    fi

    # Copy application
    log_info "Copying application to /opt/zn-vault-agent..."
    mkdir -p /opt/zn-vault-agent
    cp -r "$SCRIPT_DIR/../dist" /opt/zn-vault-agent/
    cp -r "$SCRIPT_DIR/../node_modules" /opt/zn-vault-agent/
    cp "$SCRIPT_DIR/../package.json" /opt/zn-vault-agent/

    # Create wrapper script
    log_info "Creating wrapper script..."
    cat > "$INSTALL_DIR/zn-vault-agent" << 'EOF'
#!/bin/bash
exec node /opt/zn-vault-agent/dist/index.js "$@"
EOF
    chmod +x "$INSTALL_DIR/zn-vault-agent"

    # Run setup
    log_info "Running setup..."
    "$INSTALL_DIR/zn-vault-agent" setup --yes
}

# Main
check_root
check_node

case "$1" in
    --uninstall)
        uninstall
        ;;
    --npm)
        install_from_npm
        ;;
    *)
        install_from_local
        ;;
esac

log_info ""
log_info "Installation complete!"
log_info ""
log_info "Next steps:"
echo "  1. Configure: zn-vault-agent login"
echo "  2. Add certs: zn-vault-agent certs add"
echo "  3. Start:     sudo systemctl start zn-vault-agent"
echo "  4. Status:    sudo systemctl status zn-vault-agent"
