// Server data with an offline fallback: every successful read is cached, and when the
// server cannot be reached the last cached copy is returned instead.
export function createData({ pb, db }) {
  async function cached(key, fetcher) {
    try {
      const value = await fetcher();
      await db.setCache(key, value);
      return { value, fresh: true };
    } catch (err) {
      const value = await db.getCache(key);
      if (value !== undefined) return { value, fresh: false };
      throw err;
    }
  }
  const strip = ({ collectionName, expand, ...r }) => r;
  return {
    journals: () => cached("journals", async () => (await pb.collection("journals").getFullList({ sort: "created" })).map(strip)),
    journal: (id) => cached("journal:" + id, async () => strip(await pb.collection("journals").getOne(id))),
    members: (id) =>
      cached("members:" + id, async () =>
        (await pb.collection("members").getFullList({ filter: `journal = "${id}"`, expand: "user", sort: "joined_at" })).map((m) => ({
          id: m.id, user: m.user, role: m.role, joined_at: m.joined_at, name: m.expand?.user?.name || "",
        }))),
    // Media rows are kept whole: building a file URL needs collectionId and the file names.
    media: (id) => cached("media:" + id, () => pb.collection("media").getFullList({ filter: `journal = "${id}" && status = "stored"`, sort: "-created" })),
    backupStatus: () => pb.send("/api/bj/backup/status", { method: "GET" }),
  };
}
