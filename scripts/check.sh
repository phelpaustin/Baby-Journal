#!/usr/bin/env bash
# Runs the test suites with short output. Full logs go to /tmp/bj-check/<suite>.log: read those with
# grep or tail, never print them whole.
#
#   scripts/check.sh              backend + client (about 1.5 minutes)
#   scripts/check.sh backend|client|infra
#   scripts/check.sh ops "restore|export"   a part of the slow backup suite (each part < 3 minutes)
#   scripts/check.sh all          everything except ops
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS=/tmp/bj-check; mkdir -p "$LOGS"
cleanup() {  # the [x] pattern keeps pkill from matching this script's own command line
  pkill -9 -f "[b]j_backup.py"; pkill -9 -x restic; pkill -9 -x pocketbase; pkill -9 -x caddy; pkill -9 -x haproxy
  pkill -9 -f "[n]ode --test"; sleep 1
}
run() {  # run <name> <timeout-seconds> <command...>
  local name="$1" t="$2"; shift 2
  cleanup
  timeout "$t" "$@" > "$LOGS/$name.log" 2>&1
  python3 "$ROOT/scripts/summarize.py" "$name" "$LOGS/$name.log" < "$LOGS/$name.log"
}
plain() {  # for scripts that print "  ok ..." / "  FAIL ..." lines
  local name="$1" t="$2"; shift 2
  cleanup
  timeout "$t" "$@" > "$LOGS/$name.log" 2>&1
  local code=$? ok fail
  ok=$(grep -c '^  ok' "$LOGS/$name.log"); fail=$(grep -c '^  FAIL' "$LOGS/$name.log")
  if [ "$code" = 0 ] && [ "$fail" = 0 ]; then printf '%-8s PASS       %s checks\n' "$name" "$ok"
  else printf '%-8s FAIL       %s ok, %s failed (exit %s)   log: %s\n' "$name" "$ok" "$fail" "$code" "$LOGS/$name.log"; grep '^  FAIL' "$LOGS/$name.log" | head -5; fi
}
what="${1:-quick}"
case "$what" in
  quick|all|backend) run backend 170 "$ROOT/backend/tests/run.sh" ;;
esac
case "$what" in
  quick|all|client) (cd "$ROOT/client" && run client 120 npx vitest run) ;;
esac
case "$what" in
  all|infra)
    plain config 120 "$ROOT/infra/tests/validate.sh" /tmp/bj-infra-render
    plain guard 60 "$ROOT/infra/tests/mountguard.sh" /tmp/bj-infra-render
    run chain 170 "$ROOT/infra/tests/run-chain.sh" ;;
esac
if [ "$what" = ops ]; then
  ONLY="${2:-nightly}" run "ops[${2:-nightly}]" 170 "$ROOT/ops/tests/run.sh"
fi
cleanup
