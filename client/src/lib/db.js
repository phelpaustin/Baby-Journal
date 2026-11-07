// Local storage (IndexedDB). Holds everything that has not reached the server yet,
// plus a read cache so the journal opens offline.
//
//   outbox  - entry changes waiting to be sent (idempotency key = id)
//   media   - photo/video files waiting to be uploaded (the Blob itself is kept)
//   cache   - last known server state per journal (entries, media, members)
import { openDB } from "idb";

export async function createDb(name = "babyjournal") {
  const db = await openDB(name, 1, {
    upgrade(d) {
      const outbox = d.createObjectStore("outbox", { keyPath: "id" });
      outbox.createIndex("by_created", "created");
      d.createObjectStore("media", { keyPath: "client_id" });
      d.createObjectStore("cache", { keyPath: "key" });
    },
  });
  return {
    raw: db,
    async putOp(op) { await db.put("outbox", op); },
    async getOp(id) { return db.get("outbox", id); },
    async deleteOp(id) { await db.delete("outbox", id); },
    async allOps() {
      const ops = await db.getAll("outbox");
      return ops.sort((a, b) => a.created - b.created || (a.seq || 0) - (b.seq || 0));
    },
    async putMedia(item) { await db.put("media", item); },
    async getMedia(id) { return db.get("media", id); },
    async deleteMedia(id) { await db.delete("media", id); },
    async allMedia() {
      const all = await db.getAll("media");
      return all.sort((a, b) => a.created - b.created);
    },
    async getCache(key) {
      const r = await db.get("cache", key);
      return r ? r.value : undefined;
    },
    async setCache(key, value) { await db.put("cache", { key, value }); },
    async clearCache() { await db.clear("cache"); },
    // Used on sign-out, after the person has confirmed they will lose unsent changes.
    async clearAll() {
      await db.clear("outbox");
      await db.clear("media");
      await db.clear("cache");
    },
    close() { db.close(); },
  };
}
