#!/usr/bin/env bash
# Starts a throwaway PocketBase, runs the test files, stops it. Exit code = test result.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export PORT="${PORT:-8099}" PB_URL="http://127.0.0.1:${PORT:-8099}"
"$HERE/start-pb.sh" > /tmp/pb-test.log 2>&1 &
PB_PID=$!
trap 'kill $PB_PID 2>/dev/null; wait $PB_PID 2>/dev/null' EXIT
for i in $(seq 1 50); do curl -sf "$PB_URL/api/health" >/dev/null && break; sleep 0.2; done
node --test --test-concurrency=1 --test-reporter=spec "$HERE"/*.test.mjs "$@"
