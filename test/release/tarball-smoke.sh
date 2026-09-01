#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 /absolute/path/zn-vault-agent-2.0.0.tgz /absolute/path/znvault-plugin-payara-3.0.0.tgz" >&2
  exit 64
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Required command not found: docker" >&2
  exit 69
fi

absolute_file() {
  local input_path=$1
  if [[ ! -f "$input_path" ]]; then
    echo "Tarball not found: $input_path" >&2
    exit 66
  fi
  local input_dir
  input_dir=$(cd "$(dirname "$input_path")" && pwd -P)
  echo "$input_dir/$(basename "$input_path")"
}

agent_tarball=$(absolute_file "$1")
plugin_tarball=$(absolute_file "$2")
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
runtime_script="$script_dir/tarball-smoke-runtime.mjs"

if [[ ! -f "$runtime_script" ]]; then
  echo "Runtime smoke script not found: $runtime_script" >&2
  exit 66
fi

# Matches the release CI floor and forward-runtime matrix. Override with a
# whitespace-separated list of image references (including digests) when a
# release receipt needs fully pinned container identities.
node_images=${ZNVAULT_RELEASE_NODE_IMAGES:-"node:22.13.0-bookworm node:24-bookworm"}

for node_image in $node_images; do
  echo "Running release tarball smoke in $node_image"
  docker run --rm \
    --read-only \
    --cap-drop=ALL \
    --security-opt=no-new-privileges:true \
    --pids-limit=128 \
    --user=1000:1000 \
    --env=NODE_ENV=production \
    --env=USER=node \
    --env=HOME=/tmp/home \
    --env=npm_config_cache=/tmp/npm-cache \
    --tmpfs=/tmp:rw,exec,uid=1000,gid=1000,mode=700 \
    --tmpfs=/var/lib/zn-vault-agent:rw,exec,uid=1000,gid=1000,mode=700 \
    --mount="type=bind,src=$agent_tarball,dst=/artifacts/agent.tgz,readonly" \
    --mount="type=bind,src=$plugin_tarball,dst=/artifacts/plugin.tgz,readonly" \
    --mount="type=bind,src=$runtime_script,dst=/harness/tarball-smoke-runtime.mjs,readonly" \
    "$node_image" \
    bash -euo pipefail -c '
      command -v ps >/dev/null
      smoke_dir=$(mktemp -d /tmp/znvault-release-smoke.XXXXXX)
      mkdir -p "$HOME"
      cp /harness/tarball-smoke-runtime.mjs "$smoke_dir/smoke.mjs"
      cd "$smoke_dir"
      npm init --yes >/dev/null
      npm pkg set private=true type=module >/dev/null
      npm install \
        --ignore-scripts \
        --no-audit \
        --no-fund \
        --package-lock=false \
        --save-exact \
        /artifacts/agent.tgz \
        /artifacts/plugin.tgz
      npm ls \
        @zincapp/zn-vault-agent@2.0.0 \
        @zincapp/znvault-plugin-payara@3.0.0 \
        --depth=0
      node ./smoke.mjs /artifacts/agent.tgz /artifacts/plugin.tgz
    '
done
