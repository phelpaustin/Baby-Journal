import PocketBase, { BaseAuthStore } from "pocketbase";
import { createDb } from "../src/lib/db.js";
import { createEngine } from "../src/lib/sync.js";
import { createMediaQueue, fetchTransport } from "../src/lib/media.js";

export const URL_ = () => process.env.PB_URL;
export const PASSWORD = "correct-horse-battery";
export const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

let adminPb;
export async function admin() {
  if (adminPb) return adminPb;
  adminPb = new PocketBase(URL_(), new BaseAuthStore());
  adminPb.autoCancellation(false);
  await adminPb.collection("_superusers").authWithPassword("admin@test.local", "test-admin-password-1");
  return adminPb;
}

export async function makeUser(name) {
  const a = await admin();
  const email = `${name}-${rid()}@test.local`;
  const u = await a.collection("users").create({ email, password: PASSWORD, passwordConfirm: PASSWORD, name, verified: true });
  return { id: u.id, email };
}

export async function makeJournal(members, extra = {}) {
  const a = await admin();
  const j = await a.collection("journals").create({ name: "Ophelia", ...extra });
  for (const [user, role] of members) await a.collection("members").create({ journal: j.id, user: user.id, role });
  return j;
}

// One "device": its own PocketBase client, IndexedDB and engine, signed in as `user`.
export async function device(user, opts = {}) {
  const pb = new PocketBase(URL_(), new BaseAuthStore()); // in-memory: never shares localStorage with the app under test
  pb.autoCancellation(false);
  await pb.collection("users").authWithPassword(user.email, PASSWORD);
  const db = await createDb("bj-" + rid());
  const state = { online: true };
  const online = () => state.online;
  const engine = createEngine({ pb, db, userId: user.id, online, schedule: false });
  const uploaded = [];
  const queue = createMediaQueue({
    pb, db, userId: user.id, engine, online, schedule: false,
    transport: opts.transport || fetchTransport,
    onUploaded: async (item, media) => { uploaded.push(media); },
  });
  return { pb, db, engine, queue, state, uploaded, user };
}

export const fields = (over = {}) => ({
  event_date: "2026-11-02", type: "memory", title: "First smile", text: "She smiled at us.",
  milestones: ["first_smile"], values: {}, ...over,
});
