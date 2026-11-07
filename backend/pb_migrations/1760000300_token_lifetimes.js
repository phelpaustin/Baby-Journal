/// <reference path="../pb_data/types.d.ts" />
// Token lifetimes for a family app used on phones.
// - File tokens: PocketBase's default is 2 minutes, which breaks seeking in a long video
//   and any gallery left open. One hour is enough; removing a member rotates their token
//   key, so every token they hold stops working at once regardless of lifetime.
// - Sign-in: 30 days, renewed whenever the app opens (authRefresh).
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fileToken.duration = 3600;
    users.authToken.duration = 30 * 24 * 3600;
    app.save(users);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fileToken.duration = 120;
    users.authToken.duration = 7 * 24 * 3600;
    app.save(users);
  }
);
