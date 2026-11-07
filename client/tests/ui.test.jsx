// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admin, makeUser, makeJournal, device, fields, rid, PASSWORD } from "./helpers.js";
import { xhrTransport, sha256Blob } from "../src/lib/media.js";

let App, pb;
let owner, editor, viewer, journal;

beforeAll(async () => {
  owner = await makeUser("Mum");
  editor = await makeUser("Dad");
  viewer = await makeUser("Granny");
  journal = await makeJournal([[owner, "owner"], [editor, "editor"], [viewer, "viewer"]], { name: "Ophelia", dob: "2026-10-18", due_date: "2026-10-10" });
  ({ pb } = await import("../src/lib/pb.js"));
  App = (await import("../src/App.jsx")).default;
  window.confirm = vi.fn(() => true);
  // Seed the journal through the real engine so the screens have something to show.
  const seed = await device(owner);
  await seed.engine.saveEntry(journal.id, "seed-first-smile", 0, fields({ title: "First smile", text: "She smiled at Dad.", event_date: "2026-11-01", milestones: ["first_smile"] }));
  await seed.engine.saveEntry(journal.id, "seed-weight-check", 0, fields({ title: "Weight check", type: "growth", event_date: "2026-10-25", text: "", milestones: [], values: { weight_kg: 3.9 } }));
  await seed.engine.flush();
});

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  pb.authStore.clear();
  sessionStorage.clear();
  window.location.hash = "";
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});
afterEach(() => cleanup());

async function signIn(user) {
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: PASSWORD } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: /Ophelia/ });
}

describe("signing in", () => {
  test("a wrong password shows a plain message and nothing else", async () => {
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: owner.email } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "nope-nope-nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not right/);
  });

  test("the timeline shows entries grouped by the child's life stage, with age and measurements", async () => {
    await signIn(owner);
    expect(await screen.findByRole("heading", { name: "First smile" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Weight check" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(expect.arrayContaining(["Week 3", "Week 2"]));
    expect(screen.getByRole("link", { name: "New entry" })).toBeTruthy();
  });

  test("a viewer sees the journal but has no way to add to it", async () => {
    await signIn(viewer);
    await screen.findByRole("heading", { name: "First smile" });
    expect(screen.queryByRole("link", { name: "New entry" })).toBeNull();
    expect(screen.queryByLabelText("Trash")).toBeNull();
  });
});

describe("writing", () => {
  test("a new entry is saved on the phone, shown at once, and reaches the server", async () => {
    await signIn(owner);
    fireEvent.click(await screen.findByRole("link", { name: "New entry" }));
    const title = await screen.findByLabelText("Title (optional)");
    fireEvent.change(title, { target: { value: "First bath " + rid() } });
    fireEvent.change(screen.getByLabelText("What happened"), { target: { value: "She loved the water." } });
    fireEvent.click(screen.getByRole("button", { name: "First laugh" }));
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "growth" } });
    fireEvent.change(screen.getByLabelText("Weight (kg)"), { target: { value: "4,2" } }); // comma, as typed on a Swedish keyboard
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const article = await waitFor(() => { const a = document.querySelector("article"); expect(a).toBeTruthy(); return a; });
    expect(within(article).getByText("She loved the water.")).toBeTruthy();
    expect(within(article).getByText("4.2 kg")).toBeTruthy();
    await waitFor(async () => {
      const rows = await (await admin()).collection("entries").getFullList({ filter: `title ~ "First bath"` });
      expect(rows).toHaveLength(1);
      expect(rows[0].values.weight_kg).toBe(4.2);
      expect(rows[0].milestones).toEqual(["first_laugh"]);
      expect(rows[0].author).toBe(owner.id);
    });
  });

  test("offline: the entry is kept, a plain banner explains, and it is sent when the connection returns", async () => {
    await signIn(owner);
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    window.dispatchEvent(new Event("offline"));
    fireEvent.click(await screen.findByRole("link", { name: "New entry" }));
    const t = "Written offline " + rid();
    fireEvent.change(await screen.findByLabelText("Title (optional)"), { target: { value: t } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Saved on this phone/)).toBeTruthy();
    expect(await screen.findByText(/No internet/)).toBeTruthy();
    expect(await (await admin()).collection("entries").getFullList({ filter: `title = "${t}"` })).toHaveLength(0);

    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
    window.dispatchEvent(new Event("online"));
    await waitFor(async () => expect(await (await admin()).collection("entries").getFullList({ filter: `title = "${t}"` })).toHaveLength(1), { timeout: 8000 });
    await waitFor(() => expect(screen.queryByText(/Saved on this phone/)).toBeNull(), { timeout: 8000 });
  });

  test("a validation problem is explained on the form before anything is queued", async () => {
    await signIn(owner);
    fireEvent.click(await screen.findByRole("link", { name: "New entry" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Write something/);
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "growth" } });
    fireEvent.change(screen.getByLabelText("Weight (kg)"), { target: { value: "heavy" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Weight must be a number/);
  });
});

describe("two versions of an entry", () => {
  test("the screen shows both, and saving the final version resolves it on the server", async () => {
    const mum = await device(owner);
    const dad = await device(editor);
    const cid = "ui-conflict-" + rid();
    await mum.engine.saveEntry(journal.id, cid, 0, fields({ title: "Crawling", text: "Base" }));
    await mum.engine.flush();
    await dad.engine.pull(journal.id);
    await mum.engine.saveEntry(journal.id, cid, 1, fields({ title: "Crawling", text: "Mum's version" }));
    await dad.engine.saveEntry(journal.id, cid, 1, fields({ title: "Crawling", text: "Dad's version" }));
    await mum.engine.flush();
    await dad.engine.flush();

    await signIn(owner);
    window.location.hash = `/j/${journal.id}/e/${cid}`;
    expect(await screen.findByText("Two versions of this entry")).toBeTruthy();
    expect((await screen.findAllByText(/Mum's version/)).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Another version by Dad/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Combine all texts" }));
    const finalText = screen.getByLabelText("Final text");
    expect(finalText.value).toContain("Mum's version");
    expect(finalText.value).toContain("Dad's version");
    fireEvent.click(screen.getByRole("button", { name: "Save as the final version" }));
    await waitFor(async () => {
      const [row] = await (await admin()).collection("entries").getFullList({ filter: `client_id = "${cid}"` });
      expect(row.needs_review).toBe(false);
      expect(row.text).toContain("Dad's version");
      expect(row.revision).toBe(3);
    }, { timeout: 8000 });
  });
});

describe("invites", () => {
  test("a new person opens the link, creates an account and lands in the journal as a viewer", async () => {
    const inv = await pb.send("/api/bj/invites/create", { method: "POST", body: { journal: journal.id, role: "viewer" }, headers: {} }).catch(() => null);
    // Use a separate signed-in client for the owner to create the invite, then open the link signed out.
    const d = await device(owner);
    const r = await d.pb.send("/api/bj/invites/create", { method: "POST", body: { journal: journal.id, role: "viewer" } });
    expect(inv).toBeNull();
    window.location.hash = `/join/${r.token}`;
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Grandpa" } });
    const email = `grandpa-${rid()}@test.local`;
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Create account and join" }));
    expect(await screen.findByRole("heading", { name: /Ophelia/ }, { timeout: 8000 })).toBeTruthy();
    const m = await (await admin()).collection("members").getFullList({ filter: `journal = "${journal.id}"`, expand: "user" });
    expect(m.find((x) => x.expand.user.email === email).role).toBe("viewer");
    const again = await fetch(process.env.PB_URL + "/api/bj/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: r.token, email: `x-${rid()}@test.local`, password: PASSWORD }) });
    expect(again.status).toBe(400); // single use
  });

  test("an owner sees the people screen and can create an invite link", async () => {
    await signIn(owner);
    window.location.hash = `/j/${journal.id}/people`;
    expect(await screen.findByText("Invite someone")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    const link = await screen.findByLabelText("Invite link");
    expect(link.value).toMatch(/#\/join\/[A-Za-z0-9]{40}$/);
  });
});

describe("milestones and sign-out", () => {
  test("milestones list shows when each was first recorded", async () => {
    await signIn(owner);
    window.location.hash = `/j/${journal.id}/milestones`;
    await waitFor(() => {
      const row = screen.getAllByText("First smile").map((x) => x.closest("li")).find(Boolean);
      expect(within(row).getByRole("link").textContent).toMatch(/Nov.*2026/);
    });
    expect(within(screen.getByText("First steps").closest("li")).getByText("Not yet")).toBeTruthy();
  });

  test("signing out with unsent changes asks first, and signing out clears the phone", async () => {
    await signIn(owner);
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    window.dispatchEvent(new Event("offline"));
    fireEvent.click(await screen.findByRole("link", { name: "New entry" }));
    fireEvent.change(await screen.findByLabelText("Title (optional)"), { target: { value: "Unsent " + rid() } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved on this phone/);
    window.location.hash = `/j/${journal.id}/settings`;
    window.confirm = vi.fn(() => false);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/not reached the server/));
    expect(pb.authStore.isValid).toBe(true); // declined: still signed in, change still there
    window.confirm = vi.fn(() => true);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(pb.authStore.isValid).toBe(false));
  });
});


// In jsdom, fetch cannot send jsdom's FormData, so this test transport builds the multipart body by hand.
async function multipartTransport({ url, token, fields, file, filename }) {
  const boundary = "----bj" + rid();
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${file.type || "application/octet-stream"}\r\n\r\n`));
  parts.push(Buffer.from(await file.arrayBuffer()), Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await fetch(url, { method: "POST", headers: { Authorization: token, "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: Buffer.concat(parts) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe("photos in the browser", () => {
  const dir = mkdtempSync(join(tmpdir(), "bj-ui-"));
  const p = join(dir, "p.jpg");
  execFileSync("convert", ["-size", "480x360", "gradient:teal-gold", p]);
  const bytes = readFileSync(p);

  test("the browser's own upload path (XMLHttpRequest with progress) delivers a verified photo", async () => {
    const d = await device(owner);
    const cid = "xhr-" + rid();
    await d.engine.saveEntry(journal.id, cid, 0, fields({ title: "XHR photo" }));
    await d.engine.flush();
    const file = new File([bytes], "IMG_9.JPG", { type: "image/jpeg" });
    const progress = [];
    const res = await xhrTransport({
      url: process.env.PB_URL + "/api/bj/media/upload", token: d.pb.authStore.token,
      fields: { journal: journal.id, entry: await d.engine.serverEntryId(journal.id, cid), client_id: "m-" + rid(), kind: "image", sha256: await sha256Blob(file), size: file.size },
      file, filename: file.name, onProgress: (x) => progress.push(x),
    });
    expect(res.status).toBe(200);
    expect(res.json.media.status).toBe("stored");
    expect(res.json.media.derive_status).toBe("ready");
  });

  test("a photo on an entry shows as a thumbnail whose URL carries a token and really serves the image; a viewer sees the same", async () => {
    const { File: NodeFile } = await import("node:buffer"); // jsdom's File cannot go through fake-indexeddb or Node's fetch
    const d = await device(owner, { transport: multipartTransport });
    const cid = "ui-photo-" + rid();
    await d.engine.saveEntry(journal.id, cid, 0, fields({ title: "With photo " + cid }));
    await d.engine.flush();
    await d.queue.add({ journal: journal.id, entryClientId: cid, file: new NodeFile([bytes], "IMG_1.JPG", { type: "image/jpeg" }) });
    await d.queue.run();

    for (const who of [owner, viewer]) {
      pb.authStore.clear();
      cleanup();
      await signIn(who);
      window.location.hash = `/j/${journal.id}/e/${cid}`;
      const img = await waitFor(() => { const i = document.querySelector(".grid img"); expect(i).toBeTruthy(); return i; }, { timeout: 8000 });
      expect(img.src).toMatch(/\/api\/files\/[^/]+\/[^/]+\/[^?]+\?.*token=/);
      expect(img.src).toMatch(/thumb=320x0/);
      const r = await fetch(img.src);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/image\//);
      // Opening it shows the full display copy.
      fireEvent.click(document.querySelector(".grid .thumb"));
      const big = await waitFor(() => { const i = document.querySelector(".lightbox img"); expect(i).toBeTruthy(); return i; });
      expect(big.src).not.toMatch(/thumb=/);
      const canCaption = !!screen.queryByLabelText("Caption");
      expect(canCaption).toBe(who === owner); // viewers cannot edit captions
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    }
  });
});
