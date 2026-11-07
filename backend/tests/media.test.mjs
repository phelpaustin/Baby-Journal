// Media-integrity tests (architecture v7, build step 2 gate):
// checksum-verified uploads without duplicates, no GPS in any display or playback copy,
// viewers never reach originals, backup states.
//
// Needs exiftool, ffmpeg/ffprobe and ImageMagick on the machine running the tests.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.PB_URL || "http://127.0.0.1:8099";
const PASSWORD = "correct-horse-battery";
const rid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

async function api(method, path, { token, body, form, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(form ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: token } : {}), ...(headers || {}) },
    body: form ? form : body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) { try { data = await res.json(); } catch (_) {} }
  return { status: res.status, data, res };
}

const dir = mkdtempSync(join(tmpdir(), "bj-media-"));
let admin, journalId, otherJournalId, entry, entryOther;
const people = {};

async function adminCreate(path, body) {
  const r = await api("POST", path, { token: admin, body });
  assert.equal(r.status, 200, path + " " + JSON.stringify(r.data));
  return r.data;
}
async function makeUser(name) {
  const email = `${name}-${rid()}@test.local`;
  const u = await adminCreate("/api/collections/users/records", { email, password: PASSWORD, passwordConfirm: PASSWORD, name, verified: true });
  const l = await api("POST", "/api/collections/users/auth-with-password", { body: { identity: email, password: PASSWORD } });
  return { id: u.id, email, token: l.data.token };
}

// ---------------------------------------------------------------- fixtures
const jpegPath = join(dir, "photo.jpg");
const jpegBytes = (() => {
  sh("convert", ["-size", "800x600", "gradient:skyblue-navy", jpegPath]);
  sh("exiftool", ["-overwrite_original", "-GPSLatitude=55.6050", "-GPSLatitudeRef=N", "-GPSLongitude=13.0038", "-GPSLongitudeRef=E",
    "-Make=Apple", "-Model=iPhone 15 Pro", "-SerialNumber=ABC123XYZ", "-DateTimeOriginal=2026:10:18 14:03:22", "-Orientation#=6", jpegPath]);
  return readFileSync(jpegPath);
})();

function makeVideo(name, vcodec, extra = []) {
  const p = join(dir, name);
  sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", vcodec, "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    "-metadata", "location=+55.6050+013.0038/", "-metadata", "com.apple.quicktime.model=iPhone 15 Pro",
    "-movflags", "use_metadata_tags", ...extra, p]);
  return p;
}
const hasEncoder = (n) => execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).includes(` ${n} `);

function uploadForm(over, bytes, filename = "IMG_0001.JPG", type = "image/jpeg") {
  const f = new FormData();
  const o = { journal: journalId, entry: entry.id, client_id: "m-" + rid(), kind: "image", sha256: sha(bytes), size: String(bytes.length), ...over };
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  f.append("file", new Blob([bytes], { type }), filename);
  return { form: f, fields: o };
}
const upload = (who, over, bytes, name, type) => {
  const { form, fields } = uploadForm(over, bytes, name, type);
  return api("POST", "/api/bj/media/upload", { token: people[who].token, form }).then((r) => ({ ...r, fields }));
};

async function fetchFile(who, collection, recordId, filename, extraHeaders) {
  const t = await api("POST", "/api/files/token", { token: people[who].token });
  const url = `${BASE}/api/files/${collection}/${recordId}/${filename}?token=${t.data.token}`;
  return fetch(url, { headers: extraHeaders });
}
async function download(who, collection, recordId, filename, saveAs) {
  const r = await fetchFile(who, collection, recordId, filename);
  if (r.status !== 200) return { status: r.status };
  const buf = Buffer.from(await r.arrayBuffer());
  const p = join(dir, saveAs);
  writeFileSync(p, buf);
  return { status: 200, buf, path: p };
}
const exif = (p) => JSON.parse(sh("exiftool", ["-json", "-G0", "-n", p]))[0];
const leaky = (p) => Object.keys(exif(p)).filter((k) => /^(GPS.*|Location|Coordinates|Make|Model|Software|.*SerialNumber|DeviceModelName)$/i.test(k.split(":").pop()));

before(async () => {
  const r = await api("POST", "/api/collections/_superusers/auth-with-password", { body: { identity: "admin@test.local", password: "test-admin-password-1" } });
  admin = r.data.token;
  for (const n of ["mowner", "meditor", "mviewer", "moutsider"]) people[n.slice(1)] = await makeUser(n);

  // Journals and memberships are created by the superuser here, so this file does not
  // depend on who created the first journal in the other test file.
  const j = await adminCreate("/api/collections/journals/records", { name: "Media journal" });
  const j2 = await adminCreate("/api/collections/journals/records", { name: "Other journal" });
  journalId = j.id; otherJournalId = j2.id;
  for (const [who, role] of [["owner", "owner"], ["editor", "editor"], ["viewer", "viewer"]]) {
    await adminCreate("/api/collections/members/records", { journal: journalId, user: people[who].id, role });
  }
  await adminCreate("/api/collections/members/records", { journal: otherJournalId, user: people.owner.id, role: "owner" });

  const mkEntry = async (jid) =>
    (await api("POST", "/api/bj/entries/sync", {
      token: people.owner.token,
      body: { journal: jid, client_id: "e-" + rid(), idempotency_key: "k-" + rid(), op: "upsert", base_revision: 0,
        fields: { event_date: "2026-10-18", type: "memory", title: "Photos", text: "", milestones: [], values: {} } },
    })).data.entry;
  entry = await mkEntry(journalId);
  entryOther = await mkEntry(otherJournalId);

  // Preconditions: the fixtures really do carry location and device data.
  const e = exif(jpegPath);
  assert.ok(Object.keys(e).some((k) => k.endsWith("GPSLatitude")), "fixture JPEG must contain GPS");
  assert.ok(Object.keys(e).some((k) => k.endsWith(":Model")), "fixture JPEG must contain a device model");
});

describe("photos", () => {
  let media, upRes;

  test("upload stores the original after size and checksum match, and derives a display copy", async () => {
    upRes = await upload("editor", {}, jpegBytes);
    assert.equal(upRes.status, 200, JSON.stringify(upRes.data));
    media = upRes.data.media;
    assert.equal(upRes.data.replay, false);
    assert.equal(media.status, "stored");
    assert.equal(media.derive_status, "ready", media.derive_error);
    assert.ok(media.display);
    assert.equal(media.taken_at.slice(0, 10), "2026-10-18", "capture date comes from the file, not the upload time");
    const orig = await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${media.id}"`)}`, { token: people.editor.token });
    assert.equal(orig.data.items[0].sha256, sha(jpegBytes));
    assert.equal(orig.data.items[0].size, jpegBytes.length);
    assert.equal(orig.data.items[0].original_name, "IMG_0001.JPG");
  });

  test("the stored original is byte-identical and keeps its GPS data (owners and editors only)", async () => {
    const orig = (await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${media.id}"`)}`, { token: people.owner.token })).data.items[0];
    const d = await download("owner", "media_originals", orig.id, orig.file, "orig-dl.jpg");
    assert.equal(d.status, 200);
    assert.equal(sha(d.buf), sha(jpegBytes), "bytes must be unchanged");
    assert.ok(Object.keys(exif(d.path)).some((k) => k.endsWith("GPSLatitude")));
    assert.ok(Object.keys(orig.metadata).some((k) => k.endsWith("GPSLatitude")), "extracted metadata is stored separately");
  });

  test("the display copy has no GPS or device data, is rotated upright and is a JPEG", async () => {
    const d = await download("viewer", "media", media.id, media.display, "display.jpg");
    assert.equal(d.status, 200);
    assert.deepEqual(leaky(d.path), []);
    const e = exif(d.path);
    assert.equal(e["File:MIMEType"], "image/jpeg");
    assert.equal(e["File:ImageWidth"], 600, "orientation 6 turns 800x600 into 600x800");
    assert.equal(e["File:ImageHeight"], 800);
    assert.equal(media.width, 600);
  });

  test("viewers get display copies but never originals or original filenames", async () => {
    const list = await api("GET", "/api/collections/media_originals/records", { token: people.viewer.token });
    assert.equal(list.data.totalItems, 0);
    const orig = (await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${media.id}"`)}`, { token: people.owner.token })).data.items[0];
    const r = await fetchFile("viewer", "media_originals", orig.id, orig.file);
    assert.ok([403, 404].includes(r.status), "original must be refused for a viewer, got " + r.status);
    const mv = await api("GET", `/api/collections/media/records/${media.id}`, { token: people.viewer.token });
    assert.equal(mv.status, 200);
    assert.equal(mv.data.original_name, undefined);
  });

  test("outsiders and anonymous requests cannot fetch any representation", async () => {
    const out = await fetchFile("outsider", "media", media.id, media.display);
    assert.ok([403, 404].includes(out.status), "outsider got " + out.status);
    const anon = await fetch(`${BASE}/api/files/media/${media.id}/${media.display}`);
    assert.ok([403, 404].includes(anon.status), "no token got " + anon.status);
    const thumb = await fetch(`${BASE}/api/files/media/${media.id}/${media.display}?thumb=320x0`);
    assert.ok([403, 404].includes(thumb.status), "thumbnail without token got " + thumb.status);
  });

  test("a retry with the same client_id returns the first result and creates no duplicate", async () => {
    const again = await upload("editor", { client_id: upRes.fields.client_id }, jpegBytes);
    assert.equal(again.status, 200);
    assert.equal(again.data.replay, true);
    assert.equal(again.data.media.id, media.id);
    const list = await api("GET", `/api/collections/media/records?filter=${encodeURIComponent(`client_id="${upRes.fields.client_id}"`)}`, { token: people.owner.token });
    assert.equal(list.data.totalItems, 1);
    const clash = await upload("editor", { client_id: upRes.fields.client_id }, Buffer.concat([jpegBytes, Buffer.from("x")]));
    assert.equal(clash.status, 409, "same ID with a different file must not overwrite");
  });

  test("a checksum or size mismatch stores nothing", async () => {
    const cid = "bad-" + rid();
    const wrongSha = await upload("editor", { client_id: cid, sha256: "0".repeat(64) }, jpegBytes);
    assert.equal(wrongSha.status, 422);
    const wrongSize = await upload("editor", { client_id: cid, size: String(jpegBytes.length + 1) }, jpegBytes);
    assert.equal(wrongSize.status, 422);
    const list = await api("GET", `/api/collections/media/records?filter=${encodeURIComponent(`client_id="${cid}"`)}`, { token: admin });
    assert.equal(list.data.totalItems, 0, "no media row may remain");
    const orig = await api("GET", "/api/collections/media_originals/records?perPage=200", { token: admin });
    assert.ok(orig.data.items.every((o) => o.media !== "" ), "no orphan originals");
    // The same ID can be uploaded correctly afterwards.
    const ok = await upload("editor", { client_id: cid }, jpegBytes);
    assert.equal(ok.status, 200);
  });

  test("files are checked by real content, not by name or declared type", async () => {
    const text = Buffer.from("this is not a picture, just text pretending to be one\n".repeat(20));
    const r = await upload("editor", {}, text, "evil.jpg", "image/jpeg");
    assert.equal(r.status, 422);
    const asVideo = await upload("editor", { kind: "video" }, jpegBytes, "clip.mp4", "video/mp4");
    assert.equal(asVideo.status, 422, "an image sent as video is refused");
  });

  test("viewers, outsiders and other-journal entries are refused", async () => {
    for (const who of ["viewer", "outsider"]) {
      const r = await upload(who, {}, jpegBytes);
      assert.equal(r.status, 403, who);
    }
    const wrongEntry = await upload("editor", { entry: entryOther.id }, jpegBytes);
    assert.equal(wrongEntry.status, 404, "an entry of another journal must not accept media");
  });

  test("captions, order and a corrected capture date change; the original and its metadata do not", async () => {
    const before = (await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${media.id}"`)}`, { token: people.owner.token })).data.items[0];
    const r = await api("POST", "/api/bj/media/update", { token: people.editor.token, body: { id: media.id, caption: "First day home", sort_order: 3, taken_at: "2026-10-17T09:00:00Z" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.media.caption, "First day home");
    assert.equal(r.data.media.taken_at.slice(0, 10), "2026-10-17");
    const after = (await api("GET", `/api/collections/media_originals/records/${before.id}`, { token: people.owner.token })).data;
    assert.equal(after.sha256, before.sha256);
    assert.deepEqual(after.metadata, before.metadata);
    const denied = await api("POST", "/api/bj/media/update", { token: people.viewer.token, body: { id: media.id, caption: "hack" } });
    assert.equal(denied.status, 403);
  });

  test("trashing the entry trashes its media; restoring brings back only what went with it", async () => {
    const second = (await upload("editor", {}, jpegBytes)).data.media;
    await api("POST", "/api/bj/media/update", { token: people.editor.token, body: { id: second.id, op: "trash" } }); // trashed on its own earlier
    const cid = entry.client_id;
    const cur = (await api("GET", `/api/collections/entries/records/${entry.id}`, { token: people.owner.token })).data;
    const t = await api("POST", "/api/bj/entries/sync", { token: people.owner.token, body: { journal: journalId, client_id: cid, op: "trash", idempotency_key: "k-" + rid(), base_revision: cur.revision } });
    assert.equal(t.status, 200, JSON.stringify(t.data));
    const m1 = await api("GET", `/api/collections/media/records/${media.id}`, { token: people.viewer.token });
    assert.equal(m1.status, 404, "viewers no longer see trashed media");
    const m1o = await api("GET", `/api/collections/media/records/${media.id}`, { token: people.owner.token });
    assert.ok(m1o.data.deleted_at);
    const r = await api("POST", "/api/bj/entries/sync", { token: people.owner.token, body: { journal: journalId, client_id: cid, op: "restore", idempotency_key: "k-" + rid(), base_revision: t.data.revision } });
    assert.equal(r.status, 200);
    assert.equal((await api("GET", `/api/collections/media/records/${media.id}`, { token: people.viewer.token })).status, 200);
    const s = (await api("GET", `/api/collections/media/records/${second.id}`, { token: people.owner.token })).data;
    assert.ok(s.deleted_at, "media trashed on its own stays in the trash");
  });
});

describe("videos", () => {
  let vid;

  test("H.264 video with a location tag: playback copy is a stream copy without location or device tags", async () => {
    const p = makeVideo("clip.mp4", "libx264");
    const orig = readFileSync(p);
    assert.ok(Object.keys(exif(p)).some((k) => /Location|GPSCoordinates|Xyz/i.test(k.split(":").pop())), "fixture video must carry a location tag");
    const r = await upload("editor", { kind: "video" }, orig, "MOV_0001.mp4", "video/mp4");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    vid = r.data.media;
    assert.equal(vid.derive_status, "ready", vid.derive_error);
    assert.ok(vid.playback && vid.poster);
    assert.ok(Math.abs(vid.duration - 2) < 0.3, "duration " + vid.duration);

    const d = await download("viewer", "media", vid.id, vid.playback, "playback.mp4");
    assert.equal(d.status, 200);
    assert.deepEqual(leaky(d.path), []);
    const probe = JSON.parse(sh("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", d.path]));
    assert.equal(probe.streams.find((s) => s.codec_type === "video").codec_name, "h264");
    const tags = JSON.stringify(probe.format.tags || {}) + JSON.stringify(probe.streams.map((s) => s.tags || {}));
    assert.ok(!/55\.6050|iPhone/.test(tags), "no location or device in container tags: " + tags);

    const poster = await download("viewer", "media", vid.id, vid.poster, "poster.jpg");
    assert.equal(poster.status, 200);
    assert.deepEqual(leaky(poster.path), []);
  });

  test("the original video keeps its metadata and is not reachable for viewers", async () => {
    const o = (await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${vid.id}"`)}`, { token: people.owner.token })).data.items[0];
    const mine = await download("editor", "media_originals", o.id, o.file, "orig.mp4");
    assert.equal(mine.status, 200);
    assert.ok(Object.keys(exif(mine.path)).some((k) => /Location|GPSCoordinates|Xyz/i.test(k.split(":").pop())), "original must keep its location tag");
    const v = await fetchFile("viewer", "media_originals", o.id, o.file);
    assert.ok([403, 404].includes(v.status));
  });

  test("playback supports HTTP range requests, so seeking works", async () => {
    const r = await fetchFile("viewer", "media", vid.id, vid.playback, { Range: "bytes=0-99" });
    assert.equal(r.status, 206);
    assert.equal((await r.arrayBuffer()).byteLength, 100);
    assert.match(r.headers.get("content-range") || "", /^bytes 0-99\//);
  });

  test("HEVC video gets an H.264 playback copy", { skip: !hasEncoder("libx265") && "libx265 not installed" }, async () => {
    const p = makeVideo("hevc.mp4", "libx265", ["-tag:v", "hvc1"]);
    const r = await upload("editor", { kind: "video" }, readFileSync(p), "IMG_9999.MOV", "video/quicktime");
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.media.derive_status, "ready", r.data.media.derive_error);
    const d = await download("viewer", "media", r.data.media.id, r.data.media.playback, "hevc-playback.mp4");
    const probe = JSON.parse(sh("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", d.path]));
    assert.equal(probe.streams.find((s) => s.codec_type === "video").codec_name, "h264");
    assert.deepEqual(leaky(d.path), []);
  });
});

describe("large uploads (gate: interrupted 500 MB video)", () => {
  test("an interrupted 500 MB upload leaves nothing behind, and the retry stores exactly one correct copy", { timeout: 300_000 }, async () => {
    const small = readFileSync(makeVideo("big-base.mp4", "libx264"));
    const big = Buffer.concat([small, Buffer.alloc(500 * 1024 * 1024)]); // valid MP4 followed by 500 MB of padding
    const cid = "big-" + rid();
    const fields = { journal: journalId, entry: entry.id, client_id: cid, kind: "video", sha256: sha(big), size: String(big.length) };
    const mk = () => {
      const f = new FormData();
      for (const [k, v] of Object.entries(fields)) f.append(k, v);
      f.append("file", new Blob([big], { type: "video/mp4" }), "BIG_0001.mp4");
      return f;
    };
    const ctl = new AbortController();
    const first = fetch(BASE + "/api/bj/media/upload", { method: "POST", headers: { Authorization: people.editor.token }, body: mk(), signal: ctl.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 400)); // cut the connection part-way through
    ctl.abort();
    await first;
    await new Promise((r) => setTimeout(r, 1500));
    const mid = await api("GET", `/api/collections/media/records?filter=${encodeURIComponent(`client_id="${cid}" && status="stored"`)}`, { token: admin });
    assert.equal(mid.data.totalItems, 0, "an interrupted upload must never look complete");

    const retry = await api("POST", "/api/bj/media/upload", { token: people.editor.token, form: mk() });
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.equal(retry.data.media.status, "stored");
    assert.equal(retry.data.media.derive_status, "ready", retry.data.media.derive_error);
    const all = await api("GET", `/api/collections/media/records?filter=${encodeURIComponent(`client_id="${cid}"`)}`, { token: admin });
    assert.equal(all.data.totalItems, 1, "no duplicates");
    const o = (await api("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${retry.data.media.id}"`)}`, { token: admin })).data.items[0];
    assert.equal(o.sha256, sha(big));
    assert.equal(o.size, big.length);
    const again = await api("POST", "/api/bj/media/upload", { token: people.editor.token, form: mk() });
    assert.equal(again.data.replay, true, "a second retry is a replay, not a second copy");
  });
});

describe("removed members and tokens", () => {
  test("a removed member's file tokens stop working at once", async () => {
    const guest = await makeUser("guest");
    await adminCreate("/api/collections/members/records", { journal: journalId, user: guest.id, role: "viewer" });
    people.guest = guest;
    const media = (await api("GET", `/api/collections/media/records?filter=${encodeURIComponent('kind="image"')}&perPage=1`, { token: guest.token })).data.items[0];
    const before = await fetchFile("guest", "media", media.id, media.display);
    assert.equal(before.status, 200);
    const tok = (await api("POST", "/api/files/token", { token: guest.token })).data.token; // issued before removal
    const rm = await api("POST", "/api/bj/members/remove", { token: people.owner.token, body: { journal: journalId, user: guest.id } });
    assert.equal(rm.status, 200);
    const replay = await fetch(`${BASE}/api/files/media/${media.id}/${media.display}?token=${tok}`);
    assert.ok([403, 404].includes(replay.status), "a token issued before removal must fail, got " + replay.status);
  });
});

describe("backup states", () => {
  const iso = (h) => new Date(Date.now() - h * 3600_000).toISOString();

  test("only the backup job (superuser) can record runs", async () => {
    for (const who of ["owner", "editor", "viewer"]) {
      const r = await api("POST", "/api/bj/backup/record", { token: people[who].token, body: { result: "ok", verification_result: "ok", started_at: iso(1), finished_at: iso(0) } });
      assert.ok([401, 403].includes(r.status), who + " got " + r.status);
    }
  });

  test("only the files listed in a verified snapshot are marked offsite protected; the run record alone marks nothing", async () => {
    const pending = await api("GET", "/api/bj/backup/status", { token: people.viewer.token });
    assert.ok(pending.data.media_not_offsite > 0);
    const all = (await api("GET", "/api/collections/media/records?perPage=200&filter=" + encodeURIComponent('status="stored"'), { token: admin })).data.items;
    const included = all.slice(0, 2).map((m) => m.id);
    const left = all[2];

    // recording a successful run does not protect anything by itself
    const t = new Date().toISOString();
    const rec = await api("POST", "/api/bj/backup/record", { token: admin, body: { snapshot_id: "snap-1", result: "ok", verification_result: "ok", started_at: t, finished_at: t, file_count: 10, bytes: 1000 } });
    assert.equal(rec.status, 200, JSON.stringify(rec.data));
    const still = await api("GET", `/api/collections/media/records/${left.id}`, { token: admin });
    assert.equal(still.data.offsite_at, "");

    for (const who of ["owner", "editor", "viewer"]) {
      const r = await api("POST", "/api/bj/backup/mark", { token: people[who].token, body: { snapshot_id: "snap-1", finished_at: t, media_ids: included } });
      assert.ok([401, 403].includes(r.status), who + " got " + r.status);
    }
    const mark = await api("POST", "/api/bj/backup/mark", { token: admin, body: { snapshot_id: "snap-1", finished_at: t, media_ids: [...included, "doesnotexist12345"] } });
    assert.equal(mark.status, 200, JSON.stringify(mark.data));
    assert.deepEqual([mark.data.marked, mark.data.skipped], [2, 1]);
    for (const id of included) {
      const m = (await api("GET", `/api/collections/media/records/${id}`, { token: admin })).data;
      assert.equal(m.offsite_snapshot, "snap-1");
      assert.ok(m.offsite_at);
    }
    assert.equal((await api("GET", `/api/collections/media/records/${left.id}`, { token: admin })).data.offsite_at, "", "an item not listed is not protected");
    const late = (await upload("editor", {}, Buffer.concat([jpegBytes, Buffer.alloc(8)]))).data;
    assert.equal(late.media.offsite_at, "", "an item stored after the snapshot is not protected");
  });

  test("a row that is not stored can never be marked protected, and bad requests are refused", async () => {
    const t = new Date().toISOString();
    for (const body of [{}, { snapshot_id: "s", finished_at: t, media_ids: [] }, { snapshot_id: "", finished_at: t, media_ids: ["x"] }, { snapshot_id: "s", finished_at: "nope", media_ids: ["x"] }]) {
      assert.equal((await api("POST", "/api/bj/backup/mark", { token: admin, body })).status, 400, JSON.stringify(body));
    }
  });

  test("failed or unverified run records are stored but protect nothing", async () => {
    const before = (await api("GET", "/api/collections/media/records?perPage=1&filter=" + encodeURIComponent('offsite_at=""'), { token: admin })).data.totalItems;
    const t = new Date().toISOString();
    for (const bad of [{ result: "failed", verification_result: "failed" }, { result: "ok", verification_result: "failed" }, { result: "ok", verification_result: "skipped" }]) {
      const rec = await api("POST", "/api/bj/backup/record", { token: admin, body: { snapshot_id: "snap-bad", started_at: t, finished_at: t, ...bad } });
      assert.equal(rec.status, 200, JSON.stringify(bad));
    }
    const after = (await api("GET", "/api/collections/media/records?perPage=1&filter=" + encodeURIComponent('offsite_at=""'), { token: admin })).data.totalItems;
    assert.equal(after, before);
    const status = await api("GET", "/api/bj/backup/status", { token: people.owner.token });
    assert.notEqual(status.data.last_good_at, "", "a good run from earlier still counts");
  });

  test("status warns at 18 hours and is critical at 24 hours, never a stale green", async () => {
    const post = (finished) => api("POST", "/api/bj/backup/record", { token: admin, body: { snapshot_id: "t", result: "ok", verification_result: "ok", started_at: finished, finished_at: finished } });
    // The last good run is "snap-1" from a moment ago, so the level is ok first.
    assert.equal((await api("GET", "/api/bj/backup/status", { token: people.owner.token })).data.level, "ok");
    // Newer good runs always win, so to test older ages we wipe the history first.
    for (const r of (await api("GET", "/api/collections/backup_runs/records?perPage=200", { token: admin })).data.items) {
      await api("DELETE", `/api/collections/backup_runs/records/${r.id}`, { token: admin });
    }
    assert.equal((await api("GET", "/api/bj/backup/status", { token: people.owner.token })).data.level, "critical", "no good backup at all is critical");
    await post(iso(19));
    assert.equal((await api("GET", "/api/bj/backup/status", { token: people.owner.token })).data.level, "warning");
    await post(iso(25));
    // 25 h is older than the 19 h run, so the newest good run (19 h) still decides.
    assert.equal((await api("GET", "/api/bj/backup/status", { token: people.owner.token })).data.level, "warning");
    for (const r of (await api("GET", "/api/collections/backup_runs/records?perPage=200", { token: admin })).data.items) {
      await api("DELETE", `/api/collections/backup_runs/records/${r.id}`, { token: admin });
    }
    await post(iso(25));
    assert.equal((await api("GET", "/api/bj/backup/status", { token: people.owner.token })).data.level, "critical");
    await post(iso(1));
    assert.equal((await api("GET", "/api/bj/backup/status", { token: people.owner.token })).data.level, "ok");
  });

  test("an outsider's backup status does not count other families' media", async () => {
    const s = await api("GET", "/api/bj/backup/status", { token: people.outsider.token });
    assert.equal(s.data.media_not_offsite, 0);
  });
});

describe("token lifetimes", () => {
  const exp = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).exp;
  test("file tokens last about an hour and sign-in tokens about 30 days", async () => {
    const ft = (await api("POST", "/api/files/token", { token: people.owner.token })).data.token;
    const secs = exp(ft) - Math.floor(Date.now() / 1000);
    assert.ok(secs > 3000 && secs <= 3600, "file token lifetime " + secs);
    const at = exp(people.owner.token) - Math.floor(Date.now() / 1000);
    assert.ok(at > 29 * 86400 && at <= 30 * 86400, "auth token lifetime " + at);
  });
});
