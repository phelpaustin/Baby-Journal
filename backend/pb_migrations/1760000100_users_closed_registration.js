/// <reference path="../pb_data/types.d.ts" />
//
// Users: closed registration and shared-journal visibility.
// - Accounts are created only by /api/bj/auth/register together with a valid invite
//   (or by a superuser from the command line for the very first owner).
// - A person can see the name of anyone who shares a journal with them, so the
//   members list can show names. Emails stay hidden (emailVisibility is false).

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.createRule = null;
    users.deleteRule = null; // account deletion is an owner/command-line decision in v1

    const sharesJournal =
      `@request.auth.id != "" && (id = @request.auth.id || ` +
      `(@collection.members:a.user ?= id && @collection.members:a.journal ?= @collection.members:b.journal && @collection.members:b.user ?= @request.auth.id))`;
    users.listRule = sharesJournal;
    users.viewRule = sharesJournal;
    app.save(users);

    // Basic brute-force protection for sign-in and the custom routes.
    // (Tests set BJ_TEST_NO_RATE_LIMIT=1 so they can sign in many times quickly.)
    const settings = app.settings();
    settings.rateLimits.enabled = !$os.getenv("BJ_TEST_NO_RATE_LIMIT");
    settings.rateLimits.rules = [
      { label: "*:authWithPassword", maxRequests: 10, duration: 60 },
      { label: "/api/bj/auth/register", maxRequests: 10, duration: 300 },
      { label: "/api/bj/invites/accept", maxRequests: 10, duration: 300 },
      { label: "/api/", maxRequests: 600, duration: 60 },
    ];
    app.save(settings);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.createRule = "";
    users.listRule = "id = @request.auth.id";
    users.viewRule = "id = @request.auth.id";
    app.save(users);
  }
);
