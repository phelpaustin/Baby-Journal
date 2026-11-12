#!/usr/bin/env bash
# Renders every template with test values and checks each result with the real tool.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
OUT="${1:-/tmp/bj-infra-render}"
rm -rf "$OUT"; mkdir -p "$OUT"
fail=0
check() { if "$@" >"$OUT/last.log" 2>&1; then echo "  ok   $DESC"; else echo "  FAIL $DESC"; sed 's/^/       /' "$OUT/last.log" | head -8; fail=1; fi; }

VPS_PRIV=$(wg genkey); MAC_PRIV=$(wg genkey)
cat > "$OUT/vars.json" <<JSON
{
  "domain": "journal.test", "caddy_local_certs": true,
  "caddy_wg_bind": "127.0.0.1", "caddy_wg_port": 9443, "caddy_lan_bind": "127.0.0.1", "caddy_lan_port": 9444,
  "proxy_protocol_from": "127.0.0.9",
  "internal_cidrs": ["127.0.0.1/32", "10.77.0.0/24", "192.168.0.0/16"],
  "caddy_log_dir": "$OUT/log", "pb_upstream": "127.0.0.1:${PB_PORT:-8091}",
  "haproxy_bind": "127.0.0.1", "haproxy_port": 9440, "haproxy_upstream": "127.0.0.1:9443", "haproxy_source": "127.0.0.9",
  "vault_vps_wg_private_key": "$VPS_PRIV", "vault_vps_wg_public_key": "$(echo "$VPS_PRIV" | wg pubkey)",
  "vault_mac_wg_private_key": "$MAC_PRIV", "vault_mac_wg_public_key": "$(echo "$MAC_PRIV" | wg pubkey)",
  "vault_wg_preshared_key": "$(wg genpsk)", "uptime_alert_cmd": "/tmp/bj-uptime-alert.sh", "uptime_curl_extra": "--resolve journal.test:9440:127.0.0.1", "vault_restic_password": "test-restic-pass", "vault_backup_pb_password": "test-backup-pass",
  "data_volume": "/dev/shm/bj-mg-vol", "bj_root": "$OUT/root",
  "ssh_allow_cidrs": ["198.51.100.7/32"], "alert_url": "https://ntfy.example.net/bj"
}
JSON
mkdir -p "$OUT/log"
ANSIBLE_ROLES_PATH="$HERE/../ansible/roles" ANSIBLE_LOCALHOST_WARNING=False ANSIBLE_INVENTORY_UNPARSED_WARNING=False \
  ansible-playbook "$HERE/render.yml" -e "test_vars_file=$OUT/vars.json out=$OUT/rendered" >"$OUT/render.log" 2>&1 \
  && echo "  ok   all templates render with the test variables" || { echo "  FAIL render"; tail -15 "$OUT/render.log"; exit 1; }
R="$OUT/rendered"

echo "Validating with the real tools:"
DESC="Caddyfile (caddy validate)"; check "${CADDY_BIN:-$ROOT/tools/caddy}" validate --adapter caddyfile --config "$R/Caddyfile"
DESC="Caddy attaches the PROXY-protocol wrapper to the VPS listener only"; check bash -c "'${CADDY_BIN:-$ROOT/tools/caddy}' adapt --adapter caddyfile --config '$R/Caddyfile' | python3 -c \"
import json,sys
s=json.load(sys.stdin)['apps']['http']['servers']
w={tuple(v['listen']):[x['wrapper'] for x in (v.get('listener_wrappers') or [])] for v in s.values()}
assert w[('127.0.0.1:9443',)]==['proxy_protocol','tls'], w
assert w[('127.0.0.1:9444',)]==[], w
\""
DESC="HAProxy config (haproxy -c)"; check haproxy -c -f "$R/haproxy.cfg"
DESC="VPS WireGuard config (wg-quick strip)"; check wg-quick strip "$R/vps-wg0.conf"
DESC="Mac WireGuard config (wg-quick strip)"; check wg-quick strip "$R/mac-wg0.conf"
DESC="nftables ruleset (nft -c)"; check nft -c -f "$R/nftables.conf"
for p in com.babyjournal.pocketbase com.babyjournal.caddy com.babyjournal.wireguard com.babyjournal.backup com.babyjournal.backup-watch com.babyjournal.export com.babyjournal.monitor com.babyjournal.report com.babyjournal.drill; do
  DESC="launchd plist $p (parses as a property list)"; check python3 -c "import plistlib,sys; d=plistlib.load(open('$R/$p.plist','rb')); assert d['Label']=='$p'"
done
for s in bj-start-pocketbase.sh bj-alert.sh bj-monthly-export.sh bj-uptime-check.sh; do DESC="shell script $s (bash -n)"; check bash -n "$R/$s"; done
if command -v sshd >/dev/null; then DESC="sshd hardening (sshd -t)"; check sshd -t -f "$R/sshd_hardening.conf"; else echo "  skip sshd -t (sshd not installed here)"; fi
DESC="the backup settings file has every value, and the passphrase is not echoed into any plist"; check bash -c "! grep -E '=$' '$R/backup.env' | grep -qvE 'HEALTHCHECK|SMART_DEVICE' && grep -q 'RESTIC_PASSWORD=test-restic-pass' '$R/backup.env' && ! grep -rl 'test-restic-pass' '$R' --include='*.plist' | grep -q ."
DESC="the pocketbase plist passes the alert command and the purge switch (off by default)"; check python3 -c "import plistlib; d=plistlib.load(open('$R/com.babyjournal.pocketbase.plist','rb')); e=d['EnvironmentVariables']; assert e['BJ_PURGE_ENABLE']=='0' and e['BJ_ALERT_CMD'].endswith('bj-alert.sh')"
for u in bj-uptime.service bj-uptime.timer; do DESC="systemd unit $u (sections and keys parse)"; check python3 -c "import configparser;c=configparser.ConfigParser(strict=False,interpolation=None);c.optionxform=str;c.read('$R/$u');assert c.sections()"; done
DESC="the monitor job runs in its own state folder and the drill and report schedules are quarterly and monthly"; check python3 -c "
import plistlib
m=plistlib.load(open('$R/com.babyjournal.monitor.plist','rb')); assert m['EnvironmentVariables']['BJ_STATE_DIR'].endswith('/monitor') and 'UserName' not in m
d=plistlib.load(open('$R/com.babyjournal.drill.plist','rb')); assert [x['Month'] for x in d['StartCalendarInterval']]==[1,4,7,10]
r=plistlib.load(open('$R/com.babyjournal.report.plist','rb')); assert r['StartCalendarInterval']['Day']==2"
DESC="no unrendered template markers anywhere"; check bash -c "! grep -R -n '{{\|{%' '$R'"
# Production mode (Let's Encrypt instead of the test CA): must validate and use the TLS-ALPN challenge only.
sed 's/"caddy_local_certs": true/"caddy_local_certs": false/; s/"domain": "journal.test"/"domain": "journal.example.com"/' "$OUT/vars.json" > "$OUT/vars-prod.json"
ANSIBLE_ROLES_PATH="$HERE/../ansible/roles" ansible-playbook "$HERE/render.yml" -e "test_vars_file=$OUT/vars-prod.json out=$OUT/rendered-prod" >"$OUT/render-prod.log" 2>&1 || { echo "  FAIL production render"; tail -8 "$OUT/render-prod.log"; fail=1; }
DESC="production Caddyfile validates (Let's Encrypt mode)"; check "${CADDY_BIN:-$ROOT/tools/caddy}" validate --adapter caddyfile --config "$OUT/rendered-prod/Caddyfile"
DESC="production Caddyfile: ACME on, HTTP challenge off, no test CA"; check bash -c "grep -q 'disable_http_challenge' '$OUT/rendered-prod/Caddyfile' && grep -q 'email ' '$OUT/rendered-prod/Caddyfile' && ! grep -q 'local_certs' '$OUT/rendered-prod/Caddyfile'"
DESC="production Caddyfile: the PROXY-protocol listener accepts only the VPS address"; check bash -c "grep -q 'allow 127.0.0.9/32' '$OUT/rendered-prod/Caddyfile'"
echo "$R" > "$OUT/rendered.path"
exit $fail
