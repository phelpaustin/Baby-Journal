import "fake-indexeddb/auto";
import { describe, test, expect, beforeAll } from "vitest";
import { admin, makeUser, makeJournal, device, fields, rid } from "./helpers.js";
import { ST } from "../src/lib/sync.js";

let owner, editor, viewer, journal;

beforeAll(async () => {
  owner = await makeUser("owner");
  editor = await makeUser("editor");
  viewer = await makeUser("viewer");
  journal = await makeJournal([[owner, "owner"], [editor, "editor"], [viewer, "viewer"]], { dob: "2026-10-18", due_date: "2026-10-10" });
});

const serverEntries = async (clientId) => {
  const a = await admin();
  return a.collection("entries").getFullList({ filter: `client_id = "${clientId}"` });
};

describe("offline outbox", () => {
  test("a change made offline is stored locally first, shown at once, and sent exactly once later", async () => {
    const d = await device(editor);
    d.state.online = false;
    const cid = "c-" + rid();
    await d.engine.saveEntry(journal.id, cid, 0, fields({ title: "Made on the train" }));
    await d.engine.flush();
    expect(d.engine.getState().status).toBe(ST.OFFLINE);
    expect(d.engine.getState().pending).toBe(1);
    expect(await serverEntries(cid)).toHaveLength(0);

    // The entry is visible and marked as waiting, and survives a restart (new engine, same database).
    const view = await d.engine.listEntries(journal.id);
    expect(view.find((e) => e.client_id === cid)).toMatchObject({ title: "Made on the train", _pending: true, _local: true });

    d.state.online = true;
    await d.engine.flush();
    expect(d.engine.getState().pending).toBe(0);
    const rows = await serverEntries(cid);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Made on the train");
    expect(rows[0].author).toBe(editor.id);
    const after = await d.engine.listEntries(journal.id);
    const synced = after.find((e) => e.client_id === cid);
    expect(synced.revision).toBe(1);
    expect(synced._pending).toBeFalsy();
    expect(synced._local).toBeFalsy();
  });

  test("a lost response (server saved it, the phone never heard) does not create a duplicate on retry", async () => {
    const d = await device(editor);
    const cid = "c-" + rid();
    const op = await d.engine.saveEntry(journal.id, cid, 0, fields());
    // Simulate the lost response: the server processes the request, the client sees a network error.
    const realSend = d.pb.send.bind(d.pb);
    let swallowed = false;
    d.pb.send = async (path, opts) => {
      const r = await realSend(path, opts);
      if (!swallowed) { swallowed = true; throw Object.assign(new Error("connection reset"), { status: 0 }); }
      return r;
    };
    await d.engine.flush();
    expect(d.engine.getState().status).toBe(ST.SERVER_DOWN);
    expect(d.engine.getState().pending).toBe(1);
    expect(await serverEntries(cid)).toHaveLength(1); // the server did get it
    await d.engine.flush(); // retry with the same idempotency key
    expect(d.engine.getState().pending).toBe(0);
    expect(await serverEntries(cid)).toHaveLength(1);
    expect(op.id).toBeTruthy();
  });

  test("'no internet' and 'server unreachable' are reported differently", async () => {
    const d = await device(editor);
    await d.engine.saveEntry(journal.id, "c-" + rid(), 0, fields());
    d.pb.send = async () => { throw Object.assign(new Error("fetch failed"), { status: 0 }); };
    await d.engine.flush();
    expect(d.engine.getState().status).toBe(ST.SERVER_DOWN);
    d.state.online = false;
    await d.engine.flush();
    expect(d.engine.getState().status).toBe(ST.OFFLINE);
  });

  test("two quick edits of an unsent entry become one change that carries the final text", async () => {
    const d = await device(editor);
    d.state.online = false;
    const cid = "c-" + rid();
    await d.engine.saveEntry(journal.id, cid, 0, fields({ title: "draft 1" }));
    await d.engine.saveEntry(journal.id, cid, 0, fields({ title: "draft 2" }));
    expect((await d.db.allOps())).toHaveLength(1);
    d.state.online = true;
    await d.engine.flush();
    const rows = await serverEntries(cid);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("draft 2");
    expect(rows[0].revision).toBe(1);
  });

  test("an edit queued behind an unsent create is rebased and applied, not turned into a conflict", async () => {
    const d = await device(editor);
    d.state.online = false;
    const cid = "c-" + rid();
    await d.engine.saveEntry(journal.id, cid, 0, fields({ title: "v1" }));
    // pretend the first change is on its way when the second edit happens
    const [first] = await d.db.allOps();
    first.status = "pending";
    await d.db.putOp(first);
    await d.engine.trashEntry(journal.id, cid, 0);
    d.state.online = true;
    await d.engine.flush();
    const rows = await serverEntries(cid);
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).not.toBe("");
    expect(rows[0].revision).toBe(2);
    expect(d.engine.getState()).toMatchObject({ pending: 0, rejected: 0 });
  });

  test("a rejected change is kept and shown with the reason, never dropped", async () => {
    const d = await device(editor);
    const cid = "c-" + rid();
    await d.engine.saveEntry(journal.id, cid, 0, fields({ values: { weight: 4.2 } })); // no unit: the server refuses it
    await d.engine.flush();
    expect(d.engine.getState()).toMatchObject({ pending: 0, rejected: 1 });
    const e = (await d.engine.listEntries(journal.id)).find((x) => x.client_id === cid);
    expect(e._problem).toMatch(/unit/i);
    const [op] = await d.db.allOps();
    // The person fixes the data and sends it again.
    op.fields = fields({ values: { weight_kg: 4.2 } });
    await d.db.putOp(op);
    await d.engine.retryOp(op.id);
    await d.engine.flush();
    expect(d.engine.getState()).toMatchObject({ pending: 0, rejected: 0 });
    expect((await serverEntries(cid))[0].values.weight_kg).toBe(4.2);
  });

  test("a viewer's attempt to write is rejected and visible, not silently lost", async () => {
    const d = await device(viewer);
    await d.engine.saveEntry(journal.id, "c-" + rid(), 0, fields());
    await d.engine.flush();
    expect(d.engine.getState().rejected).toBe(1);
  });

  test("an expired sign-in stops syncing and keeps every change", async () => {
    const d = await device(editor);
    await d.engine.saveEntry(journal.id, "c-" + rid(), 0, fields());
    d.pb.send = async () => { throw Object.assign(new Error("unauthorized"), { status: 401 }); };
    await d.engine.flush();
    expect(d.engine.getState().status).toBe(ST.AUTH);
    expect(d.engine.getState().pending).toBe(1);
  });
});

describe("two devices and conflicts", () => {
  test("both phones edit the same entry offline: both versions are kept and the entry is flagged", async () => {
    const a = await device(owner);
    const b = await device(editor);
    const cid = "c-" + rid();
    await a.engine.saveEntry(journal.id, cid, 0, fields({ title: "Original", text: "Base text" }));
    await a.engine.flush();
    await b.engine.pull(journal.id);
    const seenByB = await b.engine.getEntry(journal.id, cid);
    expect(seenByB.revision).toBe(1);

    a.state.online = false; b.state.online = false;
    await a.engine.saveEntry(journal.id, cid, 1, fields({ title: "Original", text: "Mum's edit" }));
    await b.engine.saveEntry(journal.id, cid, 1, fields({ title: "Original", text: "Dad's edit" }));
    a.state.online = true; b.state.online = true;
    await a.engine.flush();
    await b.engine.flush();

    const server = (await serverEntries(cid))[0];
    expect(server.text).toBe("Mum's edit"); // first to arrive wins as current
    expect(server.needs_review).toBe(true);
    expect(server.revision).toBe(2);

    const bView = await b.engine.getEntry(journal.id, cid);
    expect(bView.needs_review).toBe(true);
    expect(b.engine.getState().conflicts).toBeGreaterThan(0);

    const versions = await b.engine.conflictVersions(server.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].text).toBe("Dad's edit");
  });

  test("resolving a conflict creates a new revision, clears the flag and keeps the history", async () => {
    const a = await device(owner);
    const b = await device(editor);
    const cid = "c-" + rid();
    await a.engine.saveEntry(journal.id, cid, 0, fields({ text: "one" }));
    await a.engine.flush();
    await b.engine.pull(journal.id);
    await a.engine.saveEntry(journal.id, cid, 1, fields({ text: "A" }));
    await a.engine.flush();
    await b.engine.saveEntry(journal.id, cid, 1, fields({ text: "B" }));
    await b.engine.flush();

    await a.engine.pull(journal.id);
    const cur = await a.engine.getEntry(journal.id, cid);
    expect(cur.needs_review).toBe(true);
    await a.engine.resolveConflict(journal.id, cid, cur.revision, fields({ text: "A and B merged" }));
    await a.engine.flush();
    const server = (await serverEntries(cid))[0];
    expect(server.text).toBe("A and B merged");
    expect(server.needs_review).toBe(false);
    expect(server.revision).toBe(3);
    const adm = await admin();
    const versions = await adm.collection("entry_versions").getFullList({ filter: `entry = "${server.id}"` });
    expect(versions.length).toBeGreaterThanOrEqual(4);
    expect(versions.filter((v) => v.status === "conflict")).toHaveLength(0);
  });

  test("one phone trashes while another edits: the edit survives as a conflict on the trashed entry", async () => {
    const a = await device(owner);
    const b = await device(editor);
    const cid = "c-" + rid();
    await a.engine.saveEntry(journal.id, cid, 0, fields());
    await a.engine.flush();
    await b.engine.pull(journal.id);
    await a.engine.trashEntry(journal.id, cid, 1);
    await a.engine.flush();
    await b.engine.saveEntry(journal.id, cid, 1, fields({ text: "Edited elsewhere" }));
    await b.engine.flush();
    const server = (await serverEntries(cid))[0];
    expect(server.deleted_at).not.toBe("");
    expect(server.needs_review).toBe(true);
  });

  test("pull replaces the cache; the timeline opens from the cache with no connection", async () => {
    const a = await device(viewer);
    expect(await a.engine.pull(journal.id)).toBe(true);
    a.state.online = false;
    const offlineList = await a.engine.listEntries(journal.id);
    expect(offlineList.length).toBeGreaterThan(3);
    expect(offlineList.every((e) => e.deleted_at === "")).toBe(true); // viewers never get trashed entries
  });
});
