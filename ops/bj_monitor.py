#!/usr/bin/env python3
"""Baby Journal monitor (architecture v7, sections 6.8, 7.3 and 10). Python standard library only.

  bj_monitor.py check      run every check once; alert on changes; append today's disk sample (every 10 minutes)
  bj_monitor.py capacity   growth per month and the projected time until the disk is 70 % and 85 % full
  bj_monitor.py report     a one-page monthly report in Markdown (the "monthly look")

Checks: PocketBase health, SSD present, disk 70 % / 85 %, drive health (SMART), certificate expiry,
WireGuard handshake age, Time Machine age. The backup age (18 h / 24 h) is watched by `bj_backup.py watch`.
Settings come from the environment or --env-file (same file as the backup):
  BJ_DATA_DIR, BJ_STATE_DIR, BJ_ALERT_CMD            as for the backup
  BJ_PB_HEALTH_URL=http://127.0.0.1:8090/api/health
  BJ_DATA_MARKER=/Volumes/BabyJournal/.bj-volume-marker      empty = skip the SSD check
  BJ_SMART_DEVICE=/dev/disk4                                  empty = try diskutil for the data folder
  BJ_CERT_HOST=journal.example.com BJ_CERT_ADDR=127.0.0.1:443 empty host = skip the certificate check
  BJ_WG_INTERFACE=wg0                                         empty = skip
  BJ_TIME_MACHINE=1                                           macOS only
  BJ_ALERT_LOG=/var/log/babyjournal/alerts.log                counted in the monthly report
"""
import argparse
import datetime
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

WARN_DISK, CRIT_DISK = 70, 85
CERT_WARN_DAYS, CERT_CRIT_DAYS = 21, 7
WG_WARN_S, WG_CRIT_S = 300, 900
TM_WARN_H, TM_CRIT_H = 24, 72
REMIND_S = 6 * 3600
ORDER = {"ok": 0, "skip": 0, "warning": 1, "critical": 2}


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def run(argv, timeout=20):
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return 127, str(e)


# ------------------------------------------------------------------- checks
# Each returns (level, message). level: ok | warning | critical | skip
def check_pocketbase(env):
    url = env.get("BJ_PB_HEALTH_URL", "http://127.0.0.1:8090/api/health")
    try:
        with urllib.request.urlopen(url, timeout=8) as r:
            return ("ok", "PocketBase answers") if r.status == 200 else ("critical", "PocketBase health answered %d" % r.status)
    except urllib.error.HTTPError as e:
        return "critical", "PocketBase health answered %d" % e.code
    except Exception as e:
        return "critical", "PocketBase does not answer (%s)" % e


def check_ssd(env):
    marker = env.get("BJ_DATA_MARKER", "")
    if not marker:
        return "skip", "no marker configured"
    return ("ok", "external SSD present") if os.path.exists(marker) else ("critical", "The external SSD is missing (marker file not found).")


def disk_percent(path, env):
    if env.get("BJ_TEST_DISK_PERCENT"):
        return float(env["BJ_TEST_DISK_PERCENT"]), 2_000_000_000_000
    u = shutil.disk_usage(path)
    return 100.0 * (u.total - u.free) / u.total, u.total


def check_disk(env):
    pct, _ = disk_percent(env.get("BJ_DATA_DIR", "/"), env)
    if pct >= CRIT_DISK:
        return "critical", "Disk is %.0f%% full (critical at %d%%). Uploads will be refused at 90%%." % (pct, CRIT_DISK)
    if pct >= WARN_DISK:
        return "warning", "Disk is %.0f%% full (warning at %d%%). Plan more storage." % (pct, WARN_DISK)
    return "ok", "disk %.0f%% full" % pct


def check_smart(env):
    dev = env.get("BJ_SMART_DEVICE", "")
    if dev:
        code, out = run(["smartctl", "-H", dev])
        if code == 127:
            return "skip", "smartctl is not installed"
        if re.search(r"PASSED|OK\b", out):
            return "ok", "drive health: passed"
        if re.search(r"FAILED|FAILING", out):
            return "critical", "The drive reports a SMART FAILURE. Replace it and restore from backup."
        return "skip", "smartctl gave no verdict"
    code, out = run(["diskutil", "info", env.get("BJ_DATA_DIR", "/")])
    m = re.search(r"SMART Status:\s*(\S.*)", out)
    if code == 127 or not m:
        return "skip", "no SMART information available"
    s = m.group(1).strip()
    if s.startswith("Verified"):
        return "ok", "drive health: verified"
    if s.startswith("Failing"):
        return "critical", "The drive reports SMART status: Failing. Replace it and restore from backup."
    return "skip", "SMART status: %s" % s


def check_cert(env, now=None):
    host = env.get("BJ_CERT_HOST", "")
    if not host:
        return "skip", "no certificate host configured"
    addr = env.get("BJ_CERT_ADDR", "127.0.0.1:443")
    c1 = subprocess.run(["openssl", "s_client", "-connect", addr, "-servername", host], input="", capture_output=True, text=True, timeout=20) if shutil.which("openssl") else None
    if c1 is None:
        return "skip", "openssl is not installed"
    c2 = subprocess.run(["openssl", "x509", "-noout", "-enddate"], input=c1.stdout, capture_output=True, text=True, timeout=10)
    m = re.search(r"notAfter=(.*)", c2.stdout)
    if not m:
        return "critical", "Could not read the certificate from %s." % addr
    end = datetime.datetime.strptime(" ".join(m.group(1).split()), "%b %d %H:%M:%S %Y %Z").replace(tzinfo=datetime.timezone.utc)
    days = (end - (now or utcnow())).total_seconds() / 86400
    if days < CERT_CRIT_DAYS:
        return "critical", "The certificate expires in %.0f days. Renewal is not happening: check Caddy and the VPS path." % days
    if days < CERT_WARN_DAYS:
        return "warning", "The certificate expires in %.0f days (Caddy normally renews at 30)." % days
    return "ok", "certificate valid for %.0f more days" % days


def check_wireguard(env, now=None):
    iface = env.get("BJ_WG_INTERFACE", "")
    if not iface:
        return "skip", "no WireGuard interface configured"
    code, out = run(["wg", "show", iface, "latest-handshakes"])
    if code != 0:
        return "critical", "WireGuard interface %s is not available (%s)" % (iface, out.strip()[:80])
    stamps = [int(l.split()[-1]) for l in out.splitlines() if l.strip() and l.split()[-1].isdigit()]
    if not stamps or max(stamps) == 0:
        return "critical", "The WireGuard tunnel has never completed a handshake."
    age = (now or utcnow()).timestamp() - max(stamps)
    if age > WG_CRIT_S:
        return "critical", "The WireGuard handshake is %.0f minutes old: the tunnel to the VPS is down." % (age / 60)
    if age > WG_WARN_S:
        return "warning", "The WireGuard handshake is %.0f minutes old." % (age / 60)
    return "ok", "tunnel handshake %.0f s ago" % age


def check_timemachine(env, now=None):
    if env.get("BJ_TIME_MACHINE") != "1":
        return "skip", "Time Machine not monitored"
    code, out = run(["tmutil", "latestbackup"])
    m = re.search(r"(\d{4}-\d{2}-\d{2}-\d{6})", out)
    if code != 0 or not m:
        return "critical", "Time Machine has no backup, or it cannot be read (%s)." % out.strip()[:80]
    when = datetime.datetime.strptime(m.group(1), "%Y-%m-%d-%H%M%S").replace(tzinfo=datetime.timezone.utc)
    hours = ((now or utcnow()) - when).total_seconds() / 3600
    if hours > TM_CRIT_H:
        return "critical", "The last Time Machine backup is %.0f hours old." % hours
    if hours > TM_WARN_H:
        return "warning", "The last Time Machine backup is %.0f hours old." % hours
    return "ok", "Time Machine backup %.0f h ago" % hours


CHECKS = [("pocketbase", check_pocketbase), ("ssd", check_ssd), ("disk", check_disk), ("smart", check_smart),
          ("certificate", check_cert), ("wireguard", check_wireguard), ("timemachine", check_timemachine)]


# ------------------------------------------------------------------- state
def state_path(env):
    return os.path.join(env["BJ_STATE_DIR"], "monitor.json")


def alert(env, level, message):
    line = "%s [%s] %s" % (utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), level.upper(), message)
    print(line, flush=True)
    cmd = env.get("BJ_ALERT_CMD")
    if cmd:
        try:
            subprocess.run([cmd, level, " ".join(message.split())[:500]], timeout=30, check=False)
        except Exception as e:
            print("alert command failed: %s" % e)


def cmd_check(env, now=None):
    os.makedirs(env["BJ_STATE_DIR"], exist_ok=True)
    try:
        state = json.load(open(state_path(env)))
    except (FileNotFoundError, ValueError):
        state = {}
    now = now or utcnow()
    now_s = now.timestamp()
    worst = "ok"
    rows = []
    for name, fn in CHECKS:
        try:
            level, msg = fn(env) if name not in ("certificate", "wireguard", "timemachine") else fn(env, now)
        except Exception as e:  # a broken check must not hide the others, and must itself be visible
            level, msg = "warning", "the %s check failed to run: %r" % (name, e)
        st = state.get(name, {"level": "ok", "at": 0})
        prev = st["level"]
        if level == "skip":
            rows.append((name, "skip", msg)); continue
        if ORDER[level] > ORDER[prev] or (level == "critical" and now_s - st["at"] >= REMIND_S):
            alert(env, level, "%s: %s" % (name, msg))
            st = {"level": level, "at": now_s}
        elif level == "ok" and prev != "ok":
            alert(env, "info", "%s is back to normal: %s" % (name, msg))
            st = {"level": "ok", "at": now_s}
        elif ORDER[level] < ORDER[prev]:
            st = {"level": level, "at": st["at"]}  # improved but not healthy: no new alert
        state[name] = st
        rows.append((name, level, msg))
        if ORDER[level] > ORDER[worst]:
            worst = level
    json.dump(state, open(state_path(env), "w"))
    for r in rows:
        print("  %-12s %-9s %s" % r)
    try:
        sample_disk(env, now)
    except Exception as e:  # the capacity sample is a convenience: never let it stop the checks
        print("  (capacity sample skipped: %r)" % (e,))
    return {"ok": 0, "warning": 0, "critical": 2}.get(worst, 0)


# ---------------------------------------------------------------- capacity
def sample_disk(env, now):
    path = os.path.join(env["BJ_STATE_DIR"], "capacity.jsonl")
    today = now.strftime("%Y-%m-%d")
    try:
        if open(path).read().rstrip().splitlines()[-1].find(today) != -1:
            return
    except (FileNotFoundError, IndexError):
        pass
    pct, total = disk_percent(env.get("BJ_DATA_DIR", "/"), env)
    with open(path, "a") as f:
        f.write(json.dumps({"date": today, "percent": round(pct, 2), "total": total, "used": int(total * pct / 100)}) + "\n")


def load_samples(env):
    try:
        return [json.loads(l) for l in open(os.path.join(env["BJ_STATE_DIR"], "capacity.jsonl")) if l.strip()]
    except FileNotFoundError:
        return []


def projection(samples, now=None):
    """Growth per 30 days from the samples of the last 120 days, and months until 70 % and 85 %."""
    if len(samples) < 2:
        return None
    d0, d1 = (datetime.date.fromisoformat(samples[0]["date"]), datetime.date.fromisoformat(samples[-1]["date"]))
    days = (d1 - d0).days
    if days < 1:
        return None
    grow_pct_day = (samples[-1]["percent"] - samples[0]["percent"]) / days
    out = {"from": samples[0]["date"], "to": samples[-1]["date"], "percent_now": samples[-1]["percent"], "growth_gb_per_month": round((samples[-1]["used"] - samples[0]["used"]) / days * 30 / 1e9, 1), "months_to_70": None, "months_to_85": None}
    if grow_pct_day > 0:
        for key, target in (("months_to_70", WARN_DISK), ("months_to_85", CRIT_DISK)):
            left = target - samples[-1]["percent"]
            out[key] = 0 if left <= 0 else round(left / grow_pct_day / 30, 1)
    return out


def cmd_capacity(env):
    p = projection(load_samples(env)[-120:])
    if not p:
        print("not enough samples yet (needs two different days)")
        return 0
    print("disk %.0f%% full; growing %.1f GB per month (%s to %s)" % (p["percent_now"], p["growth_gb_per_month"], p["from"], p["to"]))
    print("projected 70%%: %s months, 85%%: %s months" % (p["months_to_70"], p["months_to_85"]))
    if p["months_to_85"] is not None and p["months_to_85"] < 6:
        alert(env, "warning", "At the current growth the disk reaches 85%% in about %.0f months. Order more storage." % p["months_to_85"])
    return 0


# ------------------------------------------------------------------ report
def cmd_report(env, now=None):
    now = now or utcnow()
    since = (now - datetime.timedelta(days=30)).strftime("%Y-%m-%d %H:%M:%S")
    lines = ["# Baby Journal: monthly report %s" % now.strftime("%Y-%m"), "", "Generated %s. A five-minute read: anything marked **ACT** needs a decision." % now.strftime("%Y-%m-%d"), ""]
    db = os.path.join(env["BJ_DATA_DIR"], "data.db")
    try:
        c = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=30)
        runs = c.execute("SELECT result, verification_result, finished_at FROM backup_runs WHERE finished_at >= ? ORDER BY finished_at", (since,)).fetchall()
        ok = [r for r in runs if r[0] == "ok" and r[1] == "ok"]
        last = c.execute("SELECT finished_at FROM backup_runs WHERE result='ok' AND verification_result='ok' ORDER BY finished_at DESC LIMIT 1").fetchone()
        stats = c.execute("SELECT COUNT(*), COALESCE(SUM(size),0) FROM media_originals").fetchone()
        unprotected = c.execute("SELECT COUNT(*) FROM media WHERE status='stored' AND offsite_at=''").fetchone()[0]
        entries = c.execute("SELECT COUNT(*) FROM entries WHERE deleted_at=''").fetchone()[0]
        review = c.execute("SELECT COUNT(*) FROM entries WHERE needs_review=1 AND deleted_at=''").fetchone()[0]
        c.close()
        lines += ["## Backups", "- Runs in the last 30 days: %d, verified ok: %d, failed: %d" % (len(runs), len(ok), len(runs) - len(ok)),
                  "- Last verified offsite backup: %s" % (last[0] if last else "**ACT: never**"),
                  "- Photos and videos not yet in a verified backup: %d%s" % (unprotected, "  **ACT**" if unprotected else "")]
        lines += ["", "## The journal", "- %d entries, %d photos and videos (%.1f GB of originals)" % (entries, stats[0], stats[1] / 1e9),
                  "- Entries waiting for a decision between two versions: %d%s" % (review, "  **ACT**: ask the owners to resolve them" if review else "")]
    except sqlite3.Error as e:
        lines += ["## Backups", "- **ACT: the database could not be read (%s)**" % e]
    p = projection(load_samples(env)[-120:])
    lines += ["", "## Storage"]
    if p:
        lines.append("- Disk %.0f%% full, growing %.1f GB a month. 70%% in %s months, 85%% in %s months.%s" % (
            p["percent_now"], p["growth_gb_per_month"], p["months_to_70"], p["months_to_85"], "  **ACT: order storage**" if (p["months_to_85"] is not None and p["months_to_85"] < 12) else ""))
    else:
        lines.append("- Not enough samples yet.")
    alog = env.get("BJ_ALERT_LOG", "")
    counts = {"CRITICAL": 0, "WARNING": 0, "INFO": 0}
    if alog and os.path.exists(alog):
        cutoff = (now - datetime.timedelta(days=30)).strftime("%Y-%m-%d")
        for l in open(alog, errors="replace"):
            m = re.match(r"(\d{4}-\d{2}-\d{2})\S* \[(\w+)\]", l)
            if m and m.group(1) >= cutoff and m.group(2).upper() in counts:
                counts[m.group(2).upper()] += 1
    lines += ["", "## Alerts in the last 30 days", "- critical: %(CRITICAL)d, warning: %(WARNING)d, info: %(INFO)d%%s" % counts % ("  **ACT: read the log**" if counts["CRITICAL"] else "")]
    exports = sorted(d for d in (os.listdir(env["BJ_EXPORT_DIR"]) if env.get("BJ_EXPORT_DIR") and os.path.isdir(env["BJ_EXPORT_DIR"]) else []))
    drill_dir = env.get("BJ_DRILL_DIR") or env["BJ_STATE_DIR"]  # the drill runs as another user, with its own state folder
    drills = sorted(f for f in (os.listdir(drill_dir) if os.path.isdir(drill_dir) else []) if f.startswith("drill-") and f.endswith(".json"))
    lines += ["", "## Routine jobs", "- Latest plain export: %s" % (exports[-1] if exports else "**ACT: none found**")]
    if drills:
        d = json.load(open(os.path.join(drill_dir, drills[-1])))
        age = (now - datetime.datetime.fromisoformat(d["finished_at"].replace("Z", "+00:00"))).days
        lines.append("- Last restore drill: %s (%d days ago), %s%s" % (d["finished_at"][:10], age, "passed" if d["ok"] else "FAILED", "  **ACT: due (quarterly)**" if age > 100 else ""))
    else:
        lines.append("- Last restore drill: **ACT: none recorded**")
    lines += ["", "## Do this quarter", "- Refresh the offline copy on the portable drive (about 20 minutes).", "- Glance at the latest export's README.", ""]
    out = os.path.join(env["BJ_STATE_DIR"], "reports")
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "monthly-%s.md" % now.strftime("%Y-%m"))
    open(path, "w").write("\n".join(lines))
    print(path)
    return 0


def load_env_file(path):
    if path:
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env-file")
    ap.add_argument("--now", help="ISO time to use instead of the clock (tests)")
    ap.add_argument("cmd", choices=["check", "capacity", "report"])
    a = ap.parse_args(argv)
    load_env_file(a.env_file)
    env = dict(os.environ)
    for k in ("BJ_DATA_DIR", "BJ_STATE_DIR"):
        if not env.get(k):
            print("%s is not set" % k, file=sys.stderr)
            return 2
    now = datetime.datetime.fromisoformat(a.now.replace("Z", "+00:00")) if a.now else None
    return {"check": lambda: cmd_check(env, now), "capacity": lambda: cmd_capacity(env), "report": lambda: cmd_report(env, now)}[a.cmd]()


if __name__ == "__main__":
    sys.exit(main())
