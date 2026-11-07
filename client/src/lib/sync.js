// Offline-first sync engine (architecture v7, sections 4.3 and 7.1).
//
// Rules this file exists to keep:
//  - A change is written to local storage BEFORE anything is sent; the UI never says
//    "saved" for something that is only in memory.
//  - Every change carries an idempotency key, so a retry after a lost response can
//    never create a duplicate.
//  - A rejected change is never dropped silently: it stays visible with the reason.
//  - A stale edit is never applied over someone else's change: the server keeps it as
//    a conflict version and the entry is flagged for review.
//  - "No internet" and "journal server unreachable" are different states.
import { uuid, sleep, errorMessage } from "./util.js";

const RETRY_MS = [5_000, 15_000, 60_000, 300_000];

export const ST = {
  IDLE: "idle",
  SYNCING: "syncing",
  OFFLINE: "offline", // the device has no internet
  SERVER_DOWN: "server_down", // internet works, the journal server does not answer
  AUTH: "auth", // the sign-in expired or was revoked
};

export function createEngine({ pb, db, userId, online = () => (typeof navigator === "undefined" ? true : navigator.onLine), schedule = true }) {
  const listeners = new Set();
  const inflight = new Set();
  let flushing = null;
  let seq = 0;
  let failures = 0;
  let timer = null;
  const journals = new Set(); // journals seen in this session, for the "needs review" count
  let state = { status: ST.IDLE, pending: 0, rejected: 0, blocked: 0, conflicts: 0, lastSyncAt: null, lastError: "" };

  const emit = () => { for (const l of listeners) l(); };
  const set = (patch) => { state = { ...state, ...patch }; emit(); };
  const cacheKey = (j) => "entries:" + j;

  async function readCache(journal) {
    return (await db.getCache(cacheKey(journal))) || { byClient: {}, pulledAt: null };
  }

  async function recount() {
    const ops = (await db.allOps()).filter((o) => o.owner === userId);
    for (const o of ops) journals.add(o.journal);
    let conflicts = 0;
    for (const j of journals) {
      conflicts += Object.values((await readCache(j)).byClient).filter((e) => e.needs_review && !e.deleted_at).length;
    }
    set({
      pending: ops.filter((o) => o.status === "pending").length,
      rejected: ops.filter((o) => o.status === "rejected").length,
      blocked: ops.filter((o) => o.status === "blocked").length,
      conflicts,
    });
  }

  // ------------------------------------------------------------------ queueing
  // Adds or updates a change. Two quick edits of the same unsent entry become one
  // change (keeping the first base revision), so only the final text is sent.
  async function enqueue({ journal, client_id, op = "upsert", base_revision = 0, fields = null }) {
    journals.add(journal);
    const ops = (await db.allOps()).filter((o) => o.owner === userId && o.client_id === client_id);
    const last = ops[ops.length - 1];
    if (op === "upsert" && last && last.op === "upsert" && last.status !== "blocked" && !inflight.has(last.id)) {
      last.fields = fields;
      last.status = "pending";
      last.error = "";
      await db.putOp(last);
      await recount();
      kick();
      return last;
    }
    const item = {
      id: uuid(), owner: userId, journal, client_id, op, base_revision, fields,
      created: Date.now(), seq: ++seq, status: "pending", error: "",
      // A change queued behind an unsent one is based on the result of that one.
      rebase: ops.some((o) => o.status === "pending"),
    };
    await db.putOp(item);
    await recount();
    kick();
    return item;
  }

  // ---------------------------------------------------------------- flushing
  function classify(err) {
    const status = err && err.status;
    if (status === 0 || status === undefined) return { kind: "network" };
    if (status === 401) return { kind: "auth" };
    if (status === 403) return { kind: "reject", message: "You no longer have permission to edit this journal." };
    if (status === 404) return { kind: "reject", message: "That entry does not exist on the server any more." };
    if (status === 409) return { kind: "blocked", message: errorMessage(err) };
    if (status === 429 || status >= 500) return { kind: "transient", message: errorMessage(err) };
    return { kind: "reject", message: errorMessage(err) }; // 400 and anything else: the data itself is wrong
  }

  async function applyResult(op, res) {
    const cache = await readCache(op.journal);
    if (res && res.entry) cache.byClient[op.client_id] = res.entry;
    await db.setCache(cacheKey(op.journal), cache);
    await db.deleteOp(op.id);
    // Queued follow-ups were written on top of this change: rebase them if it was applied.
    if (res && res.result === "applied") {
      for (const o of await db.allOps()) {
        if (o.owner === userId && o.client_id === op.client_id && o.rebase) {
          o.base_revision = res.revision;
          o.rebase = false;
          await db.putOp(o);
        }
      }
    } else {
      for (const o of await db.allOps()) {
        if (o.owner === userId && o.client_id === op.client_id && o.rebase) { o.rebase = false; await db.putOp(o); }
      }
    }
  }

  async function doFlush() {
    if (!online()) { set({ status: ST.OFFLINE }); return; }
    set({ status: ST.SYNCING });
    const ops = (await db.allOps()).filter((o) => o.owner === userId && o.status === "pending");
    const skip = new Set(); // entries whose earlier change failed: keep order, do not skip ahead
    for (const op of ops) {
      if (skip.has(op.client_id)) continue;
      inflight.add(op.id);
      try {
        const res = await pb.send("/api/bj/entries/sync", {
          method: "POST",
          body: {
            journal: op.journal, client_id: op.client_id, idempotency_key: op.id, op: op.op,
            base_revision: op.base_revision, fields: op.fields || undefined,
          },
        });
        await applyResult(op, res);
        failures = 0;
      } catch (err) {
        const c = classify(err);
        if (c.kind === "network" || c.kind === "transient") {
          failures++;
          set({ status: online() ? ST.SERVER_DOWN : ST.OFFLINE, lastError: c.message || "" });
          await recount();
          retryLater();
          return;
        }
        if (c.kind === "auth") { set({ status: ST.AUTH }); await recount(); return; }
        op.status = c.kind === "blocked" ? "blocked" : "rejected";
        op.error = c.message;
        await db.putOp(op);
        skip.add(op.client_id);
      } finally {
        inflight.delete(op.id);
      }
    }
    await recount();
    set({ status: ST.IDLE, lastSyncAt: Date.now(), lastError: "" });
  }

  function flush() {
    if (flushing) return flushing;
    flushing = doFlush().finally(() => { flushing = null; });
    return flushing;
  }
  function kick() { if (schedule) flush().catch(() => {}); }
  function retryLater() {
    if (!schedule || timer) return;
    const wait = RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)] || RETRY_MS[0];
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, wait);
  }

  // ------------------------------------------------------------------ pulling
  async function pull(journal) {
    journals.add(journal);
    if (!online()) return false;
    try {
      const rows = await pb.collection("entries").getFullList({ filter: `journal = "${journal}"`, sort: "-event_date,-created", batch: 200 });
      const cache = await readCache(journal);
      const byClient = {};
      for (const r of rows) byClient[r.client_id] = slim(r);
      // Keep entries that exist only locally because their create is still queued (they are not in the list).
      cache.byClient = byClient;
      cache.pulledAt = Date.now();
      await db.setCache(cacheKey(journal), cache);
      await recount();
      emit();
      return true;
    } catch (err) {
      const c = classify(err);
      if (c.kind === "auth") set({ status: ST.AUTH });
      else if (c.kind === "network" || c.kind === "transient") set({ status: online() ? ST.SERVER_DOWN : ST.OFFLINE });
      return false;
    }
  }

  function slim(r) {
    // Drop PocketBase bookkeeping the UI does not need; keep what the export and views use.
    const { collectionId, collectionName, expand, ...rest } = r;
    return rest;
  }

  // ----------------------------------------------------------------- viewing
  // Cached server state with the unsent changes laid over it, newest event first.
  async function listEntries(journal) {
    const cache = await readCache(journal);
    const ops = (await db.allOps()).filter((o) => o.owner === userId && o.journal === journal);
    const map = new Map(Object.entries(cache.byClient));
    for (const op of ops) {
      const base = map.get(op.client_id);
      if (op.op === "upsert") {
        const entry = { ...(base || { id: "", client_id: op.client_id, journal, revision: 0, needs_review: false, deleted_at: "", created: new Date(op.created).toISOString() }), ...op.fields };
        entry._local = !base;
        entry._pending = op.status === "pending";
        entry._problem = op.status === "rejected" || op.status === "blocked" ? op.error : "";
        entry._opId = op.id;
        map.set(op.client_id, entry);
      } else if (base) {
        map.set(op.client_id, { ...base, deleted_at: op.op === "trash" ? new Date(op.created).toISOString() : "", _pending: op.status === "pending", _problem: op.status === "rejected" || op.status === "blocked" ? op.error : "", _opId: op.id });
      }
    }
    return [...map.values()].sort((a, b) =>
      String(b.event_date).localeCompare(String(a.event_date)) || String(b.created).localeCompare(String(a.created)));
  }

  async function getEntry(journal, clientId) {
    return (await listEntries(journal)).find((e) => e.client_id === clientId) || null;
  }

  async function serverEntryId(journal, clientId) {
    const cache = await readCache(journal);
    const e = cache.byClient[clientId];
    return e && e.id ? e.id : "";
  }

  async function discardOp(id) { await db.deleteOp(id); await recount(); emit(); }
  async function retryOp(id) {
    const op = await db.getOp(id);
    if (!op) return;
    op.status = "pending"; op.error = "";
    await db.putOp(op);
    await recount();
    kick();
  }

  // Conflict versions for one entry (owners and editors only; the server enforces it).
  async function conflictVersions(entryId) {
    return pb.collection("entry_versions").getFullList({ filter: `entry = "${entryId}" && status = "conflict"`, sort: "created" });
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function getState() { return state; }
  function stop() { if (timer) clearTimeout(timer); timer = null; listeners.clear(); }

  recount().catch(() => {});

  return {
    enqueue, flush, pull, listEntries, getEntry, serverEntryId, discardOp, retryOp, conflictVersions,
    subscribe, getState, stop, recount, readCache, cacheKey,
    // convenience wrappers used by the UI
    saveEntry: (journal, client_id, base_revision, fields) => enqueue({ journal, client_id, op: "upsert", base_revision, fields }),
    trashEntry: (journal, client_id, base_revision) => enqueue({ journal, client_id, op: "trash", base_revision }),
    restoreEntry: (journal, client_id, base_revision) => enqueue({ journal, client_id, op: "restore", base_revision }),
    resolveConflict: (journal, client_id, base_revision, fields) => enqueue({ journal, client_id, op: "resolve", base_revision, fields }),
    _sleep: sleep,
  };
}
