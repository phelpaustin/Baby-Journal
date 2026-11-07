#!/usr/bin/env bash
# Runs the rendered mount guard (bj-start-pocketbase.sh) against a fake external volume.
# /dev/shm is a different filesystem than / here, so it plays the SSD; a folder under /tmp plays
# "an empty folder with the same name on the internal disk".
set -uo pipefail
OUT="${1:-/tmp/bj-infra-render}"
R="$OUT/rendered"
T=/tmp/bj-mountguard
rm -rf "$T" /dev/shm/bj-mg-vol; mkdir -p "$T/bin" "$T/log"
fail=0
ok()   { echo "  ok   $1"; }
bad()  { echo "  FAIL $1"; fail=1; }

# the real rendered scripts, pointed at test locations; a stub stands in for PocketBase
sed "s|$OUT/root|$T|g; s|$OUT/log|$T/log|g" "$R/bj-alert.sh" > "$T/bin/bj-alert.sh"
printf '#!/bin/bash\necho "STARTED $*" > "%s/started"\n' "$T" > "$T/bin/pocketbase"
chmod +x "$T/bin/bj-alert.sh" "$T/bin/pocketbase"
guard() { sed "s|/dev/shm/bj-mg-vol|$1|g; s|$OUT/root|$T|g" "$R/bj-start-pocketbase.sh" > "$T/guard.sh"; chmod +x "$T/guard.sh"; rm -f "$T/started"; "$T/guard.sh" >/dev/null 2>&1; echo $?; }
alerts() { cat "$T/log/alerts.log" 2>/dev/null || cat "$T/log/alerts.log" 2>/dev/null; }
: > "$T/log/alerts.log"

echo "Mount guard:"
# 1. the SSD is not mounted
code=$(guard /dev/shm/bj-mg-vol)
{ [ "$code" = 78 ] && [ ! -e "$T/started" ]; } && ok "SSD missing: exits 78 and PocketBase is not started" || bad "SSD missing: exit $code"
grep -q "not mounted" "$T/log/alerts.log" && ok "SSD missing: a critical alert is recorded" || bad "SSD missing: no alert"

# 2. an internal-disk folder with the marker copied into it
mkdir -p "$T/fakevol"; touch "$T/fakevol/.bj-volume-marker"
: > "$T/log/alerts.log"
code=$(guard "$T/fakevol")
{ [ "$code" = 78 ] && [ ! -e "$T/started" ]; } && ok "marker on the internal disk: refused (exit 78), nothing started" || bad "internal-disk marker accepted (exit $code)"
grep -q "internal disk" "$T/log/alerts.log" && ok "marker on the internal disk: alert names the cause" || bad "no alert for the internal-disk case"

# 3. the real thing: a different filesystem with the marker
mkdir -p /dev/shm/bj-mg-vol; touch /dev/shm/bj-mg-vol/.bj-volume-marker
code=$(guard /dev/shm/bj-mg-vol)
{ [ "$code" = 0 ] && grep -q "serve --dir /dev/shm/bj-mg-vol/pb_data" "$T/started" && grep -q -- "--http 127.0.0.1:8090" "$T/started"; } && ok "SSD present: PocketBase starts on 127.0.0.1 with its data on the SSD" || bad "good volume: exit $code, started=$(cat "$T/started" 2>/dev/null)"
[ -d /dev/shm/bj-mg-vol/pb_data ] && ok "the data folder is created on the SSD only" || bad "no data folder on the SSD"

# 4. the SSD is unplugged again (marker gone)
rm -f /dev/shm/bj-mg-vol/.bj-volume-marker
code=$(guard /dev/shm/bj-mg-vol)
{ [ "$code" = 78 ] && [ ! -e "$T/started" ]; } && ok "SSD unplugged after running: refuses to start again" || bad "unplugged: exit $code"
rm -rf "$T" /dev/shm/bj-mg-vol
exit $fail
