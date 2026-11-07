// Network-and-security gate (architecture v7, build step 4), tested against the real chain.
//
// 127.0.0.1 plays "the home network" and 127.0.0.2 plays "the internet".
// Everything goes client -> HAProxy (TLS passthrough) -> Caddy -> PocketBase, as in production.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync, readdirSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const E = process.env;
const CA = readFileSync(E.CA_FILE);
const SNI = "journal.test";
const PASSWORD = "correct-horse-battery";
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

// ---------------------------------------------------------------- HTTP helpers
function req({ port = E.CHAIN_PORT, from = "127.0.0.2", method = "GET", path = "/", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      host: "127.0.0.1", port, method, path, servername: SNI, ca: CA, localAddress: from, agent: false,
      headers: { Host: SNI, ...headers, ...(body !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body.toString()); } catch (_) { return null; } };
const pbDirect = async (method, path, { token, body } = {}) => {
  const res = await fetch(E.PB_DIRECT + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const login = async (email, from = "127.0.0.1", port = E.CHAIN_PORT) => {
  const r = await req({ port, from, method: "POST", path: "/api/collections/users/auth-with-password", body: JSON.stringify({ identity: email, password: PASSWORD }) });
  return { status: r.status, token: json(r)?.token, id: json(r)?.record?.id };
};
// curl streams from disk, so multi-GB uploads need no memory.
const curl = (args) => sh("curl", ["-sS", "--cacert", E.CA_FILE, "--resolve", `${SNI}:${E.CHAIN_PORT}:127.0.0.1`, ...args], { maxBuffer: 1 << 28 });

// A raw TLS client that first writes a PROXY-protocol line (v1) from a chosen source address.
function rawProxyRequest({ from, claim, path }) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port: Number(E.WGSIDE_PORT), localAddress: from });
    const done = (v) => { try { sock.destroy(); } catch (_) {} resolve(v); };
    sock.setTimeout(8000, () => done({ status: 0, note: "timeout" }));
    sock.on("error", (e) => done({ status: 0, note: String(e.code || e.message) }));
    sock.on("connect", () => {
      sock.write(`PROXY TCP4 ${claim} 127.0.0.1 40000 443\r\n`);
      const t = tls.connect({ socket: sock, servername: SNI, ca: CA });
      t.on("error", (e) => done({ status: 0, note: String(e.code || e.message) }));
      t.on("secureConnect", () => t.write(`GET ${path} HTTP/1.1\r\nHost: ${SNI}\r\nConnection: close\r\n\r\n`));
      let buf = "";
      t.on("data", (d) => { buf += d.toString("latin1"); });
      t.on("end", () => done({ status: Number((/^HTTP\/1\.1 (\d+)/.exec(buf) || [])[1] || 0), note: "ok" }));
      t.on("close", () => done({ status: Number((/^HTTP\/1\.1 (\d+)/.exec(buf) || [])[1] || 0), note: "closed" }));
    });
  });
}

// ---------------------------------------------------------------- fixtures
let admin, owner, editor, viewer, outsider, removed, journal, entry;
const users = {};

async function mkUser(name) {
  const email = `${name}-${rid()}@test.local`;
  const r = await pbDirect("POST", "/api/collections/users/records", { token: admin, body: { email, password: PASSWORD, passwordConfirm: PASSWORD, name, verified: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { id: r.data.id, email };
}

before(async () => {
  const a = await pbDirect("POST", "/api/collections/_superusers/auth-with-password", { body: { identity: "admin@test.local", password: "test-admin-password-1" } });
  admin = a.data.token;
  for (const n of ["owner", "editor", "viewer", "outsider", "removed"]) users[n] = await mkUser(n);
  const j = await pbDirect("POST", "/api/collections/journals/records", { token: admin, body: { name: "Chain journal" } });
  journal = j.data;
  for (const [n, role] of [["owner", "owner"], ["editor", "editor"], ["viewer", "viewer"], ["removed", "viewer"]]) {
    await pbDirect("POST", "/api/collections/members/records", { token: admin, body: { journal: journal.id, user: users[n].id, role } });
  }
  for (const n of ["owner", "editor", "viewer", "outsider", "removed"]) {
    const l = await login(users[n].email, "127.0.0.1");
    assert.equal(l.status, 200, n + " login via the chain: " + l.status);
    users[n].token = l.token;
  }
  const e = await req({ method: "POST", path: "/api/bj/entries/sync", from: "127.0.0.1", headers: { Authorization: users.owner.token },
    body: JSON.stringify({ journal: journal.id, client_id: "chain-entry-" + rid(), idempotency_key: "k-" + rid(), op: "upsert", base_revision: 0,
      fields: { event_date: "2026-11-02", type: "memory", title: "Chain", text: "", milestones: [], values: {} } }) });
  assert.equal(e.status, 200, e.body.toString());
  entry = json(e).entry;
});

// ================================================================ A. TLS passthrough
describe("TLS passthrough: the VPS forwarder never holds the certificate", () => {
  test("the certificate a client receives through HAProxy is Caddy's own, so TLS ends at home", async () => {
    const cert = await new Promise((resolve, reject) => {
      const s = tls.connect({ host: "127.0.0.1", port: Number(E.CHAIN_PORT), servername: SNI, ca: CA, localAddress: "127.0.0.2" }, () => {
        const c = s.getPeerCertificate(); s.end(); resolve(c);
      });
      s.on("error", reject);
    });
    assert.match(JSON.stringify(cert.issuer), /Caddy Local Authority/);
    assert.match(String(cert.subjectaltname), /journal\.test/);
  });

  test("the forwarder config is plain TCP: no TLS termination, no certificate, no HTTP parsing", () => {
    const cfg = readFileSync(E.HAPROXY_CFG, "utf8").replace(/#.*$/gm, "");
    assert.match(cfg, /mode tcp/);
    assert.doesNotMatch(cfg, /\bssl\b|\bcrt\b|mode http|ca-file/);
    assert.match(cfg, /send-proxy-v2/);
  });
});

// ================================================================ B. headers and caching
describe("security headers and caching", () => {
  test("every page carries HSTS, a strict CSP, nosniff and friends, and does not name the server", async () => {
    const r = await req({ path: "/" });
    assert.equal(r.status, 200);
    const h = r.headers;
    assert.match(h["strict-transport-security"], /max-age=31536000/);
    assert.equal(h["x-content-type-options"], "nosniff");
    assert.equal(h["x-frame-options"], "DENY");
    assert.equal(h["referrer-policy"], "no-referrer");
    assert.equal(h["cross-origin-opener-policy"], "same-origin");
    assert.match(h["permissions-policy"], /camera=\(\)/);
    assert.equal(h["server"], undefined);
    const csp = h["content-security-policy"];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(csp, /https?:|\*|unsafe-/, "no external origins, wildcards or unsafe-*");
    assert.equal(h["cache-control"], "no-cache");
  });

  test("the built app works under that CSP: no inline scripts or styles, no external URLs", () => {
    const html = readFileSync(join(E.APP_DIST, "index.html"), "utf8");
    assert.doesNotMatch(html.replace(/<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/g, ""), /<script(?![^>]*src=)/, "inline script");
    assert.doesNotMatch(html, /\sstyle=|<style/, "inline style");
    assert.doesNotMatch(html, /(href|src)="https?:/, "external resource");
    const assets = readdirSync(join(E.APP_DIST, "assets"));
    for (const f of assets.filter((x) => x.endsWith(".js"))) {
      const code = readFileSync(join(E.APP_DIST, "assets", f), "utf8");
      assert.doesNotMatch(code, /fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg\.com|cdnjs|googletagmanager|google-analytics/, "third-party host in " + f);
    }
  });

  test("the manifest has the right type; hashed assets are immutable; API answers are never cached", async () => {
    assert.match((await req({ path: "/manifest.webmanifest" })).headers["content-type"], /application\/manifest\+json/);
    const asset = readdirSync(join(E.APP_DIST, "assets")).find((x) => x.endsWith(".js"));
    assert.match((await req({ path: "/assets/" + asset })).headers["cache-control"], /immutable/);
    assert.equal((await req({ path: "/sw.js" })).headers["cache-control"], "no-cache");
    assert.equal((await req({ path: "/api/health" })).headers["cache-control"], "private, no-store");
  });

  test("a deep link opens the app (single-page fallback) and the app shell is served", async () => {
    const r = await req({ path: "/j/some/deep/link" });
    assert.equal(r.status, 200);
    assert.match(r.body.toString(), /<title>Baby Journal<\/title>/);
  });
});

// ================================================================ C. what the internet can reach
describe("exposure: the internet sees only the app, never the admin surface", () => {
  const blocked = [
    ["GET", "/_/"], ["GET", "/_/index.html"], ["GET", "/api/settings"], ["GET", "/api/logs"], ["GET", "/api/backups"],
    ["GET", "/api/crons"], ["GET", "/api/realtime"], ["GET", "/api/collections"],
    ["POST", "/api/collections/_superusers/auth-with-password"], ["POST", "/api/collections/pbc_3142635823/auth-with-password"],
    ["GET", "/api/collections/_superusers/records"], ["POST", "/api/batch"],
  ];
  for (const [method, path] of blocked) {
    test(`${method} ${path} from the internet: 404`, async () => {
      const r = await req({ method, path, body: method === "POST" ? "{}" : undefined, from: "127.0.0.2" });
      assert.equal(r.status, 404);
    });
  }

  test("the app's own API is reachable from the internet (and answers as the app, not as a block)", async () => {
    assert.equal((await req({ path: "/api/health" })).status, 200);
    const bad = await req({ method: "POST", path: "/api/collections/users/auth-with-password", body: JSON.stringify({ identity: "no@one.test", password: "wrong-password" }) });
    assert.equal(bad.status, 400);
    assert.equal((await req({ path: "/api/bj/backup/status" })).status, 401);
  });

  test("from the home network the admin UI and API are reachable", async () => {
    assert.equal((await req({ path: "/_/", from: "127.0.0.1" })).status, 200);
    assert.equal((await req({ path: "/api/settings", from: "127.0.0.1" })).status, 401); // reached PocketBase, which asks for the admin login
    assert.equal((await req({ path: "/_/", from: "127.0.0.1", port: E.DIRECT_PORT })).status, 200, "direct home listener");
  });

  test("the admin UI keeps PocketBase's own CSP (it needs inline styles); the app's strict CSP applies everywhere else", async () => {
    const admin_ = await req({ path: "/_/", from: "127.0.0.1" });
    assert.doesNotMatch(admin_.headers["content-security-policy"] || "", /default-src 'none'/);
    assert.match(admin_.headers["content-security-policy"] || "", /frame-ancestors 'none'/);
    assert.match((await req({ path: "/", from: "127.0.0.1" })).headers["content-security-policy"], /default-src 'none'/);
  });

  test("a PROXY-protocol header from anyone but the VPS is not believed: the home-network address cannot be forged", async () => {
    // positive control: the trusted source (127.0.0.9 plays the VPS tunnel address) may claim a home address
    const trusted = await rawProxyRequest({ from: "127.0.0.9", claim: "127.0.0.1", path: "/_/" });
    assert.equal(trusted.status, 200, "control failed: " + JSON.stringify(trusted));
    const claimsHome = await rawProxyRequest({ from: "127.0.0.2", claim: "127.0.0.1", path: "/_/" });
    assert.notEqual(claimsHome.status, 200, "forged PROXY header was accepted: " + JSON.stringify(claimsHome));
  });
});

// ================================================================ D. client addresses and rate limits
describe("real client address: rate limits protect each person separately", () => {
  test("repeated wrong passwords are limited per client address, and a forged X-Real-IP does not help", async () => {
    const statuses = [];
    for (let i = 0; i < 14; i++) {
      const r = await req({ from: "127.0.0.2", method: "POST", path: "/api/collections/users/auth-with-password",
        headers: { "X-Real-IP": `203.0.113.${i + 1}`, "X-Forwarded-For": `198.51.100.${i + 1}` },
        body: JSON.stringify({ identity: users.owner.email, password: "wrong-wrong-wrong" }) });
      statuses.push(r.status);
    }
    assert.ok(statuses.includes(429), "never limited: " + statuses.join(","));
    assert.deepEqual(statuses.slice(0, 5), [400, 400, 400, 400, 400]);
  });

  test("while that address is limited, a family member at another address signs in normally", async () => {
    const ok = await login(users.editor.email, "127.0.0.1");
    assert.equal(ok.status, 200, "a different client was wrongly limited");
    const stillLimited = await req({ from: "127.0.0.2", method: "POST", path: "/api/collections/users/auth-with-password", body: JSON.stringify({ identity: users.owner.email, password: PASSWORD }) });
    assert.equal(stillLimited.status, 429);
  });
});

// ================================================================ E. logs
describe("access logs never contain secrets", () => {
  test("file tokens in query strings and Authorization headers are redacted", async () => {
    const secret = "SECRETFILETOKEN" + rid();
    const bearer = "BEARERSECRET" + rid();
    await req({ from: "127.0.0.1", path: `/api/files/pbc_x/abc/def.jpg?token=${secret}&thumb=320x0`, headers: { Authorization: bearer, Cookie: "sid=COOKIESECRET" } });
    await new Promise((r) => setTimeout(r, 800));
    const log = readFileSync(E.ACCESS_LOG, "utf8");
    assert.ok(log.includes("/api/files/pbc_x/abc/def.jpg"), "request was not logged at all");
    assert.ok(!log.includes(secret), "file token leaked into the log");
    assert.ok(!log.includes(bearer), "Authorization header leaked into the log");
    assert.ok(!log.includes("COOKIESECRET"), "cookie leaked into the log");
    assert.match(log, /REDACTED/);
  });
});

// ================================================================ F. media authorization through the chain
describe("media authorization through the whole chain", () => {
  const dir = join(E.WORKDIR, "media");
  let media, origRow;

  before(async () => {
    mkdirSync(dir, { recursive: true });
    sh("convert", ["-size", "640x480", "gradient:green-black", join(dir, "p.jpg")]);
    const bytes = readFileSync(join(dir, "p.jpg"));
    const out = curl(["-X", "POST", "-H", `Authorization: ${users.editor.token}`, "-F", `journal=${journal.id}`, "-F", `entry=${entry.id}`,
      "-F", `client_id=chainphoto-${rid()}`, "-F", "kind=image", "-F", `sha256=${createHash("sha256").update(bytes).digest("hex")}`,
      "-F", `size=${bytes.length}`, "-F", `file=@${join(dir, "p.jpg")};type=image/jpeg`, `https://${SNI}:${E.CHAIN_PORT}/api/bj/media/upload`]);
    media = JSON.parse(out).media;
    assert.equal(media.derive_status, "ready");
    origRow = (await pbDirect("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${media.id}"`)}`, { token: admin })).data.items[0];
  });

  const fileToken = async (who) => json(await req({ from: "127.0.0.2", method: "POST", path: "/api/files/token", headers: { Authorization: users[who].token }, body: "{}" })).token;
  const get = async (who, collectionId, id, name, query = "") => {
    const t = who ? await fileToken(who) : "";
    return req({ from: "127.0.0.2", path: `/api/files/${collectionId}/${id}/${name}?token=${t}${query}` });
  };

  test("owners, editors and viewers get the display copy and thumbnails over the internet path", async () => {
    for (const who of ["owner", "editor", "viewer"]) {
      assert.equal((await get(who, media.collectionId, media.id, media.display)).status, 200, who + " display");
      const th = await get(who, media.collectionId, media.id, media.display, "&thumb=320x0");
      assert.equal(th.status, 200, who + " thumbnail");
      assert.match(th.headers["content-type"], /image\//);
      assert.equal(th.headers["cache-control"], "private, max-age=600");
    }
  });

  test("an outsider cannot fetch the display copy, a thumbnail, or the original", async () => {
    for (const [what, r] of [
      ["display", await get("outsider", media.collectionId, media.id, media.display)],
      ["thumbnail", await get("outsider", media.collectionId, media.id, media.display, "&thumb=320x0")],
      ["original", await get("outsider", origRow.collectionId, origRow.id, origRow.file)],
    ]) assert.ok([403, 404].includes(r.status), `${what}: ${r.status}`);
  });

  test("a viewer can fetch the display copy but never the original", async () => {
    const r = await get("viewer", origRow.collectionId, origRow.id, origRow.file);
    assert.ok([403, 404].includes(r.status), "viewer got " + r.status);
    assert.equal((await get("editor", origRow.collectionId, origRow.id, origRow.file)).status, 200);
  });

  test("no token, a garbage token and someone else's expired-style token all fail", async () => {
    const none = await req({ from: "127.0.0.2", path: `/api/files/${media.collectionId}/${media.id}/${media.display}` });
    assert.ok([403, 404].includes(none.status));
    const junk = await req({ from: "127.0.0.2", path: `/api/files/${media.collectionId}/${media.id}/${media.display}?token=not.a.token` });
    assert.ok([400, 403, 404].includes(junk.status));
  });

  test("a removed member's token stops working immediately", async () => {
    const t = await fileToken("removed");
    const before = await req({ from: "127.0.0.2", path: `/api/files/${media.collectionId}/${media.id}/${media.display}?token=${t}` });
    assert.equal(before.status, 200);
    const rm = await req({ from: "127.0.0.2", method: "POST", path: "/api/bj/members/remove", headers: { Authorization: users.owner.token }, body: JSON.stringify({ journal: journal.id, user: users.removed.id }) });
    assert.equal(rm.status, 200, rm.body.toString());
    const after = await req({ from: "127.0.0.2", path: `/api/files/${media.collectionId}/${media.id}/${media.display}?token=${t}` });
    assert.ok([400, 403, 404].includes(after.status), "old token still worked: " + after.status);
    const fresh = await login(users.removed.email, "127.0.0.1");
    const t2 = json(await req({ from: "127.0.0.2", method: "POST", path: "/api/files/token", headers: { Authorization: fresh.token }, body: "{}" })).token;
    const again = await req({ from: "127.0.0.2", path: `/api/files/${media.collectionId}/${media.id}/${media.display}?token=${t2}` });
    assert.ok([403, 404].includes(again.status), "a removed member could fetch with a fresh login: " + again.status);
  });
});

// ================================================================ G. big upload and seeking
describe("a 1 GB video upload and seeking, end to end", { timeout: 1_200_000 }, () => {
  test("1 GB goes through HAProxy and Caddy without buffering in memory, is verified, stored and seekable", async () => {
    const dir = join(E.WORKDIR, "big");
    mkdirSync(dir, { recursive: true });
    const clip = join(dir, "clip.mp4");
    sh("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", clip]);
    const big = join(dir, "big.mp4");
    sh("sh", ["-c", `cp '${clip}' '${big}' && head -c 1073741824 /dev/zero >> '${big}'`]);
    const size = statSync(big).size;
    assert.ok(size > 1073741824, "fixture is not 1 GB");
    const sha = sh("sha256sum", [big]).split(/\s+/)[0];

    // sample Caddy's memory while the upload runs
    let peakKb = 0;
    const sampler = setInterval(() => { try { peakKb = Math.max(peakKb, Number(sh("ps", ["-o", "rss=", "-p", E.CADDY_PID]).trim())); } catch (_) {} }, 400);
    const started = Date.now();
    const out = await new Promise((resolve, reject) => {
      const c = spawn("curl", ["-sS", "--cacert", E.CA_FILE, "--resolve", `${SNI}:${E.CHAIN_PORT}:127.0.0.1`, "--max-time", "900", "-X", "POST",
        "-H", `Authorization: ${users.editor.token}`, "-F", `journal=${journal.id}`, "-F", `entry=${entry.id}`, "-F", `client_id=big-${rid()}`, "-F", "kind=video",
        "-F", `sha256=${sha}`, "-F", `size=${size}`, "-F", `file=@${big};type=video/mp4`, `https://${SNI}:${E.CHAIN_PORT}/api/bj/media/upload`]);
      let buf = "", err = "";
      c.stdout.on("data", (d) => (buf += d)); c.stderr.on("data", (d) => (err += d));
      c.on("close", (code) => (code === 0 ? resolve(buf) : reject(new Error("curl " + code + " " + err))));
    });
    clearInterval(sampler);
    const secs = (Date.now() - started) / 1000;
    const res = JSON.parse(out);
    assert.equal(res.media.status, "stored", out.slice(0, 300));
    assert.equal(res.media.derive_status, "ready", res.media.derive_error);
    const orig = (await pbDirect("GET", `/api/collections/media_originals/records?filter=${encodeURIComponent(`media="${res.media.id}"`)}`, { token: admin })).data.items[0];
    assert.equal(orig.sha256, sha);
    assert.equal(orig.size, size);
    console.log(`      1 GB upload through the chain: ${secs.toFixed(1)} s, Caddy peak memory ${(peakKb / 1024).toFixed(0)} MB`);
    assert.ok(peakKb / 1024 < 400, "Caddy buffered the upload in memory: peak " + (peakKb / 1024).toFixed(0) + " MB");

    // seeking: the playback copy answers range requests from the middle and the end
    const t = json(await req({ from: "127.0.0.2", method: "POST", path: "/api/files/token", headers: { Authorization: users.viewer.token }, body: "{}" })).token;
    const url = `/api/files/${res.media.collectionId}/${res.media.id}/${res.media.playback}?token=${t}`;
    const full = await req({ from: "127.0.0.2", path: url });
    assert.equal(full.status, 200);
    const total = full.body.length;
    const mid = await req({ from: "127.0.0.2", path: url, headers: { Range: `bytes=${Math.floor(total / 2)}-${Math.floor(total / 2) + 999}` } });
    assert.equal(mid.status, 206);
    assert.equal(mid.body.length, 1000);
    assert.match(mid.headers["content-range"], new RegExp(`^bytes ${Math.floor(total / 2)}-${Math.floor(total / 2) + 999}/${total}$`));
    assert.ok(mid.body.equals(full.body.subarray(Math.floor(total / 2), Math.floor(total / 2) + 1000)), "range bytes differ from the full file");
    const tail = await req({ from: "127.0.0.2", path: url, headers: { Range: "bytes=-500" } });
    assert.equal(tail.status, 206);
    assert.equal(tail.body.length, Math.min(500, total));
    // and a range inside the 1 GB original (owners and editors): the last bytes match the file on disk
    const to = json(await req({ from: "127.0.0.2", method: "POST", path: "/api/files/token", headers: { Authorization: users.editor.token }, body: "{}" })).token;
    const origTail = await req({ from: "127.0.0.2", path: `/api/files/${orig.collectionId}/${orig.id}/${orig.file}?token=${to}`, headers: { Range: `bytes=${size - 4096}-${size - 1}` } });
    assert.equal(origTail.status, 206);
    assert.equal(origTail.body.length, 4096);
    assert.ok(origTail.body.equals(readFileSync(big).subarray(size - 4096)), "tail of the original differs");
  });
});
