/// <reference path="../pb_data/types.d.ts" />
//
// Media pipeline (architecture v7, section 6).
//
// Upload = one multipart request: journal, entry, client_id, kind, sha256, size, file
// (+ optional caption, sort_order, taken_at). The server never trusts the client for
// anything that protects viewers: it re-hashes the stored file, sniffs the real content
// type, and builds its own metadata-stripped display / playback / poster copies.
// A row becomes "stored" only after size and SHA-256 match; anything else is deleted.

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB per file (section 14 default)

routerAdd("POST", "/api/bj/media/upload", (e) => {
  try {
    return (function (e) {
  const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // handlers are isolated: no access to top-level constants
  const lib = require(`${__hooks}/lib.js`);
  const ml = require(`${__hooks}/media_lib.js`);
  const b = e.requestInfo().body || {};
  const journalId = String(b.journal || "");
  const entryId = String(b.entry || "");
  const clientId = String(b.client_id || "");
  const kind = String(b.kind || "");
  const wantSha = String(b.sha256 || "").toLowerCase();
  const wantSize = Number(b.size);

  lib.requireRole($app, journalId, e.auth.id, ["owner", "editor"]);
  if (clientId.length < 8 || clientId.length > 64) throw new BadRequestError("client_id must be 8 to 64 characters.");
  if (kind !== "image" && kind !== "video") throw new BadRequestError("kind must be image or video.");
  if (!/^[0-9a-f]{64}$/.test(wantSha)) throw new BadRequestError("sha256 must be 64 hex characters.");
  if (!Number.isInteger(wantSize) || wantSize <= 0 || wantSize > MAX_UPLOAD_BYTES) {
    throw new BadRequestError("size is missing or above the 5 GB limit.");
  }
  const files = e.findUploadedFiles("file");
  if (files.length !== 1) throw new BadRequestError("Exactly one file is required.");

  let entry;
  try { entry = $app.findRecordById("entries", entryId); } catch (_) { throw new NotFoundError("Entry not found."); }
  if (entry.getString("journal") !== journalId) throw new NotFoundError("Entry not found.");
  if (entry.getString("deleted_at")) throw new ApiError(409, "That entry is in the trash.", {});

  // Idempotent retry: a verified item is returned as it is. A leftover half-done
  // upload (status "uploading") is removed before starting again.
  try {
    const prev = $app.findFirstRecordByFilter("media", "journal = {:j} && client_id = {:c}", { j: journalId, c: clientId });
    if (prev.getString("status") === "stored") {
      const o = $app.findFirstRecordByFilter("media_originals", "media = {:m}", { m: prev.id });
      if (o.getString("sha256") === wantSha) return e.json(200, { replay: true, media: prev });
      throw new ApiError(409, "That media ID already holds a different file.", {});
    }
    $app.delete(prev);
  } catch (err) {
    if (err instanceof ApiError) throw err;
  }

  const limit = parseInt($os.getenv("BJ_DISK_REFUSE_PCT") || "90", 10);
  if (ml.diskUsedPercent() >= limit) {
    throw new ApiError(507, "The server is almost out of disk space. Keep the local copy and try again later.", {});
  }

  const sortOrder = b.sort_order !== undefined && b.sort_order !== "" ? parseInt(b.sort_order, 10) : 0;
  const caption = typeof b.caption === "string" ? b.caption.slice(0, 1000) : "";

  const media = new Record($app.findCollectionByNameOrId("media"));
  media.set("entry", entryId);
  media.set("journal", journalId);
  media.set("client_id", clientId);
  media.set("kind", kind);
  media.set("status", "uploading");
  media.set("derive_status", "pending");
  media.set("caption", caption);
  media.set("sort_order", isNaN(sortOrder) ? 0 : sortOrder);
  $app.save(media);

  const fail = (code, msg) => {
    try { $app.delete(media); } catch (_) {} // cascades to the original and its file
    throw new ApiError(code, msg, {});
  };

  let orig;
  try {
    orig = new Record($app.findCollectionByNameOrId("media_originals"));
    orig.set("media", media.id);
    orig.set("journal", journalId);
    orig.set("original_name", String(files[0].originalName || "").slice(0, 300));
    orig.set("file", files[0]);
    $app.save(orig);
  } catch (err) {
    fail(400, "The file could not be stored.");
  }

  // Verify what is actually on disk.
  const path = ml.storagePath(orig, "file");
  let gotSha, gotSize, mime, meta;
  try {
    gotSize = $os.stat(path).size();
    gotSha = ml.sha256File(path);
    mime = ml.sniffMime(path);
  } catch (err) {
    fail(422, "The file could not be read back for verification.");
  }
  if (gotSize !== wantSize || gotSha !== wantSha) {
    fail(422, "The file did not arrive intact (size or checksum mismatch). Nothing was stored; try again.");
  }
  if (ml.ALLOWED[mime] !== kind) {
    fail(422, "Unsupported file type: " + mime + ".");
  }
  try { meta = ml.exifJSON(path); } catch (_) { meta = {}; }

  orig.set("mime", mime);
  orig.set("size", gotSize);
  orig.set("sha256", gotSha);
  const metaStr = JSON.stringify(meta);
  orig.set("metadata", metaStr.length < 190000 ? meta : {});
  $app.save(orig);

  // Capture date: the client's value, else the file's own; never the upload time.
  let taken = "";
  if (b.taken_at) {
    const t = Date.parse(String(b.taken_at));
    if (!isNaN(t)) taken = new Date(t).toISOString();
  }
  if (!taken) taken = ml.exifDate(ml.pick(meta, ["DateTimeOriginal", "CreateDate", "CreationDate", "MediaCreateDate"]));
  if (taken) media.set("taken_at", taken);
  const w = Number(b.width), h = Number(b.height);
  if (w > 0 && h > 0) { media.set("width", Math.round(w)); media.set("height", Math.round(h)); }

  media.set("status", "stored"); // only now: size and SHA-256 matched
  $app.save(media);
  lib.audit($app, journalId, e.auth.id, "media_uploaded", media.id, { kind: kind, size: gotSize });

  ml.deriveMedia($app, media.id); // failure is recorded on the row; the original is already safe
  return e.json(200, { replay: false, media: $app.findRecordById("media", media.id) });
    })(e);
  } catch (err) {
    // PocketBase turns unexpected script errors into a bare 400. Log the cause for operators.
    // Script bugs are JS Error objects; PocketBase API errors (403, 404, 422 ...) are not.
    const isApi = !(err instanceof Error) || /unexpected EOF|connection reset|broken pipe/i.test(String(err)); // aborted uploads are expected
    if (!isApi) {
      console.log("media upload failed unexpectedly:", String(err), String(err && err.stack));
      $app.logger().error("media upload failed unexpectedly", "error", String(err));
    }
    throw err;
  }
}, $apis.requireAuth("users"), $apis.bodyLimit(MAX_UPLOAD_BYTES + 16 * 1024 * 1024));

// Captions, order and the displayed capture date (F13), plus per-item trash/restore.
// The original file and its extracted metadata are never modified.
routerAdd("POST", "/api/bj/media/update", (e) => {
  const lib = require(`${__hooks}/lib.js`);
  const b = e.requestInfo().body || {};
  let media;
  try { media = $app.findRecordById("media", String(b.id || "")); } catch (_) { throw new NotFoundError("Media not found."); }
  lib.requireRole($app, media.getString("journal"), e.auth.id, ["owner", "editor"]);

  if (b.caption !== undefined) {
    if (typeof b.caption !== "string" || b.caption.length > 1000) throw new BadRequestError("Invalid caption.");
    media.set("caption", b.caption);
  }
  if (b.sort_order !== undefined) {
    if (!Number.isInteger(b.sort_order)) throw new BadRequestError("sort_order must be an integer.");
    media.set("sort_order", b.sort_order);
  }
  if (b.taken_at !== undefined) {
    if (b.taken_at === "" || b.taken_at === null) media.set("taken_at", "");
    else {
      const t = Date.parse(String(b.taken_at));
      if (isNaN(t)) throw new BadRequestError("taken_at must be a valid date.");
      media.set("taken_at", new Date(t).toISOString());
    }
  }
  if (b.op === "trash") media.set("deleted_at", new Date().toISOString());
  else if (b.op === "restore") media.set("deleted_at", "");
  else if (b.op !== undefined) throw new BadRequestError("Unknown op.");
  $app.save(media);
  lib.audit($app, media.getString("journal"), e.auth.id, "media_updated", media.id, { fields: Object.keys(b).filter((k) => k !== "id") });
  return e.json(200, { media: media });
}, $apis.requireAuth("users"));

// Retry failed or pending derivations (for example after ffmpeg was missing or a restore).
cronAdd("bj_derive_retry", "*/5 * * * *", () => {
  const ml = require(`${__hooks}/media_lib.js`);
  const rows = $app.findRecordsByFilter("media", "status = 'stored' && derive_status != 'ready'", "updated", 3, 0);
  for (const m of rows) ml.deriveMedia($app, m.id);
});

// Uploads that never completed leave an "uploading" row. Remove them after a day.
cronAdd("bj_stale_uploads", "17 * * * *", () => {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace("T", " ");
  const rows = $app.findRecordsByFilter("media", "status = 'uploading' && created < {:c}", "", 50, 0, { c: cutoff });
  for (const m of rows) $app.delete(m);
});
