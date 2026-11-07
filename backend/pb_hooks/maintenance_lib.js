// Maintenance helpers (architecture v7, sections 6.7 and 9). Not auto-loaded; require inside handlers.
//
// Rules:
//  - Nothing here deletes a file unless a verified offsite backup already holds it.
//  - Every deleting job has a dry run, and the scheduled purge is a dry run until the owner
//    sets BJ_PURGE_ENABLE=1.
//  - The purge waits while the backup job holds the maintenance lock.
//  - Files nothing refers to are MOVED to a review folder, never deleted.

const PURGE_AFTER_DAYS = 30;
const BACKUP_MAX_AGE_HOURS = 48; // purge needs a verified backup newer than this
const LOCK_STALE_HOURS = 6;

function lockPath() {
  return $filepath.join($app.dataDir(), ".maintenance.lock");
}

// The backup job writes {pid, started} here for its whole run. A crashed job leaves the file
// behind, so a lock only counts while its process is alive and it is younger than 6 hours.
function lockActive() {
  let raw;
  try { raw = toString($os.readFile(lockPath())); } catch (_) { return false; }
  let lock;
  try { lock = JSON.parse(raw); } catch (_) { return true; } // unreadable: assume busy
  if (!lock.started || Date.now() - lock.started > LOCK_STALE_HOURS * 3600 * 1000) return false;
  try { $os.cmd("kill", "-0", String(lock.pid)).output(); return true; } catch (_) { return false; }
}

// Calls the configured alert command (the same script the shell jobs use).
function alert(level, message) {
  console.log("[bj " + level + "] " + message);
  const cmd = $os.getenv("BJ_ALERT_CMD");
  if (!cmd) return;
  try { $os.cmd(cmd, level, message).output(); } catch (err) { console.log("alert command failed: " + String(err)); }
}

function dateMs(s) {
  if (!s) return NaN;
  return Date.parse(String(s).replace(" ", "T"));
}

function lastGoodBackup(app) {
  const rows = app.findRecordsByFilter("backup_runs", "result = 'ok' && verification_result = 'ok'", "-finished_at", 1, 0);
  return rows.length ? rows[0] : null;
}

// ------------------------------------------------------------------- purge
// Removes trashed entries and media after 30 days, but only if a verified backup holds them.
function purgeTrash(app, opts) {
  const dryRun = opts.dryRun !== false;
  const now = opts.nowMs || Date.now();
  const cutoff = new Date(now - PURGE_AFTER_DAYS * 86400000).toISOString().replace("T", " ");
  const report = { dry_run: dryRun, cutoff: cutoff, skipped: "", entries: [], media: [], blocked: [] };

  if (lockActive()) { report.skipped = "a backup is running (maintenance lock held)"; return report; }
  const good = lastGoodBackup(app);
  if (!good) { report.skipped = "no verified backup has ever completed"; return report; }
  const goodAt = dateMs(good.getString("finished_at"));
  if (now - goodAt > BACKUP_MAX_AGE_HOURS * 3600000) { report.skipped = "the last verified backup is older than " + BACKUP_MAX_AGE_HOURS + " hours"; return report; }

  const doomedEntries = {};
  for (const e of app.findRecordsByFilter("entries", "deleted_at != '' && deleted_at < {:c}", "", 0, 0, { c: cutoff })) {
    const media = app.findRecordsByFilter("media", "entry = {:e}", "", 0, 0, { e: e.id });
    const unprotected = media.filter((m) => m.getString("status") === "stored" && !m.getString("offsite_at"));
    // The entry's text and history live in the database snapshot: a verified backup must have
    // finished after the entry was trashed, so a snapshot certainly contains it.
    const inBackup = goodAt > dateMs(e.getString("deleted_at"));
    if (unprotected.length || !inBackup) {
      report.blocked.push({ entry: e.id, reason: unprotected.length ? unprotected.length + " file(s) not in a verified backup yet" : "no verified backup since it was trashed" });
      continue;
    }
    doomedEntries[e.id] = true;
    report.entries.push({ id: e.id, journal: e.getString("journal"), title: e.getString("title"), deleted_at: e.getString("deleted_at"), media: media.length });
  }
  for (const m of app.findRecordsByFilter("media", "deleted_at != '' && deleted_at < {:c}", "", 0, 0, { c: cutoff })) {
    if (doomedEntries[m.getString("entry")]) continue; // goes with its entry
    if (m.getString("status") === "stored" && !m.getString("offsite_at")) {
      report.blocked.push({ media: m.id, reason: "not in a verified backup yet" });
      continue;
    }
    report.media.push({ id: m.id, entry: m.getString("entry"), journal: m.getString("journal"), deleted_at: m.getString("deleted_at") });
  }

  if (dryRun) return report;
  for (const e of report.entries) {
    app.delete(app.findRecordById("entries", e.id)); // cascades to versions, media rows, originals and their files
    const l = require(`${__hooks}/lib.js`);
    l.audit(app, e.journal, null, "entry_purged", e.id, { title: e.title, media: e.media });
  }
  for (const m of report.media) {
    try {
      app.delete(app.findRecordById("media", m.id));
      require(`${__hooks}/lib.js`).audit(app, m.journal, null, "media_purged", m.id, {});
    } catch (_) {}
  }
  return report;
}

// --------------------------------------------------------------- reconcile
function listDir(path) {
  try { return $os.readDir(path); } catch (_) { return []; }
}
function statSize(path) {
  try { return $os.stat(path).size(); } catch (_) { return -1; }
}

// Checks that every stored original has its file with the right size and checksum, that derived
// copies exist (regenerating them if asked), and reports files nothing refers to (moving them
// to a review folder, never deleting). `sample` is the fraction of files whose checksum is
// recomputed (1 = all); sizes and presence are always checked for every file.
function reconcile(app, opts) {
  const ml = require(`${__hooks}/media_lib.js`);
  const dryRun = opts.dryRun !== false;
  const sample = opts.sample === undefined ? 1 : opts.sample;
  const storage = $filepath.join($app.dataDir(), "storage");
  const report = {
    dry_run: dryRun, sample: sample, checked: 0, hashed: 0,
    missing: [], size_mismatch: [], checksum_mismatch: [], derived_missing: [], regenerated: [], orphans: [], moved: [],
  };
  const origColl = app.findCollectionByNameOrId("media_originals");
  const mediaColl = app.findCollectionByNameOrId("media");

  const knownOrig = {};
  for (const o of app.findRecordsByFilter("media_originals", "id != ''", "", 0, 0)) {
    knownOrig[o.id] = o.getString("file");
    let media;
    try { media = app.findRecordById("media", o.getString("media")); } catch (_) { continue; }
    if (media.getString("status") !== "stored") continue;
    report.checked++;
    const p = ml.storagePath(o, "file");
    const size = statSize(p);
    if (size < 0) { report.missing.push({ media: media.id, original: o.id, file: o.getString("file") }); continue; }
    if (size !== o.getInt("size")) { report.size_mismatch.push({ media: media.id, original: o.id, expected: o.getInt("size"), actual: size }); continue; }
    if (sample >= 1 || Math.random() < sample) {
      report.hashed++;
      const sha = ml.sha256File(p);
      if (sha !== o.getString("sha256")) report.checksum_mismatch.push({ media: media.id, original: o.id, expected: o.getString("sha256"), actual: sha });
    }
  }

  const knownMedia = {};
  for (const m of app.findRecordsByFilter("media", "id != ''", "", 0, 0)) {
    knownMedia[m.id] = m;
    if (m.getString("status") !== "stored" || m.getString("derive_status") !== "ready") continue;
    const gone = ["display", "poster", "playback"].filter((f) => m.getString(f) && statSize(ml.storagePath(m, f)) < 0);
    if (!gone.length) continue;
    report.derived_missing.push({ media: m.id, fields: gone });
    if (!dryRun && opts.regenerate) {
      for (const f of gone) m.set(f, null);
      m.set("derive_status", "pending");
      app.save(m);
      if (ml.deriveMedia(app, m.id)) report.regenerated.push(m.id);
    }
  }

  // Files nothing refers to.
  const review = $filepath.join($app.dataDir(), "review");
  const scan = (coll, known, fileOf) => {
    const base = $filepath.join(storage, coll.id);
    for (const d of listDir(base)) {
      const rel = coll.id + "/" + d.name();
      if (!d.isDir()) { report.orphans.push(rel); continue; }
      if (!known[d.name()]) { report.orphans.push(rel + "/"); continue; }
      const names = fileOf(d.name());
      for (const f of listDir($filepath.join(base, d.name()))) {
        const n = f.name();
        if (f.isDir() && n.indexOf("thumbs_") === 0) continue; // PocketBase's own thumbnail cache
        const bare = n.slice(-6) === ".attrs" ? n.slice(0, -6) : n; // PocketBase keeps a sidecar per file
        if (names.indexOf(bare) !== -1) continue;
        report.orphans.push(rel + "/" + n);
      }
    }
  };
  scan(origColl, knownOrig, (id) => [knownOrig[id]]);
  scan(mediaColl, knownMedia, (id) => ["display", "poster", "playback"].map((f) => knownMedia[id].getString(f)).filter(Boolean));

  if (!dryRun && opts.moveOrphans) {
    for (const rel of report.orphans) {
      const from = $filepath.join(storage, rel);
      const to = $filepath.join(review, rel);
      try {
        $os.mkdirAll($filepath.dir(to.replace(/\/$/, "")), 0o755);
        $os.rename(from.replace(/\/$/, ""), to.replace(/\/$/, ""));
        report.moved.push(rel);
      } catch (err) { report.moved.push(rel + " (failed: " + String(err).slice(0, 80) + ")"); }
    }
  }
  report.ok = !report.missing.length && !report.size_mismatch.length && !report.checksum_mismatch.length && !report.derived_missing.length;
  return report;
}

module.exports = { lockPath, lockActive, alert, lastGoodBackup, purgeTrash, reconcile, PURGE_AFTER_DAYS };
