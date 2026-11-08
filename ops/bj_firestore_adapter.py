#!/usr/bin/env python3
"""Turns a Firestore JSON export plus downloaded Google Drive files into an import bundle
(see infra/docs/migration.md). Python standard library only.

  bj_firestore_adapter.py --export firestore.json --mapping mapping.json --out bundle/

firestore.json is a JSON object with one array per collection, each document carrying its id, for example
  {"events": [{"id": "abc", "date": {"_seconds": 1745000000}, "title": "...", ...}], "users": [...]}
Anything the adapter cannot map is reported as a warning and kept in the bundle's "unmapped" notes,
never dropped silently.
"""
import argparse
import datetime
import hashlib
import json
import os
import shutil
import sys

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    ZoneInfo = None

BUNDLE_FORMAT = 1
KNOWN_TYPES = {"memory", "milestone", "growth", "health", "vaccine", "sleep", "feeding", "pregnancy", "appointment", "other"}


def to_dt(v):
    """Firestore timestamps come in several shapes. Returns an aware UTC datetime or None."""
    if v in (None, ""):
        return None
    if isinstance(v, dict):
        s = v.get("_seconds", v.get("seconds"))
        if s is not None:
            ns = v.get("_nanoseconds", v.get("nanoseconds", 0)) or 0
            return datetime.datetime.fromtimestamp(int(s) + int(ns) / 1e9, datetime.timezone.utc)
        return None
    if isinstance(v, (int, float)):
        t = v / 1000.0 if v > 1e11 else float(v)  # milliseconds or seconds
        return datetime.datetime.fromtimestamp(t, datetime.timezone.utc)
    if isinstance(v, str):
        s = v.strip().replace("Z", "+00:00")
        try:
            d = datetime.datetime.fromisoformat(s)
        except ValueError:
            return None
        return d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)
    return None


def local_date(dt, tz):
    if tz is not None:
        dt = dt.astimezone(tz)
    return dt.strftime("%Y-%m-%d")


def stable_id(prefix, source_id):
    return prefix + hashlib.sha1(str(source_id).encode()).hexdigest()[:24]


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def get(d, key):
    return d.get(key) if key else None


def convert(export, mapping, drive_root, out):
    warnings, errors = [], []
    tz = ZoneInfo(mapping["timezone"]) if (ZoneInfo and mapping.get("timezone")) else None
    cols = mapping["collections"]
    ef, uf, mf = mapping["entry"], mapping.get("user", {}), mapping.get("media_item", {})
    tmap, mmap = mapping.get("type_map", {}), mapping.get("milestone_map", {})
    default_type = mapping.get("default_type", "memory")

    people = []
    for u in export.get(cols.get("users", "users"), []):
        people.append({"source_id": str(get(u, uf.get("id", "id"))), "name": get(u, uf.get("name")) or "", "email": (get(u, uf.get("email")) or "").lower()})

    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(os.path.join(out, "media"))
    entries, media = [], []
    used_names = set()
    for doc in export.get(cols["entries"], []):
        sid = str(get(doc, ef.get("id", "id")))
        created = to_dt(get(doc, ef.get("created")))
        when = to_dt(get(doc, ef.get("date"))) or created
        if when is None:
            errors.append("entry %s has no usable date" % sid)
            continue
        raw_type = get(doc, ef.get("type"))
        t = tmap.get(raw_type, raw_type if raw_type in KNOWN_TYPES else default_type)
        if raw_type is not None and raw_type not in tmap and raw_type not in KNOWN_TYPES:
            warnings.append("entry %s: unknown type %r, imported as %s" % (sid, raw_type, default_type))
        ms = []
        for tag in get(doc, ef.get("milestones")) or []:
            if tag in mmap:
                ms.append(mmap[tag])
            else:
                key = "".join(c if c.isalnum() else "_" for c in str(tag).lower()).strip("_")[:60]
                if key:
                    ms.append(key)
                    warnings.append("entry %s: milestone %r kept as %r" % (sid, tag, key))
        values = {}
        for ours, spec in (mapping.get("values") or {}).items():
            spec = {"field": spec} if isinstance(spec, str) else spec
            raw = doc.get(spec["field"])
            if raw in (None, ""):
                continue
            try:
                num = float(raw) * float(spec.get("scale", 1))
            except (TypeError, ValueError):
                warnings.append("entry %s: %s=%r is not a number, left out" % (sid, spec["field"], raw))
                continue
            if num > 0:
                values[ours] = round(num, 3)
        entry = {
            "source_id": sid, "author_source_id": str(get(doc, ef.get("author")) or ""), "event_date": local_date(when, tz), "type": t,
            "title": (get(doc, ef.get("title")) or "").strip(), "text": get(doc, ef.get("text")) or "", "milestones": ms, "values": values,
            "created": (created or when).isoformat(), "updated": (to_dt(get(doc, ef.get("updated"))) or created or when).isoformat(),
            "deleted_at": (to_dt(get(doc, ef.get("deleted"))).isoformat() if to_dt(get(doc, ef.get("deleted"))) else ""),
        }
        entries.append(entry)
        for item in get(doc, ef.get("media")) or []:
            mid = str(get(item, mf.get("id", "id")))
            name = get(item, mf.get("name")) or mid
            src = os.path.join(drive_root, mapping.get("drive_file", "{id}").format(id=mid, name=name))
            if not os.path.isfile(src):
                alt = os.path.join(drive_root, name)
                src = alt if os.path.isfile(alt) else src
            if not os.path.isfile(src):
                warnings.append("entry %s: file %s (%s) is not in the Drive download, skipped" % (sid, mid, name))
                media.append({"source_id": mid, "entry_source_id": sid, "missing": True, "original_name": name})
                continue
            ext = os.path.splitext(name)[1].lower() or os.path.splitext(src)[1].lower()
            rel = os.path.join("media", stable_id("", mid) + ext)
            if rel in used_names:
                continue
            used_names.add(rel)
            shutil.copy2(src, os.path.join(out, rel))
            kind = get(item, mf.get("kind")) or ""
            taken = to_dt(get(item, mf.get("taken")))
            media.append({
                "source_id": mid, "entry_source_id": sid, "path": rel, "original_name": name, "caption": get(item, mf.get("caption")) or "",
                "taken_at": taken.isoformat() if taken else "", "sha256": sha256_file(os.path.join(out, rel)), "size": os.path.getsize(os.path.join(out, rel)),
                "kind_hint": "video" if str(kind).startswith("video") or ext in (".mp4", ".mov", ".webm") else "image",
            })
    journal = dict(mapping.get("journal", {}))
    with open(os.path.join(out, "bundle.json"), "w", encoding="utf-8") as f:
        json.dump({"format": BUNDLE_FORMAT, "source": mapping.get("source", "firestore-export"), "journal": journal, "people": people,
                   "counts": {"entries": len(entries), "media": len([m for m in media if not m.get("missing")])}, "warnings": warnings}, f, ensure_ascii=False, indent=2)
    for name, rows in (("entries.jsonl", entries), ("media.jsonl", media)):
        with open(os.path.join(out, name), "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return len(entries), len([m for m in media if not m.get("missing")]), warnings, errors


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--export", required=True)
    ap.add_argument("--mapping", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--drive", help="folder with the downloaded Drive files (default: drive_dir next to the export)")
    a = ap.parse_args(argv)
    mapping = json.load(open(a.mapping, encoding="utf-8"))
    export = json.load(open(a.export, encoding="utf-8"))
    drive = a.drive or os.path.join(os.path.dirname(os.path.abspath(a.export)), mapping.get("drive_dir", "drive-downloads"))
    n, m, warnings, errors = convert(export, mapping, drive, a.out)
    print("bundle written to %s: %d entries, %d media files, %d warning(s), %d error(s)" % (a.out, n, m, len(warnings), len(errors)))
    for w in warnings[:25]:
        print("  warning: " + w)
    if len(warnings) > 25:
        print("  ... %d more warnings are in bundle.json" % (len(warnings) - 25))
    for e in errors:
        print("  ERROR: " + e, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
