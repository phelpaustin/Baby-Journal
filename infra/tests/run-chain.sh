#!/usr/bin/env bash
# Starts PocketBase + Caddy + HAProxy exactly as in production (TLS passthrough with PROXY protocol),
# using the real Ansible templates, then runs the attacker's-eye tests against the chain.
#
#   client --TLS--> HAProxy :9440 (TCP only) --PROXY v2--> Caddy :9443 (TLS, accepts PROXY from 127.0.0.9 only) --> PocketBase :8091
#   "home" listener:  Caddy :9444 (plain TLS, no PROXY header)
#   127.0.0.1 plays "the home network"; 127.0.0.2 plays "the internet".
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
W=/tmp/bj-chain
export PB_PORT=8091
rm -rf "$W"; mkdir -p "$W/pb" "$W/public" "$W/caddy-data" "$W/caddy-config"

"$HERE/validate.sh" "$W/infra" || { echo "Config validation failed"; exit 1; }
R="$W/infra/rendered"

# the real built app, if there is one
if [ -d "$ROOT/client/dist" ]; then cp -r "$ROOT/client/dist/." "$W/public/"; else echo '<!doctype html><title>Baby Journal</title>' > "$W/public/index.html"; fi

PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; rm -rf "$W/big" ; }
trap cleanup EXIT

PB="$ROOT/tools/pocketbase"
export BJ_TEST_NO_RATE_LIMIT=""    # rate limits ON: they are part of what is tested
"$PB" superuser upsert admin@test.local 'test-admin-password-1' --dir "$W/pb" --migrationsDir "$ROOT/backend/pb_migrations" >/dev/null
"$PB" serve --dir "$W/pb" --migrationsDir "$ROOT/backend/pb_migrations" --hooksDir "$ROOT/backend/pb_hooks" --publicDir "$W/public" --http 127.0.0.1:$PB_PORT >"$W/pb.log" 2>&1 & PIDS+=($!)
XDG_DATA_HOME="$W/caddy-data" XDG_CONFIG_HOME="$W/caddy-config" HOME="$W" "${CADDY_BIN:-$ROOT/tools/caddy}" run --config "$R/Caddyfile" --adapter caddyfile >"$W/caddy.log" 2>&1 & PIDS+=($!)

wait_port() { for i in $(seq 1 100); do (exec 3<>/dev/tcp/127.0.0.1/$1) 2>/dev/null && return 0; sleep 0.2; done; echo "port $1 did not open"; return 1; }
# HAProxy starts only after Caddy listens: its first health check must not find the backend down.
wait_port $PB_PORT && wait_port 9443 && wait_port 9444 || { tail -5 "$W/caddy.log" "$W/pb.log"; exit 1; }
haproxy -db -f "$R/haproxy.cfg" >"$W/haproxy.log" 2>&1 & PIDS+=($!)
wait_port 9440 || { tail -5 "$W/caddy.log" "$W/haproxy.log" "$W/pb.log"; exit 1; }
for i in $(seq 1 50); do [ -f "$W/caddy-data/caddy/pki/authorities/local/root.crt" ] && break; sleep 0.2; done

export CHAIN_PORT=9440 DIRECT_PORT=9444 WGSIDE_PORT=9443 PB_DIRECT="http://127.0.0.1:$PB_PORT"
export CA_FILE="$W/caddy-data/caddy/pki/authorities/local/root.crt" ACCESS_LOG="$W/infra/log/access.log"
export HAPROXY_CFG="$R/haproxy.cfg" CADDYFILE="$R/Caddyfile" WORKDIR="$W" CADDY_PID="${PIDS[1]}" APP_DIST="$W/public"
node --test --test-reporter=spec "$HERE"/chain.test.mjs "$@"
