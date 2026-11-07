/// <reference path="../pb_data/types.d.ts" />
// Behind Caddy, every request reaches PocketBase from 127.0.0.1. Without this, PocketBase's
// per-IP rate limits would treat the whole family (and any attacker) as one client.
// Caddy sets X-Real-IP from the connection (or the PROXY-protocol header from the VPS) and
// overwrites anything the client sent, so the header can be trusted. PocketBase itself must
// therefore listen on 127.0.0.1 only; if it were reachable directly, a client could forge it.
migrate(
  (app) => {
    const settings = app.settings();
    settings.trustedProxy.headers = ["X-Real-IP"];
    settings.trustedProxy.useLeftmostIP = false;
    app.save(settings);
  },
  (app) => {
    const settings = app.settings();
    settings.trustedProxy.headers = [];
    app.save(settings);
  }
);
