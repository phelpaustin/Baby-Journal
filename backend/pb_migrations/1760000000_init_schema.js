/// <reference path="../pb_data/types.d.ts" />
//
// Baby Journal data foundation (architecture v7, sections 5.1 and 5.2).
//
// Design notes
// - All writes to journals, members, invites and entries go through the custom
//   routes in pb_hooks/ (atomic, idempotent, last-owner safe). The collections
//   therefore expose read rules to the API and null (superuser only) write rules.
// - Originals live in `media_originals` (owner/editor read). Everything a viewer
//   may see lives in `media` (display copy, poster, playback copy). PocketBase
//   protected-file checks apply the record's view rule, so separating the
//   collections is what makes "viewers never reach originals" enforceable.
// - Date-only values (event_date, due_date, dob) are text YYYY-MM-DD with no time zone.

const DATE_ONLY = "^\\d{4}-\\d{2}-\\d{2}$";

// Rule fragments. Conditions on @collection.members inside one rule share one joined row.
const IS_MEMBER_OF = (journalExpr) =>
  `@request.auth.id != "" && @collection.members.journal ?= ${journalExpr} && @collection.members.user ?= @request.auth.id`;
const IS_WRITER_OF = (journalExpr) =>
  `${IS_MEMBER_OF(journalExpr)} && (@collection.members.role ?= "owner" || @collection.members.role ?= "editor")`;
const IS_OWNER_OF = (journalExpr) =>
  `${IS_MEMBER_OF(journalExpr)} && @collection.members.role ?= "owner"`;

// Rules reference `members`, which references `journals`, so collections are
// created without rules first and the rules are applied in a second pass.
const RULE_KEYS = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"];
const pendingRules = {};
function defer(def) {
  const rules = {};
  for (const k of RULE_KEYS) {
    rules[k] = def[k] === undefined ? null : def[k];
    def[k] = null;
  }
  pendingRules[def.name] = rules;
  return new Collection(def);
}

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");

    // ---------------------------------------------------------------- journals
    const journals = defer({
      type: "base",
      name: "journals",
      listRule: IS_MEMBER_OF("id"),
      viewRule: IS_MEMBER_OF("id"),
      createRule: null, // route /api/bj/journals/create
      updateRule: null, // route /api/bj/journals/update (owner only)
      deleteRule: null, // v1: owner deletes from the command line
      fields: [
        { type: "text", name: "name", required: true, max: 200 },
        { type: "text", name: "emoji", max: 16 },
        { type: "text", name: "due_date", pattern: DATE_ONLY },
        { type: "text", name: "dob", pattern: DATE_ONLY },
        { type: "json", name: "settings", maxSize: 20000 },
        { type: "relation", name: "created_by", collectionId: users.id, maxSelect: 1 },
        { type: "date", name: "deletion_requested_at" },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
    });
    app.save(journals);

    // ----------------------------------------------------------------- members
    const members = defer({
      type: "base",
      name: "members",
      listRule: IS_MEMBER_OF("journal"),
      viewRule: IS_MEMBER_OF("journal"),
      createRule: null, // created by journal creation or invite acceptance
      updateRule: null, // route /api/bj/members/role
      deleteRule: null, // route /api/bj/members/remove
      fields: [
        { type: "relation", name: "journal", required: true, collectionId: journals.id, maxSelect: 1, cascadeDelete: true },
        { type: "relation", name: "user", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
        { type: "select", name: "role", required: true, maxSelect: 1, values: ["owner", "editor", "viewer"] },
        { type: "autodate", name: "joined_at", onCreate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_members_journal_user ON members (journal, user)", "CREATE INDEX idx_members_user ON members (user)"],
    });
    app.save(members);

    // ----------------------------------------------------------------- invites
    const invites = defer({
      type: "base",
      name: "invites",
      listRule: IS_OWNER_OF("journal"),
      viewRule: IS_OWNER_OF("journal"),
      createRule: null, // route /api/bj/invites/create (returns the raw token once)
      updateRule: null,
      deleteRule: IS_OWNER_OF("journal"),
      fields: [
        { type: "relation", name: "journal", required: true, collectionId: journals.id, maxSelect: 1, cascadeDelete: true },
        { type: "text", name: "token_hash", required: true, hidden: true },
        { type: "select", name: "role", required: true, maxSelect: 1, values: ["owner", "editor", "viewer"] },
        { type: "date", name: "expires_at", required: true },
        { type: "date", name: "used_at" },
        { type: "relation", name: "used_by", collectionId: users.id, maxSelect: 1 },
        { type: "relation", name: "created_by", collectionId: users.id, maxSelect: 1 },
        { type: "autodate", name: "created", onCreate: true },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_invites_token_hash ON invites (token_hash)"],
    });
    app.save(invites);

    // ----------------------------------------------------------------- entries
    // Viewers cannot see trashed entries; owners and editors can (to restore them).
    const entryRead = `${IS_MEMBER_OF("journal")} && (deleted_at = "" || @collection.members.role ?= "owner" || @collection.members.role ?= "editor")`;
    const entries = defer({
      type: "base",
      name: "entries",
      listRule: entryRead,
      viewRule: entryRead,
      createRule: null, // route /api/bj/entries/sync
      updateRule: null,
      deleteRule: null, // never hard-deleted by clients; the purge job does it
      fields: [
        { type: "relation", name: "journal", required: true, collectionId: journals.id, maxSelect: 1, cascadeDelete: true },
        { type: "relation", name: "author", required: true, collectionId: users.id, maxSelect: 1 },
        { type: "text", name: "client_id", required: true, min: 8, max: 64 },
        { type: "text", name: "event_date", required: true, pattern: DATE_ONLY },
        {
          type: "select", name: "type", required: true, maxSelect: 1,
          values: ["memory", "milestone", "growth", "health", "vaccine", "sleep", "feeding", "pregnancy", "appointment", "other"],
        },
        { type: "text", name: "title", max: 300 },
        { type: "editor", name: "text", maxSize: 200000, convertURLs: false },
        { type: "json", name: "milestones", maxSize: 20000 },
        { type: "json", name: "values", maxSize: 20000 }, // numbers with explicit units, e.g. weight_kg
        { type: "number", name: "revision", required: true, onlyInt: true, min: 1 },
        { type: "bool", name: "needs_review" },
        { type: "date", name: "deleted_at" },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_entries_journal_client ON entries (journal, client_id)",
        "CREATE INDEX idx_entries_journal_date ON entries (journal, event_date)",
        "CREATE INDEX idx_entries_journal_type ON entries (journal, type)",
        "CREATE INDEX idx_entries_deleted ON entries (deleted_at)",
      ],
    });
    app.save(entries);

    // ---------------------------------------------------------- entry_versions
    const entryVersions = defer({
      type: "base",
      name: "entry_versions",
      listRule: `@request.auth.id != "" && @collection.members.journal ?= journal && @collection.members.user ?= @request.auth.id && (@collection.members.role ?= "owner" || @collection.members.role ?= "editor")`,
      viewRule: `@request.auth.id != "" && @collection.members.journal ?= journal && @collection.members.user ?= @request.auth.id && (@collection.members.role ?= "owner" || @collection.members.role ?= "editor")`,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { type: "relation", name: "entry", required: true, collectionId: entries.id, maxSelect: 1, cascadeDelete: true },
        { type: "relation", name: "journal", required: true, collectionId: journals.id, maxSelect: 1, cascadeDelete: true },
        { type: "number", name: "revision", required: true, onlyInt: true },
        { type: "number", name: "base_revision", onlyInt: true, min: 0 },
        { type: "relation", name: "author", required: true, collectionId: users.id, maxSelect: 1 },
        { type: "text", name: "title", max: 300 },
        { type: "editor", name: "text", maxSize: 200000, convertURLs: false },
        { type: "json", name: "values", maxSize: 20000 },
        { type: "json", name: "milestones", maxSize: 20000 },
        { type: "text", name: "event_date", pattern: DATE_ONLY },
        { type: "select", name: "status", required: true, maxSelect: 1, values: ["current", "conflict", "superseded"] },
        { type: "text", name: "idempotency_key", required: true, min: 8, max: 80 },
        { type: "autodate", name: "created", onCreate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_entry_versions_idem ON entry_versions (entry, idempotency_key)",
        "CREATE INDEX idx_entry_versions_entry ON entry_versions (entry, status)",
      ],
    });
    app.save(entryVersions);

    // ------------------------------------------------------------------- media
    // Viewer-safe records: metadata-stripped display copy, poster, playback copy.
    const mediaRead = `${IS_MEMBER_OF("journal")} && (deleted_at = "" || @collection.members.role ?= "owner" || @collection.members.role ?= "editor")`;
    const media = defer({
      type: "base",
      name: "media",
      listRule: mediaRead,
      viewRule: mediaRead,
      createRule: null, // upload pipeline (build step 2)
      updateRule: null, // captions, sort order, corrected capture date go through a route
      deleteRule: null,
      fields: [
        { type: "relation", name: "entry", required: true, collectionId: entries.id, maxSelect: 1, cascadeDelete: true },
        { type: "relation", name: "journal", required: true, collectionId: journals.id, maxSelect: 1, cascadeDelete: true },
        { type: "text", name: "client_id", required: true, min: 8, max: 64 },
        { type: "select", name: "kind", required: true, maxSelect: 1, values: ["image", "video"] },
        { type: "select", name: "status", required: true, maxSelect: 1, values: ["uploading", "stored"] },
        { type: "text", name: "caption", max: 1000 },
        { type: "number", name: "sort_order", onlyInt: true },
        { type: "date", name: "taken_at" }, // user-correctable display date; original metadata stays in media_originals
        { type: "number", name: "width", onlyInt: true },
        { type: "number", name: "height", onlyInt: true },
        { type: "number", name: "duration" },
        { type: "file", name: "poster", maxSelect: 1, maxSize: 20971520, protected: true, thumbs: ["320x0", "800x0"] },
        { type: "file", name: "display", maxSelect: 1, maxSize: 52428800, protected: true, thumbs: ["320x0", "800x0"] },
        { type: "file", name: "playback", maxSelect: 1, maxSize: 5368709120, protected: true },
        { type: "date", name: "offsite_at" },
        { type: "text", name: "offsite_snapshot", max: 100 },
        { type: "date", name: "deleted_at" },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_media_journal_client ON media (journal, client_id)",
        "CREATE INDEX idx_media_entry ON media (entry, sort_order)",
      ],
    });
    app.save(media);

    // --------------------------------------------------------- media_originals
    const originalsRead = `${IS_WRITER_OF("journal")}`;
    const mediaOriginals = defer({
      type: "base",
      name: "media_originals",
      listRule: originalsRead,
      viewRule: originalsRead,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { type: "relation", name: "media", required: true, collectionId: media.id, maxSelect: 1, cascadeDelete: true },
        { type: "relation", name: "journal", required: true, collectionId: journals.id, maxSelect: 1, cascadeDelete: true },
        { type: "file", name: "file", maxSelect: 1, maxSize: 5368709120, protected: true },
        { type: "text", name: "original_name", max: 300 },
        { type: "text", name: "mime", max: 100 },
        { type: "number", name: "size", onlyInt: true },
        { type: "text", name: "sha256", pattern: "^[0-9a-f]{64}$" },
        { type: "json", name: "metadata", maxSize: 200000 }, // extracted EXIF etc., never edited
      ],
      indexes: ["CREATE UNIQUE INDEX idx_media_originals_media ON media_originals (media)"],
    });
    app.save(mediaOriginals);

    // --------------------------------------------------------------- audit_log
    const auditLog = defer({
      type: "base",
      name: "audit_log",
      listRule: IS_OWNER_OF("journal"),
      viewRule: IS_OWNER_OF("journal"),
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { type: "relation", name: "journal", required: true, collectionId: journals.id, maxSelect: 1, cascadeDelete: true },
        { type: "relation", name: "actor", collectionId: users.id, maxSelect: 1 },
        { type: "text", name: "action", required: true, max: 80 },
        { type: "text", name: "target", max: 200 },
        { type: "json", name: "detail", maxSize: 5000 },
        { type: "autodate", name: "created", onCreate: true },
      ],
      indexes: ["CREATE INDEX idx_audit_journal ON audit_log (journal, created)"],
    });
    app.save(auditLog);

    // ------------------------------------------------------------- backup_runs
    // Written only by the backup job (superuser). Any signed-in member may read,
    // so the app can show the time of the last good backup.
    const backupRuns = defer({
      type: "base",
      name: "backup_runs",
      listRule: `@request.auth.id != "" && @collection.members.user ?= @request.auth.id`,
      viewRule: `@request.auth.id != "" && @collection.members.user ?= @request.auth.id`,
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        { type: "text", name: "snapshot_id", max: 100 },
        { type: "date", name: "started_at" },
        { type: "date", name: "finished_at" },
        { type: "select", name: "result", maxSelect: 1, values: ["ok", "failed"] },
        { type: "select", name: "verification_result", maxSelect: 1, values: ["ok", "failed", "skipped"] },
        { type: "number", name: "file_count", onlyInt: true },
        { type: "number", name: "bytes", onlyInt: true },
      ],
      indexes: ["CREATE INDEX idx_backup_runs_finished ON backup_runs (finished_at)"],
    });
    app.save(backupRuns);

    for (const name of Object.keys(pendingRules)) {
      const col = app.findCollectionByNameOrId(name);
      for (const k of RULE_KEYS) col[k] = pendingRules[name][k];
      app.save(col);
    }
  },
  (app) => {
    for (const name of ["backup_runs", "audit_log", "media_originals", "media", "entry_versions", "entries", "invites", "members", "journals"]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (_) {}
    }
  }
);
