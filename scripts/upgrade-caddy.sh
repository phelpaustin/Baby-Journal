#!/usr/bin/env bash
# Tries a Caddy version against the config checks and the whole network chain (35 tests) before it goes near the Mac.
#   scripts/upgrade-caddy.sh 2.11.9
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="${1:?usage: upgrade-caddy.sh <version, e.g. 2.11.9>}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"; [ "$OS" = darwin ] && OS=mac
ARCH="$(uname -m)"; case "$ARCH" in x86_64) ARCH=amd64;; arm64|aarch64) ARCH=arm64;; esac
DIR="$ROOT/tools/upgrade/caddy-$VER"
mkdir -p "$DIR" && cd "$DIR" || exit 1
if [ ! -x ./caddy ]; then
  curl -fsSL -o c.tgz "https://github.com/caddyserver/caddy/releases/download/v${VER}/caddy_${VER}_${OS}_${ARCH}.tar.gz" || { echo "download failed: is v$VER a real release?"; exit 1; }
  tar xzf c.tgz caddy && rm -f c.tgz
fi
echo "candidate: $(./caddy version | cut -d' ' -f1)   release notes: https://github.com/caddyserver/caddy/releases/tag/v$VER"
echo "pinned:    $(grep -m1 '^VERSION=' "$ROOT/tools/get-caddy.sh" | cut -d'"' -f2)"
CADDY_BIN="$DIR/caddy" "$ROOT/scripts/check.sh" infra | tee /tmp/bj-upgrade.out
if grep -q "FAIL\|INCOMPLETE" /tmp/bj-upgrade.out; then echo "RESULT: do NOT upgrade yet. Read /tmp/bj-check/chain.log and the release notes."; exit 1; fi
cat <<MSG
RESULT: the candidate passes the config checks and the network chain tests (headers, admin lockout, PROXY protocol, rate limits, logs, 1 GB upload).
Then: change VERSION in tools/get-caddy.sh, caddy_version and caddy_sha256 in infra/ansible/group_vars/all.yml, run ansible-playbook macmini.yml
(the play validates the new Caddyfile with the new binary before installing it).
MSG
