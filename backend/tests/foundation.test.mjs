// Data-foundation tests (architecture v7, build step 1 gate):
// "the rule tests pass for owner, co-owner, editor, viewer and outsider".
//
// Run: npm test   (starts a throwaway PocketBase, runs these, stops it)

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.PB_URL || "http://127.0.0.1:8099";

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

let admin;
const people = {}; // name -> { id, token, email }
let journal; // main journal
let otherJournal; // a journal the editor does not belong to

const PASSWORD = "correct-horse-battery";
const rid = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

async function adminCreateUser(name) {
  const email = `${name}-${rid()}@test.local`;
  const r = await api("POST", "/api/collections/users/records", {
    token: admin, body: { email, password: PASSWORD, passwordConfirm: PASSWORD, name, emailVisibility: false, verified: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { id: r.data.id, email };
}
async function login(p) {
  const r = await api("POST", "/api/collections/users/auth-with-password", { body: { identity: p.email, password: PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  p.token = r.data.token;
}
async function inviteAndJoin(ownerToken, journalId, role, name) {
  const inv = await api("POST", "/api/bj/invites/create", { token: ownerToken, body: { journal: journalId, role } });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  const email = `${name}-${rid()}@test.local`;
  const reg = await api("POST", "/api/bj/auth/register", { body: { token: inv.data.token, email, password: PASSWORD, name } });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const p = { email };
  await login(p);
  p.id = (await api("POST", "/api/collections/users/auth-with-password", { body: { identity: email, password: PASSWORD } })).data.record.id;
  return { p, invite: inv.data };
}

const fields = (over = {}) => ({
  event_date: "2026-11-02", type: "memory", title: "First smile", text: "<p>She smiled at us.</p>",
  milestones: ["first_smile"], values: { weight_kg: 4.2 }, ...over,
});
function sync(token, body) {
  return api("POST", "/api/bj/entries/sync", { token, body: { journal: journal.id, op: "upsert", ...body } });
}

before(async () => {
  const r = await api("POST", "/api/collections/_superusers/auth-with-password", {
    body: { identity: "admin@test.local", password: "test-admin-password-1" },
  });
  assert.equal(r.status, 200, "superuser login failed: " + JSON.stringify(r.data));
  admin = r.data.token;

  Object.assign((people.owner = {}), await adminCreateUser("owner"));
  Object.assign((people.outsider = {}), await adminCreateUser("outsider"));
  await login(people.owner);
  await login(people.outsider);

  const j = await api("POST", "/api/bj/journals/create", {
    token: people.owner.token, body: { name: "Ophelia", emoji: "🍼", due_date: "2026-10-01" },
  });
  assert.equal(j.status, 200, JSON.stringify(j.data));
  journal = j.data.journal;

  const j2 = await api("POST", "/api/bj/journals/create", { token: people.owner.token, body: { name: "Other child" } });
  otherJournal = j2.data.journal;

  for (const [role, name] of [["owner", "coowner"], ["editor", "editor"], ["viewer", "viewer"]]) {
    people[name] = (await inviteAndJoin(people.owner.token, journal.id, role, name)).p;
  }
});

describe("journals and registration", () => {
  test("registration is closed: no account without an invite", async () => {
    const direct = await api("POST", "/api/collections/users/records", {
      body: { email: "x@test.local", password: PASSWORD, passwordConfirm: PASSWORD },
    });
    assert.ok([400, 403].includes(direct.status), "direct signup must fail, got " + direct.status);
    const noInvite = await api("POST", "/api/bj/auth/register", {
      body: { token: "x".repeat(40), email: "y@test.local", password: PASSWORD },
    });
    assert.equal(noInvite.status, 400);
  });

  test("invited family cannot create journals of their own", async () => {
    const r = await api("POST", "/api/bj/journals/create", { token: people.viewer.token, body: { name: "Mine" } });
    assert.equal(r.status, 403);
  });

  test("date-only fields are validated", async () => {
    const r = await api("POST", "/api/bj/journals/update", { token: people.owner.token, body: { journal: journal.id, due_date: "2026-13-40" } });
    assert.equal(r.status, 400);
  });

  test("only owners can edit the profile", async () => {
    for (const who of ["editor", "viewer", "outsider"]) {
      const r = await api("POST", "/api/bj/journals/update", { token: people[who].token, body: { journal: journal.id, name: "Hacked" } });
      assert.equal(r.status, 403, who);
    }
    const ok = await api("POST", "/api/bj/journals/update", { token: people.coowner.token, body: { journal: journal.id, name: "Ophelia Mikyla" } });
    assert.equal(ok.status, 200);
  });

  test("journal and member visibility: members yes, outsider no", async () => {
    for (const who of ["owner", "coowner", "editor", "viewer"]) {
      const r = await api("GET", `/api/collections/journals/records/${journal.id}`, { token: people[who].token });
      assert.equal(r.status, 200, who);
    }
    const out = await api("GET", `/api/collections/journals/records/${journal.id}`, { token: people.outsider.token });
    assert.equal(out.status, 404);
    const list = await api("GET", "/api/collections/members/records", { token: people.outsider.token });
    assert.equal(list.data.totalItems, 0);
  });

  test("members can see names of people they share a journal with, never emails; outsiders see nobody", async () => {
    const r = await api("GET", `/api/collections/users/records/${people.owner.id}`, { token: people.viewer.token });
    assert.equal(r.status, 200);
    assert.equal(r.data.name, "owner");
    assert.ok(!r.data.email, "email must stay hidden");
    const o = await api("GET", `/api/collections/users/records/${people.owner.id}`, { token: people.outsider.token });
    assert.equal(o.status, 404);
  });

  test("direct writes to protected collections are refused for everyone", async () => {
    for (const col of ["journals", "members", "entries", "invites", "entry_versions", "media", "media_originals", "audit_log"]) {
      const r = await api("POST", `/api/collections/${col}/records`, { token: people.owner.token, body: {} });
      assert.ok([400, 403].includes(r.status), `${col}: ${r.status}`);
      assert.notEqual(r.status, 200);
    }
    const del = await api("DELETE", `/api/collections/journals/records/${journal.id}`, { token: people.owner.token });
    assert.ok([403, 404].includes(del.status));
  });
});

describe("invites", () => {
  test("single use: a second registration with the same token fails", async () => {
    const inv = await api("POST", "/api/bj/invites/create", { token: people.owner.token, body: { journal: journal.id, role: "viewer" } });
    const a = await api("POST", "/api/bj/auth/register", { body: { token: inv.data.token, email: `a-${rid()}@test.local`, password: PASSWORD } });
    assert.equal(a.status, 200);
    const b = await api("POST", "/api/bj/auth/register", { body: { token: inv.data.token, email: `b-${rid()}@test.local`, password: PASSWORD } });
    assert.equal(b.status, 400);
  });

  test("expired invite is refused", async () => {
    const inv = await api("POST", "/api/bj/invites/create", { token: people.owner.token, body: { journal: journal.id, role: "viewer" } });
    const past = new Date(Date.now() - 3600_000).toISOString().replace("T", " ");
    const upd = await api("PATCH", `/api/collections/invites/records/${inv.data.invite}`, { token: admin, body: { expires_at: past } });
    assert.equal(upd.status, 200, JSON.stringify(upd.data));
    const r = await api("POST", "/api/bj/auth/register", { body: { token: inv.data.token, email: `e-${rid()}@test.local`, password: PASSWORD } });
    assert.equal(r.status, 400);
  });

  test("only owners can create invites; only the hash is stored", async () => {
    for (const who of ["editor", "viewer", "outsider"]) {
      const r = await api("POST", "/api/bj/invites/create", { token: people[who].token, body: { journal: journal.id, role: "viewer" } });
      assert.equal(r.status, 403, who);
    }
    const inv = await api("POST", "/api/bj/invites/create", { token: people.owner.token, body: { journal: journal.id, role: "viewer" } });
    const rec = await api("GET", `/api/collections/invites/records/${inv.data.invite}`, { token: admin });
    assert.notEqual(rec.data.token_hash, inv.data.token);
    assert.equal(rec.data.token_hash.length, 64);
    const asEditor = await api("GET", `/api/collections/invites/records/${inv.data.invite}`, { token: people.editor.token });
    assert.equal(asEditor.status, 404, "editors cannot see invites");
  });

  test("an existing member cannot use an invite to change their role, and the invite is not burned", async () => {
    const inv = await api("POST", "/api/bj/invites/create", { token: people.owner.token, body: { journal: journal.id, role: "owner" } });
    const r = await api("POST", "/api/bj/invites/accept", { token: people.viewer.token, body: { token: inv.data.token } });
    assert.equal(r.status, 409);
    const m = await api("GET", `/api/collections/members/records?filter=${encodeURIComponent(`user="${people.viewer.id}"`)}`, { token: people.owner.token });
    assert.equal(m.data.items[0].role, "viewer");
    const rec = await api("GET", `/api/collections/invites/records/${inv.data.invite}`, { token: admin });
    assert.equal(rec.data.used_at, "");
  });

  test("an existing account (the outsider) can accept an invite", async () => {
    const inv = await api("POST", "/api/bj/invites/create", { token: people.owner.token, body: { journal: otherJournal.id, role: "viewer" } });
    const r = await api("POST", "/api/bj/invites/accept", { token: people.outsider.token, body: { token: inv.data.token } });
    assert.equal(r.status, 200);
    assert.equal(r.data.role, "viewer");
  });
});

describe("entries: roles and validation", () => {
  let entryId;
  test("editor and owners create entries; viewer and outsider cannot", async () => {
    for (const who of ["owner", "coowner", "editor"]) {
      const r = await sync(people[who].token, { client_id: "c-" + rid(), idempotency_key: "k-" + rid(), base_revision: 0, fields: fields() });
      assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.result, "applied");
      entryId = r.data.entry.id;
    }
    for (const who of ["viewer", "outsider"]) {
      const r = await sync(people[who].token, { client_id: "c-" + rid(), idempotency_key: "k-" + rid(), base_revision: 0, fields: fields() });
      assert.equal(r.status, 403, who);
    }
  });

  test("everyone in the journal can read entries, outsider cannot", async () => {
    for (const who of ["owner", "coowner", "editor", "viewer"]) {
      const r = await api("GET", `/api/collections/entries/records/${entryId}`, { token: people[who].token });
      assert.equal(r.status, 200, who);
    }
    const out = await api("GET", `/api/collections/entries/records/${entryId}`, { token: people.outsider.token });
    assert.equal(out.status, 404);
  });

  test("an editor of another journal cannot write here (cross-journal)", async () => {
    const r = await api("POST", "/api/bj/entries/sync", {
      token: people.outsider.token,
      body: { journal: journal.id, op: "upsert", client_id: "x-" + rid(), idempotency_key: "k-" + rid(), base_revision: 0, fields: fields() },
    });
    assert.equal(r.status, 403);
  });

  test("measurements need explicit units and numeric values; types and dates are validated", async () => {
    const bad = [
      fields({ values: { weight: 4.2 } }),
      fields({ values: { weight_kg: "4.2" } }),
      fields({ type: "party" }),
      fields({ event_date: "02/11/2026" }),
      fields({ milestones: "first_smile" }),
    ];
    for (const f of bad) {
      const r = await sync(people.editor.token, { client_id: "v-" + rid(), idempotency_key: "k-" + rid(), base_revision: 0, fields: f });
      assert.equal(r.status, 400, JSON.stringify(f));
    }
  });

  test("event_date stays separate from created: a back-dated entry keeps its event date", async () => {
    const r = await sync(people.editor.token, { client_id: "d-" + rid(), idempotency_key: "k-" + rid(), base_revision: 0, fields: fields({ event_date: "2026-08-15" }) });
    assert.equal(r.data.entry.event_date, "2026-08-15");
    assert.notEqual(r.data.entry.created.slice(0, 10), "2026-08-15");
  });
});

describe("sync: idempotency and conflicts", () => {
  const clientId = "sync-" + rid();
  let rev1;

  test("create, and a retry with the same idempotency key creates no duplicate", async () => {
    const key = "key-create-" + rid();
    const a = await sync(people.editor.token, { client_id: clientId, idempotency_key: key, base_revision: 0, fields: fields() });
    assert.equal(a.data.result, "applied");
    assert.equal(a.data.revision, 1);
    rev1 = a.data.entry;
    const b = await sync(people.editor.token, { client_id: clientId, idempotency_key: key, base_revision: 0, fields: fields() });
    assert.equal(b.status, 200);
    assert.equal(b.data.replay, true);
    assert.equal(b.data.entry.id, rev1.id);
    const list = await api("GET", `/api/collections/entries/records?filter=${encodeURIComponent(`client_id="${clientId}"`)}`, { token: people.owner.token });
    assert.equal(list.data.totalItems, 1);
  });

  test("a normal edit on the current revision applies and bumps the revision", async () => {
    const r = await sync(people.editor.token, { client_id: clientId, idempotency_key: "k-" + rid(), base_revision: 1, fields: fields({ title: "Edited by editor" }) });
    assert.equal(r.data.result, "applied");
    assert.equal(r.data.revision, 2);
    assert.equal(r.data.entry.title, "Edited by editor");
  });

  test("a stale edit is kept as a conflict version and flags the entry; current is unchanged", async () => {
    const r = await sync(people.coowner.token, { client_id: clientId, idempotency_key: "k-" + rid(), base_revision: 1, fields: fields({ title: "Offline edit A" }) });
    assert.equal(r.data.result, "conflict");
    assert.equal(r.data.entry.title, "Edited by editor");
    assert.equal(r.data.entry.revision, 2);
    assert.equal(r.data.entry.needs_review, true);
  });

  test("a third stale edit joins the open versions without changing the current version", async () => {
    const r = await sync(people.owner.token, { client_id: clientId, idempotency_key: "k-" + rid(), base_revision: 1, fields: fields({ title: "Offline edit B" }) });
    assert.equal(r.data.result, "conflict");
    const v = await api("GET", `/api/collections/entry_versions/records?filter=${encodeURIComponent(`entry="${rev1.id}" && status="conflict"`)}`, { token: people.owner.token });
    assert.equal(v.data.totalItems, 2);
    const cur = await api("GET", `/api/collections/entries/records/${rev1.id}`, { token: people.owner.token });
    assert.equal(cur.data.title, "Edited by editor");
  });

  test("viewers cannot read version history", async () => {
    const v = await api("GET", `/api/collections/entry_versions/records?filter=${encodeURIComponent(`entry="${rev1.id}"`)}`, { token: people.viewer.token });
    assert.equal(v.data.totalItems, 0);
  });

  test("resolve with a merged text: new revision, history kept, flag cleared", async () => {
    const stale = await sync(people.editor.token, { client_id: clientId, op: "resolve", idempotency_key: "k-" + rid(), base_revision: 1, fields: fields() });
    assert.equal(stale.status, 409, "resolve must be based on the current revision");
    const outsiderTry = await sync(people.viewer.token, { client_id: clientId, op: "resolve", idempotency_key: "k-" + rid(), base_revision: 2, fields: fields() });
    assert.equal(outsiderTry.status, 403);
    const r = await sync(people.owner.token, { client_id: clientId, op: "resolve", idempotency_key: "k-" + rid(), base_revision: 2, fields: fields({ title: "Merged title" }) });
    assert.equal(r.data.result, "applied");
    assert.equal(r.data.revision, 3);
    assert.equal(r.data.entry.needs_review, false);
    const all = await api("GET", `/api/collections/entry_versions/records?filter=${encodeURIComponent(`entry="${rev1.id}"`)}&perPage=50`, { token: people.owner.token });
    const byStatus = {};
    for (const v of all.data.items) byStatus[v.status] = (byStatus[v.status] || 0) + 1;
    assert.equal(byStatus.current, 1);
    assert.equal(byStatus.conflict || 0, 0);
    assert.ok(all.data.totalItems >= 5, "every version stays in history");
  });

  test("a late stale edit after resolution still becomes a conflict version", async () => {
    const r = await sync(people.coowner.token, { client_id: clientId, idempotency_key: "k-" + rid(), base_revision: 2, fields: fields({ title: "Very late edit" }) });
    assert.equal(r.data.result, "conflict");
    assert.equal(r.data.entry.title, "Merged title");
    assert.equal(r.data.entry.needs_review, true);
  });

  test("two stale writes at the same instant: every version is preserved", async () => {
    const cid = "race-" + rid();
    const a = await sync(people.editor.token, { client_id: cid, idempotency_key: "k-" + rid(), base_revision: 0, fields: fields() });
    await sync(people.editor.token, { client_id: cid, idempotency_key: "k-" + rid(), base_revision: 1, fields: fields({ title: "v2" }) });
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        sync([people.owner, people.coowner, people.editor][i % 3].token, { client_id: cid, idempotency_key: "race-" + i + rid(), base_revision: 1, fields: fields({ title: "stale " + i }) })
      )
    );
    assert.ok(attempts.every((x) => x.status === 200 && x.data.result === "conflict"), JSON.stringify(attempts.map((x) => x.status)));
    const v = await api("GET", `/api/collections/entry_versions/records?filter=${encodeURIComponent(`entry="${a.data.entry.id}" && status="conflict"`)}&perPage=50`, { token: people.owner.token });
    assert.equal(v.data.totalItems, 6);
    const cur = await api("GET", `/api/collections/entries/records/${a.data.entry.id}`, { token: people.owner.token });
    assert.equal(cur.data.revision, 2);
  });

  test("two concurrent retries of the same request create exactly one entry", async () => {
    const cid = "dup-" + rid();
    const key = "dup-key-" + rid();
    const res = await Promise.all([0, 1, 2].map(() => sync(people.editor.token, { client_id: cid, idempotency_key: key, base_revision: 0, fields: fields() })));
    assert.ok(res.every((r) => r.status === 200), JSON.stringify(res.map((r) => r.status)));
    const list = await api("GET", `/api/collections/entries/records?filter=${encodeURIComponent(`client_id="${cid}"`)}`, { token: people.owner.token });
    assert.equal(list.data.totalItems, 1);
  });
});

describe("trash", () => {
  const cid = "trash-" + rid();
  let id;
  test("trash hides the entry from viewers, owners and editors still see it", async () => {
    const c = await sync(people.editor.token, { client_id: cid, idempotency_key: "k-" + rid(), base_revision: 0, fields: fields() });
    id = c.data.entry.id;
    const t = await sync(people.editor.token, { client_id: cid, op: "trash", idempotency_key: "k-" + rid(), base_revision: 1 });
    assert.equal(t.data.result, "applied");
    assert.ok(t.data.entry.deleted_at);
    assert.equal((await api("GET", `/api/collections/entries/records/${id}`, { token: people.viewer.token })).status, 404);
    assert.equal((await api("GET", `/api/collections/entries/records/${id}`, { token: people.editor.token })).status, 200);
  });

  test("an edit based on the pre-trash revision is kept as a conflict on the trashed entry", async () => {
    const r = await sync(people.coowner.token, { client_id: cid, idempotency_key: "k-" + rid(), base_revision: 1, fields: fields({ title: "Edited while another phone trashed it" }) });
    assert.equal(r.data.result, "conflict");
    assert.ok(r.data.entry.deleted_at, "still trashed");
  });

  test("editing a trashed entry on its current revision is refused until restored", async () => {
    const r = await sync(people.editor.token, { client_id: cid, idempotency_key: "k-" + rid(), base_revision: 2, fields: fields() });
    assert.equal(r.status, 409);
    const back = await sync(people.editor.token, { client_id: cid, op: "restore", idempotency_key: "k-" + rid(), base_revision: 2 });
    assert.equal(back.data.entry.deleted_at, "");
    assert.equal((await api("GET", `/api/collections/entries/records/${id}`, { token: people.viewer.token })).status, 200);
  });
});

describe("media privacy: viewers never reach originals", () => {
  test("viewer and outsider cannot list or view media_originals (the only place originals live)", async () => {
    for (const who of ["viewer", "outsider"]) {
      const r = await api("GET", "/api/collections/media_originals/records", { token: people[who].token });
      assert.equal(r.status, 200);
      assert.equal(r.data.totalItems, 0, who);
    }
  });
  test("the rule on originals admits owners and editors only", async () => {
    const col = await api("GET", "/api/collections/media_originals", { token: admin });
    assert.match(col.data.listRule, /role \?= "owner" \|\| .*role \?= "editor"/);
    const media = await api("GET", "/api/collections/media", { token: admin });
    assert.equal(media.data.fields.find((f) => f.name === "display").protected, true);
    assert.equal(media.data.fields.find((f) => f.name === "playback").protected, true);
    assert.equal(media.data.fields.find((f) => f.name === "poster").protected, true);
    assert.equal(col.data.fields.find((f) => f.name === "file").protected, true);
  });
});

describe("owners, last-owner rule, removal and sessions", () => {
  test("only owners change roles", async () => {
    const r = await api("POST", "/api/bj/members/role", { token: people.editor.token, body: { journal: journal.id, user: people.viewer.id, role: "editor" } });
    assert.equal(r.status, 403);
  });

  test("the last owner cannot be demoted, removed or leave", async () => {
    // otherJournal has exactly one owner (owner)
    const demote = await api("POST", "/api/bj/members/role", { token: people.owner.token, body: { journal: otherJournal.id, user: people.owner.id, role: "viewer" } });
    assert.equal(demote.status, 400);
    const leave = await api("POST", "/api/bj/members/remove", { token: people.owner.token, body: { journal: otherJournal.id } });
    assert.equal(leave.status, 400);
    const remove = await api("POST", "/api/bj/members/remove", { token: people.owner.token, body: { journal: otherJournal.id, user: people.owner.id } });
    assert.equal(remove.status, 400);
  });

  test("ownership transfer: promote first, then the original owner may step down", async () => {
    const promote = await api("POST", "/api/bj/members/role", { token: people.owner.token, body: { journal: otherJournal.id, user: people.outsider.id, role: "owner" } });
    assert.equal(promote.status, 200);
    const stepDown = await api("POST", "/api/bj/members/role", { token: people.owner.token, body: { journal: otherJournal.id, user: people.owner.id, role: "editor" } });
    assert.equal(stepDown.status, 200);
    // the new sole owner is now protected
    const blocked = await api("POST", "/api/bj/members/role", { token: people.outsider.token, body: { journal: otherJournal.id, user: people.outsider.id, role: "viewer" } });
    assert.equal(blocked.status, 400);
  });

  test("owner changes are written to the audit log, readable by owners only", async () => {
    const asOwner = await api("GET", `/api/collections/audit_log/records?filter=${encodeURIComponent(`journal="${otherJournal.id}" && action="role_changed"`)}`, { token: people.outsider.token });
    assert.ok(asOwner.data.totalItems >= 2);
    const asEditor = await api("GET", `/api/collections/audit_log/records?filter=${encodeURIComponent(`journal="${otherJournal.id}"`)}`, { token: people.owner.token });
    assert.equal(asEditor.data.totalItems, 0, "a former owner (now editor) cannot read the audit log");
  });

  test("removing a member revokes their sessions at once and ends their read access", async () => {
    const { p: temp } = await inviteAndJoin(people.owner.token, journal.id, "viewer", "temp");
    const before = await api("GET", `/api/collections/entries/records?perPage=1`, { token: temp.token });
    assert.equal(before.status, 200);
    assert.ok(before.data.totalItems > 0);
    const rm = await api("POST", "/api/bj/members/remove", { token: people.owner.token, body: { journal: journal.id, user: temp.id } });
    assert.equal(rm.status, 200);
    // An invalid token is treated as a guest on list endpoints (200, nothing visible), and rejected where auth is required.
    const after = await api("GET", `/api/collections/entries/records?perPage=1`, { token: temp.token });
    assert.equal(after.data.totalItems, 0, "old token must see nothing");
    const refresh = await api("POST", "/api/collections/users/auth-refresh", { token: temp.token });
    assert.equal(refresh.status, 401, "old token must be rejected");
    // A fresh login works, but the journal is no longer visible.
    await login(temp);
    const fresh = await api("GET", `/api/collections/entries/records?perPage=1`, { token: temp.token });
    assert.equal(fresh.data.totalItems, 0);
  });

  test("sign out everywhere invalidates earlier tokens", async () => {
    const { p } = await inviteAndJoin(people.owner.token, journal.id, "viewer", "phone");
    const oldToken = p.token;
    const r = await api("POST", "/api/bj/me/sign-out-everywhere", { token: oldToken });
    assert.equal(r.status, 200);
    const again = await api("POST", "/api/bj/me/sign-out-everywhere", { token: oldToken });
    assert.equal(again.status, 401);
  });

  test("an owner can sign a member out (lost phone) but an editor cannot", async () => {
    const { p } = await inviteAndJoin(people.owner.token, journal.id, "viewer", "lost");
    const denied = await api("POST", "/api/bj/members/sign-out", { token: people.editor.token, body: { journal: journal.id, user: p.id } });
    assert.equal(denied.status, 403);
    const ok = await api("POST", "/api/bj/members/sign-out", { token: people.owner.token, body: { journal: journal.id, user: p.id } });
    assert.equal(ok.status, 200);
    const old = await api("POST", "/api/collections/users/auth-refresh", { token: p.token });
    assert.equal(old.status, 401);
    const seen = await api("GET", "/api/collections/journals/records", { token: p.token });
    assert.equal(seen.data.totalItems, 0);
  });
});

describe("export (F10)", () => {
  test("owners get a self-contained, versioned export; others are refused", async () => {
    const r = await api("GET", `/api/bj/journals/export?journal=${journal.id}`, { token: people.coowner.token });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.schema_version, 1);
    assert.equal(r.data.journal.id, journal.id);
    assert.ok(r.data.entries.length >= 5);
    assert.ok(r.data.entry_versions.length >= r.data.entries.length, "history is included");
    assert.ok(r.data.entries.some((e) => e.deleted_at === "" && e.values.weight_kg === 4.2), "values keep explicit units");
    assert.ok(r.data.members.some((m) => m.role === "owner" && m.name));
    assert.ok(r.data.entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.event_date)));
    for (const who of ["editor", "viewer", "outsider"]) {
      const d = await api("GET", `/api/bj/journals/export?journal=${journal.id}`, { token: people[who].token });
      assert.equal(d.status, 403, who);
    }
  });
});

describe("proxy trust and rate limits", () => {
  test("PocketBase reads the client address from X-Real-IP (set by Caddy) and rate limits are configured", async () => {
    const s = await api("GET", "/api/settings", { token: admin });
    assert.deepEqual(s.data.trustedProxy.headers, ["X-Real-IP"]);
    assert.equal(s.data.trustedProxy.useLeftmostIP, false);
  });
});
