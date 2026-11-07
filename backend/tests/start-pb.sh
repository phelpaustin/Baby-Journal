#!/usr/bin/env bash
# Starts a throwaway PocketBase on 127.0.0.1:${PORT:-8099} with a clean data dir.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PB="${PB_BIN:-$HERE/../tools/pocketbase}"
DIR="${PB_TEST_DIR:-/tmp/pbtest}"
PORT="${PORT:-8099}"
export BJ_TEST_NO_RATE_LIMIT="${BJ_TEST_NO_RATE_LIMIT-1}"   # set it empty to test with rate limits on
rm -rf "$DIR"; mkdir -p "$DIR"
"$PB" superuser upsert admin@test.local 'test-admin-password-1' --dir "$DIR" --migrationsDir "$HERE/pb_migrations" >/dev/null
exec "$PB" serve --dir "$DIR" --migrationsDir "$HERE/pb_migrations" --hooksDir "$HERE/pb_hooks" --http "127.0.0.1:$PORT"
