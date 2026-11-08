// Migration tests (architecture v7, build step 6): a synthetic Firestore export with awkward cases goes
// through adapter -> check -> run (interrupted, resumed, repeated) -> reconcile, and damage is caught.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const E = process.env;
const PB_URL = E.PB_URL;
const ADAPTER = join(E.OPS_DIR, "bj_firestore_adapter.py"), IMPORTER = join(E.OPS_DIR, "bj_import.py");
const PASSWORD = "correct-horse-battery";
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const W = mkdtempSync(join(tmpdir(), "bj-imp-"));
const group = (name, fn) => (!E.ONLY || new RegExp(E.ONLY, "i").test(name) ? describe(name, fn) : describe.skip(name, fn));

async function api(method, path, { token, body } = {}) {
  const res = await fetch(PB_URL + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

let admin, wife, husband, journalName, bundle, env;
const run = (script, args, extra = {}) => spawnSync("python3", [script, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
const imp = (...args) => run(IMPORTER, args.map(String));
const listEntries = async () => (await api("GET", `/api/collections/entries/records?perPage=200&filter=${encodeURIComponent(`client_id~"imp-"`)}`, { token: admin })).data;
const importerArgs = () => ["--journal-name", journalName, "--default-author", wife.email, "--add-members", "--create-journal"];

before(async () => {
  admin = (await api("POST", "/api/collections/_superusers/auth-with-password", { body: { identity: "admin@test.local", password: "test-admin-password-1" } })).data.token;
  const mk = async (name) => {
    const email = `${name}-${rid()}@test.local`;
    const u = await api("POST", "/api/collections/users/records", { token: admin, body: { email, password: PASSWORD, passwordConfirm: PASSWORD, name, verified: true } });
    return { id: u.data.id, email };
  };
  wife = await mk("wife"); husband = await mk("husband");
  journalName = "Imported " + rid();
  env = { ...process.env, BJ_PB_URL: PB_URL, BJ_PB_SUPERUSER: "admin@test.local", BJ_PB_PASSWORD: "test-admin-password-1", BJ_IMPORT_USER: wife.email, BJ_IMPORT_PASSWORD: PASSWORD };

  // ---- the old app's data, as awkward as real data
  const drive = join(W, "drive-downloads"); mkdirSync(drive, { recursive: true });
  sh("convert", ["-size", "640x480", "gradient:pink-teal", "jpeg:" + join(drive, "d1")]);
  sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", join(drive, "d2")]);
  const ts = (iso) => ({ _seconds: Math.floor(Date.parse(iso) / 1000), _nanoseconds: 0 });
  const events = [
    { id: "e1", date: ts("2025-04-19T22:30:00Z"), category: "photo", title: "First smile", notes: "She smiled at Dad.", tags: ["First smile"], createdBy: "u-wife", createdAt: "2025-04-20T06:00:00Z", photos: [{ driveFileId: "d1", name: "IMG_0001.JPG", caption: "The smile", takenAt: ts("2025-04-19T22:29:00Z") }] },
    { id: "e2", date: "2025-07-01T10:00:00Z", category: "weight", title: "", notes: "", weightGrams: 6200, lengthCm: 64.5, createdBy: "u-husband", createdAt: ts("2025-07-01T10:05:00Z") },
    { id: "e3", date: Date.parse("2026-01-15T12:00:00Z"), category: "doctor", title: "Läkarbesök", notes: "Allt bra: åäö 🍼\nTvå rader.", tags: ["Custom thing"], createdBy: "u-grandma", createdAt: Date.parse("2026-01-15T15:00:00Z") },
    { id: "e4", date: { seconds: Math.floor(Date.parse("2026-02-02T09:00:00Z") / 1000) }, category: "photo", title: "Crawling video", createdBy: "u-wife", createdAt: "2026-02-02T09:30:00Z", photos: [{ driveFileId: "d2", name: "MOV_0007.mp4", type: "video/mp4" }] },
    { id: "e5", date: "2026-03-03T08:00:00Z", category: "mystery", title: "Moved to trash", createdBy: "u-wife", createdAt: "2026-03-03T08:30:00Z", deletedAt: "2026-04-01T00:00:00Z" },
    { id: "e6", date: "2026-04-04T08:00:00Z", category: "photo", title: "Lost photo", createdBy: "u-wife", createdAt: "2026-04-04T08:30:00Z", photos: [{ driveFileId: "d-missing", name: "GONE.JPG" }] },
  ];
  for (let i = 0; i < 24; i++) events.push({ id: "f" + i, date: `2026-0${1 + (i % 9)}-${String(1 + i).padStart(2, "0")}T10:00:00Z`, category: "note", title: "Filler " + i, notes: "Text " + i, createdBy: i % 2 ? "u-wife" : "u-husband", createdAt: "2026-05-01T10:00:00Z" });
  const users = [{ id: "u-wife", displayName: "Wife", email: wife.email.toUpperCase() }, { id: "u-husband", displayName: "Husband", email: husband.email }, { id: "u-grandma", displayName: "Grandma", email: "grandma@old.example" }];
  writeFileSync(join(W, "firestore.json"), JSON.stringify({ events, users }));
  const mapping = JSON.parse(readFileSync(join(E.OPS_DIR, "import-mapping.example.json"), "utf8"));
  mapping.journal.name = journalName;
  writeFileSync(join(W, "mapping.json"), JSON.stringify(mapping));
  bundle = join(W, "bundle");
});

group("import: adapter and check", () => {
  test("the example mapping is valid JSON with every section the adapter needs", () => {
    const m = JSON.parse(readFileSync(join(E.OPS_DIR, "import-mapping.example.json"), "utf8"));
    for (const k of ["timezone", "collections", "entry", "media_item", "type_map", "milestone_map", "values", "drive_dir"]) assert.ok(k in m, k);
  });

  test("the adapter converts everything, fixes time zones and units, and reports (never hides) what it could not map", () => {
    const r = run(ADAPTER, ["--export", join(W, "firestore.json"), "--mapping", join(W, "mapping.json"), "--out", bundle]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const entries = readFileSync(join(bundle, "entries.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(entries.length, 30, "no entry is dropped");
    const by = Object.fromEntries(entries.map((e) => [e.source_id, e]));
    assert.equal(by.e1.event_date, "2025-04-20", "22:30 UTC is already the 20th in Stockholm");
    assert.deepEqual(by.e1.milestones, ["first_smile"]);
    assert.deepEqual(by.e2.values, { weight_kg: 6.2, length_cm: 64.5 }, "grams become kilograms");
    assert.equal(by.e2.type, "growth");
    assert.equal(by.e3.event_date, "2026-01-15", "milliseconds are read correctly");
    assert.equal(by.e3.text, "Allt bra: åäö 🍼\nTvå rader.");
    assert.deepEqual(by.e3.milestones, ["custom_thing"]);
    assert.equal(by.e4.event_date, "2026-02-02");
    assert.equal(by.e5.type, "memory", "an unknown category falls back, with a warning");
    assert.ok(by.e5.deleted_at);
    assert.match(r.stdout, /unknown type 'mystery'/);
    assert.match(r.stdout, /milestone 'Custom thing' kept as 'custom_thing'/);
    assert.match(r.stdout, /d-missing.*not in the Drive download/);
    const media = readFileSync(join(bundle, "media.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(media.filter((m) => !m.missing).length, 2);
    assert.equal(media.filter((m) => m.missing).length, 1);
    const photo = media.find((m) => m.source_id === "d1");
    assert.equal(photo.sha256, sha(readFileSync(join(bundle, photo.path))));
    assert.equal(media.find((m) => m.source_id === "d2").kind_hint, "video");
  });

  test("check passes on the good bundle and reports counts by year and type", () => {
    const r = imp("check", bundle);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /30 entries \(1 trashed\), 2 media files/);
    assert.match(r.stdout, /by year: 2025: 2, 2026: 28/);
    assert.match(r.stdout, /ready to import/);
  });

  test("check refuses a damaged bundle and says exactly what is wrong, and run refuses it before touching the server", async () => {
    const bad = join(W, "bundle-bad"); rmSync(bad, { recursive: true, force: true }); cpSync(bundle, bad, { recursive: true });
    const lines = readFileSync(join(bad, "entries.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    lines[0].event_date = "20-04-2025";
    lines[1].values = { weight: 6.2 };
    lines[2].type = "party";
    writeFileSync(join(bad, "entries.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const media = readFileSync(join(bad, "media.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const m1 = media.find((m) => m.path); const f = join(bad, m1.path); const b = readFileSync(f); b[100] ^= 0xff; writeFileSync(f, b);
    const r = imp("check", bad);
    assert.equal(r.status, 1);
    for (const needle of [/event_date '20-04-2025'/, /needs a unit suffix/, /unknown type 'party'/, /checksum differs/]) assert.match(r.stderr, needle);
    // and `run` refuses it without touching the server
    const before = (await listEntries()).totalItems;
    const run_ = imp("run", bad, ...importerArgs());
    assert.equal(run_.status, 1);
    assert.match(run_.stderr, /run `check` first/);
    assert.equal((await listEntries()).totalItems, before);
  });
});
const authorsOf = (items) => Object.fromEntries(items.map((e) => [e.client_id, e.author]));
const cidOf = (sid) => "imp-" + createHash("sha1").update(sid).digest("hex").slice(0, 24);

group("import: run, resume, repeat, reconcile", () => {
  let journalId;

  test("an interrupted import leaves a clean partial state, and the next run completes it without duplicates", async () => {
    const r1 = run(IMPORTER, ["run", bundle, ...importerArgs()], { BJ_IMPORT_STOP_AFTER: "5" });
    assert.equal(r1.status, 3, r1.stdout + r1.stderr);
    assert.equal((await listEntries()).totalItems, 5, "exactly the entries done before the interruption");

    const r2 = imp("run", bundle, ...importerArgs());
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.match(r2.stdout, /entries: 25 created, 5 already there/);
    assert.match(r2.stdout, /media: 2 uploaded, 0 already there, 0 error/);
    const all = await listEntries();
    assert.equal(all.totalItems, 30, "30 entries, no duplicates");
    journalId = all.items[0].journal;
  });

  test("everything arrived as it was: authors, written-on times, trash, text, units, and the files byte for byte", async () => {
    const items = (await listEntries()).items;
    const byCid = Object.fromEntries(items.map((e) => [e.client_id, e]));
    const e1 = byCid[cidOf("e1")], e3 = byCid[cidOf("e3")], e5 = byCid[cidOf("e5")], e2 = byCid[cidOf("e2")];
    assert.equal(e1.author, wife.id, "matched by e-mail, even though the old e-mail was in capitals");
    assert.equal(byCid[cidOf("e2")].author, husband.id);
    assert.equal(e3.author, wife.id, "an author with no account goes to the default author, not nowhere");
    assert.equal(e1.created.slice(0, 19), "2025-04-20 06:00:00", "the written-on time is the original");
    assert.equal(e1.event_date, "2025-04-20");
    assert.equal(e3.text, "Allt bra: åäö 🍼\nTvå rader.");
    assert.deepEqual(e2.values, { weight_kg: 6.2, length_cm: 64.5 });
    assert.ok(e5.deleted_at, "the trashed entry is still in the trash");
    assert.deepEqual(e1.milestones, ["first_smile"]);
    const members = (await api("GET", `/api/collections/members/records?filter=${encodeURIComponent(`journal="${journalId}"`)}`, { token: admin })).data.items;
    assert.deepEqual(members.map((m) => m.user).sort(), [wife.id, husband.id].sort(), "the people who wrote entries were added to the journal");

    const media = (await api("GET", `/api/collections/media/records?filter=${encodeURIComponent(`journal="${journalId}"`)}&perPage=50`, { token: admin })).data.items;
    assert.equal(media.length, 2);
    for (const m of media) {
      assert.equal(m.status, "stored");
      assert.equal(m.derive_status, "ready", m.derive_error);
      const o = (await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${m.id}"`)}`, { token: admin })).data.items[0];
      const src = readFileSync(join(W, "drive-downloads", m.kind === "video" ? "d2" : "d1"));
      assert.equal(o.sha256, sha(src));
      assert.equal(o.size, src.length);
    }
    const photo = media.find((m) => m.kind === "image");
    assert.equal(photo.caption, "The smile");
    assert.equal(photo.taken_at.slice(0, 19), "2025-04-19 22:29:00");
    assert.equal(photo.entry, e1.id);
  });

  test("running it again does nothing: no new entries, no files re-uploaded", async () => {
    const r = imp("run", bundle, ...importerArgs());
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /entries: 0 created, 30 already there/);
    assert.match(r.stdout, /media: 0 uploaded, 2 already there/);
    assert.equal((await listEntries()).totalItems, 30);
  });

  test("reconcile proves it: counts, every field, every file checksum, and the one known gap is listed", () => {
    const r = imp("reconcile", bundle, "--journal-name", journalName, "--default-author", wife.email);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /source: 30 entries \(1 trashed\), 2 media files/);
    assert.match(r.stdout, /server: 30 imported entries, 2 imported media; 2 file checksums match/);
    assert.match(r.stdout, /gap: file missing from the Drive download: GONE\.JPG/);
    assert.match(r.stdout, /RECONCILED/);
    const rep = JSON.parse(readFileSync(join(bundle, "reconcile-report.json"), "utf8"));
    assert.deepEqual(rep.mismatches, []);
  });

  test("reconcile catches damage: a changed entry, a missing file and a wrong author are each reported; a repeat run repairs the file only", async () => {
    const items = (await listEntries()).items;
    const e4 = items.find((e) => e.client_id === cidOf("e4"));
    const e2 = items.find((e) => e.client_id === cidOf("e2"));
    await api("PATCH", `/api/collections/entries/records/${e4.id}`, { token: admin, body: { title: "Tampered title" } });
    await api("PATCH", `/api/collections/entries/records/${e2.id}`, { token: admin, body: { author: wife.id } });
    const vid = (await api("GET", `/api/collections/media/records?filter=${encodeURIComponent('client_id~"impm-" && kind="video"')}`, { token: admin })).data.items[0];
    assert.equal((await api("DELETE", `/api/collections/media/records/${vid.id}`, { token: admin })).status, 204);

    const r = imp("reconcile", bundle, "--journal-name", journalName, "--default-author", wife.email);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /MISMATCH: entry e4: title differs/);
    assert.match(r.stdout, /MISMATCH: entry e2: author differs/);
    assert.match(r.stdout, /MISMATCH: media d2 \(MOV_0007\.mp4\) is not stored on the server/);
    assert.match(r.stdout, /NOT RECONCILED: 3 mismatch/);

    const fix = imp("run", bundle, ...importerArgs());
    assert.equal(fix.status, 0, fix.stdout + fix.stderr);
    assert.match(fix.stdout, /media: 1 uploaded, 1 already there/, "only the missing file is uploaded again");
    const after = imp("reconcile", bundle, "--journal-name", journalName, "--default-author", wife.email);
    assert.match(after.stdout, /NOT RECONCILED: 2 mismatch/, "the run never overwrites an existing entry, so changed entries stay flagged until corrected");
    await api("PATCH", `/api/collections/entries/records/${e4.id}`, { token: admin, body: { title: "Crawling video" } });
    await api("PATCH", `/api/collections/entries/records/${e2.id}`, { token: admin, body: { author: husband.id } });
    assert.equal(imp("reconcile", bundle, "--journal-name", journalName, "--default-author", wife.email).status, 0);
  });

  test("an author with no account and no default author stops the import before anything is written", async () => {
    const r = imp("run", bundle, "--journal-name", journalName + " other", "--add-members", "--create-journal");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /author 'u-grandma' has no matching account/);
  });
});
