// Migration route tests: original author and original timestamps are kept, and re-running changes nothing.
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.PB_URL || "http://127.0.0.1:8099";
const PASSWORD = "correct-horse-battery";
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}
let admin, wife, husband, outsider, journal;
const fields = (over = {}) => ({ event_date: "2025-04-20", type: "memory", title: "First smile", text: "She smiled.", milestones: ["first_smile"], values: { weight_kg: 4.2 }, ...over });
const imp = (body, token = admin) => api("POST", "/api/bj/import/entry", { token, body });

before(async () => {
  admin = (await api("POST", "/api/collections/_superusers/auth-with-password", { body: { identity: "admin@test.local", password: "test-admin-password-1" } })).data.token;
  const mk = async (name) => {
    const email = `${name}-${rid()}@test.local`;
    const u = await api("POST", "/api/collections/users/records", { token: admin, body: { email, password: PASSWORD, passwordConfirm: PASSWORD, name, verified: true } });
    const l = await api("POST", "/api/collections/users/auth-with-password", { body: { identity: email, password: PASSWORD } });
    return { id: u.data.id, token: l.data.token };
  };
  [wife, husband, outsider] = [await mk("wife"), await mk("husband"), await mk("outsider")];
  journal = (await api("POST", "/api/collections/journals/records", { token: admin, body: { name: "Imported" } })).data;
  for (const [u, role] of [[wife, "owner"], [husband, "owner"]]) await api("POST", "/api/collections/members/records", { token: admin, body: { journal: journal.id, user: u.id, role } });
});

describe("import entry", () => {
  const cid = "imp-" + rid();
  test("keeps the original author and the original written-on time", async () => {
    const r = await imp({ journal: journal.id, client_id: cid, author: wife.id, fields: fields(), created: "2025-04-20T18:30:00Z", updated: "2025-04-21T07:00:00Z" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.result, "created");
    const e = r.data.entry;
    assert.equal(e.author, wife.id);
    assert.equal(e.created.slice(0, 19), "2025-04-20 18:30:00");
    assert.equal(e.updated.slice(0, 19), "2025-04-21 07:00:00");
    assert.equal(e.revision, 1);
    const seen = await api("GET", `/api/collections/entries/records/${e.id}`, { token: husband.token });
    assert.equal(seen.status, 200);
    assert.equal(seen.data.created.slice(0, 10), "2025-04-20");
    const v = await api("GET", `/api/collections/entry_versions/records?filter=${encodeURIComponent(`entry="${e.id}"`)}`, { token: wife.token });
    assert.equal(v.data.totalItems, 1);
  });

  test("running it again changes nothing and creates no duplicate", async () => {
    const again = await imp({ journal: journal.id, client_id: cid, author: husband.id, fields: fields({ title: "DIFFERENT" }), created: "2030-01-01T00:00:00Z" });
    assert.equal(again.data.result, "exists");
    assert.equal(again.data.entry.title, "First smile");
    assert.equal(again.data.entry.author, wife.id);
    const list = await api("GET", `/api/collections/entries/records?filter=${encodeURIComponent(`client_id="${cid}"`)}`, { token: wife.token });
    assert.equal(list.data.totalItems, 1);
  });

  test("an imported entry can be edited afterwards like any other, from revision 1", async () => {
    const e = (await api("GET", `/api/collections/entries/records?filter=${encodeURIComponent(`client_id="${cid}"`)}`, { token: wife.token })).data.items[0];
    const r = await api("POST", "/api/bj/entries/sync", { token: husband.token, body: { journal: journal.id, client_id: cid, idempotency_key: "k-" + rid(), op: "upsert", base_revision: 1, fields: fields({ title: "Edited later" }) } });
    assert.equal(r.data.result, "applied");
    assert.equal(r.data.entry.revision, 2);
    assert.equal(r.data.entry.created.slice(0, 10), "2025-04-20", "the written-on time stays");
    assert.equal(e.author, wife.id);
  });

  test("trashed entries stay in the trash; bad input is refused; only the superuser may import", async () => {
    const t = await imp({ journal: journal.id, client_id: "imp-" + rid(), author: wife.id, fields: fields(), created: "2025-05-01T00:00:00Z", deleted_at: new Date(Date.now() - 2 * 86400000).toISOString() }); // recent, so the purge tests are unaffected
    assert.ok(t.data.entry.deleted_at);
    const bad = [
      { fields: fields({ values: { weight: 4 } }) }, { fields: fields({ event_date: "20-04-2025" }) }, { created: "yesterday" },
      { client_id: "short" }, { author: outsider.id }, { journal: "nope" },
    ];
    for (const over of bad) {
      const r = await imp({ journal: journal.id, client_id: "imp-" + rid(), author: wife.id, fields: fields(), created: "2025-05-01T00:00:00Z", ...over });
      assert.ok([400, 404].includes(r.status), JSON.stringify(over) + " -> " + r.status);
    }
    for (const who of [wife, outsider]) assert.ok([401, 403].includes((await imp({ journal: journal.id, client_id: "imp-" + rid(), author: wife.id, fields: fields(), created: "2025-05-01T00:00:00Z" }, who.token)).status));
  });
});
