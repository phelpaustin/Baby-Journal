#!/usr/bin/env python3
"""Baby Journal backup tool (architecture v7, sections 6.9 and 9). Python standard library only.

  bj_backup.py backup    nightly: consistent snapshot -> one restic snapshot -> verify -> mark protected
  bj_backup.py watch     every 30 minutes: alert when the last verified backup is too old or failed
  bj_backup.py restore   rebuild a pb_data folder from the offsite repository and verify every file
  bj_backup.py drill     quarterly restore check: restore, start a server on it, reconcile, export, verify
  bj_backup.py forget    apply the retention policy (dry run unless --apply)

Settings come from the environment, or from a KEY=VALUE file given with --env-file:
  BJ_DATA_DIR            PocketBase data folder (contains data.db and storage/)
  BJ_STATE_DIR           where this tool keeps staging, local snapshots, manifests, reports, logs
  RESTIC_REPOSITORY      and RESTIC_PASSWORD or RESTIC_PASSWORD_FILE (restic reads these itself)
  BJ_PB_URL, BJ_PB_SUPERUSER, BJ_PB_PASSWORD   PocketBase API and a superuser for the bookkeeping calls
  BJ_ALERT_CMD           optional: command called as  CMD <warning|critical> "message"
  BJ_HEALTHCHECK_URL     optional: pinged on success, URL/fail on failure (dead-man switch)
  BJ_INCLUDE_DERIVED=0   1 also backs up display/playback copies (they can be regenerated)
  BJ_VERIFY_SAMPLE_FILES=3   files re-read from the repository and re-hashed after every backup
  BJ_CHECK_SUBSET=5%     share of the repository data that restic re-reads after every backup
  BJ_LOCAL_SNAPSHOT_DAYS=14  how long local database snapshots are kept (Time Machine copies them)
  BJ_RESTIC_BIN=restic
  BJ_PB_BIN, BJ_BACKEND_DIR   for `drill`: the PocketBase binary and the folder with pb_migrations and pb_hooks
"""
import argparse
import contextlib
import datetime
import hashlib
import json
import os
import random
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

TOOL_VERSION = 1
MANIFEST_FORMAT = 1
LOCK_NAME = ".maintenance.lock"
BIG_FILE_LIMIT = 2 * 1024 ** 3  # files above this are not re-read in the sample check


# ------------------------------------------------------------------ helpers
def utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (dt.microsecond // 1000)


def parse_iso(s):
    s = s.replace(" ", "T").replace("Z", "+00:00")
    return datetime.datetime.fromisoformat(s)


class Fail(Exception):
    """A backup problem that must raise an alert."""


class Config:
    def __init__(self, env):
        self.env = env
        self.data_dir = self.need("BJ_DATA_DIR")
        self.state_dir = self.need("BJ_STATE_DIR")
        self.restic_bin = env.get("BJ_RESTIC_BIN", "restic")
        self.include_derived = env.get("BJ_INCLUDE_DERIVED", "0") == "1"
        self.sample_files = int(env.get("BJ_VERIFY_SAMPLE_FILES", "3"))
        self.check_subset = env.get("BJ_CHECK_SUBSET", "5%")
        self.local_days = int(env.get("BJ_LOCAL_SNAPSHOT_DAYS", "14"))

    def need(self, key):
        v = self.env.get(key, "")
        if not v:
            raise SystemExit("%s is not set" % key)
        return v

    def path(self, *parts):
        return os.path.join(self.state_dir, *parts)


def load_env_file(path):
    if not path:
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


class Logger:
    def __init__(self, cfg):
        os.makedirs(cfg.path("logs"), exist_ok=True)
        self.file = cfg.path("logs", "backup.log")

    def __call__(self, msg):
        line = "%s %s" % (iso(utcnow()), msg)
        print(line, flush=True)
        with open(self.file, "a") as f:
            f.write(line + "\n")


def alert(cfg, log, level, message):
    message = " ".join(str(message).split())[:600]  # one clean line: alerts end up in phone notifications
    log("[%s] %s" % (level.upper(), message))
    cmd = cfg.env.get("BJ_ALERT_CMD")
    if cmd:
        try:
            subprocess.run([cmd, level, message], timeout=30, check=False)
        except Exception as e:  # an alert that cannot be sent must not hide the original problem
            log("alert command failed: %s" % e)


def ping(cfg, log, suffix=""):
    url = cfg.env.get("BJ_HEALTHCHECK_URL")
    if not url:
        return
    try:
        urllib.request.urlopen(url.rstrip("/") + suffix, timeout=15).read()
    except Exception as e:
        log("healthcheck ping failed: %s" % e)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (ProcessLookupError, ValueError):
        return False
    except PermissionError:
        return True


# --------------------------------------------------------------------- lock
@contextlib.contextmanager
def maintenance_lock(cfg, log):
    """The purge job in PocketBase waits while this file is held by a live process."""
    path = os.path.join(cfg.data_dir, LOCK_NAME)
    try:
        with open(path) as f:
            old = json.load(f)
        if pid_alive(old.get("pid", 0)) and time.time() * 1000 - old.get("started", 0) < 6 * 3600 * 1000:
            raise Fail("another backup is already running (pid %s)" % old.get("pid"))
        log("removing a stale lock left by a crashed run (pid %s)" % old.get("pid"))
    except (FileNotFoundError, ValueError):
        pass
    with open(path, "w") as f:
        json.dump({"pid": os.getpid(), "started": int(time.time() * 1000)}, f)
    try:
        yield
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.remove(path)


# ------------------------------------------------------------------- restic
def restic(cfg, *args, check=True, capture=True):
    p = subprocess.run([cfg.restic_bin, *args], env=cfg.env, capture_output=capture, text=True)
    if check and p.returncode != 0:
        raise Fail("restic %s failed: %s" % (args[0], (p.stderr or p.stdout or "").strip()[-400:]))
    return p


def restic_json_lines(cfg, *args):
    p = restic(cfg, *args, "--json")
    out = []
    for line in p.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


# ----------------------------------------------------------------- database
def open_db(path):
    """Read-only when possible. A WAL database nobody has open cannot be opened read-only, so fall back."""
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % path, uri=True, timeout=60)
        conn.execute("SELECT 1 FROM sqlite_master LIMIT 1")
        return conn
    except sqlite3.OperationalError:
        return sqlite3.connect(path, timeout=60)


def sqlite_snapshot(src_db, dest):
    """SQLite's online backup: consistent while the app is writing. Never a plain file copy."""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    src = open_db(src_db)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
        res = dst.execute("PRAGMA integrity_check").fetchone()[0]
        if res != "ok":
            raise Fail("the database snapshot failed its integrity check: %s" % res)
    finally:
        dst.close()
        src.close()
    return dest


def collection_ids(conn):
    return {name: cid for name, cid in conn.execute("SELECT name, id FROM _collections")}


def build_manifest(snapshot_db, data_dir):
    """Every stored media row (trashed ones too) with its path, size and SHA-256, read from the
    snapshot, not from the live database. Returns (entries, problems, collection_ids)."""
    conn = sqlite3.connect(snapshot_db)
    conn.row_factory = sqlite3.Row
    try:
        ids = collection_ids(conn)
        orig_coll = ids["media_originals"]
        rows = conn.execute(
            "SELECT m.id AS media, m.entry, m.journal, m.kind, m.deleted_at, m.display, m.poster, m.playback, "
            "o.id AS orig, o.file, o.size, o.sha256, o.original_name "
            "FROM media m JOIN media_originals o ON o.media = m.id WHERE m.status = 'stored' ORDER BY m.id").fetchall()
    finally:
        conn.close()
    entries, problems = [], []
    for r in rows:
        rel = "storage/%s/%s/%s" % (orig_coll, r["orig"], r["file"])
        full = os.path.join(data_dir, rel)
        e = {"type": "media", "media": r["media"], "entry": r["entry"], "journal": r["journal"], "kind": r["kind"],
             "deleted_at": r["deleted_at"], "original": r["orig"], "path": rel, "size": r["size"], "sha256": r["sha256"],
             "original_name": r["original_name"]}
        if not r["file"] or not os.path.isfile(full):
            problems.append("missing original: %s" % rel)
        elif os.path.getsize(full) != r["size"]:
            problems.append("wrong size on disk: %s (database says %d, disk has %d)" % (rel, r["size"], os.path.getsize(full)))
        entries.append(e)
    return entries, problems, ids


# ------------------------------------------------------------- PocketBase API
class PB:
    def __init__(self, cfg):
        self.base = cfg.need("BJ_PB_URL").rstrip("/")
        self.cfg = cfg
        self.token = None

    def call(self, method, path, body=None, auth=True):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        if auth:
            req.add_header("Authorization", self.token)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise Fail("PocketBase %s %s answered %d: %s" % (method, path, e.code, e.read()[:200]))
        except urllib.error.URLError as e:
            raise Fail("PocketBase is not reachable: %s" % e.reason)

    def login(self):
        r = self.call("POST", "/api/collections/_superusers/auth-with-password",
                      {"identity": self.cfg.need("BJ_PB_SUPERUSER"), "password": self.cfg.need("BJ_PB_PASSWORD")}, auth=False)
        self.token = r["token"]


# ---------------------------------------------------------------- test hooks
def test_hook(cfg, log, name):
    """Lets tests pause or stop a run at a precise point (never set in production)."""
    pause = cfg.env.get("BJ_TEST_PAUSE_AFTER_SNAPSHOT_FILE")
    if name == "after_snapshot" and pause and os.path.exists(pause):
        log("TEST: paused after the database snapshot")
        while os.path.exists(pause):
            time.sleep(0.2)
    if cfg.env.get("BJ_TEST_HANG_AFTER") == name:
        log("TEST: hanging after %s" % name)
        open(cfg.path("hang-marker"), "w").write(name)
        time.sleep(600)
    if cfg.env.get("BJ_TEST_FAIL_AT") == name:
        raise Fail("injected failure after %s" % name)


# ------------------------------------------------------------------- backup
def cmd_backup(cfg):
    log = Logger(cfg)
    started = utcnow()
    run = {"started_at": iso(started), "result": "failed", "verification_result": "skipped", "snapshot_id": "", "file_count": 0, "bytes": 0}
    pb = PB(cfg)
    try:
        with maintenance_lock(cfg, log):
            summary = backup_steps(cfg, log, pb, started, run)
        run.update(summary)
        run["result"], run["verification_result"] = "ok", "ok"
        run["finished_at"] = iso(utcnow())
        pb.call("POST", "/api/bj/backup/record", run)
        log("backup ok: snapshot %s, %d files, %d bytes" % (run["snapshot_id"], run["file_count"], run["bytes"]))
        report(cfg, run)
        ping(cfg, log)
        return 0
    except Fail as e:
        return fail_run(cfg, log, pb, run, str(e))
    except Exception as e:  # an unexpected crash is still a failed backup
        return fail_run(cfg, log, pb, run, "unexpected error: %r" % (e,))


def fail_run(cfg, log, pb, run, message):
    run["finished_at"] = iso(utcnow())
    run["result"] = "failed"
    if run["verification_result"] == "skipped" and run.get("snapshot_id"):
        run["verification_result"] = "failed"
    alert(cfg, log, "critical", "Backup failed: %s" % message)
    try:
        if not pb.token:
            pb.login()
        pb.call("POST", "/api/bj/backup/record", run)
    except Exception as e:
        log("could not record the failed run: %s" % e)
    run["error"] = message
    report(cfg, run)
    ping(cfg, log, "/fail")
    return 1


def report(cfg, run):
    os.makedirs(cfg.path("reports"), exist_ok=True)
    stamp = run["started_at"].replace(":", "").replace("-", "").replace(".", "")
    with open(cfg.path("reports", "backup-%s.json" % stamp), "w") as f:
        json.dump(run, f, indent=2)


def backup_steps(cfg, log, pb, started, run):
    db_live = os.path.join(cfg.data_dir, "data.db")
    if not os.path.isfile(db_live):
        raise Fail("no database at %s" % db_live)
    pb.login()
    stamp = started.strftime("%Y%m%dT%H%M%SZ")

    # 1. consistent database snapshot (SQLite online backup), time recorded
    staging = cfg.path("staging")
    shutil.rmtree(staging, ignore_errors=True)
    snap_db = sqlite_snapshot(db_live, os.path.join(staging, "db", "data.db"))
    snapshot_time = iso(utcnow())
    log("database snapshot taken at %s" % snapshot_time)
    test_hook(cfg, log, "after_snapshot")

    # 2. manifest from that snapshot
    entries, problems, ids = build_manifest(snap_db, cfg.data_dir)
    if problems:
        raise Fail("%d problem(s) with stored originals, for example: %s" % (len(problems), "; ".join(problems[:3])))
    originals_dir = os.path.join(cfg.data_dir, "storage", ids["media_originals"])
    os.makedirs(originals_dir, exist_ok=True)
    total_bytes = sum(e["size"] for e in entries)
    header = {"type": "header", "format": MANIFEST_FORMAT, "snapshot_time": snapshot_time, "db_sha256": sha256_file(snap_db),
              "originals_rel": "storage/%s" % ids["media_originals"], "count": len(entries), "bytes": total_bytes,
              "include_derived": cfg.include_derived}
    manifest = os.path.join(staging, "manifest.jsonl")
    with open(manifest, "w") as f:
        f.write(json.dumps(header) + "\n")
        for e in entries:
            f.write(json.dumps(e) + "\n")
    info = {"tool_version": TOOL_VERSION, "snapshot_time": snapshot_time, "data_dir": cfg.data_dir, "originals_dir": originals_dir,
            "originals_rel": header["originals_rel"], "derived_rel": "storage/%s" % ids["media"], "include_derived": cfg.include_derived}
    with open(os.path.join(staging, "backup-info.json"), "w") as f:
        json.dump(info, f, indent=2)
    test_hook(cfg, log, "after_manifest")

    # 3. ONE restic run, so database, manifest and files share one snapshot id
    paths = [staging, originals_dir]
    if cfg.include_derived:
        paths.append(os.path.join(cfg.data_dir, "storage", ids["media"]))
    log("restic backup of %d path(s)" % len(paths))
    msgs = restic_json_lines(cfg, "backup", "--tag", "bj-nightly", "--host", "bj", *paths)
    summ = next((m for m in msgs if m.get("message_type") == "summary"), None)
    if not summ:
        raise Fail("restic did not report a snapshot summary")
    snap_id = summ["snapshot_id"]
    run["snapshot_id"] = snap_id
    log("restic snapshot %s written" % snap_id)
    test_hook(cfg, log, "after_restic")

    # 4. verify: every manifest file is in the snapshot with the right size, a sample is re-read and
    #    re-hashed, and a share of the repository data is re-read by restic itself
    verify_snapshot(cfg, log, snap_id, staging, originals_dir, entries, ids)
    run["verification_result"] = "ok"
    test_hook(cfg, log, "after_verify")

    # 5. only now: mark exactly the files in the manifest as offsite protected
    finished = iso(utcnow())
    media_ids = [e["media"] for e in entries]
    marked = 0
    for i in range(0, len(media_ids), 500):
        r = pb.call("POST", "/api/bj/backup/mark", {"snapshot_id": snap_id, "finished_at": finished, "media_ids": media_ids[i:i + 500]})
        marked += r["marked"]
    log("marked %d of %d media rows as offsite protected" % (marked, len(media_ids)))
    test_hook(cfg, log, "after_mark")

    # 6. keep the snapshot and the manifest locally (Time Machine copies these; manifests rebuild the flags)
    keep_local(cfg, stamp, snap_id, snap_db, manifest)
    shutil.rmtree(staging, ignore_errors=True)
    return {"file_count": len(entries), "bytes": total_bytes}


def verify_snapshot(cfg, log, snap_id, staging, originals_dir, entries, ids):
    listing = restic_json_lines(cfg, "ls", snap_id)
    in_snap = {m["path"]: m.get("size", 0) for m in listing if m.get("struct_type") == "node" and m.get("type") == "file"}
    for needed in (os.path.join(staging, "db", "data.db"), os.path.join(staging, "manifest.jsonl")):
        if needed not in in_snap:
            raise Fail("verification failed: %s is not in snapshot %s" % (needed, snap_id))
    bad = []
    for e in entries:
        p = os.path.join(originals_dir, *e["path"].split("/")[2:])
        if p not in in_snap:
            bad.append("not in the snapshot: %s" % e["path"])
        elif in_snap[p] != e["size"]:
            bad.append("size differs in the snapshot: %s" % e["path"])
    if bad:
        raise Fail("verification failed, %d file(s): %s" % (len(bad), "; ".join(bad[:3])))
    log("verified: all %d manifest files are in the snapshot with the right size" % len(entries))

    if cfg.check_subset and cfg.check_subset != "0":
        restic(cfg, "check", "--read-data-subset=%s" % cfg.check_subset)
        log("restic check passed (data subset %s)" % cfg.check_subset)

    candidates = [e for e in entries if 0 < e["size"] <= BIG_FILE_LIMIT]
    sample = random.sample(candidates, min(cfg.sample_files, len(candidates)))
    for e in sample:
        p = os.path.join(originals_dir, *e["path"].split("/")[2:])
        h = hashlib.sha256()
        proc = subprocess.Popen([cfg.restic_bin, "dump", snap_id, p], env=cfg.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for chunk in iter(lambda: proc.stdout.read(8 * 1024 * 1024), b""):
            h.update(chunk)
        proc.wait()
        if proc.returncode != 0 or h.hexdigest() != e["sha256"]:
            raise Fail("verification failed: %s read back from the repository does not match its checksum" % e["path"])
    log("re-read and re-hashed %d sample file(s) from the repository: ok" % len(sample))


def keep_local(cfg, stamp, snap_id, snap_db, manifest):
    d = cfg.path("snapshots", stamp)
    os.makedirs(d, exist_ok=True)
    shutil.copy2(snap_db, os.path.join(d, "data.db"))
    os.makedirs(cfg.path("manifests"), exist_ok=True)
    shutil.copy2(manifest, cfg.path("manifests", "%s__%s.jsonl" % (stamp, snap_id)))
    cutoff = time.time() - cfg.local_days * 86400
    snaps = cfg.path("snapshots")
    for name in os.listdir(snaps):
        p = os.path.join(snaps, name)
        if os.path.isdir(p) and os.path.getmtime(p) < cutoff:
            shutil.rmtree(p, ignore_errors=True)


# -------------------------------------------------------------------- watch
def cmd_watch(cfg, now=None):
    """Raises the 18 h and 24 h alerts and reports a failed last run. Reads the live database
    read-only, so it keeps working when PocketBase itself is down."""
    log = Logger(cfg)
    now = now or utcnow()
    db = os.path.join(cfg.data_dir, "data.db")
    state_path = cfg.path("watch.json")
    try:
        state = json.load(open(state_path))
    except (FileNotFoundError, ValueError):
        state = {}
    conn = open_db(db)
    try:
        good = conn.execute("SELECT finished_at FROM backup_runs WHERE result='ok' AND verification_result='ok' ORDER BY finished_at DESC LIMIT 1").fetchone()
        last = conn.execute("SELECT id, result, verification_result, finished_at FROM backup_runs ORDER BY finished_at DESC LIMIT 1").fetchone()
    finally:
        conn.close()
    if not good:
        level, hours = "critical", None
    else:
        hours = (now - parse_iso(good[0])).total_seconds() / 3600
        level = "critical" if hours >= 24 else "warning" if hours >= 18 else "ok"

    notes = []
    if last and (last[1] != "ok" or last[2] == "failed") and state.get("alerted_run") != last[0]:
        alert(cfg, log, "critical", "The latest backup run failed or did not verify.")
        state["alerted_run"] = last[0]
        notes.append("failed-run")
    prev = state.get("level", "ok")
    since = state.get("alerted_at_ms", 0)
    now_ms = int(now.timestamp() * 1000)
    if level != "ok":
        age = "never completed" if hours is None else "%.0f hours ago" % hours
        if level != prev or (level == "critical" and now_ms - since >= 6 * 3600 * 1000):
            alert(cfg, log, level, "No verified offsite backup since: %s. The journal is outside its recovery target." % age if level == "critical"
                  else "The last verified offsite backup was %s." % age)
            state["alerted_at_ms"] = now_ms
            notes.append(level)
    elif prev != "ok":
        log("[INFO] backups are healthy again")
        notes.append("recovered")
    state["level"] = level
    os.makedirs(cfg.state_dir, exist_ok=True)
    json.dump(state, open(state_path, "w"))
    log("watch: level=%s hours=%s %s" % (level, "n/a" if hours is None else "%.1f" % hours, ",".join(notes)))
    return 0


# ------------------------------------------------------------------ restore
def cmd_restore(cfg, snapshot, target, verify):
    """Rebuilds <target>/pb_data from the offsite repository. Needs only the repository and its
    passphrase. Every manifest file is re-hashed before the restore is declared good."""
    log = Logger(cfg)
    os.makedirs(target, exist_ok=True)
    tmp = os.path.join(target, ".restore-tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    log("restoring snapshot %s into %s" % (snapshot, target))
    restic(cfg, "restore", snapshot, "--target", tmp)
    info_path = None
    for root, _dirs, files in os.walk(tmp):
        if "backup-info.json" in files and os.path.basename(root) == "staging":
            info_path = os.path.join(root, "backup-info.json")
            break
    if not info_path:
        raise Fail("the snapshot does not contain backup-info.json: is this a Baby Journal snapshot?")
    staging = os.path.dirname(info_path)
    info = json.load(open(info_path))
    pb_data = os.path.join(target, "pb_data")
    os.makedirs(os.path.join(pb_data, "storage"), exist_ok=True)
    shutil.copy2(os.path.join(staging, "db", "data.db"), os.path.join(pb_data, "data.db"))
    shutil.copy2(os.path.join(staging, "manifest.jsonl"), os.path.join(target, "manifest.jsonl"))
    orig_abs = os.path.join(tmp, info["originals_dir"].lstrip("/"))
    dest_orig = os.path.join(pb_data, info["originals_rel"])
    shutil.rmtree(dest_orig, ignore_errors=True)
    if os.path.isdir(orig_abs):
        shutil.move(orig_abs, dest_orig)
    else:
        os.makedirs(dest_orig, exist_ok=True)
    if info.get("include_derived"):
        derived_abs = os.path.join(tmp, info["data_dir"].lstrip("/"), info["derived_rel"])
        if os.path.isdir(derived_abs):
            shutil.move(derived_abs, os.path.join(pb_data, info["derived_rel"]))
    shutil.rmtree(tmp, ignore_errors=True)

    problems, checked = [], 0
    with open(os.path.join(target, "manifest.jsonl")) as f:
        header = json.loads(f.readline())
        for line in f:
            e = json.loads(line)
            p = os.path.join(pb_data, *e["path"].split("/"))
            checked += 1
            if not os.path.isfile(p):
                problems.append("missing: %s" % e["path"])
            elif os.path.getsize(p) != e["size"]:
                problems.append("wrong size: %s" % e["path"])
            elif verify == "full" and sha256_file(p) != e["sha256"]:
                problems.append("checksum mismatch: %s" % e["path"])
    result = {"snapshot": snapshot, "snapshot_time": header["snapshot_time"], "files": checked, "verified": verify, "problems": problems,
              "pb_data": pb_data, "derived_included": bool(info.get("include_derived")), "ok": not problems}
    json.dump(result, open(os.path.join(target, "restore-report.json"), "w"), indent=2)
    log("restore %s: %d file(s) checked, %d problem(s)" % ("ok" if not problems else "FAILED", checked, len(problems)))
    for p in problems[:10]:
        log("  " + p)
    if not problems:
        log("Next: start PocketBase on %s, then POST /api/bj/maintenance/reconcile {dry_run:false, regenerate:true}" % pb_data)
    return 0 if not problems else 1


# -------------------------------------------------------------------- drill
def cmd_drill(cfg, snapshot, keep):
    """The quarterly restore check, scripted: restore, start a server on the restored data, reconcile,
    export, verify the export. Result goes to <state>/drill-YYYYMMDD.json and failures raise an alert."""
    import socket
    log = Logger(cfg)
    started = utcnow()
    result = {"started_at": iso(started), "ok": False, "snapshot": snapshot, "steps": {}, "problems": []}
    work = cfg.path("drill-work")
    shutil.rmtree(work, ignore_errors=True)
    proc = None
    t = time.time()

    def step(name):
        nonlocal t
        result["steps"][name] = round(time.time() - t, 1)
        t = time.time()

    try:
        pb_bin = cfg.need("BJ_PB_BIN")
        backend = cfg.need("BJ_BACKEND_DIR")
        env = dict(cfg.env)
        env["BJ_DATA_DIR"], env["BJ_STATE_DIR"] = work, os.path.join(work, ".state")
        rc = cmd_restore(Config(env), snapshot, work, "full")
        step("restore")
        rep = json.load(open(os.path.join(work, "restore-report.json")))
        result["files"] = rep["files"]
        if rc != 0:
            raise Fail("the restore did not verify: %s" % "; ".join(rep["problems"][:3]))

        with socket.socket() as sck:
            sck.bind(("127.0.0.1", 0))
            port = sck.getsockname()[1]
        base = "http://127.0.0.1:%d" % port
        proc = subprocess.Popen([pb_bin, "serve", "--dir", os.path.join(work, "pb_data"), "--migrationsDir", os.path.join(backend, "pb_migrations"),
                                 "--hooksDir", os.path.join(backend, "pb_hooks"), "--http", "127.0.0.1:%d" % port], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(150):
            try:
                urllib.request.urlopen(base + "/api/health", timeout=2).read()
                break
            except Exception:
                if proc.poll() is not None:
                    raise Fail("the restored server exited immediately")
                time.sleep(0.2)
        else:
            raise Fail("the restored server did not start")
        step("start")
        drill_cfg = Config({**env, "BJ_PB_URL": base})
        pb = PB(drill_cfg)
        pb.login()
        fix = pb.call("POST", "/api/bj/maintenance/reconcile", {"dry_run": False, "regenerate": True})
        again = pb.call("POST", "/api/bj/maintenance/reconcile", {})
        step("reconcile")
        bad = len(again["missing"]) + len(again["size_mismatch"]) + len(again["checksum_mismatch"]) + len(again["derived_missing"])
        result["derived_regenerated"] = len(fix["regenerated"])
        if not again["ok"]:
            raise Fail("reconcile on the restored server found %d problem(s)" % bad)
        counts = pb.call("GET", "/api/collections/media/records?perPage=1&filter=" + urllib.parse.quote('status = "stored"'))["totalItems"]
        header = json.loads(open(os.path.join(work, "manifest.jsonl")).readline())
        if counts != header["count"]:
            raise Fail("the restored server has %d stored media rows but the manifest lists %d" % (counts, header["count"]))
        result["entries"] = pb.call("GET", "/api/collections/entries/records?perPage=1")["totalItems"]

        exp = os.path.join(work, "export")
        p = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "bj_export.py"), "--data-dir", os.path.join(work, "pb_data"), "--out", exp], capture_output=True, text=True)
        if p.returncode != 0:
            raise Fail("the export from the restored data reported problems: %s" % (p.stderr or p.stdout)[-200:])
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import bj_export
        ok, problems, stats = bj_export.verify_export(exp)
        step("export")
        if not ok:
            raise Fail("the export did not verify: %s" % "; ".join(problems[:3]))
        result["export"] = stats
        result["ok"] = True
        log("DRILL OK: %d files re-hashed, %d entries, export verified (%s)" % (result["files"], result["entries"], result["steps"]))
    except Fail as e:
        result["problems"].append(str(e))
    except Exception as e:
        result["problems"].append("unexpected error: %r" % (e,))
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
        if not keep:
            shutil.rmtree(work, ignore_errors=True)
        result["finished_at"] = iso(utcnow())
        os.makedirs(cfg.state_dir, exist_ok=True)
        json.dump(result, open(cfg.path("drill-%s.json" % utcnow().strftime("%Y%m%d")), "w"), indent=2)
    if not result["ok"]:
        alert(cfg, log, "critical", "The restore drill FAILED: %s" % "; ".join(result["problems"]))
        return 1
    alert(cfg, log, "info", "Restore drill passed: everything restored, verified and exported (%d files)." % result["files"])
    return 0


# ------------------------------------------------------------------- forget
def cmd_forget(cfg, apply):
    """Retention (written policy): daily 14, weekly 8, monthly 12, yearly 3. Run it from a machine that
    holds the repository's delete credentials, not from the Mac that makes the backups."""
    log = Logger(cfg)
    args = ["forget", "--tag", "bj-nightly", "--host", "bj", "--keep-daily", "14", "--keep-weekly", "8", "--keep-monthly", "12", "--keep-yearly", "3"]
    if apply:
        args.append("--prune")
    else:
        args.append("--dry-run")
    p = restic(cfg, *args)
    log(p.stdout.strip()[-800:])
    return 0


# --------------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env-file")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("backup")
    w = sub.add_parser("watch")
    w.add_argument("--now", help="ISO time to use instead of the clock (tests)")
    r = sub.add_parser("restore")
    r.add_argument("--snapshot", default="latest")
    r.add_argument("--target", required=True)
    r.add_argument("--verify", choices=["full", "size"], default="full")
    d = sub.add_parser("drill")
    d.add_argument("--snapshot", default="latest")
    d.add_argument("--keep", action="store_true", help="keep the restored copy for inspection")
    f = sub.add_parser("forget")
    f.add_argument("--apply", action="store_true")
    args = ap.parse_args(argv)
    load_env_file(args.env_file)
    env = dict(os.environ)
    try:
        if args.cmd == "restore":
            env.setdefault("BJ_DATA_DIR", args.target)
            env.setdefault("BJ_STATE_DIR", os.path.join(args.target, ".state"))
        cfg = Config(env)
        if args.cmd == "backup":
            return cmd_backup(cfg)
        if args.cmd == "watch":
            return cmd_watch(cfg, parse_iso(args.now) if args.now else None)
        if args.cmd == "restore":
            return cmd_restore(cfg, args.snapshot, args.target, args.verify)
        if args.cmd == "drill":
            return cmd_drill(cfg, args.snapshot, args.keep)
        if args.cmd == "forget":
            return cmd_forget(cfg, args.apply)
    except Fail as e:
        print("ERROR: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
