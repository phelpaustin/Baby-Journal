import "fake-indexeddb/auto";
import { describe, test, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagnostics, summarizePerf, summarizeUploads, buildReport, reportText, median, TARGETS } from "../src/lib/diagnostics.js";
import { makeUser, makeJournal, device, fields, rid } from "./helpers.js";
import { fetchTransport } from "../src/lib/media.js";

const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const run = (scenario, timeline_ms, thumbs_ms = 1000) => ({ at: rid(), scenario, timeline_ms, thumbs_ms, thumbs_first_ms: thumbs_ms, thumbs: 4 });
const ups = (id, size, net, ...outcomes) => outcomes.map((outcome) => ({ id, size, kind: "video", net, outcome }));

describe("start-up timing against the targets", () => {
  test("median, worst and the pass or fail verdict per scenario", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(3); // rounds the middle pair
    expect(median([])).toBeNull();
    const warmOk = Array.from({ length: 10 }, (_, i) => run("warm", 1200 + i * 100)); // worst 2100
    const s = summarizePerf([...warmOk, run("cold", 4800), run("cold", 5200), run("cold", 4000)]);
    expect(s.warm).toMatchObject({ runs: 10, enough_runs: true, timeline_median_ms: 1650, timeline_worst_ms: 2100, timeline_pass: true });
    expect(s.cold).toMatchObject({ runs: 3, enough_runs: false, timeline_median_ms: 4800, timeline_pass: true });
    const warmBad = summarizePerf(Array.from({ length: 10 }, (_, i) => run("warm", i === 9 ? 3500 : 1000)));
    expect(warmBad.warm.timeline_pass).toBe(false); // median fine, but the worst run is over 3 s
    expect(summarizePerf([run("cold", 6000)]).cold.timeline_pass).toBe(false);
    expect(summarizePerf([]).warm.timeline_pass).toBeNull();
    expect(TARGETS.warm.timeline_median_ms).toBe(2000);
  });

  test("marks are recorded once, survive in storage, and a full or broken storage never throws", () => {
    const st = memStorage();
    let t = 0;
    const d = createDiagnostics({ storage: st, now: () => t });
    d.startRun("warm");
    t = 900; d.markTimeline(); t = 1500; d.markTimeline(); // second call ignored
    t = 1800; d.markThumbnail(); t = 2200; d.markThumbnail(); t = 2600; d.markThumbnail(); t = 3000; d.markThumbnail(); t = 9000; d.markThumbnail();
    const [r] = d.runs();
    expect(r).toMatchObject({ scenario: "warm", timeline_ms: 900, thumbs_first_ms: 1800, thumbs_ms: 3000, thumbs: 5 });
    expect(createDiagnostics({ storage: { getItem: () => "not json{", setItem: () => { throw new Error("quota"); } } }).runs()).toEqual([]);
    const nostore = createDiagnostics({});
    nostore.startRun("cold"); expect(() => nostore.markTimeline()).not.toThrow();
  });

  test("thumbnails before the timeline are ignored, and old runs are trimmed", () => {
    const d = createDiagnostics({ storage: memStorage(), now: () => 100 });
    d.startRun("cold"); d.markThumbnail();
    expect(d.runs()).toEqual([]);
    for (let i = 0; i < 70; i++) { d.startRun("cold"); d.markTimeline(); }
    expect(d.runs().length).toBeLessThanOrEqual(60);
  });
});

describe("upload thresholds", () => {
  test("a clean pilot does not require resumable uploads", () => {
    const events = Array.from({ length: 12 }, (_, i) => ups("f" + i, 5e6, "wifi", "done")).flat();
    const s = summarizeUploads(events);
    expect(s).toMatchObject({ files: 12, done: 12, failed: 0, restarted: 0, failure_or_restart_rate: 0, resumable_uploads_required: false });
  });

  test("more than 2 percent failed or restarted (over at least 10 files) requires resumable uploads", () => {
    const events = [...Array.from({ length: 9 }, (_, i) => ups("f" + i, 5e6, "wifi", "done")).flat(), ...ups("r", 5e6, "wifi", "network", "done")];
    const s = summarizeUploads(events);
    expect(s.restarted).toBe(1);
    expect(s.failure_or_restart_rate).toBeCloseTo(0.1);
    expect(s.over_threshold).toBe(true);
    expect(s.resumable_uploads_required).toBe(true);
    expect(summarizeUploads(ups("r", 5e6, "wifi", "network", "done")).over_threshold).toBe(false); // one file is not a sample
  });

  test("any file over 1 GB that failed or restarted on mobile data requires them, whatever the rate", () => {
    const ok = summarizeUploads([...ups("big", 2e9, "cellular", "network", "network")]);
    expect(ok.big_mobile_failures).toBe(1);
    expect(ok.resumable_uploads_required).toBe(true);
    const wifi = summarizeUploads(ups("big", 2e9, "wifi", "network", "network"));
    expect(wifi.big_mobile_failures).toBe(0);
    const doneFirst = summarizeUploads(ups("big", 2e9, "cellular", "done"));
    expect(doneFirst.big_mobile_failures).toBe(0);
    expect(summarizeUploads(ups("small", 5e7, "4g", "failed")).big_mobile_failures).toBe(0);
  });

  test("the copyable report names the verdicts in plain words", () => {
    const r = buildReport({ perf: [run("warm", 1000), run("cold", 7000)], uploads: ups("big", 2e9, "cellular", "failed"), device: { user_agent: "TestPhone", standalone: true, storage_persisted: true, net: "cellular" } });
    const text = reportText(r);
    expect(text).toMatch(/Warm start \(1 runs, need 10\)/);
    expect(text).toMatch(/Cold start.*MISSES TARGET/);
    expect(text).toMatch(/RESUMABLE UPLOADS ARE REQUIRED/);
    expect(text).toMatch(/Device: TestPhone/);
  });
});

describe("the upload queue reports each attempt", () => {
  let editor, journal, jpeg;
  beforeAll(async () => {
    editor = await makeUser("editor");
    journal = await makeJournal([[editor, "editor"]]);
    execFileSync("convert", ["-size", "320x240", "gradient:red-green", "/tmp/bj-diag.jpg"]);
    jpeg = readFileSync("/tmp/bj-diag.jpg");
  });

  test("a dropped connection then a success shows as one restarted file; the numbers feed the summary", async () => {
    const events = [];
    let calls = 0;
    const flaky = async (args) => { calls++; if (calls === 1) throw Object.assign(new Error("Network error"), { network: true }); return fetchTransport(args); };
    const d = await device(editor, { transport: flaky, onAttempt: (e) => events.push(e) });
    const cid = "c-" + rid();
    await d.engine.saveEntry(journal.id, cid, 0, fields());
    await d.engine.flush();
    await d.queue.add({ journal: journal.id, entryClientId: cid, file: new File([jpeg], "a.jpg", { type: "image/jpeg" }) });
    await d.queue.run(); await d.queue.run();
    expect(events.map((e) => e.outcome)).toEqual(["network", "done"]);
    expect(events.every((e) => e.size === jpeg.length && e.kind === "image" && e.ms >= 0)).toBe(true);
    const s = summarizeUploads(events);
    expect(s).toMatchObject({ files: 1, done: 1, failed: 0, restarted: 1 });
  });

  test("a file the server refuses is reported as failed", async () => {
    const events = [];
    const d = await device(editor, { onAttempt: (e) => events.push(e) });
    const cid = "c-" + rid();
    await d.engine.saveEntry(journal.id, cid, 0, fields());
    await d.engine.flush();
    await d.queue.add({ journal: journal.id, entryClientId: cid, file: new File([Buffer.from("not an image, just text\n".repeat(40))], "fake.jpg", { type: "image/jpeg" }) });
    await d.queue.run();
    expect(events.map((e) => e.outcome)).toEqual(["failed"]);
  });
});
