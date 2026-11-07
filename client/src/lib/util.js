// Small shared helpers.

// crypto.randomUUID only exists in secure contexts (HTTPS or localhost). Over plain
// http on a home network it is missing, so fall back to getRandomValues.
export function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Today as a local calendar date (YYYY-MM-DD), not UTC: "today" must match the wall clock.
export function todayLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// PocketBase stores dates as "2026-10-18 14:03:22.000Z".
export function parsePbDate(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

export function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 ** 2) return (n / 1024).toFixed(0) + " KB";
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + " MB";
  return (n / 1024 ** 3).toFixed(2) + " GB";
}

// Turn any thrown value into something a person can read.
export function errorMessage(err) {
  if (!err) return "Unknown error";
  const r = err.response;
  if (r && typeof r.message === "string" && r.message) return r.message;
  return err.message || String(err);
}
