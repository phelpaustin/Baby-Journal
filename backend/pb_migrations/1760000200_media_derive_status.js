/// <reference path="../pb_data/types.d.ts" />
// Derived-copy bookkeeping: a media row is "stored" once the original is verified;
// its viewer-safe copies are "pending", "ready" or "failed" (retried by a cron job).
migrate(
  (app) => {
    const media = app.findCollectionByNameOrId("media");
    media.fields.add(new SelectField({ name: "derive_status", maxSelect: 1, values: ["pending", "ready", "failed"] }));
    media.fields.add(new TextField({ name: "derive_error", max: 500 }));
    app.save(media);
  },
  (app) => {
    const media = app.findCollectionByNameOrId("media");
    media.fields.removeByName("derive_status");
    media.fields.removeByName("derive_error");
    app.save(media);
  }
);
