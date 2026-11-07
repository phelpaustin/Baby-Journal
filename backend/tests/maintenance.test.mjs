// Maintenance tests (architecture v7, sections 6.7 and 9): purge only after a verified backup,
// lock handling, dry runs, and the reconcile/integrity job.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.PB_URL || "http://127.0.0.1:8099";
const DATA = process.env.PB_TEST_DIR || "/tmp/pbtest";
const PASSWORD = "correct-horse-battery";
const rid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const DAY = 86400000;
const pbDate = (ms) => new Date(ms).toISOString().replace("T", " ");

async function api(method, path, { token, body, form } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(form ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: token } : {}) },
    body: form ? form : body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

let admin, owner, editor, journal;
const dir = mkdtempSync(join(tmpdir(), "bj-maint-"));
let jpeg;

const adminPatch = (col, id, body) => api("PATCH", `/api/collections/${col}/records/${id}`, { token: admin, body });
const adminGet = (col, id) => api("GET", `/api/collections/${col}/records/${id}`, { token: admin });
const purge = (body = {}) => api("POST", "/api/bj/maintenance/purge", { token: admin, body });
const reconcile = (body = {}) => api("POST", "/api/bj/maintenance/reconcile", { token: admin, body });

async function mkUser(name) {
  const email = `${name}-${rid()}@test.local`;
  const u = await api("POST", "/api/collections/users/records", { token: admin, body: { email, password: PASSWORD, passwordConfirm: PASSWORD, name, verified: true } });
  const l = await api("POST", "/api/collections/users/auth-with-password", { body: { identity: email, password: PASSWORD } });
  return { id: u.data.id, token: l.data.token };
}
async function newEntry(title) {
  const cid = "e-" + rid();
  const r = await api("POST", "/api/bj/entries/sync", { token: editor.token, body: { journal: journal.id, client_id: cid, idempotency_key: "k-" + rid(), op: "upsert", base_revision: 0,
    fields: { event_date: "2026-10-18", type: "memory", title, text: "", milestones: [], values: {} } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { cid, entry: r.data.entry };
}
async function addPhoto(entry, salt = "") {
  const bytes = Buffer.concat([jpeg, Buffer.from(salt || rid())]);
  const f = new FormData();
  for (const [k, v] of Object.entries({ journal: journal.id, entry: entry.id, client_id: "m-" + rid(), kind: "image", sha256: sha(bytes), size: String(bytes.length) })) f.append(k, v);
  f.append("file", new Blob([bytes], { type: "image/jpeg" }), "IMG.JPG");
  const r = await api("POST", "/api/bj/media/upload", { token: editor.token, form: f });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const orig = (await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${r.data.media.id}"`)}`, { token: admin })).data.items[0];
  return { media: r.data.media, orig, bytes };
}
const trash = (cid, base) => api("POST", "/api/bj/entries/sync", { token: editor.token, body: { journal: journal.id, client_id: cid, idempotency_key: "k-" + rid(), op: "trash", base_revision: base } });
const storageDir = (collectionId, id) => join(DATA, "storage", collectionId, id);
const clearRuns = async () => {
  for (const r of (await api("GET", "/api/collections/backup_runs/records?perPage=200", { token: admin })).data.items) await api("DELETE", `/api/collections/backup_runs/records/${r.id}`, { token: admin });
};
const goodRun = (finishedMs = Date.now()) => api("POST", "/api/bj/backup/record", { token: admin, body: { snapshot_id: "snap", result: "ok", verification_result: "ok", started_at: new Date(finishedMs - 60000).toISOString(), finished_at: new Date(finishedMs).toISOString() } });
const lockFile = join(DATA, ".maintenance.lock");

before(async () => {
  const r = await api("POST", "/api/collections/_superusers/auth-with-password", { body: { identity: "admin@test.local", password: "test-admin-password-1" } });
  admin = r.data.token;
  owner = await mkUser("mowner"); editor = await mkUser("meditor");
  journal = (await api("POST", "/api/collections/journals/records", { token: admin, body: { name: "Maintenance journal" } })).data;
  for (const [u, role] of [[owner, "owner"], [editor, "editor"]]) await api("POST", "/api/collections/members/records", { token: admin, body: { journal: journal.id, user: u.id, role } });
  sh("convert", ["-size", "320x240", "gradient:red-blue", join(dir, "p.jpg")]);
  jpeg = readFileSync(join(dir, "p.jpg"));
  rmSync(lockFile, { force: true });
});

describe("access", () => {
  test("maintenance routes are for the superuser only", async () => {
    for (const who of [owner, editor]) {
      for (const path of ["/api/bj/maintenance/purge", "/api/bj/maintenance/reconcile"]) {
        const r = await api("POST", path, { token: who.token, body: {} });
        assert.ok([401, 403].includes(r.status), path + " " + r.status);
      }
    }
    assert.ok([401, 403].includes((await api("POST", "/api/bj/maintenance/purge", { body: {} })).status));
  });
});

describe("trash purge: only after a verified backup holds the data", () => {
  let A, B, C, mediaOnly;

  before(async () => {
    await clearRuns();
    A = await newEntry("Entry A (has a photo)"); A.photo = await addPhoto(A.entry);
    B = await newEntry("Entry B (has a photo)"); B.photo = await addPhoto(B.entry);
    C = await newEntry("Entry C (text only)");
    mediaOnly = await newEntry("Entry D (live, one photo trashed alone)"); mediaOnly.photo = await addPhoto(mediaOnly.entry);
    for (const x of [A, B, C]) {
      const t = await trash(x.cid, 1);
      assert.equal(t.status, 200);
    }
    // make them 31 days old (entries and their media were trashed together)
    const old = pbDate(Date.now() - 31 * DAY);
    for (const x of [A, B, C]) await adminPatch("entries", x.entry.id, { deleted_at: old });
    for (const x of [A, B]) await adminPatch("media", x.photo.media.id, { deleted_at: old });
    await api("POST", "/api/bj/media/update", { token: editor.token, body: { id: mediaOnly.photo.media.id, op: "trash" } });
    await adminPatch("media", mediaOnly.photo.media.id, { deleted_at: old });
  });

  test("with no verified backup at all, nothing is purged (even for real)", async () => {
    const r = await purge({ dry_run: false });
    assert.equal(r.status, 200);
    assert.match(r.data.skipped, /no verified backup/);
    assert.equal((await adminGet("entries", A.entry.id)).status, 200);
    assert.ok(existsSync(storageDir(A.photo.orig.collectionId, A.photo.orig.id)));
  });

  test("the default is a dry run that lists what would go and what is blocked, and changes nothing", async () => {
    await goodRun();
    const r = await purge(); // no dry_run field: must default to a dry run
    assert.equal(r.data.dry_run, true);
    const ids = r.data.entries.map((e) => e.id);
    assert.ok(ids.includes(C.entry.id), "the text-only entry is eligible");
    assert.ok(!ids.includes(A.entry.id) && !ids.includes(B.entry.id), "entries whose files are not offsite are not eligible");
    const blocked = r.data.blocked.map((b) => b.entry || b.media);
    assert.ok(blocked.includes(A.entry.id) && blocked.includes(B.entry.id));
    assert.ok(blocked.includes(mediaOnly.photo.media.id), "an unprotected photo trashed on its own is blocked too");
    assert.equal((await adminGet("entries", C.entry.id)).status, 200, "a dry run deletes nothing");
  });

  test("a recently trashed entry (5 days) is never touched", async () => {
    const fresh = await newEntry("Fresh trash");
    await trash(fresh.cid, 1);
    await adminPatch("entries", fresh.entry.id, { deleted_at: pbDate(Date.now() - 5 * DAY) });
    const r = await purge();
    assert.ok(!r.data.entries.some((e) => e.id === fresh.entry.id));
    assert.ok(!r.data.blocked.some((b) => b.entry === fresh.entry.id));
  });

  test("once a file is in a verified snapshot (marked offsite) its entry can be purged, files and all; others stay", async () => {
    await api("POST", "/api/bj/backup/mark", { token: admin, body: { snapshot_id: "snap", finished_at: new Date().toISOString(), media_ids: [A.photo.media.id, mediaOnly.photo.media.id] } });
    await goodRun();
    const dry = await purge();
    const ids = dry.data.entries.map((e) => e.id);
    assert.deepEqual(ids.sort(), [A.entry.id, C.entry.id].sort());
    assert.deepEqual(dry.data.media.map((m) => m.id), [mediaOnly.photo.media.id]);

    const live = await purge({ dry_run: false });
    assert.equal(live.status, 200);
    assert.equal((await adminGet("entries", A.entry.id)).status, 404);
    assert.equal((await adminGet("entries", C.entry.id)).status, 404);
    assert.equal((await adminGet("media", A.photo.media.id)).status, 404);
    assert.equal((await adminGet("media_originals", A.photo.orig.id)).status, 404);
    assert.ok(!existsSync(storageDir(A.photo.orig.collectionId, A.photo.orig.id)), "the original's file is gone with its row");
    // B is not protected, so it survives with its file
    assert.equal((await adminGet("entries", B.entry.id)).status, 200);
    assert.ok(existsSync(storageDir(B.photo.orig.collectionId, B.photo.orig.id)));
    // the photo trashed on its own went; its live entry stayed
    assert.equal((await adminGet("media", mediaOnly.photo.media.id)).status, 404);
    assert.equal((await adminGet("entries", mediaOnly.entry.id)).status, 200);
    const audit = await api("GET", `/api/collections/audit_log/records?filter=${encodeURIComponent(`journal="${journal.id}" && action="entry_purged"`)}`, { token: admin });
    assert.ok(audit.data.totalItems >= 2, "purges are written to the audit log");
  });

  test("a backup that is more than 48 hours old is not good enough", async () => {
    await clearRuns();
    await goodRun(Date.now() - 49 * 3600000);
    const r = await purge({ dry_run: false });
    assert.match(r.data.skipped, /older than 48 hours/);
    assert.equal((await adminGet("entries", B.entry.id)).status, 200);
  });
});

describe("the maintenance lock", () => {
  let target;
  before(async () => {
    await clearRuns();
    target = await newEntry("Lock test");
    await trash(target.cid, 1);
    await adminPatch("entries", target.entry.id, { deleted_at: pbDate(Date.now() - 31 * DAY) });
    await goodRun();
  });

  test("while a live backup holds the lock, the purge waits; the lock of a dead or ancient process is ignored", async () => {
    const sleeper = spawn("sleep", ["60"]);
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: sleeper.pid, started: Date.now() }));
      const held = await purge({ dry_run: false });
      assert.match(held.data.skipped, /backup is running/);
      assert.equal((await adminGet("entries", target.entry.id)).status, 200);

      writeFileSync(lockFile, JSON.stringify({ pid: sleeper.pid, started: Date.now() - 7 * 3600000 }));
      assert.equal((await purge()).data.skipped, "", "a lock older than 6 hours is stale");
      sleeper.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 300));
      writeFileSync(lockFile, JSON.stringify({ pid: sleeper.pid, started: Date.now() }));
      assert.equal((await purge()).data.skipped, "", "a crashed backup (dead process) must not block the purge forever");
      writeFileSync(lockFile, "not json");
      assert.match((await purge()).data.skipped, /backup is running/, "an unreadable lock is treated as busy");
    } finally {
      sleeper.kill("SIGKILL");
      rmSync(lockFile, { force: true });
    }
    assert.equal((await purge({ dry_run: false })).data.entries.length >= 1, true);
  });
});

describe("reconcile and the integrity check", () => {
  let p1, p2, p3, p4;
  before(async () => {
    const e = await newEntry("Reconcile");
    p1 = await addPhoto(e.entry); p2 = await addPhoto(e.entry); p3 = await addPhoto(e.entry); p4 = await addPhoto(e.entry);
  });

  test("a healthy store reconciles clean", async () => {
    const r = await reconcile();
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ok, true, JSON.stringify(r.data));
    assert.ok(r.data.checked >= 4);
    assert.equal(r.data.hashed, r.data.checked);
    assert.deepEqual([r.data.missing, r.data.size_mismatch, r.data.checksum_mismatch, r.data.orphans], [[], [], [], []]);
  });

  test("a missing file, a wrong-size file and a same-size corrupted file are each reported", async () => {
    const f = (p) => join(storageDir(p.orig.collectionId, p.orig.id), p.orig.file);
    const keep = { p2: readFileSync(f(p2)), p3: readFileSync(f(p3)), p4: readFileSync(f(p4)) };
    rmSync(f(p1));
    appendFileSync(f(p2), "extra");
    const c = Buffer.from(keep.p3); c[200] ^= 0xff; writeFileSync(f(p3), c);

    const full = (await reconcile()).data;
    assert.equal(full.ok, false);
    assert.deepEqual(full.missing.map((x) => x.original), [p1.orig.id]);
    assert.deepEqual(full.size_mismatch.map((x) => x.original), [p2.orig.id]);
    assert.deepEqual(full.checksum_mismatch.map((x) => x.original), [p3.orig.id]);
    assert.equal(full.checksum_mismatch[0].expected, p3.orig.sha256);

    const sizesOnly = (await reconcile({ sample: 0 })).data;
    assert.equal(sizesOnly.hashed, 0);
    assert.equal(sizesOnly.missing.length, 1);
    assert.equal(sizesOnly.size_mismatch.length, 1);
    assert.equal(sizesOnly.checksum_mismatch.length, 0, "with no hashing, a same-size corruption is not seen (that is what the sample is for)");

    // put the files back so later tests start clean
    writeFileSync(f(p1), p1.bytes); writeFileSync(f(p2), keep.p2); writeFileSync(f(p3), keep.p3);
    assert.equal((await reconcile()).data.ok, true);
  });

  test("a missing derived copy is reported, and regenerated on request", async () => {
    const m = (await adminGet("media", p4.media.id)).data;
    const displayPath = join(storageDir(m.collectionId, m.id), m.display);
    rmSync(displayPath);
    const dry = (await reconcile()).data;
    assert.equal(dry.derived_missing.length, 1);
    assert.deepEqual(dry.derived_missing[0].fields, ["display"]);
    assert.equal(existsSync(displayPath), false, "a dry run regenerates nothing");
    const fix = (await reconcile({ dry_run: false, regenerate: true })).data;
    assert.deepEqual(fix.regenerated, [p4.media.id]);
    const after = (await adminGet("media", p4.media.id)).data;
    assert.equal(after.derive_status, "ready");
    assert.ok(existsSync(join(storageDir(after.collectionId, after.id), after.display)));
    assert.equal((await reconcile()).data.ok, true);
  });

  test("files nothing refers to are moved to a review folder, never deleted", async () => {
    const stray = join(DATA, "storage", p1.orig.collectionId, "strayrecord0001");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "lost-video.mp4"), "irreplaceable bytes");
    const extra = join(storageDir(p1.orig.collectionId, p1.orig.id), "leftover.tmp");
    writeFileSync(extra, "leftover");

    const dry = (await reconcile()).data;
    assert.ok(dry.orphans.some((o) => o.endsWith("strayrecord0001/")), JSON.stringify(dry.orphans));
    assert.ok(dry.orphans.some((o) => o.endsWith("leftover.tmp")));
    assert.ok(existsSync(join(stray, "lost-video.mp4")), "a dry run moves nothing");

    const moved = (await reconcile({ dry_run: false, move_orphans: true })).data;
    assert.ok(moved.moved.length >= 2, JSON.stringify(moved.moved));
    assert.ok(!existsSync(stray));
    assert.equal(readFileSync(join(DATA, "review", p1.orig.collectionId, "strayrecord0001", "lost-video.mp4"), "utf8"), "irreplaceable bytes");
    assert.ok(existsSync(join(DATA, "review", p1.orig.collectionId, p1.orig.id, "leftover.tmp")));
    assert.equal((await reconcile()).data.orphans.length, 0);
  });
});
