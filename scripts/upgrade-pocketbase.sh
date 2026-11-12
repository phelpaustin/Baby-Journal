#!/usr/bin/env bash
# Tries a PocketBase version against the whole test suite BEFORE it goes near the real server.
#   scripts/upgrade-pocketbase.sh 0.41.0
# Downloads it to tools/upgrade/, runs the backend and client suites on it, and says what to change if it passes.
# It never touches the pinned binary or any real data. Test it on a restored copy next (docs/operations.md).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="${1:?usage: upgrade-pocketbase.sh <version, e.g. 0.41.0>}"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"; ARCH="$(uname -m)"; case "$ARCH" in x86_64) ARCH=amd64;; arm64|aarch64) ARCH=arm64;; esac
DIR="$ROOT/tools/upgrade/pocketbase-$VER"
mkdir -p "$DIR" && cd "$DIR" || exit 1
if [ ! -x ./pocketbase ]; then
  curl -fsSL -o pb.zip "https://github.com/pocketbase/pocketbase/releases/download/v${VER}/pocketbase_${VER}_${OS}_${ARCH}.zip" || { echo "download failed: is v$VER a real release?"; exit 1; }
  unzip -o -q pb.zip pocketbase && rm -f pb.zip
fi
echo "candidate: $(./pocketbase --version)   release notes: https://github.com/pocketbase/pocketbase/releases/tag/v$VER"
echo "pinned:    $(grep -m1 '^VERSION=' "$ROOT/tools/get-pocketbase.sh" | cut -d'"' -f2)"
echo "Running the test suites on the candidate (about 1 minute)..."
PB_BIN="$DIR/pocketbase" "$ROOT/scripts/check.sh" quick | tee /tmp/bj-upgrade.out
if grep -q "FAIL\|INCOMPLETE" /tmp/bj-upgrade.out; then
  echo "RESULT: do NOT upgrade yet. Read /tmp/bj-check/backend.log and the release notes for breaking changes."
  exit 1
fi
cat <<MSG
RESULT: the candidate passes the backend and client suites.
Before upgrading the real server:
  1. Read the release notes above for changes to migrations, hooks (JS) and the admin API.
  2. Take a backup and run the restore drill's copy on the candidate:  bj_backup.py restore --target /tmp/try  then
     $DIR/pocketbase serve --dir /tmp/try/pb_data --migrationsDir backend/pb_migrations --hooksDir backend/pb_hooks
     and POST /api/bj/maintenance/reconcile (docs/recovery.md).
  3. Change the pin in tools/get-pocketbase.sh (VERSION), infra/ansible/group_vars/all.yml (pocketbase_version) and
     pocketbase_sha256, then run: ansible-playbook macmini.yml  (see docs/operations.md, "Upgrading").
MSG
