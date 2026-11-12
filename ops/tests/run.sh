#!/usr/bin/env bash
# Starts a throwaway PocketBase (real hooks and migrations) and runs the backup/restore/export tests.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
export PORT="${PORT:-8096}" PB_TEST_DIR=/tmp/pbtest-ops
export PB_URL="http://127.0.0.1:$PORT" PB_DATA="$PB_TEST_DIR" OPS_DIR="$HERE/.." REPO_ROOT="$ROOT"
"$ROOT/backend/tests/start-pb.sh" > /tmp/pb-ops.log 2>&1 &
PB=$!
trap 'kill $PB 2>/dev/null; wait $PB 2>/dev/null' EXIT
for i in $(seq 1 100); do curl -sf "$PB_URL/api/health" >/dev/null && break; sleep 0.2; done
node --test --test-concurrency=1 --test-reporter=${REPORTER:-spec} ${ONLY_FILE:-"$HERE"/backup.test.mjs "$HERE"/import.test.mjs "$HERE"/monitor.test.mjs} "$@"
