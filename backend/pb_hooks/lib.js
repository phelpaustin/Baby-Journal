// Shared helpers. Not auto-loaded (no .pb.js suffix); handlers must
// require(`${__hooks}/lib.js`) inside their own body because PocketBase
// JS handlers run in isolated scopes.

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_TYPES = ["memory", "milestone", "growth", "health", "vaccine", "sleep", "feeding", "pregnancy", "appointment", "other"];
const ROLES = ["owner", "editor", "viewer"];
const UNIT_SUFFIXES = ["kg", "g", "cm", "mm", "c", "ml", "l", "min", "h", "bpm", "count"];

function validDate(s) {
  if (typeof s !== "string" || !DATE_ONLY.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Returns the member row for (journal, user) or null.
function membership(app, journalId, userId) {
  try {
    return app.findFirstRecordByFilter("members", "journal = {:j} && user = {:u}", { j: journalId, u: userId });
  } catch (_) {
    return null;
  }
}

function requireRole(app, journalId, userId, allowed) {
  const m = membership(app, journalId, userId);
  if (!m || allowed.indexOf(m.getString("role")) === -1) {
    // Do not reveal whether the journal exists to outsiders.
    throw new ForbiddenError("You do not have permission to do that.");
  }
  return m;
}

function ownerCount(app, journalId) {
  return app.countRecords("members", $dbx.hashExp({ journal: journalId, role: "owner" }));
}

function audit(app, journalId, actorId, action, target, detail) {
  const col = app.findCollectionByNameOrId("audit_log");
  const rec = new Record(col);
  rec.set("journal", journalId);
  if (actorId) rec.set("actor", actorId);
  rec.set("action", action);
  rec.set("target", target || "");
  rec.set("detail", detail || {});
  app.save(rec);
}

// Entry fields coming from the client outbox. Throws BadRequestError on anything odd.
function cleanEntryFields(f) {
  if (!f || typeof f !== "object") throw new BadRequestError("fields is required.");
  const out = {};
  if (!validDate(f.event_date)) throw new BadRequestError("event_date must be a valid YYYY-MM-DD date.");
  out.event_date = f.event_date;
  if (ENTRY_TYPES.indexOf(f.type) === -1) throw new BadRequestError("Unknown entry type.");
  out.type = f.type;
  out.title = typeof f.title === "string" ? f.title.slice(0, 300) : "";
  out.text = typeof f.text === "string" ? f.text : "";
  if (out.text.length > 200000) throw new BadRequestError("text is too long.");

  const ms = f.milestones == null ? [] : f.milestones;
  if (!Array.isArray(ms) || ms.length > 20 || ms.some((m) => typeof m !== "string" || m.length === 0 || m.length > 60)) {
    throw new BadRequestError("milestones must be up to 20 short strings.");
  }
  out.milestones = ms;

  const vals = f.values == null ? {} : f.values;
  if (typeof vals !== "object" || Array.isArray(vals)) throw new BadRequestError("values must be an object.");
  for (const k of Object.keys(vals)) {
    const m = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_([a-z]+)$/.exec(k);
    if (!m || UNIT_SUFFIXES.indexOf(m[1]) === -1) {
      throw new BadRequestError("values keys need an explicit unit suffix, e.g. weight_kg: " + k);
    }
    if (typeof vals[k] !== "number" || !isFinite(vals[k])) throw new BadRequestError("values must be numbers: " + k);
  }
  out.values = vals;
  return out;
}

function parseJSONField(rec, name, fallback) {
  try {
    const s = rec.getString(name);
    return s ? JSON.parse(s) : fallback;
  } catch (_) {
    return fallback;
  }
}

// Shared by "accept" (existing account) and "register" (new account).
function consumeInvite(tx, token, userId) {
  if (typeof token !== "string" || token.length < 20) throw new BadRequestError("This invite is not valid.");
  let inv;
  try {
    inv = tx.findFirstRecordByFilter("invites", "token_hash = {:h}", { h: $security.sha256(token) });
  } catch (_) {
    throw new BadRequestError("This invite is not valid.");
  }
  const expires = Date.parse(inv.getString("expires_at").replace(" ", "T"));
  if (inv.getString("used_at") || isNaN(expires) || expires < Date.now()) {
    throw new BadRequestError("This invite is not valid.");
  }
  const journalId = inv.getString("journal");
  if (membership(tx, journalId, userId)) {
    // Do not burn the invite, and never change an existing role through an invite.
    throw new ApiError(409, "You are already a member of this journal.", {});
  }
  const m = new Record(tx.findCollectionByNameOrId("members"));
  m.set("journal", journalId);
  m.set("user", userId);
  m.set("role", inv.getString("role"));
  tx.save(m);
  inv.set("used_at", new Date().toISOString());
  inv.set("used_by", userId);
  tx.save(inv);
  audit(tx, journalId, userId, "invite_accepted", inv.id, { role: inv.getString("role") });
  return { journal: journalId, role: inv.getString("role") };
}


function changeRole(e, remove) {
  const b = e.requestInfo().body || {};
  const journalId = String(b.journal || "");
  const targetUser = String(b.user || e.auth.id);
  const isSelf = targetUser === e.auth.id;

  $app.runInTransaction((tx) => {
    const actor = membership(tx, journalId, e.auth.id);
    if (!actor) throw new ForbiddenError("You do not have permission to do that.");
    // Owners manage anyone. Anyone may remove themselves (leave).
    if (!(actor.getString("role") === "owner" || (remove && isSelf))) {
      throw new ForbiddenError("You do not have permission to do that.");
    }
    const target = membership(tx, journalId, targetUser);
    if (!target) throw new NotFoundError("That person is not a member.");

    const wasOwner = target.getString("role") === "owner";
    let newRole = null;
    if (!remove) {
      newRole = String(b.role || "");
      if (ROLES.indexOf(newRole) === -1) throw new BadRequestError("role must be owner, editor or viewer.");
    }
    // Last-owner rule: refuse anything that would leave the journal with no owner.
    if (wasOwner && newRole !== "owner" && ownerCount(tx, journalId) <= 1) {
      throw new BadRequestError("A journal must keep at least one owner. Promote someone else first.");
    }

    if (remove) {
      tx.delete(target);
      if (!isSelf) {
        // Revoke every session of the removed person (rotates the token key).
        const u = tx.findRecordById("users", targetUser);
        u.refreshTokenKey();
        tx.save(u);
      }
      audit(tx, journalId, e.auth.id, isSelf ? "member_left" : "member_removed", targetUser, { was: target.getString("role") });
    } else {
      const old = target.getString("role");
      target.set("role", newRole);
      tx.save(target);
      audit(tx, journalId, e.auth.id, "role_changed", targetUser, { from: old, to: newRole });
    }
    // Owner changes are written to the audit log, which every owner can read.
    // Email notification to the other owners is added with the mail relay (section 7.4).
  });
  return e.json(200, { ok: true });
}

module.exports = {
  INVITE_TTL_MS, consumeInvite, changeRole,
  DATE_ONLY, ENTRY_TYPES, ROLES,
  validDate, membership, requireRole, ownerCount, audit, cleanEntryFields, parseJSONField,
};
