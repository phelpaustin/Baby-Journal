#!/usr/bin/env bash
# Downloads the pinned Caddy release into tools/ (used by the infra tests; production uses the
# Ansible-installed copy). Bump the version only after re-running infra/tests/run-all.sh.
set -euo pipefail
VERSION="2.11.8"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"; [ "$OS" = darwin ] && OS=mac
ARCH="$(uname -m)"; case "$ARCH" in x86_64) ARCH=amd64;; arm64|aarch64) ARCH=arm64;; esac
cd "$(dirname "$0")"
curl -fsSL -o caddy.tgz "https://github.com/caddyserver/caddy/releases/download/v${VERSION}/caddy_${VERSION}_${OS}_${ARCH}.tar.gz"
tar xzf caddy.tgz caddy && rm caddy.tgz
./caddy version
