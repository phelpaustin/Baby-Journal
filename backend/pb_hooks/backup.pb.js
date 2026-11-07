/// <reference path="../pb_data/types.d.ts" />
//
// Backup bookkeeping (architecture v7, sections 6.9 and 9).
// The nightly backup job (a superuser) does three separate things, in this order, and only the
// last two happen after the snapshot has been verified:
//   1. take a snapshot and verify it           (no server call)
//   2. POST /api/bj/backup/mark                (flags exactly the files the snapshot holds)
//   3. POST /api/bj/backup/record              (the run report that drives the status levels)
// A job that dies before step 2 therefore protects nothing.

routerAdd("POST", "/api/bj/backup/mark", (e) => {
  const b = e.requestInfo().body || {};
  const ids = Array.isArray(b.media_ids) ? b.media_ids : null;
  const finished = Date.parse(String(b.finished_at || ""));
  const snapshot = String(b.snapshot_id || "").slice(0, 100);
  if (!ids || ids.length === 0 || ids.length > 1000) throw new BadRequestError("media_ids must list 1 to 1000 ids.");
  if (!snapshot) throw new BadRequestError("snapshot_id is required.");
  if (isNaN(finished)) throw new BadRequestError("finished_at must be a valid date.");

  let marked = 0, skipped = 0;
  $app.runInTransaction((tx) => {
    for (const id of ids) {
      let m;
      try { m = tx.findRecordById("media", String(id)); } catch (_) { skipped++; continue; }
      if (m.getString("status") !== "stored") { skipped++; continue; } // a row that is not stored is never protected
      m.set("offsite_at", new Date(finished).toISOString());
      m.set("offsite_snapshot", snapshot);
      tx.save(m);
      marked++;
    }
  });
  return e.json(200, { marked: marked, skipped: skipped });
}, $apis.requireSuperuserAuth());

routerAdd("POST", "/api/bj/backup/record", (e) => {
  const b = e.requestInfo().body || {};
  const result = String(b.result || "");
  const verification = String(b.verification_result || "skipped");
  const started = Date.parse(String(b.started_at || ""));
  const finished = Date.parse(String(b.finished_at || ""));
  if (["ok", "failed"].indexOf(result) === -1 || ["ok", "failed", "skipped"].indexOf(verification) === -1) {
    throw new BadRequestError("result and verification_result are invalid.");
  }
  if (isNaN(started) || isNaN(finished) || finished < started) throw new BadRequestError("started_at and finished_at must be valid dates.");

  const run = new Record($app.findCollectionByNameOrId("backup_runs"));
  run.set("snapshot_id", String(b.snapshot_id || "").slice(0, 100));
  run.set("started_at", new Date(started).toISOString());
  run.set("finished_at", new Date(finished).toISOString());
  run.set("result", result);
  run.set("verification_result", verification);
  run.set("file_count", Number(b.file_count) || 0);
  run.set("bytes", Number(b.bytes) || 0);
  $app.save(run);
  return e.json(200, { ok: true });
}, $apis.requireSuperuserAuth());

// For the app: time of the last good offsite backup and the resulting level.
// ok < 18 h <= warning < 24 h <= critical. Never a stale green status.
routerAdd("GET", "/api/bj/backup/status", (e) => {
  const goods = $app.findRecordsByFilter("backup_runs", "result = 'ok' && verification_result = 'ok'", "-finished_at", 1, 0);
  const last = goods.length ? goods[0] : null;
  let level = "critical", hours = null, lastAt = "";
  if (last) {
    lastAt = last.getString("finished_at");
    hours = (Date.now() - Date.parse(lastAt.replace(" ", "T"))) / 3600000;
    level = hours >= 24 ? "critical" : hours >= 18 ? "warning" : "ok";
  }
  // Only media of journals this person belongs to.
  const pending = $app.countRecords("media", $dbx.exp(
    "status = 'stored' AND offsite_at = '' AND journal IN (SELECT journal FROM members WHERE user = {:u})", { u: e.auth.id }));
  return e.json(200, { level: level, last_good_at: lastAt, hours_since: hours, media_not_offsite: pending });
}, $apis.requireAuth("users"));
