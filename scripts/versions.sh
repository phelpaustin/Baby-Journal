#!/usr/bin/env bash
# Pinned versus latest for the components that matter (architecture 10: pinned, upgraded on purpose).
# Read-only. Needs network for the "latest" column; says "unknown" when offline.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pinned() { grep -m1 '^VERSION=' "$ROOT/tools/$1" | cut -d'"' -f2; }
latest() { timeout 25 git ls-remote --tags --refs "https://github.com/$1" 2>/dev/null | awk -F/ '{print $3}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 | sed 's/^v//'; }
yaml()   { grep -m1 "^$1:" "$ROOT/infra/ansible/group_vars/all.yml" | sed -E 's/^[a-z_]+: *"?([0-9.]+)"?.*/\1/'; }
row() { # name pinned latest note
  local st="current"; [ -z "$3" ] && st="unknown (offline?)"; [ -n "$3" ] && [ "$2" != "$3" ] && st="NEWER AVAILABLE"
  printf '%-12s pinned %-9s latest %-9s %s%s\n' "$1" "$2" "${3:-?}" "$st" "$4"
}
pb_pin=$(pinned get-pocketbase.sh); cd_pin=$(pinned get-caddy.sh)
row pocketbase "$pb_pin" "$(latest pocketbase/pocketbase)" "$([ "$pb_pin" != "$(yaml pocketbase_version)" ] && echo '  MISMATCH with ansible group_vars: '"$(yaml pocketbase_version)")"
row caddy "$cd_pin" "$(latest caddyserver/caddy)" "$([ "$cd_pin" != "$(yaml caddy_version)" ] && echo '  MISMATCH with ansible group_vars: '"$(yaml caddy_version)")"
row restic "$(restic version 2>/dev/null | awk '{print $2}')" "$(latest restic/restic)" "  (installed, not pinned: brew/apt)"
echo "node         $(node -v 2>/dev/null)   python $(python3 -V 2>/dev/null | cut -d' ' -f2)"
if [ -d "$ROOT/client/node_modules" ]; then
  n=$(cd "$ROOT/client" && timeout 60 npm outdated --json 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d))' 2>/dev/null)
  echo "client deps  ${n:-?} package(s) with newer versions (lockfile pins the installed ones: client/package-lock.json)"
fi
