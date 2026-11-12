// Monitor tests (architecture v7, 6.8, 7.3, 10): every threshold, the alert throttling, capacity projection and the report.
import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const E = process.env;
const group = (name, fn) => (!E.ONLY || new RegExp(E.ONLY, "i").test(name) ? describe(name, fn) : describe.skip(name, fn));
const MONITOR = join(E.OPS_DIR, "bj_monitor.py");
const W = mkdtempSync(join(tmpdir(), "bj-mon-"));
const BIN = join(W, "bin"); mkdirSync(BIN);
const T0 = "2026-11-10T12:00:00Z";
const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);
const plus = (iso, hours) => new Date(Date.parse(iso) + hours * 3600_000).toISOString();

// fake system commands: they print whatever the test last wrote into their data file
const fake = (name, body) => { writeFileSync(join(BIN, name), `#!/bin/bash\n${body}\n`); chmodSync(join(BIN, name), 0o755); };
const data = (name, text) => writeFileSync(join(W, name), text);
fake("wg", `cat "${W}/wg.txt"; exit $(cat "${W}/wg.code" 2>/dev/null || echo 0)`);
fake("smartctl", `cat "${W}/smart.txt"`);
fake("tmutil", `cat "${W}/tm.txt"; exit $(cat "${W}/tm.code" 2>/dev/null || echo 0)`);
fake("openssl", `if [ "$1" = "s_client" ]; then echo "CERT"; else cat "${W}/cert.txt"; fi`);
fake("diskutil", `echo "   SMART Status:             Not Supported"`);

// The fake health endpoint runs in its own process: spawnSync blocks this one, so a server here could not answer.
const flag = join(W, "health-down");
const healthServer = spawn("node", ["-e", `const fs=require("fs");require("http").createServer((q,r)=>{r.statusCode=fs.existsSync(${JSON.stringify(flag)})?503:200;r.end("{}")}).listen(0,"127.0.0.1",function(){console.log(this.address().port)})`], { stdio: ["ignore", "pipe", "inherit"] });
let healthPort = 0;
const setHealthy = (ok) => (ok ? rmSync(flag, { force: true }) : writeFileSync(flag, "x"));
let state, alertLog;

before(async () => { healthPort = await new Promise((r) => healthServer.stdout.once("data", (d) => r(Number(String(d).trim())))); writeFileSync(join(W, "alert.sh"), `#!/bin/bash\necho "$1 $2" >> "${join(W, "alerts.log")}"\n`, { mode: 0o755 }); });

beforeEach(() => {
  rmSync(join(W, "state"), { recursive: true, force: true });
  rmSync(join(W, "alerts.log"), { force: true });
  state = join(W, "state");
  alertLog = join(W, "alerts.log");
  setHealthy(true);
  mkdirSync(join(W, "vol"), { recursive: true });
  writeFileSync(join(W, "vol", ".marker"), "x");
  data("wg.txt", `PUBKEY\t${epoch(T0) - 60}\n`); data("wg.code", "0");
  data("smart.txt", "SMART overall-health self-assessment test result: PASSED\n");
  data("tm.txt", "/Volumes/TM/Backups.backupdb/Mac/2026-11-10-070000\n"); data("tm.code", "0");
  data("cert.txt", "notAfter=Feb  8 12:00:00 2027 GMT\n");
});

const alerts = () => (existsSync(alertLog) ? readFileSync(alertLog, "utf8").trim().split("\n").filter(Boolean) : []);
function monitor(cmd, over = {}, now = T0) {
  if (now !== T0 && !over.KEEP_WG) data("wg.txt", `PUBKEY\t${epoch(now) - 60}\n`); // the tunnel keeps shaking hands as the simulated clock moves
  delete over.KEEP_WG;
  const env = {
    PATH: BIN + ":" + process.env.PATH, BJ_DATA_DIR: join(W, "vol"), BJ_STATE_DIR: state, BJ_ALERT_CMD: join(W, "alert.sh"),
    BJ_PB_HEALTH_URL: `http://127.0.0.1:${healthPort}/api/health`, BJ_DATA_MARKER: join(W, "vol", ".marker"),
    BJ_SMART_DEVICE: "/dev/fake", BJ_CERT_HOST: "journal.test", BJ_CERT_ADDR: "127.0.0.1:443", BJ_WG_INTERFACE: "wg0", BJ_TIME_MACHINE: "1",
    BJ_TEST_DISK_PERCENT: "40", ...over,
  };
  return spawnSync("python3", [MONITOR, "--now", now, cmd], { env, encoding: "utf8" });
}

group("continuous checks and alert throttling", () => {
  test("everything healthy: no alert, exit 0, every check listed", () => {
    const r = monitor("check");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const name of ["pocketbase", "ssd", "disk", "smart", "certificate", "wireguard", "timemachine"]) assert.match(r.stdout, new RegExp(name + "\\s+ok"));
    assert.deepEqual(alerts(), []);
  });

  test("disk: warning at 70%, critical at 85%, no repeats, a reminder after 6 h, and an all-clear when it recovers", () => {
    monitor("check", { BJ_TEST_DISK_PERCENT: "69" });
    assert.deepEqual(alerts(), []);
    monitor("check", { BJ_TEST_DISK_PERCENT: "72" });
    assert.match(alerts().pop(), /^warning disk: Disk is 72% full \(warning at 70%\)/);
    const n = alerts().length;
    monitor("check", { BJ_TEST_DISK_PERCENT: "73" }, plus(T0, 1));
    assert.equal(alerts().length, n, "a warning is not repeated");
    monitor("check", { BJ_TEST_DISK_PERCENT: "86" }, plus(T0, 2));
    assert.match(alerts().pop(), /^critical disk: Disk is 86% full/);
    const m = alerts().length;
    monitor("check", { BJ_TEST_DISK_PERCENT: "86" }, plus(T0, 5));
    assert.equal(alerts().length, m, "no repeat within 6 hours");
    monitor("check", { BJ_TEST_DISK_PERCENT: "86" }, plus(T0, 9));
    assert.equal(alerts().length, m + 1, "a reminder after 6 hours while critical");
    monitor("check", { BJ_TEST_DISK_PERCENT: "50" }, plus(T0, 10));
    assert.match(alerts().pop(), /^info disk is back to normal/);
  });

  test("the SSD missing and PocketBase down are critical at once", () => {
    rmSync(join(W, "vol", ".marker"));
    setHealthy(false);
    const r = monitor("check");
    assert.equal(r.status, 2);
    const a = alerts().join("\n");
    assert.match(a, /critical ssd: The external SSD is missing/);
    assert.match(a, /critical pocketbase: PocketBase health answered 503/);
  });

  test("drive health: a SMART failure is critical; a drive without SMART data is skipped, not alarming", () => {
    data("smart.txt", "SMART overall-health self-assessment test result: FAILED!\n");
    monitor("check");
    assert.match(alerts().pop(), /^critical smart: The drive reports a SMART FAILURE/);
    rmSync(state, { recursive: true });
    const r = monitor("check", { BJ_SMART_DEVICE: "" }); // falls back to diskutil, which says Not Supported
    assert.match(r.stdout, /smart\s+skip/);
    assert.deepEqual(alerts().filter((l) => /smart/.test(l) && /failure/i.test(l)).length, 1, "only the earlier alert");
  });

  test("certificate: warns under 21 days, critical under 7, critical when unreadable", () => {
    data("cert.txt", "notAfter=Nov 30 12:00:00 2026 GMT\n"); // 20 days
    monitor("check");
    assert.match(alerts().pop(), /^warning certificate: The certificate expires in 20 days/);
    data("cert.txt", "notAfter=Nov 15 12:00:00 2026 GMT\n"); // 5 days
    monitor("check", {}, plus(T0, 1));
    assert.match(alerts().pop(), /^critical certificate: The certificate expires in 5 days/);
    data("cert.txt", "garbage\n");
    rmSync(state, { recursive: true });
    monitor("check");
    assert.match(alerts().pop(), /^critical certificate: Could not read the certificate/);
  });

  test("WireGuard: fine at 1 minute, warning past 5 minutes, critical past 15 or when it never connected or the interface is gone", () => {
    for (const [age, level] of [[60, null], [400, "warning"], [1000, "critical"]]) {
      rmSync(state, { recursive: true, force: true }); rmSync(alertLog, { force: true });
      data("wg.txt", `PUBKEY\t${epoch(T0) - age}\n`);
      monitor("check");
      if (!level) assert.deepEqual(alerts(), []); else assert.match(alerts().pop(), new RegExp(`^${level} wireguard`));
    }
    rmSync(state, { recursive: true }); data("wg.txt", "PUBKEY\t0\n");
    monitor("check"); assert.match(alerts().pop(), /^critical wireguard: The WireGuard tunnel has never completed a handshake/);
    rmSync(state, { recursive: true }); data("wg.txt", "wg: no such interface\n"); data("wg.code", "1");
    monitor("check"); assert.match(alerts().pop(), /^critical wireguard: WireGuard interface wg0 is not available/);
  });

  test("Time Machine: warns after 24 hours, critical after 72, skipped when not monitored", () => {
    data("tm.txt", "/Volumes/TM/Backups.backupdb/Mac/2026-11-09-050000\n"); // 31 h
    monitor("check"); assert.match(alerts().pop(), /^warning timemachine: The last Time Machine backup is 31 hours old/);
    data("tm.txt", "/Volumes/TM/Backups.backupdb/Mac/2026-11-06-050000\n"); // 103 h
    monitor("check", {}, plus(T0, 1)); assert.match(alerts().pop(), /^critical timemachine/);
    rmSync(state, { recursive: true }); rmSync(alertLog, { force: true });
    assert.match(monitor("check", { BJ_TIME_MACHINE: "" }).stdout, /timemachine\s+skip/);
    assert.deepEqual(alerts(), []);
  });

  test("a check that breaks is reported as such and never hides the other checks", () => {
    const r = monitor("check", { BJ_TEST_DISK_PERCENT: "not-a-number" });
    assert.match(r.stdout, /disk\s+warning\s+the disk check failed to run/);
    assert.match(r.stdout, /pocketbase\s+ok/);
    assert.match(alerts().join("\n"), /warning disk: the disk check failed to run/);
  });
});

import { after } from "node:test";
after(() => healthServer.kill());

group("capacity and the monthly report", () => {
  const seed = (rows) => { mkdirSync(state, { recursive: true }); writeFileSync(join(state, "capacity.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); };
  const TB = 2e12;

  test("a daily sample is stored once per day", () => {
    monitor("check"); monitor("check"); monitor("check", {}, plus(T0, 30));
    assert.equal(readFileSync(join(state, "capacity.jsonl"), "utf8").trim().split("\n").length, 2);
  });

  test("growth per month and the months left until 70% and 85%; an alert when 85% is under 6 months away", () => {
    seed([{ date: "2026-08-10", percent: 40, total: TB, used: 0.4 * TB }, { date: "2026-11-08", percent: 49, total: TB, used: 0.49 * TB }]);
    const r = monitor("capacity");
    assert.match(r.stdout, /disk 49% full; growing 60\.\d GB per month/);
    assert.match(r.stdout, /projected 70%: 7\.\d months, 85%: 12\.\d months/);
    assert.deepEqual(alerts(), []);
    seed([{ date: "2026-08-10", percent: 50, total: TB, used: 0.5 * TB }, { date: "2026-11-08", percent: 74, total: TB, used: 0.74 * TB }]);
    monitor("capacity");
    assert.match(alerts().pop(), /^warning At the current growth the disk reaches 85% in about \d+ months/);
    seed([{ date: "2026-11-08", percent: 40, total: TB, used: 1 }]);
    assert.match(monitor("capacity").stdout, /not enough samples/);
  });

  test("the monthly report lists what happened and marks what needs a decision", () => {
    const dataDir = join(W, "reportdata"); rmSync(dataDir, { recursive: true, force: true }); mkdirSync(dataDir);
    const sql = `CREATE TABLE backup_runs (result TEXT, verification_result TEXT, finished_at TEXT);
      CREATE TABLE media_originals (size INTEGER); CREATE TABLE media (status TEXT, offsite_at TEXT);
      CREATE TABLE entries (deleted_at TEXT, needs_review INTEGER);
      INSERT INTO backup_runs VALUES ('ok','ok','2026-11-09 03:20:00.000Z'),('ok','ok','2026-11-08 03:20:00.000Z'),('failed','failed','2026-11-07 03:20:00.000Z');
      INSERT INTO media_originals VALUES (5000000000),(7000000000);
      INSERT INTO media VALUES ('stored','2026-11-09'),('stored','');
      INSERT INTO entries VALUES ('',0),('',1),('2026-01-01',0);`;
    execFileSync("sqlite3", [join(dataDir, "data.db"), sql]);
    seed([{ date: "2026-08-10", percent: 40, total: TB, used: 0.4 * TB }, { date: "2026-11-08", percent: 49, total: TB, used: 0.49 * TB }]);
    mkdirSync(join(W, "exports", "2026-11-01"), { recursive: true });
    writeFileSync(join(state, "drill-20260801.json"), JSON.stringify({ ok: true, finished_at: "2026-08-01T05:00:00Z" }));
    writeFileSync(alertLog.replace("alerts.log", "alerts-test.log"), "2026-11-02T03:00:00Z [CRITICAL] backup failed\n2026-11-03T03:00:00Z [WARNING] disk\n2026-09-01T03:00:00Z [CRITICAL] old\n");
    const r = monitor("report", { BJ_DATA_DIR: dataDir, BJ_EXPORT_DIR: join(W, "exports"), BJ_ALERT_LOG: alertLog.replace("alerts.log", "alerts-test.log") });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const path = r.stdout.trim().split("\n").pop();
    assert.match(path, /monthly-2026-11\.md$/);
    const md = readFileSync(path, "utf8");
    assert.match(md, /Runs in the last 30 days: 3, verified ok: 2, failed: 1/);
    assert.match(md, /Last verified offsite backup: 2026-11-09 03:20/);
    assert.match(md, /not yet in a verified backup: 1 +\*\*ACT\*\*/);
    assert.match(md, /2 entries, 2 photos and videos \(12\.0 GB of originals\)/);
    assert.match(md, /waiting for a decision between two versions: 1 +\*\*ACT\*\*/);
    assert.match(md, /critical: 1, warning: 1, info: 0 +\*\*ACT: read the log\*\*/);
    assert.match(md, /Latest plain export: 2026-11-01/);
    assert.match(md, /Last restore drill: 2026-08-01 \(\d+ days ago\), passed/);
    assert.match(md, /Refresh the offline copy/);
  });

  test("an empty or unreadable database is reported as an action, not a crash", () => {
    const dataDir = join(W, "emptydata"); rmSync(dataDir, { recursive: true, force: true }); mkdirSync(dataDir);
    const r = monitor("report", { BJ_DATA_DIR: dataDir });
    assert.equal(r.status, 0);
    assert.match(readFileSync(r.stdout.trim().split("\n").pop(), "utf8"), /ACT: the database could not be read/);
  });
});
