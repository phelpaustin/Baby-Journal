// Step 5 gates (architecture v7, section 9): consistent backups, the four concurrency cases,
// failure and alert behaviour, restore on a second machine, account recovery, and the export.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const E = process.env;
const PB_URL = E.PB_URL, PB_DATA = E.PB_DATA;
const BACKUP = join(E.OPS_DIR, "bj_backup.py"), EXPORT = join(E.OPS_DIR, "bj_export.py");
const PB_BIN = join(E.REPO_ROOT, "tools", "pocketbase"), BACKEND = join(E.REPO_ROOT, "backend");
const PASSWORD = "correct-horse-battery";
const ADMIN = ["admin@test.local", "test-admin-password-1"];
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = mkdtempSync(join(tmpdir(), "bj-ops-"));
// ONLY="regex" runs just the matching top-level groups (each restic command costs a couple of seconds)
const group = (name, fn) => (!E.ONLY || new RegExp(E.ONLY, "i").test(name) ? describe(name, fn) : describe.skip(name, fn));

async function api(method, path, { token, body, form, base = PB_URL } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(form ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: token } : {}) },
    body: form ? form : body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

let admin, journal, users = {}, jpeg, clip;
const adminOf = async (base) => (await api("POST", "/api/collections/_superusers/auth-with-password", { base, body: { identity: ADMIN[0], password: ADMIN[1] } })).data.token;

// ------------------------------------------------------------ fixtures and helpers
async function mkUser(name) {
  const email = `${name}-${rid()}@test.local`;
  const u = await api("POST", "/api/collections/users/records", { token: admin, body: { email, password: PASSWORD, passwordConfirm: PASSWORD, name, verified: true } });
  const l = await api("POST", "/api/collections/users/auth-with-password", { body: { identity: email, password: PASSWORD } });
  return { id: u.data.id, email, token: l.data.token, name };
}
async function newEntry(title, date = "2026-10-18") {
  const cid = "e-" + rid();
  const r = await api("POST", "/api/bj/entries/sync", { token: users.editor.token, body: { journal: journal.id, client_id: cid, idempotency_key: "k-" + rid(), op: "upsert", base_revision: 0,
    fields: { event_date: date, type: "memory", title, text: "Text of " + title, milestones: ["first_smile"], values: { weight_kg: 4.2 } } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { cid, entry: r.data.entry };
}
async function upload(entry, bytes, kind = "image", name = "IMG.JPG", type = "image/jpeg") {
  const f = new FormData();
  for (const [k, v] of Object.entries({ journal: journal.id, entry: entry.id, client_id: "m-" + rid(), kind, sha256: sha(bytes), size: String(bytes.length) })) f.append(k, v);
  f.append("file", new Blob([bytes], { type }), name);
  const r = await api("POST", "/api/bj/media/upload", { token: users.editor.token, form: f });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.media;
}
const photo = (salt = rid()) => Buffer.concat([jpeg, Buffer.from(salt)]);

// a tiny healthcheck receiver and an alert script that records what it is told
const pings = [];
const hc = http.createServer((req, res) => { pings.push(req.url); res.end("OK"); });
const alertLog = join(W, "alerts.log");
const alertScript = join(W, "alert.sh");

function env(name, extra = {}) {
  const base = join(W, name);
  mkdirSync(base, { recursive: true });
  return {
    ...process.env, BJ_DATA_DIR: PB_DATA, BJ_STATE_DIR: join(base, "state"), RESTIC_REPOSITORY: join(base, "repo"), RESTIC_PASSWORD: "restic-test-passphrase",
    BJ_PB_URL: PB_URL, BJ_PB_SUPERUSER: ADMIN[0], BJ_PB_PASSWORD: ADMIN[1], BJ_ALERT_CMD: alertScript,
    BJ_HEALTHCHECK_URL: `http://127.0.0.1:${hc.address().port}/ping`, BJ_CHECK_SUBSET: "10%", ...extra,
  };
}
const initRepo = (e) => sh("restic", ["init"], { env: e });
const backup = (e) => spawnSync("python3", [BACKUP, "backup"], { env: e, encoding: "utf8" });
const resticJson = (e, ...args) => JSON.parse(sh("restic", [...args, "--json"], { env: e }));
const mediaRows = async (filter = "") => (await api("GET", `/api/collections/media/records?perPage=500${filter ? "&filter=" + encodeURIComponent(filter) : ""}`, { token: admin })).data.items;
const lastAlerts = () => (existsSync(alertLog) ? readFileSync(alertLog, "utf8").trim().split("\n").filter(Boolean) : []);
const runs = async () => (await api("GET", "/api/collections/backup_runs/records?perPage=200&sort=started_at,finished_at", { token: admin })).data.items;
const lockFile = join(PB_DATA, ".maintenance.lock");

before(async () => {
  await new Promise((r) => hc.listen(0, "127.0.0.1", r));
  writeFileSync(alertScript, `#!/bin/bash\necho "$1 $2" >> "${alertLog}"\n`, { mode: 0o755 });
  admin = await adminOf(PB_URL);
  for (const n of ["owner", "editor", "viewer"]) users[n] = await mkUser(n);
  journal = (await api("POST", "/api/collections/journals/records", { token: admin, body: { name: "Ophelia Mikyla", emoji: "🍼", dob: "2025-03-02" } })).data;
  for (const [n, role] of [["owner", "owner"], ["editor", "editor"], ["viewer", "viewer"]]) await api("POST", "/api/collections/members/records", { token: admin, body: { journal: journal.id, user: users[n].id, role } });
  sh("convert", ["-size", "640x480", "gradient:gold-purple", join(W, "p.jpg")]);
  jpeg = readFileSync(join(W, "p.jpg"));
  sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=25", "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(W, "c.mp4")]);
  clip = readFileSync(join(W, "c.mp4"));
  // entries in three different years, with photos and a video
  const a = await newEntry("First smile", "2025-04-20"); await upload(a.entry, photo());
  const b = await newEntry("Crawling at last", "2026-01-15"); await upload(b.entry, photo()); await upload(b.entry, clip, "video", "MOV_0007.mp4", "video/mp4");
  const c = await newEntry("Birthday & cake: \"one\"!", "2027-03-02"); await upload(c.entry, photo());
  await newEntry("Just words", "2026-06-01");
});

after(() => hc.close());

// ====================================================================== the nightly backup
group("the nightly backup", () => {
  const e = () => env("main");
  let snapId, first;

  test("one restic snapshot holds the database snapshot, the manifest and the originals; originals become offsite protected", async () => {
    initRepo(e());
    const before = await mediaRows();
    assert.ok(before.length >= 4 && before.every((m) => m.offsite_at === ""));
    first = backup(e());
    assert.equal(first.status, 0, first.stdout + first.stderr);

    const snaps = resticJson(e(), "snapshots");
    assert.equal(snaps.length, 1, "exactly one snapshot");
    snapId = snaps[0].id;
    const ls = sh("restic", ["ls", snapId], { env: e() });
    assert.match(ls, /staging\/db\/data\.db/);
    assert.match(ls, /staging\/manifest\.jsonl/);
    assert.match(ls, /staging\/backup-info\.json/);
    assert.equal((ls.match(/\.(jpg|JPG|mp4)\b/g) || []).length >= 4, true, "the originals are in it");

    const after_ = await mediaRows();
    assert.ok(after_.every((m) => m.offsite_snapshot === snapId.slice(0, 8) || m.offsite_snapshot.startsWith(snapId.slice(0, 8)) || snapId.startsWith(m.offsite_snapshot)), "every row carries the snapshot id");
    assert.ok(after_.every((m) => m.offsite_at));

    const rs = await runs();
    const last = rs[rs.length - 1];
    assert.deepEqual([last.result, last.verification_result], ["ok", "ok"]);
    assert.ok(last.file_count >= 4 && last.bytes > 0);
    const status = await api("GET", "/api/bj/backup/status", { token: users.owner.token });
    assert.equal(status.data.level, "ok");
    assert.equal(status.data.media_not_offsite, 0);
  });

  test("bookkeeping: lock released, local snapshot and manifest kept, report written, healthcheck pinged, no alert", async () => {
    assert.ok(!existsSync(lockFile), "the maintenance lock must be released");
    const st = e().BJ_STATE_DIR;
    assert.equal(readdirSync(join(st, "snapshots")).length, 1);
    assert.ok(existsSync(join(st, "snapshots", readdirSync(join(st, "snapshots"))[0], "data.db")));
    assert.equal(readdirSync(join(st, "manifests")).length, 1);
    assert.equal(readdirSync(join(st, "reports")).length, 1);
    assert.ok(!existsSync(join(st, "staging")), "staging is cleaned up");
    assert.deepEqual(pings.filter((p) => p === "/ping").length, 1);
    assert.ok(!pings.includes("/ping/fail"));
    assert.deepEqual(lastAlerts(), []);
  });

  test("the manifest matches the database: every stored row, with path, size and SHA-256", async () => {
    const man = readFileSync(join(e().BJ_STATE_DIR, "manifests", readdirSync(join(e().BJ_STATE_DIR, "manifests"))[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const header = man[0];
    assert.equal(header.type, "header");
    const rows = man.slice(1);
    assert.equal(rows.length, header.count);
    const db = await mediaRows('status="stored"');
    assert.equal(rows.length, db.length);
    for (const r of rows) {
      const disk = readFileSync(join(PB_DATA, r.path));
      assert.equal(disk.length, r.size);
      assert.equal(sha(disk), r.sha256);
    }
  });

  test("a second night is incremental: a new photo is protected, nothing is re-uploaded for the old ones", async () => {
    const x = await newEntry("Added later");
    const m = await upload(x.entry, photo());
    assert.equal((await mediaRows(`id="${m.id}"`))[0].offsite_at, "");
    const before = Number(JSON.parse(sh("restic", ["stats", "--mode", "raw-data", "--json"], { env: e() })).total_size);
    const r = backup(e());
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after_ = Number(JSON.parse(sh("restic", ["stats", "--mode", "raw-data", "--json"], { env: e() })).total_size);
    assert.ok(after_ - before < jpeg.length * 3, `repository grew by ${after_ - before} bytes, expected about one photo`);
    assert.ok((await mediaRows(`id="${m.id}"`))[0].offsite_at);
    assert.equal(resticJson(e(), "snapshots").length, 2);
  });
});

// ====================================================================== concurrency cases (a) (b) (c)
group("consistency while the backup runs", () => {
  test("(a)(b)(c) upload finishing after the snapshot, a trash during the backup, and a purge during the backup", async () => {
    const e = env("concurrent");
    initRepo(e);
    const live = await newEntry("Live entry that gets a late upload");
    const doomed = await newEntry("Trashed during the backup");
    const doomedMedia = await upload(doomed.entry, photo());
    const pause = join(W, "pause-flag-" + rid());
    writeFileSync(pause, "x");
    const proc = spawn("python3", [BACKUP, "backup"], { env: { ...e, BJ_TEST_PAUSE_AFTER_SNAPSHOT_FILE: pause }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; proc.stdout.on("data", (d) => (out += d)); proc.stderr.on("data", (d) => (out += d));
    const closed = new Promise((resolve) => proc.on("close", resolve));
    let late;
    try {
      for (let i = 0; i < 100 && !out.includes("paused after the database snapshot"); i++) await sleep(100);
      assert.match(out, /paused after the database snapshot/);

      // (c) the purge waits for the lock
      const purge = await api("POST", "/api/bj/maintenance/purge", { token: admin, body: { dry_run: false } });
      assert.match(purge.data.skipped, /backup is running/, "the purge must wait for the backup's lock");

      // (b) trash an entry (and so its media) during the backup
      const tr = await api("POST", "/api/bj/entries/sync", { token: users.editor.token, body: { journal: journal.id, client_id: doomed.cid, idempotency_key: "k-" + rid(), op: "trash", base_revision: 1 } });
      assert.equal(tr.status, 200);
      // (a) an upload that finishes AFTER the database snapshot
      late = await upload(live.entry, photo("late"));
    } finally {
      rmSync(pause, { force: true });
    }
    await closed;
    assert.match(out, /backup ok/, out);

    const manDir = join(e.BJ_STATE_DIR, "manifests");
    const man = readFileSync(join(manDir, readdirSync(manDir)[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l)).slice(1);
    assert.ok(!man.some((m) => m.media === late.id), "(a) the late upload is not in the manifest, because the manifest comes from the snapshot");
    assert.equal((await mediaRows(`id="${late.id}"`))[0].offsite_at, "", "(a) so it is not marked protected");
    assert.ok(man.every((m) => existsSync(join(PB_DATA, m.path))), "(a) never a manifest row without its file");
    const lateOrig = (await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${late.id}"`)}`, { token: admin })).data.items[0];
    const snapId = resticJson(e, "snapshots")[0].id;
    assert.ok(sh("restic", ["ls", snapId], { env: e }).includes(lateOrig.file), "(a) its file may sit in the snapshot as an extra file, which is harmless");

    // (b) the media of the entry trashed during the backup is in the manifest (it was live at snapshot time) and its file is intact
    assert.ok(man.some((m) => m.media === doomedMedia.id), "(b) it was live when the snapshot was taken");
    const dOrig = (await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${doomedMedia.id}"`)}`, { token: admin })).data.items[0];
    assert.ok(existsSync(join(PB_DATA, "storage", dOrig.collectionId, dOrig.id, dOrig.file)), "(b) trashing never touches the files");
    assert.ok((await mediaRows(`id="${doomedMedia.id}"`))[0].offsite_at, "(b) and it is protected");

    // the next night protects the late upload
    const r2 = backup(e);
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.ok((await mediaRows(`id="${late.id}"`))[0].offsite_at, "the next night protects it");
    assert.equal(resticJson(e, "snapshots").length, 2);
  });
});

// ====================================================================== (d) killed halfway
group("a backup killed halfway", () => {
  test("(d) protects nothing, leaves a stale lock that blocks nothing, and the next run recovers", async () => {
    const e = env("killed");
    initRepo(e);
    const x = await newEntry("Killed run");
    const m = await upload(x.entry, photo());
    const proc = spawn("python3", [BACKUP, "backup"], { env: { ...e, BJ_TEST_HANG_AFTER: "after_restic" }, stdio: "ignore" });
    const marker = join(e.BJ_STATE_DIR, "hang-marker");
    for (let i = 0; i < 300 && !existsSync(marker); i++) await sleep(100);
    if (!existsSync(marker)) { proc.kill("SIGKILL"); assert.fail("the run did not reach the restic step"); }
    assert.ok(existsSync(lockFile), "the run holds the lock");
    assert.equal((await api("POST", "/api/bj/maintenance/purge", { token: admin, body: {} })).data.skipped.includes("running"), true);
    const killed = new Promise((r) => proc.on("close", r));
    proc.kill("SIGKILL");
    await killed;

    assert.equal((await mediaRows(`id="${m.id}"`))[0].offsite_at, "", "no media may be marked protected by a run that never finished");
    assert.ok(existsSync(lockFile), "a killed process leaves its lock behind");
    const purge = await api("POST", "/api/bj/maintenance/purge", { token: admin, body: {} });
    assert.doesNotMatch(purge.data.skipped || "", /running/, "the stale lock of a dead process must not block the purge");
    assert.equal(resticJson(e, "snapshots").length, 1, "restic did write a snapshot, but it was never verified or marked");

    const again = backup(env("killed"));
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /removing a stale lock/);
    assert.ok((await mediaRows(`id="${m.id}"`))[0].offsite_at);
    assert.ok(!existsSync(lockFile));
  });
});

// ====================================================================== verification catches damage
group("failures are detected, recorded and alerted", () => {
  test("a missing original stops the backup, marks nothing, records a failed run and alerts", async () => {
    const e = env("missing");
    initRepo(e);
    const x = await newEntry("Will lose its file");
    const m = await upload(x.entry, photo());
    const orig = (await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${m.id}"`)}`, { token: admin })).data.items[0];
    const path = join(PB_DATA, "storage", orig.collectionId, orig.id, orig.file);
    const keep = readFileSync(path);
    rmSync(path);
    const alertsBefore = lastAlerts().length, failPings = pings.filter((p) => p === "/ping/fail").length, runsBefore = (await runs()).length;
    const r = backup(e);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /missing original/);
    assert.equal((await mediaRows(`id="${m.id}"`))[0].offsite_at, "");
    assert.equal((await mediaRows('offsite_at!=""&&offsite_snapshot="killed"')).length, 0);
    const rs = await runs();
    assert.equal(rs.length, runsBefore + 1);
    assert.equal(rs[rs.length - 1].result, "failed");
    assert.equal(lastAlerts().length, alertsBefore + 1);
    assert.match(lastAlerts().pop(), /^critical Backup failed/);
    assert.equal(pings.filter((p) => p === "/ping/fail").length, failPings + 1);
    writeFileSync(path, keep); // put it back
  });

  test("damage inside the repository is found by the integrity check, not trusted", async () => {
    const e = env("damaged", { BJ_CHECK_SUBSET: "100%" });
    initRepo(e);
    assert.equal(backup(e).status, 0);
    const dataDir = join(e.RESTIC_REPOSITORY, "data");
    const pack = readdirSync(dataDir).flatMap((d) => readdirSync(join(dataDir, d)).map((f) => join(dataDir, d, f)))[0];
    truncateSync(pack, Math.floor(statSync(pack).size / 2));
    const x = await newEntry("After the damage");
    await upload(x.entry, photo());
    const r = backup(e);
    assert.equal(r.status, 1, "the backup must fail when the repository is damaged: " + r.stdout.slice(-300));
    assert.match(r.stdout + r.stderr, /restic check failed|verification failed/);
    assert.match(lastAlerts().pop(), /^critical Backup failed/);
  });

  test("an unreachable repository fails the run loudly, every night", async () => {
    const e = env("unreachable", { RESTIC_REPOSITORY: "/nonexistent/readonly/repo" });
    const before = lastAlerts().length, rb = (await runs()).length;
    for (let night = 1; night <= 3; night++) {
      const r = backup(e);
      assert.equal(r.status, 1);
    }
    assert.equal(lastAlerts().length, before + 3, "one alert per failed night");
    assert.equal((await runs()).length, rb + 3);
  });
});

// ====================================================================== alerts for stale or failed backups
group("alert levels (18 h warning, 24 h critical)", () => {
  test("three failed nights: the watcher warns at 18 h, goes critical at 24 h, does not repeat, and recovers", async () => {
    const e = env("watch");
    // start from a clean slate: one good run "now", then nothing good afterwards
    for (const r of await runs()) await api("DELETE", `/api/collections/backup_runs/records/${r.id}`, { token: admin });
    const t0 = new Date();
    const good = (await api("POST", "/api/bj/backup/record", { token: admin, body: { snapshot_id: "w", result: "ok", verification_result: "ok", started_at: t0.toISOString(), finished_at: t0.toISOString() } }));
    assert.equal(good.status, 200);
    const watch = (hoursLater) => spawnSync("python3", [BACKUP, "watch", "--now", new Date(t0.getTime() + hoursLater * 3600000).toISOString()], { env: e, encoding: "utf8" });
    const n0 = lastAlerts().length;

    assert.equal(watch(10).status, 0);
    assert.equal(lastAlerts().length, n0, "10 h: no alert");
    watch(19);
    assert.match(lastAlerts().pop(), /^warning The last verified offsite backup was 19 hours ago/);
    const n1 = lastAlerts().length;
    watch(20);
    assert.equal(lastAlerts().length, n1, "no repeat of the same warning");
    watch(25);
    assert.match(lastAlerts().pop(), /^critical No verified offsite backup since: 25 hours ago/);
    const n2 = lastAlerts().length;
    watch(26);
    assert.equal(lastAlerts().length, n2, "no repeat within 6 hours");
    watch(32);
    assert.equal(lastAlerts().length, n2 + 1, "a reminder after 6 hours while critical");
    watch(72); // three nights gone
    assert.match(lastAlerts().pop(), /^critical.*72 hours ago/);

    // a failed run raises its own alert at once, once
    await api("POST", "/api/bj/backup/record", { token: admin, body: { snapshot_id: "f", result: "failed", verification_result: "failed", started_at: new Date().toISOString(), finished_at: new Date().toISOString() } });
    const n3 = lastAlerts().length;
    watch(72.1);
    assert.match(lastAlerts().slice(n3).join("\n"), /latest backup run failed/);
    const n4 = lastAlerts().length;
    watch(72.2);
    assert.equal(lastAlerts().slice(n4).filter((l) => /latest backup run failed/.test(l)).length, 0);

    // a good run brings it back to quiet
    const t1 = new Date(t0.getTime() + 73 * 3600000);
    await api("POST", "/api/bj/backup/record", { token: admin, body: { snapshot_id: "g", result: "ok", verification_result: "ok", started_at: t1.toISOString(), finished_at: t1.toISOString() } });
    const n5 = lastAlerts().length;
    const w = watch(74);
    assert.match(w.stdout, /healthy again/);
    assert.equal(lastAlerts().length, n5);
  });

  test("with no backup ever recorded the level is critical", async () => {
    const e = env("watch-empty");
    for (const r of await runs()) await api("DELETE", `/api/collections/backup_runs/records/${r.id}`, { token: admin });
    const n = lastAlerts().length;
    spawnSync("python3", [BACKUP, "watch"], { env: e, encoding: "utf8" });
    assert.match(lastAlerts().slice(n).join("\n"), /critical No verified offsite backup since: never completed/);
  });
});

// ====================================================================== the restore drill
group("restore on a second machine, and recovery", () => {
  const e = () => env("drill");
  let second, secondBase, rdir, origCounts, origHashes;
  const SECOND_PORT = 8094;

  const startSecond = async (dir) => {
    second = spawn(PB_BIN, ["serve", "--dir", dir, "--migrationsDir", join(BACKEND, "pb_migrations"), "--hooksDir", join(BACKEND, "pb_hooks"), "--http", `127.0.0.1:${SECOND_PORT}`], { stdio: "ignore" });
    secondBase = `http://127.0.0.1:${SECOND_PORT}`;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(secondBase + "/api/health")).ok) return; } catch (_) {} await sleep(200); }
    throw new Error("the restored server did not start");
  };
  const stopSecond = async () => { if (second) { second.kill("SIGTERM"); await new Promise((r) => second.on("close", r)); second = null; } };
  after(stopSecond);

  test("take the backup, then rebuild everything from the repository alone", async () => {
    initRepo(e());
    assert.equal(backup(e()).status, 0);
    const media = await mediaRows('status="stored"');
    origCounts = { media: media.length, entries: (await api("GET", "/api/collections/entries/records?perPage=1", { token: admin })).data.totalItems };
    origHashes = {};
    for (const o of (await api("GET", "/api/collections/media_originals/records?perPage=500", { token: admin })).data.items) origHashes[o.media] = o.sha256;

    // the second machine knows nothing but the repository location and passphrase
    rdir = join(W, "second-machine");
    const secondEnv = { PATH: process.env.PATH, RESTIC_REPOSITORY: e().RESTIC_REPOSITORY, RESTIC_PASSWORD: e().RESTIC_PASSWORD };
    const r = spawnSync("python3", [BACKUP, "restore", "--target", rdir], { env: secondEnv, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /restore ok/);
    const rep = JSON.parse(readFileSync(join(rdir, "restore-report.json"), "utf8"));
    assert.equal(rep.ok, true);
    assert.equal(rep.files, origCounts.media);
    assert.equal(rep.derived_included, false);
    assert.ok(existsSync(join(rdir, "pb_data", "data.db")));
  });

  test("the restored server starts, the data is all there, and reconcile rebuilds the derived copies", async () => {
    await startSecond(join(rdir, "pb_data"));
    const sAdmin = await adminOf(secondBase);
    assert.ok(sAdmin, "the admin login survives the restore");
    const count = async (col, filter = "") => (await api("GET", `/api/collections/${col}/records?perPage=1${filter ? "&filter=" + encodeURIComponent(filter) : ""}`, { token: sAdmin, base: secondBase })).data.totalItems;
    assert.equal(await count("entries"), origCounts.entries);
    assert.equal(await count("media", 'status="stored"'), origCounts.media);
    assert.equal(await count("journals"), 1 + (await count("journals")) - 1 >= 1 ? await count("journals") : 0);

    const dry = (await api("POST", "/api/bj/maintenance/reconcile", { token: sAdmin, base: secondBase, body: {} })).data;
    assert.equal(dry.missing.length + dry.size_mismatch.length + dry.checksum_mismatch.length, 0, "every original is present and intact");
    assert.ok(dry.derived_missing.length > 0, "the derived copies were not backed up, so they are reported");
    const fix = (await api("POST", "/api/bj/maintenance/reconcile", { token: sAdmin, base: secondBase, body: { dry_run: false, regenerate: true } })).data;
    assert.equal(fix.regenerated.length, dry.derived_missing.length);
    const again = (await api("POST", "/api/bj/maintenance/reconcile", { token: sAdmin, base: secondBase, body: {} })).data;
    assert.equal(again.ok, true, JSON.stringify(again).slice(0, 400));
    assert.equal(again.orphans.length, 0);
  });

  test("sign in as the owner with the old password, and an old video plays back (with a range request)", async () => {
    const login = await api("POST", "/api/collections/users/auth-with-password", { base: secondBase, body: { identity: users.owner.email, password: PASSWORD } });
    assert.equal(login.status, 200, "passwords survive the restore");
    const tok = login.data.token;
    const vids = (await api("GET", `/api/collections/media/records?filter=${encodeURIComponent('kind="video"')}`, { token: tok, base: secondBase })).data.items;
    assert.ok(vids.length >= 1);
    const ft = (await api("POST", "/api/files/token", { token: tok, base: secondBase })).data.token;
    const v = vids[0];
    const res = await fetch(`${secondBase}/api/files/${v.collectionId}/${v.id}/${v.playback}?token=${ft}`, { headers: { Range: "bytes=0-99" } });
    assert.equal(res.status, 206);
    assert.equal((await res.arrayBuffer()).byteLength, 100);
    // the original is byte-identical to what was uploaded
    const orig = (await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${v.id}"`)}`, { token: tok, base: secondBase })).data.items[0];
    const full = Buffer.from(await (await fetch(`${secondBase}/api/files/${orig.collectionId}/${orig.id}/${orig.file}?token=${ft}`)).arrayBuffer());
    assert.equal(sha(full), origHashes[v.id]);
  });

  test("account recovery with no e-mail: set an owner's password from the command line on the restored server", async () => {
    await stopSecond();
    const NEW = "brand-new-password-2027";
    const r = spawnSync(PB_BIN, ["bj-set-password", users.owner.email, "--dir", join(rdir, "pb_data"), "--hooksDir", join(BACKEND, "pb_hooks"), "--migrationsDir", join(BACKEND, "pb_migrations")],
      { env: { ...process.env, BJ_NEW_PASSWORD: NEW }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /Password set for/);
    const short = spawnSync(PB_BIN, ["bj-set-password", users.owner.email, "--dir", join(rdir, "pb_data"), "--hooksDir", join(BACKEND, "pb_hooks")], { env: { ...process.env, BJ_NEW_PASSWORD: "short" }, encoding: "utf8" });
    assert.notEqual(short.status, 0, "a weak password is refused");

    await startSecond(join(rdir, "pb_data"));
    assert.equal((await api("POST", "/api/collections/users/auth-with-password", { base: secondBase, body: { identity: users.owner.email, password: PASSWORD } })).status, 400, "the old password no longer works");
    assert.equal((await api("POST", "/api/collections/users/auth-with-password", { base: secondBase, body: { identity: users.owner.email, password: NEW } })).status, 200);
    // tokens issued before are rejected (the token key was rotated)
    const stale = await api("POST", "/api/collections/users/auth-refresh", { token: users.owner.token, base: secondBase });
    assert.equal(stale.status, 401);
    const unknown = spawnSync(PB_BIN, ["bj-set-password", "nobody@nowhere.test", "--dir", join(rdir, "pb_data"), "--hooksDir", join(BACKEND, "pb_hooks")], { env: { ...process.env, BJ_NEW_PASSWORD: NEW }, encoding: "utf8" });
    assert.notEqual(unknown.status, 0);
  });

  test("silent corruption that a nightly sample misses is still caught: restore re-hashes every file and refuses to call itself good", async () => {
    const x = await newEntry("Silently corrupted");
    const m = await upload(x.entry, photo("corrupt-me"));
    const orig = (await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${m.id}"`)}`, { token: admin })).data.items[0];
    const path = join(PB_DATA, "storage", orig.collectionId, orig.id, orig.file);
    const good = readFileSync(path);
    const bad = Buffer.from(good); bad[120] ^= 0xff; // same size, one flipped byte: invisible to size checks
    writeFileSync(path, bad);
    try {
      // sampling is off for this run, as it effectively is for a file the 3-file sample does not pick
      const e = env("silent", { BJ_VERIFY_SAMPLE_FILES: "0" });
      initRepo(e);
      assert.equal(backup(e).status, 0, "the nightly backup does not re-hash every file, so it cannot see this");
      const target = join(W, "second-silent");
      const r = spawnSync("python3", [BACKUP, "restore", "--target", target], { env: { PATH: process.env.PATH, RESTIC_REPOSITORY: e.RESTIC_REPOSITORY, RESTIC_PASSWORD: e.RESTIC_PASSWORD }, encoding: "utf8" });
      assert.equal(r.status, 1, "restore must fail: " + r.stdout);
      assert.match(r.stdout, /checksum mismatch/);
      const rep = JSON.parse(readFileSync(join(target, "restore-report.json"), "utf8"));
      assert.equal(rep.ok, false);
      assert.equal(rep.problems.length, 1);
      // and the monthly integrity check (full re-hash here) finds it on the live store
      const live = (await api("POST", "/api/bj/maintenance/reconcile", { token: admin, body: { sample: 1 } })).data;
      assert.equal(live.checksum_mismatch.length, 1);
      assert.equal(live.checksum_mismatch[0].original, orig.id);
    } finally {
      writeFileSync(path, good);
    }
  });
});

// ====================================================================== the scripted restore drill
group("restore drill (scripted)", () => {
  const drillEnv = (name, extra = {}) => env(name, { BJ_PB_BIN: PB_BIN, BJ_BACKEND_DIR: BACKEND, ...extra });
  const drill = (e) => spawnSync("python3", [BACKUP, "drill"], { env: e, encoding: "utf8" });
  const report = (e) => { const f = readdirSync(e.BJ_STATE_DIR).filter((x) => /^drill-\d+\.json$/.test(x)).sort().pop(); return JSON.parse(readFileSync(join(e.BJ_STATE_DIR, f), "utf8")); };

  test("restore, boot a server on the restored data, reconcile, export and verify: one command, recorded and reported", async () => {
    const e = drillEnv("drill-ok");
    initRepo(e);
    assert.equal(backup(e).status, 0);
    const before = lastAlerts().length;
    const r = drill(e);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const rep = report(e);
    assert.equal(rep.ok, true, JSON.stringify(rep));
    assert.deepEqual(Object.keys(rep.steps), ["restore", "start", "reconcile", "export"]);
    assert.ok(rep.files >= 4 && rep.entries >= 4);
    assert.ok(rep.derived_regenerated >= 4, "the preview copies were rebuilt on the restored server");
    assert.ok(rep.export.entries >= 4 && rep.export.files >= 4);
    assert.match(lastAlerts().slice(before).join("\n"), /info Restore drill passed/);
    assert.ok(!existsSync(join(e.BJ_STATE_DIR, "drill-work")), "the temporary restored copy is removed");
    // only real PocketBase processes count (a shell whose command line merely mentions the folder does not)
    const left = sh("ps", ["-eo", "args="]).split("\n").filter((l) => /^\S*pocketbase serve /.test(l) && l.includes("drill-work/pb_data")).join("\n");
    assert.equal(left, "", "the temporary server is stopped, but found: " + left);
  });

  test("a damaged original that the nightly sample missed makes the drill fail, record why, and alert critically", async () => {
    const x = await newEntry("Drill damage");
    const m = await upload(x.entry, photo("drill-damage"));
    const orig = (await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${m.id}"`)}`, { token: admin })).data.items[0];
    const path = join(PB_DATA, "storage", orig.collectionId, orig.id, orig.file);
    const good = readFileSync(path); const bad = Buffer.from(good); bad[90] ^= 0xff; writeFileSync(path, bad);
    try {
      const e = drillEnv("drill-bad", { BJ_VERIFY_SAMPLE_FILES: "0" });
      initRepo(e);
      assert.equal(backup(e).status, 0);
      const before = lastAlerts().length;
      const r = drill(e);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      const rep = report(e);
      assert.equal(rep.ok, false);
      assert.match(rep.problems.join(" "), /did not verify.*checksum mismatch/);
      assert.match(lastAlerts().slice(before).join("\n"), /critical The restore drill FAILED/);
      assert.ok(!existsSync(join(e.BJ_STATE_DIR, "drill-work")));
    } finally { writeFileSync(path, good); }
  });

  test("export --verify passes a good export and names each kind of damage", () => {
    const snap = join(W, "verify-snap.db");
    sh("python3", ["-c", `import sqlite3;s=sqlite3.connect('file:${PB_DATA}/data.db?mode=ro',uri=True);d=sqlite3.connect('${snap}');s.backup(d);d.close()`]);
    const cid = sh("sqlite3", [snap, "SELECT id FROM _collections WHERE name='media_originals'"]).trim();
    const out = join(W, "verify-export"); rmSync(out, { recursive: true, force: true });
    assert.equal(spawnSync("python3", [EXPORT, "--db", snap, "--originals", join(PB_DATA, "storage", cid), "--out", out], { encoding: "utf8" }).status, 0);
    const verify = () => spawnSync("python3", [EXPORT, "--verify", out], { encoding: "utf8" });
    assert.equal(verify().status, 0, verify().stderr);
    const root = join(out, readdirSync(out)[0]);
    const find = (dir, re) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? find(join(dir, d.name), re) : re.test(d.name) ? [join(dir, d.name)] : []));
    const photo1 = find(join(root, "entries"), /^photo-01\./)[0];
    const keep = readFileSync(photo1);
    rmSync(photo1);
    let r = verify(); assert.equal(r.status, 1); assert.match(r.stderr, /is missing/); assert.match(r.stderr, /checksums\.sha256 lists a missing file/);
    writeFileSync(photo1, keep);
    const b = Buffer.from(keep); b[40] ^= 0xff; writeFileSync(photo1, b);
    r = verify(); assert.equal(r.status, 1); assert.match(r.stderr, /checksum differs/);
    writeFileSync(photo1, keep);
    const readme = readFileSync(join(root, "README.md")); rmSync(join(root, "README.md"));
    r = verify(); assert.match(r.stderr, /README\.md is missing/);
    writeFileSync(join(root, "README.md"), readme);
    const idx = readFileSync(join(root, "index.html"), "utf8"); writeFileSync(join(root, "index.html"), idx.replace(/entries\/[^']+entry\.md/, "entries/nowhere/entry.md"));
    r = verify(); assert.match(r.stderr, /index\.html links to a missing file/);
    writeFileSync(join(root, "index.html"), idx);
    assert.equal(verify().status, 0, "restored to good: passes again");
  });
});

// ====================================================================== retention
group("retention policy", () => {
  test("daily 14, weekly 8, monthly 12: the dry run lists what would go and changes nothing; the real run keeps the recent days", async () => {
    const e = env("retention");
    initRepo(e);
    const dir = join(W, "retention-src"); mkdirSync(dir, { recursive: true });
    const days = [...Array(20).keys(), ...Array.from({ length: 21 }, (_, i) => 20 + i * 4)]; // daily for 20 days, then every 4th day to ~100 days
    for (const d of days) {
      writeFileSync(join(dir, "f.txt"), "day " + d);
      const when = new Date(Date.now() - d * 86400000).toISOString().replace("T", " ").slice(0, 19);
      sh("restic", ["backup", dir, "--tag", "bj-nightly", "--host", "bj", "--time", when], { env: e });
    }
    assert.equal(resticJson(e, "snapshots").length, days.length);
    const dry = spawnSync("python3", [BACKUP, "forget"], { env: e, encoding: "utf8" });
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.equal(resticJson(e, "snapshots").length, days.length, "a dry run removes nothing");
    const real = spawnSync("python3", [BACKUP, "forget", "--apply"], { env: e, encoding: "utf8" });
    assert.equal(real.status, 0, real.stdout + real.stderr);
    const left = resticJson(e, "snapshots");
    assert.ok(left.length < days.length, "something old was removed");
    const ageDays = (sn) => (Date.now() - Date.parse(sn.time)) / 86400000;
    assert.equal(left.filter((sn) => ageDays(sn) < 13.9).length, 14, "all of the last 14 days are kept");
    assert.ok(left.length >= 14 + 2, "weekly and monthly points are kept too: " + left.length);
  });
});

// ====================================================================== export self-sufficiency
group("export self-sufficiency (clean computer: no network, no PocketBase, no app code)", () => {
  let out, root;

  test("the export is produced from a snapshot of the database, with every original", async () => {
    const trashed = await newEntry("Moved to the trash", "2026-02-02");
    assert.equal((await api("POST", "/api/bj/entries/sync", { token: users.editor.token, body: { journal: journal.id, client_id: trashed.cid, idempotency_key: "k-" + rid(), op: "trash", base_revision: 1 } })).status, 200);
    const snap = join(W, "export-snap.db");
    sh("python3", ["-c", `import sqlite3;s=sqlite3.connect('file:${PB_DATA}/data.db?mode=ro',uri=True);d=sqlite3.connect('${snap}');s.backup(d);d.close()`]);
    out = join(W, "export-out");
    const r = spawnSync("python3", [EXPORT, "--db", snap, "--originals", join(PB_DATA, "storage", mediaOrigId()), "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    root = join(out, readdirSync(out)[0]);
  });
  const mediaOrigId = () => readdirSync(join(PB_DATA, "storage")).find((d) => readdirSync(join(PB_DATA, "storage", d)).some((r) => readdirSync(join(PB_DATA, "storage", d, r)).some((f) => /^img.*\.jpg$/i.test(f) || /^mov/i.test(f) || f.endsWith(".mp4"))) && !readdirSync(join(PB_DATA, "storage", d)).some((r) => readdirSync(join(PB_DATA, "storage", d, r)).some((f) => f.startsWith("display"))));

  test("using only the export folder and its README: find the entries, open three from three different years, check checksums", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    for (const needle of ["index.html", "entries/YEAR", "journal.json", "sha256sum -c", "schema version", "UTC", "weight_kg"]) assert.match(readme, new RegExp(needle, "i"), "README must explain " + needle);
    const index = readFileSync(join(root, "index.html"), "utf8");
    const links = [...index.matchAll(/href='(entries\/[^']+entry\.md)'/g)].map((m) => decodeURIComponent(m[1]));
    assert.ok(links.length >= 4, "the index lists the entries");
    const years = new Set(links.map((l) => l.split("/")[1]));
    assert.ok(years.size >= 3, "three different years: " + [...years]);
    const picks = [...years].slice(0, 3).map((y) => links.find((l) => l.split("/")[1] === y));
    let opened = 0;
    for (const md of picks) {
      assert.ok(existsSync(join(root, md)));
      const dir = join(root, md, "..");
      const files = readdirSync(dir);
      assert.ok(files.includes("entry.json"));
      for (const f of files.filter((x) => /^(photo|video)-/.test(x))) {
        if (f.startsWith("photo")) assert.match(sh("identify", [join(dir, f)]), /JPEG 640x480/);
        else assert.match(sh("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", join(dir, f)]), /h264/);
        opened++;
      }
    }
    assert.ok(opened >= 3, "opened originals with ordinary software");
    assert.equal(spawnSync("sha256sum", ["-c", "checksums.sha256"], { cwd: root, encoding: "utf8" }).status, 0, "sha256sum -c passes");
  });

  test("the structured data is complete: schema version, history, units, trashed entries, no e-mail addresses", () => {
    const j = JSON.parse(readFileSync(join(root, "journal.json"), "utf8"));
    assert.equal(j.schema_version, 1);
    assert.equal(j.journal.name, "Ophelia Mikyla");
    assert.ok(j.entries.length >= 5 && j.entry_versions.length >= j.entries.length);
    assert.ok(j.entries.some((e) => e.values.weight_kg === 4.2));
    assert.ok(j.entries.some((e) => e.deleted_at), "trashed entries are kept in journal.json");
    assert.doesNotMatch(readFileSync(join(root, "journal.json"), "utf8"), /@test\.local|password|token/i);
    const year = readdirSync(join(root, "entries"))[0];
    const folder = readdirSync(join(root, "entries", year))[0];
    const md = readFileSync(join(root, "entries", year, folder, "entry.md"), "utf8");
    assert.match(md, /^# /);
  });

  test("a damaged file in the export is caught by the checksum list", () => {
    const f = readdirSync(join(root, "entries", "2025")).map((d) => join(root, "entries", "2025", d, "photo-01.jpg")).find((p) => existsSync(p));
    const b = readFileSync(f); const bak = Buffer.from(b); b[50] ^= 0xff; writeFileSync(f, b);
    assert.notEqual(spawnSync("sha256sum", ["-c", "checksums.sha256"], { cwd: root, encoding: "utf8" }).status, 0);
    writeFileSync(f, bak);
    assert.equal(spawnSync("sha256sum", ["-c", "checksums.sha256"], { cwd: root, encoding: "utf8" }).status, 0);
  });

  test("a missing original is reported in the README and the exit code, not hidden", () => {
    const snap = join(W, "export-snap.db");
    const empty = join(W, "empty-originals"); mkdirSync(empty, { recursive: true });
    const r = spawnSync("python3", [EXPORT, "--db", snap, "--originals", empty, "--out", join(W, "export-missing")], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /original missing/);
    const dir = join(W, "export-missing", readdirSync(join(W, "export-missing"))[0]);
    assert.match(readFileSync(join(dir, "README.md"), "utf8"), /original missing for media/);
  });
});
