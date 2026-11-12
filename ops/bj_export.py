#!/usr/bin/env python3
"""Baby Journal plain export (architecture v7, F10 and section 9). Python standard library only.

Reads a database file (a snapshot or a restored data.db) and the originals folder directly, so it
needs no PocketBase, no app code and no network. The result is a folder anyone can open:

  README.md           what everything is, and how to check it
  index.html          the whole journal in a browser, no software or internet needed
  journal.json        everything, including history and trashed entries (schema_version inside)
  entries/YYYY/YYYY-MM-DD_title/   entry.md, entry.json and the original photos and videos
  checksums.sha256    for  sha256sum -c checksums.sha256

Usage:  bj_export.py --db data.db --originals pb_data/storage/<collection id> --out export-folder
        bj_export.py --data-dir pb_data --out export-folder        (finds both itself)
"""
import argparse
import datetime
import hashlib
import html
import json
import os
import re
import shutil
import sqlite3
import sys
import unicodedata
import urllib.parse

SCHEMA_VERSION = 1
PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def slug(text, limit=40):
    s = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()[:limit].strip("-")
    return s or "entry"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def jload(s, default):
    try:
        return json.loads(s) if s else default
    except ValueError:
        return default


def pb_time(s):
    if not s:
        return None
    try:
        return datetime.datetime.fromisoformat(s.replace(" ", "T").replace("Z", "+00:00"))
    except ValueError:
        return None


def ext_of(name, mime):
    e = os.path.splitext(name or "")[1].lower()
    if e:
        return e
    return {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic", "video/mp4": ".mp4",
            "video/quicktime": ".mov", "video/webm": ".webm"}.get(mime, ".bin")


def export_journal(conn, journal, originals_dir, out_root):
    jid = journal["id"]
    out = os.path.join(out_root, "%s-%s" % (slug(journal["name"], 30), jid[:6]))
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(os.path.join(out, "entries"))
    problems = []
    users = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM users")}  # names only: never emails or passwords

    entries = conn.execute("SELECT * FROM entries WHERE journal = ? ORDER BY event_date, created", (jid,)).fetchall()
    media_by_entry = {}
    for m in conn.execute(
            "SELECT m.*, o.id AS orig_id, o.file AS orig_file, o.original_name, o.mime, o.size, o.sha256, o.metadata "
            "FROM media m LEFT JOIN media_originals o ON o.media = m.id WHERE m.journal = ? AND m.status = 'stored' "
            "ORDER BY m.sort_order, COALESCE(NULLIF(m.taken_at, ''), m.created), m.id", (jid,)):
        media_by_entry.setdefault(m["entry"], []).append(m)

    used = set()
    index_rows = []
    full_entries = []
    n_files = 0
    for e in entries:
        ms = media_by_entry.get(e["id"], [])
        trashed = bool(e["deleted_at"])
        item = {
            "id": e["id"], "client_id": e["client_id"], "author": users.get(e["author"], ""), "event_date": e["event_date"],
            "type": e["type"], "title": e["title"], "text": e["text"], "milestones": jload(e["milestones"], []),
            "values": jload(e["values"], {}), "revision": e["revision"], "needs_review": bool(e["needs_review"]),
            "deleted_at": e["deleted_at"], "created": e["created"], "updated": e["updated"], "media": [],
        }
        folder_rel = ""
        if not trashed:
            year = (e["event_date"] or "0000")[:4]
            base = "%s_%s" % (e["event_date"], slug(e["title"]))
            name = base
            if os.path.join(year, name) in used:
                name = "%s-%s" % (base, e["id"][:4])
            used.add(os.path.join(year, name))
            folder_rel = os.path.join("entries", year, name)
            os.makedirs(os.path.join(out, folder_rel), exist_ok=True)
        counters = {"image": 0, "video": 0}
        for m in ms:
            rec = {"media_id": m["id"], "kind": m["kind"], "original_name": m["original_name"] or "", "mime": m["mime"] or "",
                   "size": m["size"], "sha256": m["sha256"], "caption": m["caption"], "taken_at": m["taken_at"],
                   "width": m["width"], "height": m["height"], "duration": m["duration"], "deleted_at": m["deleted_at"], "file": ""}
            if not trashed and not m["deleted_at"]:
                src = os.path.join(originals_dir, m["orig_id"] or "-", m["orig_file"] or "-")
                if not os.path.isfile(src):
                    problems.append("original missing for media %s (%s)" % (m["id"], m["original_name"]))
                else:
                    counters[m["kind"]] += 1
                    fname = "%s-%02d%s" % ("photo" if m["kind"] == "image" else "video", counters[m["kind"]], ext_of(m["original_name"], m["mime"]))
                    dst = os.path.join(out, folder_rel, fname)
                    shutil.copy2(src, dst)
                    if sha256_file(dst) != m["sha256"]:
                        problems.append("checksum differs for media %s (%s)" % (m["id"], m["original_name"]))
                    when = pb_time(m["taken_at"]) or pb_time(m["created"])
                    if when:
                        os.utime(dst, (when.timestamp(), when.timestamp()))
                    rec["file"] = fname
                    n_files += 1
            item["media"].append(rec)
        full_entries.append(item)
        if not trashed:
            write_entry(out, folder_rel, item)
            index_rows.append((folder_rel, item))

    versions = [dict(r) for r in conn.execute("SELECT entry, revision, base_revision, author, status, title, text, event_date, created FROM entry_versions WHERE journal = ? ORDER BY entry, created", (jid,))]
    for v in versions:
        v["author"] = users.get(v["author"], "")
    members = [{"name": users.get(r["user"], ""), "role": r["role"], "joined_at": r["joined_at"]} for r in conn.execute("SELECT user, role, joined_at FROM members WHERE journal = ?", (jid,))]
    jjson = {
        "schema_version": SCHEMA_VERSION, "exported_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "journal": {"id": jid, "name": journal["name"], "emoji": journal["emoji"], "due_date": journal["due_date"], "dob": journal["dob"]},
        "members": members, "entries": full_entries, "entry_versions": versions,
    }
    with open(os.path.join(out, "journal.json"), "w", encoding="utf-8") as f:
        json.dump(jjson, f, ensure_ascii=False, indent=2)
    write_index(out, journal, index_rows)
    counts = {"entries": len(index_rows), "trashed_entries": len(full_entries) - len(index_rows), "files": n_files, "versions": len(versions)}
    write_readme(out, journal, counts, problems)
    write_checksums(out)
    return out, counts, problems


def write_entry(out, folder_rel, item):
    d = os.path.join(out, folder_rel)
    with open(os.path.join(d, "entry.json"), "w", encoding="utf-8") as f:
        json.dump(item, f, ensure_ascii=False, indent=2)
    lines = ["# %s" % (item["title"] or "Untitled"), "", "- **Date:** %s" % item["event_date"], "- **Type:** %s" % item["type"]]
    if item["author"]:
        lines.append("- **Written by:** %s" % item["author"])
    if item["milestones"]:
        lines.append("- **Milestones:** %s" % ", ".join(m.replace("_", " ") for m in item["milestones"]))
    if item["values"]:
        lines.append("- **Measurements:** %s" % ", ".join("%s = %s" % (k, v) for k, v in item["values"].items()))
    lines += ["", item["text"] or "", ""]
    shown = [m for m in item["media"] if m["file"]]
    if shown:
        lines += ["## Photos and videos", ""]
        for m in shown:
            bits = [m["caption"]] if m["caption"] else []
            if m["original_name"]:
                bits.append("originally %s" % m["original_name"])
            if m["taken_at"]:
                bits.append("taken %s" % m["taken_at"][:16].replace("T", " "))
            lines.append("- %s%s" % (m["file"], " (%s)" % "; ".join(bits) if bits else ""))
    with open(os.path.join(d, "entry.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def href(path):
    return "/".join(urllib.parse.quote(p) for p in path.split(os.sep))


def write_index(out, journal, rows):
    years = {}
    for folder_rel, item in rows:
        years.setdefault((item["event_date"] or "")[:4], []).append((folder_rel, item))
    parts = ["<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>",
             "<title>%s</title>" % html.escape(journal["name"]),
             "<style>body{font:18px/1.5 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem}h2{margin-top:2.5rem;border-bottom:1px solid #ccc}"
             "article{margin:1.2rem 0}img{height:110px;margin:2px;border-radius:6px}.m{color:#666;font-size:.9rem}</style></head><body>",
             "<h1>%s %s</h1>" % (html.escape(journal["emoji"] or ""), html.escape(journal["name"])),
             "<p class='m'>A copy of the journal. Open any folder under <code>entries</code> for the full text and the original files. See README.md.</p><nav>"]
    parts.append(" ".join("<a href='#y%s'>%s</a>" % (y, y) for y in sorted(years)) + "</nav>")
    for y in sorted(years):
        parts.append("<h2 id='y%s'>%s</h2>" % (y, y))
        for folder_rel, item in sorted(years[y], key=lambda r: r[1]["event_date"]):
            parts.append("<article><div class='m'>%s &middot; %s</div><h3><a href='%s'>%s</a></h3>" % (
                item["event_date"], html.escape(item["type"]), href(os.path.join(folder_rel, "entry.md")), html.escape(item["title"] or "Untitled")))
            if item["text"]:
                t = item["text"].strip()
                parts.append("<p>%s</p>" % html.escape(t[:300] + ("…" if len(t) > 300 else "")).replace("\n", "<br>"))
            files = [m for m in item["media"] if m["file"]]
            for m in files:
                p = href(os.path.join(folder_rel, m["file"]))
                if os.path.splitext(m["file"])[1].lower() in PHOTO_EXT:
                    parts.append("<a href='%s'><img src='%s' loading='lazy' alt='%s'></a>" % (p, p, html.escape(m["caption"] or "")))
                else:
                    parts.append("<div><a href='%s'>%s</a></div>" % (p, html.escape(m["file"])))
            parts.append("</article>")
    parts.append("</body></html>")
    with open(os.path.join(out, "index.html"), "w", encoding="utf-8") as f:
        f.write("\n".join(parts))


def write_readme(out, journal, counts, problems):
    text = """# %(name)s: a copy of the journal

Exported on %(date)s. Export schema version: **%(schema)d**.
This folder is complete by itself. You do not need any app, server or account to read it.

## What is here

| Item | What it is |
|---|---|
| `index.html` | Open this in any web browser. It lists every entry by year with its photos. |
| `entries/YEAR/DATE_title/` | One folder per entry. `entry.md` is the text (any text editor opens it), `entry.json` has the same data in a structured form, and the photos and videos are the **original files**, named `photo-01.jpg`, `video-01.mp4` and so on. |
| `journal.json` | Everything in one file: all entries (also the ones in the trash), every earlier version of each entry, and the people. The field `schema_version` says which layout this is. |
| `checksums.sha256` | A fingerprint of every file, so you can prove nothing was damaged. |

This export holds %(entries)d entries, %(files)d photo and video files%(trash)s, and %(versions)d saved versions.

## Checking that nothing is damaged

Open a terminal in this folder and run:

- macOS: `shasum -a 256 -c checksums.sha256`
- Linux: `sha256sum -c checksums.sha256`
- Windows (PowerShell): `Get-Content checksums.sha256 | ForEach-Object { $h,$f = $_ -split '  ',2; if ((Get-FileHash $f -Algorithm SHA256).Hash.ToLower() -ne $h) { "DIFFERENT: $f" } }`

Every line should end in `OK`.

## Details for someone reading the data

- Dates in folder names and `event_date` are the day the event happened (year-month-day), not the day it was typed in.
- Dates with a time (`created`, `taken_at`) are UTC. The files' own "modified" time is set to when the photo or video was taken.
- `values` holds measurements, and the unit is part of the name: `weight_kg` is kilograms, `length_cm` centimetres, `temperature_c` degrees Celsius.
- `milestones` are short names such as `first_smile`.
- `original_name` is the file name the phone gave the photo; the file here is renamed so that folders stay tidy.
- Entries with `needs_review: true` had two versions written at the same time; both are in `entry_versions` inside `journal.json`.
- Photos and videos are the unmodified originals, including location and camera data. Share them with care.

## Problems found while exporting

%(problems)s
""" % {
        "name": journal["name"], "date": datetime.date.today().isoformat(), "schema": SCHEMA_VERSION, "entries": counts["entries"],
        "files": counts["files"], "versions": counts["versions"],
        "trash": " (and %d trashed entries, which are only in `journal.json`)" % counts["trashed_entries"] if counts["trashed_entries"] else "",
        "problems": "\n".join("- " + p for p in problems) if problems else "None.",
    }
    with open(os.path.join(out, "README.md"), "w", encoding="utf-8") as f:
        f.write(text)


def write_checksums(out):
    lines = []
    for root, _d, files in os.walk(out):
        for fn in sorted(files):
            if fn == "checksums.sha256":
                continue
            p = os.path.join(root, fn)
            lines.append("%s  %s" % (sha256_file(p), os.path.relpath(p, out).replace(os.sep, "/")))
    with open(os.path.join(out, "checksums.sha256"), "w", encoding="utf-8") as f:
        f.write("\n".join(sorted(lines, key=lambda s: s.split("  ", 1)[1])) + "\n")


def verify_export(folder, check_hashes=True):
    """Checks an export folder the way a person opening it years later would rely on it. Returns (ok, problems, stats)."""
    problems = []
    roots = [folder] if os.path.exists(os.path.join(folder, "journal.json")) else [os.path.join(folder, d) for d in sorted(os.listdir(folder)) if os.path.isdir(os.path.join(folder, d))]
    stats = {"journals": 0, "entries": 0, "files": 0}
    if not roots:
        problems.append("no journal folder found in %s" % folder)
    for root in roots:
        stats["journals"] += 1
        for needed in ("README.md", "index.html", "journal.json", "checksums.sha256"):
            if not os.path.isfile(os.path.join(root, needed)):
                problems.append("%s: %s is missing" % (os.path.basename(root), needed))
        try:
            j = json.load(open(os.path.join(root, "journal.json"), encoding="utf-8"))
        except (OSError, ValueError) as e:
            problems.append("%s: journal.json cannot be read (%s)" % (os.path.basename(root), e))
            continue
        if j.get("schema_version") != SCHEMA_VERSION:
            problems.append("%s: unexpected schema_version %r" % (os.path.basename(root), j.get("schema_version")))
        live = [e for e in j.get("entries", []) if not e.get("deleted_at")]
        folders = [os.path.join(dp) for dp, _dn, fn in os.walk(os.path.join(root, "entries")) if "entry.json" in fn]
        stats["entries"] += len(live)
        if len(folders) != len(live):
            problems.append("%s: %d entries in journal.json but %d entry folders" % (os.path.basename(root), len(live), len(folders)))
        for d in folders:
            try:
                e = json.load(open(os.path.join(d, "entry.json"), encoding="utf-8"))
            except (OSError, ValueError):
                problems.append("%s: entry.json unreadable" % os.path.relpath(d, root))
                continue
            if not os.path.isfile(os.path.join(d, "entry.md")):
                problems.append("%s: entry.md is missing" % os.path.relpath(d, root))
            for m in e.get("media", []):
                if m.get("file"):
                    stats["files"] += 1
                    if not os.path.isfile(os.path.join(d, m["file"])):
                        problems.append("%s: %s is missing" % (os.path.relpath(d, root), m["file"]))
        try:
            page = open(os.path.join(root, "index.html"), encoding="utf-8").read()
            for link in re.findall(r"(?:href|src)='(entries/[^']+)'", page):
                if not os.path.exists(os.path.join(root, urllib.parse.unquote(link))):
                    problems.append("index.html links to a missing file: %s" % link)
        except OSError:
            pass
        if check_hashes and os.path.isfile(os.path.join(root, "checksums.sha256")):
            for line in open(os.path.join(root, "checksums.sha256"), encoding="utf-8"):
                if "  " not in line:
                    continue
                digest, rel = line.rstrip("\n").split("  ", 1)
                p2 = os.path.join(root, rel)
                if not os.path.isfile(p2):
                    problems.append("checksums.sha256 lists a missing file: %s" % rel)
                elif sha256_file(p2) != digest:
                    problems.append("checksum differs: %s" % rel)
    return (not problems), problems, stats


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", help="a pb_data folder (uses data.db and the originals folder inside it)")
    ap.add_argument("--db", help="a database file or snapshot")
    ap.add_argument("--originals", help="the originals folder (storage/<media_originals collection id>)")
    ap.add_argument("--out")
    ap.add_argument("--journal", help="export only this journal id")
    ap.add_argument("--verify", metavar="FOLDER", help="check an existing export folder (structure, links, every checksum) and exit")
    args = ap.parse_args(argv)
    if args.verify:
        ok, problems, stats = verify_export(args.verify)
        print("%s: %d journal(s), %d entries, %d files" % ("export verified" if ok else "EXPORT HAS PROBLEMS", stats["journals"], stats["entries"], stats["files"]))
        for pr in problems[:20]:
            print("  PROBLEM: " + pr, file=sys.stderr)
        return 0 if ok else 1
    if not args.out:
        ap.error("--out is required")
    db = args.db or (os.path.join(args.data_dir, "data.db") if args.data_dir else None)
    if not db:
        ap.error("give --db or --data-dir")
    conn = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    conn.row_factory = sqlite3.Row
    cid = conn.execute("SELECT id FROM _collections WHERE name = 'media_originals'").fetchone()[0]
    originals = args.originals or os.path.join(args.data_dir or os.path.dirname(db), "storage", cid)
    journals = conn.execute("SELECT * FROM journals" + (" WHERE id = ?" if args.journal else ""), (args.journal,) if args.journal else ()).fetchall()
    os.makedirs(args.out, exist_ok=True)
    code = 0
    for j in journals:
        out, counts, problems = export_journal(conn, j, originals, args.out)
        print("exported %s: %s" % (out, counts))
        for p in problems:
            print("  PROBLEM: " + p, file=sys.stderr)
        if problems:
            code = 2
    return code


if __name__ == "__main__":
    sys.exit(main())
