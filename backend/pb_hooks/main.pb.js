/// <reference path="../pb_data/types.d.ts" />
//
// Baby Journal server logic (architecture v7, sections 4.1, 4.3, 5.2 and 5.4).
// Pinned to PocketBase 0.40.x. Run `npm test` in backend/ before any upgrade.
//
// Every write to journals, members, invites and entries goes through a route
// here, inside one transaction, so the rules that PocketBase access rules
// cannot express (last owner, single-use invites, atomic revision check,
// idempotent retries) are enforced in one place.

// -------------------------------------------------------------- journals
routerAdd("POST", "/api/bj/journals/create", (e) => {
  const lib = require(`${__hooks}/lib.js`);
  const b = e.requestInfo().body || {};
  const userId = e.auth.id;

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 200) throw new BadRequestError("name is required (max 200 characters).");
  for (const k of ["due_date", "dob"]) {
    if (b[k] && !lib.validDate(b[k])) throw new BadRequestError(k + " must be a valid YYYY-MM-DD date.");
  }

  let journalId;
  $app.runInTransaction((tx) => {
    // Journal creation is for the first user, or for existing owners. Invited
    // family cannot spawn journals (and storage) of their own.
    const total = tx.countRecords("journals");
    const ownsAny = tx.countRecords("members", $dbx.hashExp({ user: userId, role: "owner" })) > 0;
    if (total > 0 && !ownsAny) throw new ForbiddenError("You do not have permission to do that.");

    const j = new Record(tx.findCollectionByNameOrId("journals"));
    j.set("name", name);
    j.set("emoji", typeof b.emoji === "string" ? b.emoji.slice(0, 16) : "");
    j.set("due_date", b.due_date || "");
    j.set("dob", b.dob || "");
    j.set("settings", {});
    j.set("created_by", userId);
    tx.save(j);

    const m = new Record(tx.findCollectionByNameOrId("members"));
    m.set("journal", j.id);
    m.set("user", userId);
    m.set("role", "owner");
    tx.save(m);

    lib.audit(tx, j.id, userId, "journal_created", j.id, {});
    journalId = j.id;
  });

  return e.json(200, { journal: $app.findRecordById("journals", journalId) });
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bj/journals/update", (e) => {
  const lib = require(`${__hooks}/lib.js`);
  const b = e.requestInfo().body || {};
  const journalId = String(b.journal || "");

  $app.runInTransaction((tx) => {
    lib.requireRole(tx, journalId, e.auth.id, ["owner"]);
    const j = tx.findRecordById("journals", journalId);
    if (b.name !== undefined) {
      if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 200) throw new BadRequestError("Invalid name.");
      j.set("name", b.name.trim());
    }
    if (b.emoji !== undefined) j.set("emoji", String(b.emoji).slice(0, 16));
    for (const k of ["due_date", "dob"]) {
      if (b[k] !== undefined) {
        if (b[k] && !lib.validDate(b[k])) throw new BadRequestError(k + " must be a valid YYYY-MM-DD date.");
        j.set(k, b[k] || "");
      }
    }
    if (b.settings !== undefined) {
      if (typeof b.settings !== "object" || b.settings === null || Array.isArray(b.settings)) throw new BadRequestError("Invalid settings.");
      j.set("settings", b.settings);
    }
    tx.save(j);
    lib.audit(tx, j.id, e.auth.id, "journal_updated", j.id, { fields: Object.keys(b).filter((k) => k !== "journal") });
  });

  return e.json(200, { journal: $app.findRecordById("journals", journalId) });
}, $apis.requireAuth("users"));

// ---------------------------------------------------------------- invites
routerAdd("POST", "/api/bj/invites/create", (e) => {
  const lib = require(`${__hooks}/lib.js`);
  const b = e.requestInfo().body || {};
  const journalId = String(b.journal || "");
  const role = String(b.role || "");
  if (lib.ROLES.indexOf(role) === -1) throw new BadRequestError("role must be owner, editor or viewer.");

  const token = $security.randomString(40);
  const expires = new Date(Date.now() + lib.INVITE_TTL_MS).toISOString();
  let inviteId;

  $app.runInTransaction((tx) => {
    lib.requireRole(tx, journalId, e.auth.id, ["owner"]);
    const inv = new Record(tx.findCollectionByNameOrId("invites"));
    inv.set("journal", journalId);
    inv.set("token_hash", $security.sha256(token)); // only the hash is stored
    inv.set("role", role);
    inv.set("expires_at", expires);
    inv.set("created_by", e.auth.id);
    tx.save(inv);
    lib.audit(tx, journalId, e.auth.id, "invite_created", inv.id, { role: role });
    inviteId = inv.id;
  });

  // The raw token is returned exactly once and never stored.
  return e.json(200, { invite: inviteId, token: token, role: role, expires_at: expires });
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bj/invites/accept", (e) => {
  const lib = require(`${__hooks}/lib.js`);
  const b = e.requestInfo().body || {};
  let out;
  $app.runInTransaction((tx) => {
    out = lib.consumeInvite(tx, b.token, e.auth.id);
  });
  return e.json(200, out);
}, $apis.requireAuth("users"));

// Registration is closed: an account can only be created together with a valid invite.
routerAdd("POST", "/api/bj/auth/register", (e) => {
  const lib = require(`${__hooks}/lib.js`);
  const b = e.requestInfo().body || {};
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 100) : "";
  const password = typeof b.password === "string" ? b.password : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequestError("A valid email is required.");
  if (password.length < 10) throw new BadRequestError("The password must be at least 10 characters.");

  let out;
  $app.runInTransaction((tx) => {
    const exists = tx.countRecords("users", $dbx.hashExp({ email: email })) > 0;
    if (exists) throw new BadRequestError("Could not create the account.");
    const u = new Record(tx.findCollectionByNameOrId("users"));
    u.set("email", email);
    u.set("name", name);
    u.set("emailVisibility", false);
    u.setPassword(password);
    tx.save(u);
    out = lib.consumeInvite(tx, b.token, u.id);
  });
  return e.json(200, out);
});

// ---------------------------------------------------------------- members
routerAdd("POST", "/api/bj/members/role", (e) => require(`${__hooks}/lib.js`).changeRole(e, false), $apis.requireAuth("users"));
routerAdd("POST", "/api/bj/members/remove", (e) => require(`${__hooks}/lib.js`).changeRole(e, true), $apis.requireAuth("users"));

// Sign a member out everywhere (lost phone). An owner may do it for anyone.
routerAdd("POST", "/api/bj/members/sign-out", (e) => {
  const lib = require(`${__hooks}/lib.js`);
  const b = e.requestInfo().body || {};
  const journalId = String(b.journal || "");
  $app.runInTransaction((tx) => {
    lib.requireRole(tx, journalId, e.auth.id, ["owner"]);
    if (!lib.membership(tx, journalId, String(b.user || ""))) throw new NotFoundError("That person is not a member.");
    const u = tx.findRecordById("users", String(b.user));
    u.refreshTokenKey();
    tx.save(u);
    lib.audit(tx, journalId, e.auth.id, "member_signed_out", String(b.user), {});
  });
  return e.json(200, { ok: true });
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/bj/me/sign-out-everywhere", (e) => {
  const u = $app.findRecordById("users", e.auth.id);
  u.refreshTokenKey();
  $app.save(u);
  return e.json(200, { ok: true });
}, $apis.requireAuth("users"));

// ---------------------------------------------------------- entry sync
// One endpoint for the offline outbox. Body:
//   { journal, client_id, idempotency_key, op, base_revision, fields }
//   op: "upsert" | "trash" | "restore" | "resolve"
// Atomic (one transaction) and idempotent (a retry returns the first outcome).
routerAdd("POST", "/api/bj/entries/sync", (e) => {
  const lib = require(`${__hooks}/lib.js`);
  const b = e.requestInfo().body || {};
  const journalId = String(b.journal || "");
  const clientId = String(b.client_id || "");
  const idem = String(b.idempotency_key || "");
  const op = String(b.op || "upsert");
  const base = Number(b.base_revision);

  if (clientId.length < 8 || clientId.length > 64) throw new BadRequestError("client_id must be 8 to 64 characters.");
  if (idem.length < 8 || idem.length > 80) throw new BadRequestError("idempotency_key must be 8 to 80 characters.");
  if (["upsert", "trash", "restore", "resolve"].indexOf(op) === -1) throw new BadRequestError("Unknown op.");
  if (!Number.isInteger(base) || base < 0) throw new BadRequestError("base_revision must be a non-negative integer.");

  let result;
  $app.runInTransaction((tx) => {
    lib.requireRole(tx, journalId, e.auth.id, ["owner", "editor"]);
    const versionsCol = tx.findCollectionByNameOrId("entry_versions");

    let entry = null;
    try {
      entry = tx.findFirstRecordByFilter("entries", "journal = {:j} && client_id = {:c}", { j: journalId, c: clientId });
    } catch (_) {}

    // Idempotent replay: return the original outcome, change nothing.
    if (entry) {
      try {
        const prev = tx.findFirstRecordByFilter("entry_versions", "entry = {:e} && idempotency_key = {:k}", { e: entry.id, k: idem });
        result = {
          result: prev.getString("status") === "conflict" ? "conflict" : "applied",
          replay: true,
          revision: entry.getInt("revision"),
          entry: entry,
        };
        return;
      } catch (_) {}
    }

    const writeVersion = (ent, status, rev, fieldsFrom) => {
      const v = new Record(versionsCol);
      v.set("entry", ent.id);
      v.set("journal", journalId);
      v.set("revision", rev);
      v.set("base_revision", base);
      v.set("author", e.auth.id);
      v.set("title", fieldsFrom.title);
      v.set("text", fieldsFrom.text);
      v.set("values", fieldsFrom.values);
      v.set("milestones", fieldsFrom.milestones);
      v.set("event_date", fieldsFrom.event_date);
      v.set("status", status);
      v.set("idempotency_key", idem);
      tx.save(v);
    };
    const snapshot = (ent) => ({
      title: ent.getString("title"),
      text: ent.getString("text"),
      values: lib.parseJSONField(ent, "values", {}),
      milestones: lib.parseJSONField(ent, "milestones", []),
      event_date: ent.getString("event_date"),
    });
    const closeOpenVersions = (ent, statuses) => {
      const open = tx.findRecordsByFilter("entry_versions", "entry = {:e}", "", 0, 0, { e: ent.id });
      for (const v of open) {
        if (statuses.indexOf(v.getString("status")) !== -1) {
          v.set("status", "superseded");
          tx.save(v);
        }
      }
    };
    const applyFields = (ent, f) => {
      ent.set("event_date", f.event_date);
      ent.set("type", f.type);
      ent.set("title", f.title);
      ent.set("text", f.text);
      ent.set("milestones", f.milestones);
      ent.set("values", f.values);
    };

    // ---- create
    if (!entry) {
      if (op !== "upsert" || base !== 0) throw new ApiError(404, "That entry does not exist on the server.", {});
      const f = lib.cleanEntryFields(b.fields);
      entry = new Record(tx.findCollectionByNameOrId("entries"));
      entry.set("journal", journalId);
      entry.set("author", e.auth.id);
      entry.set("client_id", clientId);
      applyFields(entry, f);
      entry.set("revision", 1);
      entry.set("needs_review", false);
      tx.save(entry);
      writeVersion(entry, "current", 1, f);
      result = { result: "applied", replay: false, revision: 1, entry: entry };
      return;
    }

    const cur = entry.getInt("revision");
    const trashed = !!entry.getString("deleted_at");

    // ---- trash / restore: state changes, applied regardless of base revision.
    // A stale edit that arrives later becomes a conflict version, so nothing is lost.
    if (op === "trash" || op === "restore") {
      if (op === "trash" && trashed) { result = { result: "applied", replay: false, revision: cur, entry: entry }; return; }
      if (op === "restore" && !trashed) { result = { result: "applied", replay: false, revision: cur, entry: entry }; return; }
      const prevDeleted = entry.getString("deleted_at");
      const stamp = new Date().toISOString();
      entry.set("deleted_at", op === "trash" ? stamp : "");
      entry.set("revision", cur + 1);
      tx.save(entry);
      // Media follows its entry (section 6.7). Restoring brings back only the media that
      // was trashed together with the entry, not items trashed on their own earlier.
      for (const m of tx.findRecordsByFilter("media", "entry = {:e}", "", 0, 0, { e: entry.id })) {
        if (op === "trash" && !m.getString("deleted_at")) {
          m.set("deleted_at", stamp);
          tx.save(m);
        } else if (op === "restore" && m.getString("deleted_at") && m.getString("deleted_at") === prevDeleted) {
          m.set("deleted_at", "");
          tx.save(m);
        }
      }
      closeOpenVersions(entry, ["current"]);
      writeVersion(entry, "current", cur + 1, snapshot(entry));
      lib.audit(tx, journalId, e.auth.id, op === "trash" ? "entry_trashed" : "entry_restored", entry.id, {});
      result = { result: "applied", replay: false, revision: cur + 1, entry: entry };
      return;
    }

    if (base > cur) throw new BadRequestError("base_revision is ahead of the server.");
    const f = lib.cleanEntryFields(b.fields);

    // ---- resolve a conflict: needs the current revision, produces a new revision.
    if (op === "resolve") {
      if (base !== cur) throw new ApiError(409, "The entry changed again. Reload and resolve the latest versions.", {});
      const conflicts = tx.findRecordsByFilter("entry_versions", "entry = {:e} && status = 'conflict'", "", 0, 0, { e: entry.id });
      if (conflicts.length === 0) throw new ApiError(409, "There is nothing to resolve.", {});
      const isOwner = lib.membership(tx, journalId, e.auth.id).getString("role") === "owner";
      const isAuthor = conflicts.some((v) => v.getString("author") === e.auth.id);
      if (!isOwner && !isAuthor) throw new ForbiddenError("Only an owner or an author of a conflicting version can resolve it.");
      closeOpenVersions(entry, ["current", "conflict"]);
      applyFields(entry, f);
      entry.set("revision", cur + 1);
      entry.set("needs_review", false);
      tx.save(entry);
      writeVersion(entry, "current", cur + 1, f);
      lib.audit(tx, journalId, e.auth.id, "entry_conflict_resolved", entry.id, { versions: conflicts.length });
      result = { result: "applied", replay: false, revision: cur + 1, entry: entry };
      return;
    }

    // ---- upsert on an existing entry
    if (base === cur) {
      if (trashed) throw new ApiError(409, "This entry is in the trash. Restore it first.", {});
      closeOpenVersions(entry, ["current"]);
      applyFields(entry, f);
      entry.set("revision", cur + 1);
      tx.save(entry);
      writeVersion(entry, "current", cur + 1, f);
      result = { result: "applied", replay: false, revision: cur + 1, entry: entry };
      return;
    }

    // base < cur: a stale write. Never applied silently. Keep it as a conflict version.
    writeVersion(entry, "conflict", cur, f);
    entry.set("needs_review", true);
    tx.save(entry);
    result = { result: "conflict", replay: false, revision: cur, entry: entry };
  });

  return e.json(200, result);
}, $apis.requireAuth("users"));

// ---------------------------------------------------------------- export
// F10: everything in open formats. Owner only. The JSON carries a schema version so
// later app versions can read older exports. Original files are listed with their
// SHA-256 and storage path; the monthly export job copies the files themselves.
routerAdd("GET", "/api/bj/journals/export", (e) => {
  const lib = require(`${__hooks}/lib.js`);
  const journalId = String(e.request.url.query().get("journal") || "");
  lib.requireRole($app, journalId, e.auth.id, ["owner"]);

  const all = (col, sort) => $app.findRecordsByFilter(col, "journal = {:j}", sort, 0, 0, { j: journalId });
  const journal = $app.findRecordById("journals", journalId);

  const members = all("members", "joined_at").map((m) => {
    let name = "";
    try { name = $app.findRecordById("users", m.getString("user")).getString("name"); } catch (_) {}
    return { user: m.getString("user"), name: name, role: m.getString("role"), joined_at: m.getString("joined_at") };
  });
  const originals = {};
  for (const o of all("media_originals", "")) {
    originals[o.getString("media")] = {
      original_name: o.getString("original_name"), mime: o.getString("mime"), size: o.getInt("size"),
      sha256: o.getString("sha256"), metadata: lib.parseJSONField(o, "metadata", {}),
      file: o.getString("file") ? `${o.collection().id}/${o.id}/${o.getString("file")}` : "",
    };
  }
  const media = all("media", "entry,sort_order").map((m) => ({
    id: m.id, entry: m.getString("entry"), client_id: m.getString("client_id"), kind: m.getString("kind"),
    caption: m.getString("caption"), sort_order: m.getInt("sort_order"), taken_at: m.getString("taken_at"),
    width: m.getInt("width"), height: m.getInt("height"), duration: m.getFloat("duration"),
    deleted_at: m.getString("deleted_at"), offsite_at: m.getString("offsite_at"),
    original: originals[m.id] || null,
  }));

  e.response.header().set("Content-Disposition", 'attachment; filename="journal-export.json"');
  return e.json(200, {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    journal: {
      id: journal.id, name: journal.getString("name"), emoji: journal.getString("emoji"),
      due_date: journal.getString("due_date"), dob: journal.getString("dob"),
    },
    members: members,
    entries: all("entries", "event_date,created").map((x) => ({
      id: x.id, client_id: x.getString("client_id"), author: x.getString("author"),
      event_date: x.getString("event_date"), type: x.getString("type"), title: x.getString("title"),
      text: x.getString("text"), milestones: lib.parseJSONField(x, "milestones", []),
      values: lib.parseJSONField(x, "values", {}), revision: x.getInt("revision"),
      needs_review: x.getBool("needs_review"), deleted_at: x.getString("deleted_at"),
      created: x.getString("created"), updated: x.getString("updated"),
    })),
    entry_versions: all("entry_versions", "entry,created").map((v) => ({
      entry: v.getString("entry"), revision: v.getInt("revision"), base_revision: v.getInt("base_revision"),
      author: v.getString("author"), status: v.getString("status"), title: v.getString("title"),
      text: v.getString("text"), event_date: v.getString("event_date"),
      values: lib.parseJSONField(v, "values", {}), milestones: lib.parseJSONField(v, "milestones", []),
      created: v.getString("created"),
    })),
    media: media,
  });
}, $apis.requireAuth("users"));
