// Photo and video upload queue (architecture v7, sections 6.3 and 7.1).
//
// Each file is kept in local storage until the server confirms it is stored; only then
// is the local copy dropped. The server re-checks size and SHA-256, so the client hashes
// the whole file first (streamed in chunks, so a multi-GB video does not need that much
// memory) and sends the result with it.
import { createSHA256 } from "hash-wasm";
import { uuid, errorMessage } from "./util.js";

const CHUNK = 8 * 1024 * 1024;
const MAX_CHECKSUM_RETRIES = 3;
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];
export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;

export async function sha256Blob(blob, onProgress) {
  const hasher = await createSHA256();
  hasher.init();
  for (let off = 0; off < blob.size; off += CHUNK) {
    const buf = await blob.slice(off, Math.min(off + CHUNK, blob.size)).arrayBuffer();
    hasher.update(new Uint8Array(buf));
    if (onProgress) onProgress(Math.min(1, (off + CHUNK) / blob.size));
  }
  return hasher.digest("hex");
}

export function kindOf(file) {
  const t = (file.type || "").toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  // Some phones leave the type empty for HEIC and MOV: fall back to the extension.
  const ext = (file.name || "").toLowerCase().split(".").pop();
  if (["heic", "heif", "jpg", "jpeg", "png", "webp"].includes(ext)) return "image";
  if (["mov", "mp4", "webm", "m4v"].includes(ext)) return "video";
  return "";
}

// --------------------------------------------------------------- transports
// Browser: XMLHttpRequest, because fetch cannot report upload progress.
export function xhrTransport({ url, token, fields, file, filename, onProgress }) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    form.append("file", file, filename);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    if (token) xhr.setRequestHeader("Authorization", token);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let json = null;
      try { json = JSON.parse(xhr.responseText); } catch (_) {}
      resolve({ status: xhr.status, json });
    };
    xhr.onerror = () => reject(Object.assign(new Error("Network error"), { network: true }));
    xhr.ontimeout = () => reject(Object.assign(new Error("Timed out"), { network: true }));
    xhr.onabort = () => reject(Object.assign(new Error("Aborted"), { network: true }));
    xhr.send(form);
  });
}

// Node and tests (no progress events).
export async function fetchTransport({ url, token, fields, file, filename, onProgress }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append("file", file, filename);
  try {
    const res = await fetch(url, { method: "POST", headers: token ? { Authorization: token } : {}, body: form });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    if (onProgress) onProgress(1);
    return { status: res.status, json };
  } catch (err) {
    throw Object.assign(new Error("Network error"), { network: true });
  }
}

export const defaultTransport = typeof XMLHttpRequest !== "undefined" && typeof window !== "undefined" ? xhrTransport : fetchTransport;

// -------------------------------------------------------------------- queue
export function createMediaQueue({ pb, db, userId, engine, transport = defaultTransport, online = () => (typeof navigator === "undefined" ? true : navigator.onLine), onUploaded, onAttempt, schedule = true }) {
  const listeners = new Set();
  let running = null;
  let timer = null;
  let progress = {}; // client_id -> 0..1
  let failures = 0;
  let state = { status: "idle", items: [] };

  const emit = () => { for (const l of listeners) l(); };
  async function refresh() {
    const items = (await db.allMedia()).filter((m) => m.owner === userId).map(({ file, ...rest }) => ({ ...rest, progress: progress[rest.client_id] || 0 }));
    state = { ...state, items };
    emit();
  }

  async function add({ journal, entryClientId, file, caption = "", takenAt = "" }) {
    const kind = kindOf(file);
    if (!kind) throw new Error("That file type is not supported. Use a photo (JPEG, PNG, WebP, HEIC) or a video (MP4, MOV, WebM).");
    if (file.size > MAX_FILE_BYTES) throw new Error("Files larger than 5 GB cannot be uploaded.");
    if (file.size === 0) throw new Error("That file is empty.");
    const item = {
      client_id: uuid(), owner: userId, journal, entry_client_id: entryClientId, kind, file,
      name: file.name || (kind === "image" ? "photo.jpg" : "video.mp4"), size: file.size, type: file.type || "",
      caption, taken_at: takenAt, sha256: "", status: "queued", attempts: 0, error: "", created: Date.now(),
    };
    await db.putMedia(item); // stored locally first
    await refresh();
    kick();
    return item.client_id;
  }

  async function update(item, patch) {
    Object.assign(item, patch);
    await db.putMedia(item);
    await refresh();
  }

  const note = (item, outcome, started) => { if (onAttempt) onAttempt({ id: item.client_id, size: item.size, kind: item.kind, outcome, ms: Date.now() - started }); };

  async function uploadOne(item) {
    const entryId = await engine.serverEntryId(item.journal, item.entry_client_id);
    if (!entryId) { await update(item, { status: "waiting_entry" }); return "wait"; }
    // Browser storage can lose or damage a file (low disk space, Safari quirks). Never hash or
    // upload something that no longer matches what the person picked.
    if (!(item.file && typeof item.file.slice === "function") || item.file.size !== item.size) {
      note(item, "failed", Date.now());
      await update(item, { status: "failed", error: "This phone no longer has an intact copy of the file. Add it again from your photo library." });
      return "failed";
    }
    if (!item.sha256) {
      await update(item, { status: "hashing" });
      item.sha256 = await sha256Blob(item.file);
      await db.putMedia(item);
    }
    await update(item, { status: "uploading", error: "" });
    const started = Date.now();
    let res;
    try {
      res = await transport({
        url: pb.baseURL.replace(/\/$/, "") + "/api/bj/media/upload",
        token: pb.authStore.token,
        fields: {
          journal: item.journal, entry: entryId, client_id: item.client_id, kind: item.kind,
          sha256: item.sha256, size: item.size, caption: item.caption || "", ...(item.taken_at ? { taken_at: item.taken_at } : {}),
        },
        file: item.file, filename: item.name,
        onProgress: (p) => {
          progress[item.client_id] = p;
          state = { ...state, items: state.items.map((i) => (i.client_id === item.client_id ? { ...i, progress: p } : i)) };
          emit();
        },
      });
    } catch (err) {
      note(item, "network", started);
      await update(item, { status: "queued", error: "Connection lost. It will resume automatically." });
      return "network";
    }
    delete progress[item.client_id];
    const msg = (res.json && res.json.message) || "";
    if (res.status === 200 && res.json && res.json.media && res.json.media.status === "stored") {
      note(item, "done", started);
      await db.deleteMedia(item.client_id); // the server confirmed: only now is the local copy dropped
      await refresh();
      if (onUploaded) await onUploaded(item, res.json.media);
      return "done";
    }
    if (res.status === 422 && /intact|checksum/i.test(msg) && item.attempts + 1 < MAX_CHECKSUM_RETRIES) {
      note(item, "retry", started);
      await update(item, { status: "queued", attempts: item.attempts + 1, error: "The upload arrived damaged. Trying again." });
      return "retry";
    }
    if (res.status === 401) { await update(item, { status: "queued" }); return "auth"; }
    if (res.status === 507) { note(item, "full", started); await update(item, { status: "paused", error: msg || "The server is almost out of disk space. Your file is safe on this phone." }); return "full"; }
    if (res.status === 429 || res.status >= 500) { note(item, "network", started); await update(item, { status: "queued", error: msg }); return "network"; }
    // 403, 404, 409, other 4xx: retrying cannot help. Keep the file so nothing is lost.
    note(item, "failed", started);
    await update(item, { status: "failed", error: msg || "The server refused this file." });
    return "failed";
  }

  async function doRun() {
    if (!online()) return;
    const items = (await db.allMedia()).filter((m) => m.owner === userId && ["queued", "waiting_entry", "paused", "hashing", "uploading"].includes(m.status));
    for (const item of items) {
      let outcome;
      do {
        outcome = await uploadOne(item);
      } while (outcome === "retry");
      if (outcome === "network") { failures++; retryLater(); return; }
      if (outcome === "auth" || outcome === "full") return;
      failures = 0;
    }
  }

  function run() {
    if (running) return running;
    running = doRun().catch(async (err) => { state = { ...state, lastError: errorMessage(err) }; emit(); }).finally(() => { running = null; });
    return running;
  }
  function kick() { if (schedule) run(); }
  function retryLater() {
    if (!schedule || timer) return;
    const wait = RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)] || RETRY_MS[0];
    timer = setTimeout(() => { timer = null; run(); }, wait);
  }
  async function retry(id) {
    const it = await db.getMedia(id);
    if (it) { it.status = "queued"; it.error = ""; it.attempts = 0; await db.putMedia(it); await refresh(); kick(); }
  }
  async function discard(id) { await db.deleteMedia(id); await refresh(); }

  return {
    add, run, retry, discard, refresh,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getState: () => state,
    stop: () => { if (timer) clearTimeout(timer); timer = null; listeners.clear(); },
  };
}
