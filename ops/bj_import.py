#!/usr/bin/env python3
"""Baby Journal import (architecture v7, build step 6). Python standard library only.

  bj_import.py check     BUNDLE                 validate the bundle offline; touches nothing
  bj_import.py run       BUNDLE [options]       load it into PocketBase; safe to repeat or resume
  bj_import.py reconcile BUNDLE [options]       prove the result: counts, every field, every file checksum

The bundle is made by bj_firestore_adapter.py (format in infra/docs/migration.md).
Settings (environment):
  BJ_PB_URL                    e.g. http://127.0.0.1:8090
  BJ_PB_SUPERUSER / BJ_PB_PASSWORD   a superuser: creates entries with their original author and time, reads results
  BJ_IMPORT_USER / BJ_IMPORT_PASSWORD   an owner or editor of the journal: uploads the photos and videos
Options for run and reconcile:
  --journal-id ID | --journal-name NAME     which journal (name is looked up, and created if --create-journal)
  --authors FILE         JSON {source person id: e-mail of the account}; default: match people by e-mail
  --default-author EMAIL account that takes entries whose author cannot be matched
  --add-members          make matched authors editors of the journal if they are not members yet
"""
import argparse
import datetime
import hashlib
import http.client
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

DATE_ONLY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
UNIT_KEY = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_([a-z]+)$")
UNITS = {"kg", "g", "cm", "mm", "c", "ml", "l", "min", "h", "bpm", "count"}
TYPES = {"memory", "milestone", "growth", "health", "vaccine", "sleep", "feeding", "pregnancy", "appointment", "other"}
MEDIA_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".mp4", ".mov", ".webm"}
VIDEO_EXT = {".mp4", ".mov", ".webm"}


class Fail(Exception):
    pass


def eid(source_id):
    return "imp-" + hashlib.sha1(str(source_id).encode()).hexdigest()[:24]


def mid(source_id):
    return "impm-" + hashlib.sha1(str(source_id).encode()).hexdigest()[:24]


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def valid_date(s):
    if not isinstance(s, str) or not DATE_ONLY.match(s):
        return False
    try:
        datetime.date.fromisoformat(s)
        return True
    except ValueError:
        return False


def parse_when(s):
    try:
        d = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return None


# ------------------------------------------------------------------- bundle
def load_bundle(path):
    meta = json.load(open(os.path.join(path, "bundle.json"), encoding="utf-8"))
    def rows(name):
        p = os.path.join(path, name)
        return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()] if os.path.exists(p) else []
    return meta, rows("entries.jsonl"), rows("media.jsonl")


def validate(path, meta, entries, media):
    errors, warnings = [], list(meta.get("warnings", []))
    if meta.get("format") != 1:
        errors.append("unsupported bundle format %r (this tool reads format 1)" % meta.get("format"))
    seen, ids = set(), set()
    for e in entries:
        sid = e.get("source_id")
        if not sid or sid in seen:
            errors.append("entry source_id missing or duplicated: %r" % sid)
        seen.add(sid); ids.add(sid)
        if not valid_date(e.get("event_date")):
            errors.append("entry %s: event_date %r is not a valid YYYY-MM-DD date" % (sid, e.get("event_date")))
        if e.get("type") not in TYPES:
            errors.append("entry %s: unknown type %r" % (sid, e.get("type")))
        if len(e.get("title") or "") > 300:
            errors.append("entry %s: title longer than 300 characters" % sid)
        if not isinstance(e.get("milestones", []), list) or any((not isinstance(m, str)) or not m or len(m) > 60 for m in e.get("milestones", [])):
            errors.append("entry %s: milestones must be short strings (1 to 60 characters)" % sid)
        for k, v in (e.get("values") or {}).items():
            m = UNIT_KEY.match(k)
            if not m or m.group(1) not in UNITS:
                errors.append("entry %s: measurement %r needs a unit suffix such as _kg or _cm" % (sid, k))
            elif not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or v <= 0:
                errors.append("entry %s: measurement %s=%r is not a positive number" % (sid, k, v))
        if parse_when(e.get("created")) is None:
            errors.append("entry %s: created %r is not a date" % (sid, e.get("created")))
    mseen = set()
    for m in media:
        if m.get("missing"):
            continue
        if m["source_id"] in mseen:
            errors.append("media source_id duplicated: %s" % m["source_id"])
        mseen.add(m["source_id"])
        if m.get("entry_source_id") not in ids:
            errors.append("media %s belongs to an unknown entry %s" % (m["source_id"], m.get("entry_source_id")))
        p = os.path.join(path, m.get("path", ""))
        if not os.path.isfile(p):
            errors.append("media %s: file %s is missing from the bundle" % (m["source_id"], m.get("path")))
            continue
        if os.path.splitext(p)[1].lower() not in MEDIA_EXT:
            errors.append("media %s: file type %s is not supported" % (m["source_id"], os.path.splitext(p)[1]))
        if m.get("size") is not None and os.path.getsize(p) != m["size"]:
            errors.append("media %s: size differs from the bundle record" % m["source_id"])
        elif m.get("sha256") and sha256_file(p) != m["sha256"]:
            errors.append("media %s: checksum differs from the bundle record (file changed or damaged)" % m["source_id"])
    return errors, warnings


def summary(entries, media):
    years, types = {}, {}
    for e in entries:
        years[e["event_date"][:4]] = years.get(e["event_date"][:4], 0) + 1
        types[e["type"]] = types.get(e["type"], 0) + 1
    good = [m for m in media if not m.get("missing")]
    return {"entries": len(entries), "trashed": len([e for e in entries if e.get("deleted_at")]), "media": len(good),
            "missing_media": len(media) - len(good), "bytes": sum(m.get("size") or 0 for m in good), "by_year": dict(sorted(years.items())), "by_type": types}


# --------------------------------------------------------------------- API
class PB:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.token = ""

    def call(self, method, path, body=None, token=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        req.add_header("Authorization", token if token is not None else self.token)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raise Fail("%s %s answered %d: %s" % (method, path, e.code, e.read()[:300].decode("utf8", "replace")))
        except urllib.error.URLError as e:
            raise Fail("PocketBase is not reachable: %s" % e.reason)

    def login(self, collection, identity, password):
        r = self.call("POST", "/api/collections/%s/auth-with-password" % collection, {"identity": identity, "password": password}, token="")
        return r["token"], r.get("record", {})

    def all(self, collection, filter="", token=None, fields=""):
        out, page = [], 1
        while True:
            q = "?perPage=200&page=%d" % page + ("&filter=" + urllib.parse.quote(filter) if filter else "") + ("&fields=" + fields if fields else "")
            r = self.call("GET", "/api/collections/%s/records%s" % (collection, q), token=token)
            out += r["items"]
            if page >= r["totalPages"]:
                return out
            page += 1

    def upload(self, token, fields, path, filename):
        """Streams a multipart upload from disk, so a multi-GB video never has to fit in memory."""
        u = urllib.parse.urlparse(self.base)
        boundary = uuid.uuid4().hex
        pre = b"".join(("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n" % (boundary, k, v)).encode() for k, v in fields.items())
        pre += ("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\nContent-Type: application/octet-stream\r\n\r\n" % (boundary, filename.replace('"', ""))).encode()
        post = ("\r\n--%s--\r\n" % boundary).encode()
        conn = (http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection)(u.hostname, u.port, timeout=3600)
        try:
            conn.putrequest("POST", "/api/bj/media/upload")
            conn.putheader("Authorization", token)
            conn.putheader("Content-Type", "multipart/form-data; boundary=" + boundary)
            conn.putheader("Content-Length", str(len(pre) + os.path.getsize(path) + len(post)))
            conn.endheaders()
            conn.send(pre)
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
                    conn.send(chunk)
            conn.send(post)
            r = conn.getresponse()
            body = r.read()
            try:
                return r.status, json.loads(body or b"{}")
            except ValueError:
                return r.status, {"message": body[:200].decode("utf8", "replace")}
        finally:
            conn.close()


def connect(need_user):
    base = os.environ.get("BJ_PB_URL")
    if not base:
        raise Fail("BJ_PB_URL is not set")
    pb = PB(base)
    pb.token, _ = pb.login("_superusers", os.environ.get("BJ_PB_SUPERUSER", ""), os.environ.get("BJ_PB_PASSWORD", ""))
    user_token = None
    if need_user:
        user_token, _ = pb.login("users", os.environ.get("BJ_IMPORT_USER", ""), os.environ.get("BJ_IMPORT_PASSWORD", ""))
    return pb, user_token


def resolve_journal(pb, meta, args, create):
    if args.journal_id:
        return pb.call("GET", "/api/collections/journals/records/" + args.journal_id)
    name = args.journal_name or meta.get("journal", {}).get("name")
    found = pb.all("journals", 'name = "%s"' % name.replace('"', ""))
    if found:
        return found[0]
    if not create:
        raise Fail("no journal named %r; give --journal-id or --create-journal" % name)
    j = meta.get("journal", {})
    return pb.call("POST", "/api/collections/journals/records", {"name": name, "emoji": j.get("emoji", ""), "dob": j.get("dob", ""), "due_date": j.get("due_date", "")})


def resolve_authors(pb, journal, meta, entries, args):
    """Maps each old author to a PocketBase account. Nothing is attributed to the wrong person silently."""
    users = {u["email"].lower(): u for u in pb.all("users")}
    mapping = json.load(open(args.authors)) if args.authors else {}
    by_source = {}
    for p in meta.get("people", []):
        email = (mapping.get(p["source_id"]) or p.get("email") or "").lower()
        if email in users:
            by_source[p["source_id"]] = users[email]
    for sid, email in mapping.items():
        if email.lower() in users:
            by_source[sid] = users[email.lower()]
    default = users.get((args.default_author or "").lower())
    if args.default_author and not default:
        raise Fail("--default-author %s is not an account" % args.default_author)
    members = {m["user"]: m for m in pb.all("members", 'journal = "%s"' % journal["id"])}
    resolved, problems = {}, []
    for e in entries:
        src = e.get("author_source_id", "")
        u = by_source.get(src) or default
        if not u:
            problems.append("author %r has no matching account (give --authors or --default-author)" % src)
            continue
        if u["id"] not in members:
            if args.add_members:
                members[u["id"]] = pb.call("POST", "/api/collections/members/records", {"journal": journal["id"], "user": u["id"], "role": "editor"})
            else:
                problems.append("%s is not a member of the journal (use --add-members or invite them first)" % u["email"])
                continue
        resolved[e["source_id"]] = u["id"]
    return resolved, sorted(set(problems))


# --------------------------------------------------------------------- run
def cmd_run(path, args):
    meta, entries, media = load_bundle(path)
    errors, _ = validate(path, meta, entries, media)
    if errors:
        raise Fail("the bundle has %d error(s); run `check` first. First: %s" % (len(errors), errors[0]))
    pb, user_token = connect(True)
    journal = resolve_journal(pb, meta, args, args.create_journal)
    authors, problems = resolve_authors(pb, journal, meta, entries, args)
    if problems:
        raise Fail("cannot attribute all entries:\n  " + "\n  ".join(problems))
    report = {"journal": journal["id"], "entries_created": 0, "entries_existing": 0, "media_uploaded": 0, "media_existing": 0, "errors": []}
    stop_after = int(os.environ.get("BJ_IMPORT_STOP_AFTER", "0") or 0)  # lets tests simulate an interruption

    for e in sorted(entries, key=lambda x: (x["event_date"], x["created"])):
        r = pb.call("POST", "/api/bj/import/entry", {
            "journal": journal["id"], "client_id": eid(e["source_id"]), "author": authors[e["source_id"]],
            "fields": {"event_date": e["event_date"], "type": e["type"], "title": e["title"], "text": e["text"], "milestones": e["milestones"], "values": e["values"]},
            "created": e["created"], "updated": e["updated"], "deleted_at": e.get("deleted_at") or None})
        report["entries_created" if r["result"] == "created" else "entries_existing"] += 1
        if stop_after and report["entries_created"] >= stop_after:
            print("stopped after %d entries (BJ_IMPORT_STOP_AFTER)" % stop_after)
            return 3
    print("entries: %d created, %d already there" % (report["entries_created"], report["entries_existing"]))

    entry_ids = {r["client_id"]: r for r in pb.all("entries", 'journal = "%s" && client_id ~ "imp-"' % journal["id"], fields="id,client_id,deleted_at")}
    have = {r["client_id"] for r in pb.all("media", 'journal = "%s" && client_id ~ "impm-" && status = "stored"' % journal["id"], token=user_token, fields="client_id")}
    todo = [m for m in media if not m.get("missing")]
    for i, m in enumerate(todo, 1):
        cid = mid(m["source_id"])
        if cid in have:
            report["media_existing"] += 1
            continue
        entry = entry_ids.get(eid(m["entry_source_id"]))
        if not entry:
            report["errors"].append("media %s: its entry is not on the server" % m["source_id"])
            continue
        p = os.path.join(path, m["path"])
        fields = {"journal": journal["id"], "entry": entry["id"], "client_id": cid, "kind": "video" if os.path.splitext(p)[1].lower() in VIDEO_EXT else "image",
                  "sha256": m.get("sha256") or sha256_file(p), "size": os.path.getsize(p), "caption": m.get("caption", "")}
        if m.get("taken_at"):
            fields["taken_at"] = m["taken_at"]
        status, body = pb.upload(user_token, fields, p, m.get("original_name") or os.path.basename(p))
        if status == 200 and body.get("media", {}).get("status") == "stored":
            report["media_uploaded"] += 1
            print("  [%d/%d] %s" % (i, len(todo), m.get("original_name")))
        else:
            report["errors"].append("media %s (%s): %s %s" % (m["source_id"], m.get("original_name"), status, body.get("message", "")))
    json.dump(report, open(os.path.join(path, "import-report.json"), "w"), indent=2)
    print("media: %d uploaded, %d already there, %d error(s)" % (report["media_uploaded"], report["media_existing"], len(report["errors"])))
    for err in report["errors"][:10]:
        print("  ERROR: " + err, file=sys.stderr)
    return 1 if report["errors"] else 0


# --------------------------------------------------------------- reconcile
def cmd_reconcile(path, args):
    meta, entries, media = load_bundle(path)
    pb, user_token = connect(True)
    journal = resolve_journal(pb, meta, args, False)
    authors, _ = resolve_authors(pb, journal, meta, entries, argparse.Namespace(**{**vars(args), "add_members": False}))
    dest = {r["client_id"]: r for r in pb.all("entries", 'journal = "%s" && client_id ~ "imp-"' % journal["id"])}
    dmedia = {r["client_id"]: r for r in pb.all("media", 'journal = "%s" && client_id ~ "impm-"' % journal["id"])}
    origs = {r["media"]: r for r in pb.all("media_originals", 'journal = "%s"' % journal["id"])}
    bad = []
    src = summary(entries, media)
    for e in entries:
        d = dest.get(eid(e["source_id"]))
        if not d:
            bad.append("entry %s (%s %s) is missing on the server" % (e["source_id"], e["event_date"], e["title"][:30]))
            continue
        for k in ("event_date", "type", "title", "text", "milestones", "values"):
            want = e[k]
            got = d[k]
            if k == "values":
                same = set(want) == set(got) and all(abs(want[x] - got[x]) < 1e-6 for x in want)
            else:
                same = want == got
            if not same:
                bad.append("entry %s: %s differs (source %r, server %r)" % (e["source_id"], k, str(want)[:40], str(got)[:40]))
        if bool(e.get("deleted_at")) != bool(d.get("deleted_at")):
            bad.append("entry %s: trash state differs" % e["source_id"])
        if authors.get(e["source_id"]) and d["author"] != authors[e["source_id"]]:
            bad.append("entry %s: author differs" % e["source_id"])
        w, g = parse_when(e["created"]), parse_when(d["created"])
        if w and g and abs((w - g).total_seconds()) > 1:
            bad.append("entry %s: written-on time differs (source %s, server %s)" % (e["source_id"], e["created"][:19], d["created"][:19]))
    total_hash_ok = 0
    for m in [x for x in media if not x.get("missing")]:
        d = dmedia.get(mid(m["source_id"]))
        if not d or d["status"] != "stored":
            bad.append("media %s (%s) is not stored on the server" % (m["source_id"], m.get("original_name")))
            continue
        o = origs.get(d["id"])
        local = m.get("sha256") or sha256_file(os.path.join(path, m["path"]))
        if not o or o["sha256"] != local:
            bad.append("media %s (%s): checksum on the server differs from the source file" % (m["source_id"], m.get("original_name")))
        elif o["size"] != os.path.getsize(os.path.join(path, m["path"])):
            bad.append("media %s: size differs" % m["source_id"])
        else:
            total_hash_ok += 1
        parent = dest.get(eid(m["entry_source_id"]))
        if parent and d["entry"] != parent["id"]:
            bad.append("media %s is attached to the wrong entry" % m["source_id"])
    extra = [c for c in dest if c not in {eid(e["source_id"]) for e in entries}]
    result = {"source": src, "server_entries": len(dest), "server_media": len([d for d in dmedia.values() if d["status"] == "stored"]), "checksums_verified": total_hash_ok,
              "known_gaps": ["file missing from the Drive download: %s" % m.get("original_name") for m in media if m.get("missing")], "mismatches": bad, "extra_on_server": extra}
    json.dump(result, open(os.path.join(path, "reconcile-report.json"), "w"), indent=2)
    print("source: %d entries (%d trashed), %d media files, %.1f MB" % (src["entries"], src["trashed"], src["media"], src["bytes"] / 1e6))
    print("server: %d imported entries, %d imported media; %d file checksums match the source" % (len(dest), result["server_media"], total_hash_ok))
    for g in result["known_gaps"]:
        print("  gap: " + g)
    for b in bad[:15]:
        print("  MISMATCH: " + b)
    if len(bad) > 15:
        print("  ... %d more in reconcile-report.json" % (len(bad) - 15))
    print("RECONCILED" if not bad else "NOT RECONCILED: %d mismatch(es)" % len(bad))
    return 0 if not bad else 1


def cmd_check(path):
    meta, entries, media = load_bundle(path)
    errors, warnings = validate(path, meta, entries, media)
    s = summary(entries, media)
    print("bundle: %d entries (%d trashed), %d media files (%.1f MB), %d file(s) missing at conversion" % (s["entries"], s["trashed"], s["media"], s["bytes"] / 1e6, s["missing_media"]))
    print("by year: " + ", ".join("%s: %d" % kv for kv in s["by_year"].items()))
    print("by type: " + ", ".join("%s: %d" % kv for kv in sorted(s["by_type"].items())))
    for w in warnings[:10]:
        print("  warning: " + w)
    for e in errors[:20]:
        print("  ERROR: " + e, file=sys.stderr)
    print("OK, ready to import" if not errors else "%d error(s): fix the bundle or the mapping" % len(errors))
    return 0 if not errors else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check"); c.add_argument("bundle")
    for name in ("run", "reconcile"):
        p = sub.add_parser(name)
        p.add_argument("bundle")
        p.add_argument("--journal-id"); p.add_argument("--journal-name"); p.add_argument("--authors"); p.add_argument("--default-author")
        p.add_argument("--create-journal", action="store_true"); p.add_argument("--add-members", action="store_true")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "check":
            return cmd_check(a.bundle)
        return (cmd_run if a.cmd == "run" else cmd_reconcile)(a.bundle, a)
    except Fail as e:
        print("ERROR: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
