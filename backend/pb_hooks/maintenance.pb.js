/// <reference path="../pb_data/types.d.ts" />
//
// Maintenance routes (superuser only), scheduled jobs and the recovery command.

// Trash purge. dry_run defaults to true: it only reports what would be removed.
routerAdd("POST", "/api/bj/maintenance/purge", (e) => {
  const ml = require(`${__hooks}/maintenance_lib.js`);
  const b = e.requestInfo().body || {};
  const report = ml.purgeTrash($app, { dryRun: b.dry_run !== false, nowMs: b.now_ms ? Number(b.now_ms) : undefined });
  return e.json(200, report);
}, $apis.requireSuperuserAuth());

// Reconcile after a restore, and the monthly integrity check.
routerAdd("POST", "/api/bj/maintenance/reconcile", (e) => {
  const ml = require(`${__hooks}/maintenance_lib.js`);
  const b = e.requestInfo().body || {};
  const report = ml.reconcile($app, {
    dryRun: b.dry_run !== false,
    sample: b.sample === undefined ? 1 : Number(b.sample),
    moveOrphans: b.move_orphans === true,
    regenerate: b.regenerate === true,
  });
  return e.json(200, report);
}, $apis.requireSuperuserAuth());

// Daily: report what the purge would remove. It only deletes after the owner has looked at a
// few dry runs and set BJ_PURGE_ENABLE=1 in the service environment.
cronAdd("bj_purge", "10 4 * * *", () => {
  const ml = require(`${__hooks}/maintenance_lib.js`);
  const live = $os.getenv("BJ_PURGE_ENABLE") === "1";
  const r = ml.purgeTrash($app, { dryRun: !live });
  console.log("[bj purge " + (live ? "LIVE" : "dry run") + "] " + (r.skipped ? "skipped: " + r.skipped : r.entries.length + " entries, " + r.media.length + " media; blocked " + r.blocked.length));
});

// Monthly: re-hash a random 5% of the originals (every file's presence and size is checked).
cronAdd("bj_integrity", "30 5 1 * *", () => {
  const ml = require(`${__hooks}/maintenance_lib.js`);
  const r = ml.reconcile($app, { dryRun: true, sample: 0.05 });
  if (!r.ok) ml.alert("critical", `Monthly integrity check found problems: ${r.missing.length} missing, ${r.size_mismatch.length} wrong size, ${r.checksum_mismatch.length} bad checksum, ${r.derived_missing.length} derived copies missing.`);
  else console.log("[bj integrity] ok: " + r.checked + " files checked, " + r.hashed + " re-hashed");
});

// Account recovery without e-mail (architecture 4.1): set a person's password from the command line,
// for example on a restored server. The new password is read from the environment, never from argv.
//   BJ_NEW_PASSWORD='...' pocketbase bj-set-password someone@example.com --dir ... --hooksDir ...
$app.rootCmd.addCommand(new Command({
  use: "bj-set-password <email>",
  short: "Set a user's password (reads BJ_NEW_PASSWORD) and sign them out everywhere",
  run: (cmd, args) => {
    const pw = $os.getenv("BJ_NEW_PASSWORD");
    if (!args || args.length !== 1) { console.log("usage: bj-set-password <email>"); $os.exit(2); }
    if (!pw || pw.length < 10) { console.log("BJ_NEW_PASSWORD must be set and at least 10 characters."); $os.exit(2); }
    $app.bootstrap();
    let u;
    try { u = $app.findAuthRecordByEmail("users", args[0]); } catch (_) { console.log("No user with that email."); $os.exit(1); }
    u.setPassword(pw);
    u.refreshTokenKey();
    $app.save(u);
    console.log("Password set for " + args[0] + ". All earlier sessions are signed out.");
  },
}));
