#!/usr/bin/env bash
# Downloads the pinned PocketBase release into tools/. Bump the version only after
# reading the release notes and running `npm test` in backend/ (architecture section 3).
set -euo pipefail
VERSION="0.40.6"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"; ARCH="$(uname -m)"
case "$ARCH" in x86_64) ARCH=amd64;; arm64|aarch64) ARCH=arm64;; esac
cd "$(dirname "$0")"
curl -fsSL -o pb.zip "https://github.com/pocketbase/pocketbase/releases/download/v${VERSION}/pocketbase_${VERSION}_${OS}_${ARCH}.zip"
unzip -o -q pb.zip pocketbase && rm pb.zip
./pocketbase --version
