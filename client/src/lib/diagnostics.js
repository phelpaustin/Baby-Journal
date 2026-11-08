// Pilot diagnostics (architecture v7, section 4.1 performance test and section 14 resumable-upload
// thresholds). Everything stays on the phone: nothing is sent anywhere. A person copies the report and
// sends it to the journal owner.
//
//  - Start-up timing: app-start -> timeline-first-content -> first thumbnails, per scenario (cold or warm).
//  - Upload outcomes: attempts, restarts and failures per file, with the connection type and file size.
const RUNS_KEY = "bj.perf.runs";
const EVENTS_KEY = "bj.diag.events";
const MAX_RUNS = 60;
const MAX_EVENTS = 400;
const MOBILE_NET = ["cellular", "5g", "4g", "3g", "2g", "slow-2g"];
const GB = 1024 ** 3;

// Targets from the architecture document.
export const TARGETS = {
  cold: { timeline_median_ms: 5000 },
  warm: { timeline_median_ms: 2000, timeline_worst_ms: 3000 },
  thumbs_median_ms: 4000,
  max_failure_or_restart_rate: 0.02,
};

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function read(storage, key) {
  try {
    const v = JSON.parse(storage.getItem(key) || "[]");
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}
function write(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch (_) {} // full or blocked storage must never break the app
}

export function createDiagnostics({ storage, now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()), env = {} } = {}) {
  let current = null;
  const stor = storage || { getItem: () => null, setItem: () => {} };

  function startRun(scenario) {
    // performance.now() counts from the start of navigation, so the marks are "time until visible".
    current = { at: new Date().toISOString(), scenario, timeline_ms: null, thumbs_first_ms: null, thumbs_ms: null, thumbs: 0 };
    return current;
  }
  function save() {
    if (!current) return;
    const runs = read(stor, RUNS_KEY).filter((r) => r.at !== current.at);
    runs.push({ ...current });
    write(stor, RUNS_KEY, runs.slice(-MAX_RUNS));
  }
  function markTimeline() {
    if (!current || current.timeline_ms !== null) return;
    current.timeline_ms = Math.round(now());
    save();
  }
  // "First thumbnails of the first screen": the 1st is recorded, and the 4th (or the last one that
  // arrives within 10 seconds) counts as the screen being filled.
  function markThumbnail() {
    if (!current || current.timeline_ms === null) return;
    current.thumbs += 1;
    const t = Math.round(now());
    if (current.thumbs_first_ms === null) current.thumbs_first_ms = t;
    if (current.thumbs <= 4) current.thumbs_ms = t;
    save();
  }

  function recordUpload(ev) {
    const events = read(stor, EVENTS_KEY);
    events.push({ ts: new Date().toISOString(), net: env.net ? env.net() : "", ...ev });
    write(stor, EVENTS_KEY, events.slice(-MAX_EVENTS));
  }
  const runs = () => read(stor, RUNS_KEY);
  const events = () => read(stor, EVENTS_KEY);
  function clear() { write(stor, RUNS_KEY, []); write(stor, EVENTS_KEY, []); }

  return { startRun, markTimeline, markThumbnail, recordUpload, runs, events, clear };
}

export function summarizePerf(runs) {
  const out = {};
  for (const scenario of ["cold", "warm"]) {
    const rs = runs.filter((r) => r.scenario === scenario && r.timeline_ms !== null);
    const tl = rs.map((r) => r.timeline_ms);
    const th = rs.map((r) => r.thumbs_ms).filter((x) => x !== null);
    const t = TARGETS[scenario];
    const med = median(tl), worst = tl.length ? Math.max(...tl) : null, thMed = median(th);
    const pass = tl.length === 0 ? null : med <= t.timeline_median_ms && (t.timeline_worst_ms === undefined || worst <= t.timeline_worst_ms);
    out[scenario] = {
      runs: rs.length, enough_runs: rs.length >= 10, timeline_median_ms: med, timeline_worst_ms: worst,
      thumbs_median_ms: thMed, thumbs_pass: thMed === null ? null : thMed <= TARGETS.thumbs_median_ms, timeline_pass: pass,
    };
  }
  return out;
}

export function summarizeUploads(events) {
  const files = new Map();
  for (const e of events) {
    if (!e.id) continue;
    const f = files.get(e.id) || { id: e.id, size: e.size || 0, kind: e.kind, attempts: 0, outcomes: [], net: e.net || "" };
    f.attempts += 1;
    f.outcomes.push(e.outcome);
    f.net = e.net || f.net;
    f.size = e.size || f.size;
    files.set(e.id, f);
  }
  const list = [...files.values()];
  for (const f of list) {
    const last = f.outcomes[f.outcomes.length - 1];
    f.final = last === "done" ? "done" : last === "failed" ? "failed" : "pending";
    f.restarted = f.outcomes.some((o) => o === "network" || o === "retry" || o === "full") || f.attempts > 1;
  }
  const done = list.filter((f) => f.final === "done").length;
  const failed = list.filter((f) => f.final === "failed").length;
  const restarted = list.filter((f) => f.restarted).length;
  const finished = done + failed;
  const bigMobileFailures = list.filter((f) => f.size > GB && MOBILE_NET.includes(f.net) && f.final !== "done" && (f.final === "failed" || f.restarted));
  const rate = list.length ? (failed + list.filter((f) => f.final !== "failed" && f.restarted).length) / list.length : 0;
  return {
    files: list.length, done, failed, pending: list.length - finished, restarted,
    failure_or_restart_rate: Math.round(rate * 1000) / 1000,
    over_threshold: list.length >= 10 && rate > TARGETS.max_failure_or_restart_rate,
    big_mobile_failures: bigMobileFailures.length,
    resumable_uploads_required: (list.length >= 10 && rate > TARGETS.max_failure_or_restart_rate) || bigMobileFailures.length > 0,
  };
}

export function buildReport({ perf, uploads, device }) {
  const p = summarizePerf(perf), u = summarizeUploads(uploads);
  return { generated_at: new Date().toISOString(), device, startup: p, uploads: u, runs: perf.slice(-30), upload_events: uploads.slice(-100) };
}

export function reportText(r) {
  const fmt = (n) => (n === null || n === undefined ? "n/a" : n + " ms");
  const flag = (b) => (b === null ? "no data" : b ? "meets target" : "MISSES TARGET");
  const lines = ["Baby Journal pilot diagnostics", "Created " + r.generated_at, "Device: " + (r.device.model || r.device.user_agent), "Installed to home screen: " + r.device.standalone + ", storage kept: " + r.device.storage_persisted, "Connection now: " + (r.device.net || "unknown"), ""];
  for (const s of ["cold", "warm"]) {
    const x = r.startup[s];
    lines.push(`${s === "cold" ? "Cold start" : "Warm start"} (${x.runs} runs${x.enough_runs ? "" : ", need 10"}): median ${fmt(x.timeline_median_ms)}, worst ${fmt(x.timeline_worst_ms)} to first entries: ${flag(x.timeline_pass)}; thumbnails median ${fmt(x.thumbs_median_ms)}: ${flag(x.thumbs_pass)}`);
  }
  const u = r.uploads;
  lines.push("", `Uploads: ${u.files} files, ${u.done} done, ${u.failed} failed, ${u.pending} unfinished, ${u.restarted} restarted (${(u.failure_or_restart_rate * 100).toFixed(1)}%)`);
  lines.push(`Over 1 GB on mobile data that failed or restarted: ${u.big_mobile_failures}`);
  lines.push(u.resumable_uploads_required ? "RESUMABLE UPLOADS ARE REQUIRED by the pilot thresholds." : "Resumable uploads: not required by the thresholds so far.");
  return lines.join("\n");
}

export function deviceInfo({ persisted } = {}) {
  const nav = typeof navigator !== "undefined" ? navigator : {};
  const c = nav.connection || {};
  return {
    user_agent: nav.userAgent || "", model: nav.userAgentData && nav.userAgentData.platform ? nav.userAgentData.platform : "",
    standalone: typeof matchMedia === "function" ? matchMedia("(display-mode: standalone)").matches || nav.standalone === true : false,
    storage_persisted: persisted === undefined ? "unknown" : !!persisted, net: c.type || c.effectiveType || "", downlink_mbps: c.downlink || null,
  };
}

export function connectionType() {
  const c = (typeof navigator !== "undefined" && navigator.connection) || {};
  return c.type || c.effectiveType || "";
}
