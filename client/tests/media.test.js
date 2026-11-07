import "fake-indexeddb/auto";
import { describe, test, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admin, makeUser, makeJournal, device, fields, rid } from "./helpers.js";
import { sha256Blob, kindOf, fetchTransport } from "../src/lib/media.js";

let owner, editor, viewer, journal, jpeg;

beforeAll(async () => {
  owner = await makeUser("owner");
  editor = await makeUser("editor");
  viewer = await makeUser("viewer");
  journal = await makeJournal([[owner, "owner"], [editor, "editor"], [viewer, "viewer"]]);
  const dir = mkdtempSync(join(tmpdir(), "bj-client-"));
  const p = join(dir, "p.jpg");
  execFileSync("convert", ["-size", "640x480", "gradient:orange-purple", p]);
  jpeg = readFileSync(p);
});

const photo = (name = "IMG_1.JPG") => new File([jpeg], name, { type: "image/jpeg" });
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const serverMedia = async (clientId) => (await admin()).collection("media").getFullList({ filter: `client_id = "${clientId}"` });

async function entryOn(d) {
  const cid = "c-" + rid();
  await d.engine.saveEntry(journal.id, cid, 0, fields());
  return cid;
}

describe("hashing and file kinds", () => {
  test("streamed SHA-256 matches Node's across chunk boundaries", async () => {
    const big = randomBytes(8 * 1024 * 1024 * 2 + 12345); // two full chunks plus a tail
    expect(await sha256Blob(new Blob([big]))).toBe(sha(big));
    expect(await sha256Blob(new Blob([]))).toBe(sha(Buffer.alloc(0)));
  });
  test("kind detection copes with phones that leave the type empty", () => {
    expect(kindOf(new File([1], "IMG_0001.HEIC", { type: "" }))).toBe("image");
    expect(kindOf(new File([1], "MOV_0001.MOV", { type: "" }))).toBe("video");
    expect(kindOf(new File([1], "notes.pdf", { type: "application/pdf" }))).toBe("");
  });
  test("unsupported and empty files are refused at once, before anything is stored", async () => {
    const d = await device(editor);
    await expect(d.queue.add({ journal: journal.id, entryClientId: "x", file: new File(["x"], "a.pdf", { type: "application/pdf" }) })).rejects.toThrow(/not supported/);
    await expect(d.queue.add({ journal: journal.id, entryClientId: "x", file: new File([], "a.jpg", { type: "image/jpeg" }) })).rejects.toThrow(/empty/);
    expect(await d.db.allMedia()).toHaveLength(0);
  });
});

describe("upload queue", () => {
  test("a file that storage returns damaged is never uploaded: it fails with a clear message", async () => {
    const d = await device(editor);
    const cid = await entryOn(d);
    await d.engine.flush();
    const mid = await d.queue.add({ journal: journal.id, entryClientId: cid, file: photo() });
    const item = await d.db.getMedia(mid);
    item.file = {}; // what a broken browser store hands back
    await d.db.putMedia(item);
    await d.queue.run();
    const after = await d.db.getMedia(mid);
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/intact copy/);
    expect(await serverMedia(mid)).toHaveLength(0);
  });

  test("a photo added before its entry reaches the server waits, then uploads; the local copy is dropped only after the server confirms", async () => {
    const d = await device(editor);
    d.state.online = false;
    const cid = await entryOn(d);
    const mid = await d.queue.add({ journal: journal.id, entryClientId: cid, file: photo(), caption: "Day one" });
    expect(await d.db.getMedia(mid)).toBeTruthy(); // stored locally first

    d.state.online = true;
    await d.queue.run();
    expect((await d.db.getMedia(mid)).status).toBe("waiting_entry");

    await d.engine.flush(); // the entry reaches the server
    await d.queue.run();
    expect(await d.db.getMedia(mid)).toBeUndefined();
    const rows = await serverMedia(mid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "stored", caption: "Day one", derive_status: "ready" });
    expect(d.uploaded).toHaveLength(1);
    const orig = await (await admin()).collection("media_originals").getFirstListItem(`media = "${rows[0].id}"`);
    expect(orig.sha256).toBe(sha(jpeg));
  });

  test("connection lost mid-upload: the file stays queued, resumes, and the server ends with exactly one copy", async () => {
    let calls = 0;
    const flaky = async (args) => {
      calls++;
      if (calls === 1) {
        await fetchTransport(args); // the server stores it, but the phone never hears back
        throw Object.assign(new Error("Network error"), { network: true });
      }
      return fetchTransport(args);
    };
    const d = await device(editor, { transport: flaky });
    const cid = await entryOn(d);
    await d.engine.flush();
    const mid = await d.queue.add({ journal: journal.id, entryClientId: cid, file: photo() });
    await d.queue.run();
    expect(await d.db.getMedia(mid)).toBeTruthy(); // not dropped: the confirmation never arrived
    await d.queue.run();
    expect(await d.db.getMedia(mid)).toBeUndefined();
    expect(await serverMedia(mid)).toHaveLength(1); // the retry was a replay, not a second copy
    expect(calls).toBe(2);
  });

  test("a damaged transfer is retried and succeeds; one that keeps arriving damaged ends as failed with the file kept", async () => {
    let n = 0;
    const corruptTwice = (args) => {
      n++;
      if (n <= 2) { const b = Buffer.from(jpeg); b[100] ^= 0xff; args = { ...args, file: new Blob([b]) }; }
      return fetchTransport(args);
    };
    const d1 = await device(editor, { transport: corruptTwice });
    const c1 = await entryOn(d1);
    await d1.engine.flush();
    const m1 = await d1.queue.add({ journal: journal.id, entryClientId: c1, file: photo() });
    await d1.queue.run();
    expect(await d1.db.getMedia(m1)).toBeUndefined();
    expect(await serverMedia(m1)).toHaveLength(1);
    expect(n).toBe(3);

    const alwaysBad = (args) => { const b = Buffer.from(jpeg); b[100] ^= 0xff; return fetchTransport({ ...args, file: new Blob([b]) }); };
    const d2 = await device(editor, { transport: alwaysBad });
    const c2 = await entryOn(d2);
    await d2.engine.flush();
    const m2 = await d2.queue.add({ journal: journal.id, entryClientId: c2, file: photo() });
    await d2.queue.run();
    const item = await d2.db.getMedia(m2);
    expect(item.status).toBe("failed");
    expect(item.file).toBeTruthy(); // the original is still on the phone
    expect(await serverMedia(m2)).toHaveLength(0);
    // The person can retry later from the screen.
    await d2.queue.retry(m2);
    expect((await d2.db.getMedia(m2)).status).toBe("queued");
  });

  test("a viewer cannot upload: the file is kept with the reason", async () => {
    const d = await device(viewer);
    await d.engine.pull(journal.id);
    const any = (await d.engine.listEntries(journal.id))[0];
    const mid = await d.queue.add({ journal: journal.id, entryClientId: any.client_id, file: photo() });
    await d.queue.run();
    const item = await d.db.getMedia(mid);
    expect(item.status).toBe("failed");
    expect(item.error).toMatch(/permission/i);
  });

  test("a failed upload does not block the files queued behind it", async () => {
    const d = await device(editor);
    const cid = await entryOn(d);
    await d.engine.flush();
    const bad = await d.queue.add({ journal: journal.id, entryClientId: cid, file: new File([Buffer.from("not an image at all, just text\n".repeat(30))], "fake.jpg", { type: "image/jpeg" }) });
    const good = await d.queue.add({ journal: journal.id, entryClientId: cid, file: photo("good.jpg") });
    await d.queue.run();
    expect((await d.db.getMedia(bad)).status).toBe("failed");
    expect(await d.db.getMedia(good)).toBeUndefined();
    expect(await serverMedia(good)).toHaveLength(1);
  });

  test("while offline nothing is sent and nothing is lost", async () => {
    const d = await device(editor);
    const cid = await entryOn(d);
    await d.engine.flush();
    d.state.online = false;
    const mid = await d.queue.add({ journal: journal.id, entryClientId: cid, file: photo() });
    await d.queue.run();
    expect((await d.db.getMedia(mid)).status).toBe("queued");
    expect(await serverMedia(mid)).toHaveLength(0);
  });
});
