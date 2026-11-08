/// <reference path="../pb_data/types.d.ts" />
//
// Migration support (architecture v7, build step 6). Superuser only.
// Creates an entry exactly as the old app had it: same author, same "written on" time. The normal
// sync route cannot do that (it always uses the caller and the current time). Idempotent: running the
// import twice changes nothing, so an interrupted import is simply started again.
routerAdd("POST", "/api/bj/import/entry", (e) => {
  const lib = require(`${__hooks}/lib.js`);
  const b = e.requestInfo().body || {};
  const journalId = String(b.journal || "");
  const clientId = String(b.client_id || "");
  const authorId = String(b.author || "");
  if (clientId.length < 8 || clientId.length > 64) throw new BadRequestError("client_id must be 8 to 64 characters.");
  const f = lib.cleanEntryFields(b.fields);
  const created = Date.parse(String(b.created || ""));
  if (isNaN(created)) throw new BadRequestError("created must be a valid date.");
  const updated = b.updated ? Date.parse(String(b.updated)) : created;
  if (isNaN(updated)) throw new BadRequestError("updated must be a valid date.");
  const deleted = b.deleted_at ? new Date(Date.parse(String(b.deleted_at))).toISOString() : "";
  if (b.deleted_at && deleted === "Invalid Date") throw new BadRequestError("deleted_at must be a valid date.");

  let result;
  $app.runInTransaction((tx) => {
    try { tx.findRecordById("journals", journalId); } catch (_) { throw new NotFoundError("Journal not found."); }
    if (!lib.membership(tx, journalId, authorId)) throw new BadRequestError("author must be a member of the journal.");

    try {
      const existing = tx.findFirstRecordByFilter("entries", "journal = {:j} && client_id = {:c}", { j: journalId, c: clientId });
      result = { result: "exists", entry: existing };
      return;
    } catch (_) {}

    const entry = new Record(tx.findCollectionByNameOrId("entries"));
    entry.set("journal", journalId);
    entry.set("author", authorId);
    entry.set("client_id", clientId);
    entry.set("event_date", f.event_date);
    entry.set("type", f.type);
    entry.set("title", f.title);
    entry.set("text", f.text);
    entry.set("milestones", f.milestones);
    entry.set("values", f.values);
    entry.set("revision", 1);
    entry.set("needs_review", false);
    if (deleted) entry.set("deleted_at", deleted);
    tx.save(entry);

    const v = new Record(tx.findCollectionByNameOrId("entry_versions"));
    v.set("entry", entry.id); v.set("journal", journalId); v.set("revision", 1); v.set("base_revision", 0);
    v.set("author", authorId); v.set("title", f.title); v.set("text", f.text); v.set("values", f.values);
    v.set("milestones", f.milestones); v.set("event_date", f.event_date); v.set("status", "current");
    v.set("idempotency_key", "import-" + clientId.slice(0, 60));
    tx.save(v);

    // The timestamps are set by the database on save; put the original ones back.
    const iso = (ms) => new Date(ms).toISOString().replace("T", " ");
    tx.db().newQuery("UPDATE entries SET created = {:c}, updated = {:u} WHERE id = {:id}").bind({ c: iso(created), u: iso(updated), id: entry.id }).execute();
    tx.db().newQuery("UPDATE entry_versions SET created = {:c} WHERE id = {:id}").bind({ c: iso(created), id: v.id }).execute();
    lib.audit(tx, journalId, null, "entry_imported", entry.id, { source_id: clientId });
    result = { result: "created", entry: tx.findRecordById("entries", entry.id) };
  });
  return e.json(200, result);
}, $apis.requireSuperuserAuth());
