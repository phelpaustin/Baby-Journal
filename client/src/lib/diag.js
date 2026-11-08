import { createDiagnostics, connectionType } from "./diagnostics.js";

// One instance for the whole app. Storage is the phone's own localStorage; nothing leaves the device.
export const diag = createDiagnostics({
  storage: typeof localStorage !== "undefined" ? localStorage : undefined,
  env: { net: connectionType },
});

// Cold = the service worker did not control this page yet (first visit or first launch after an update).
export function beginStartupRun() {
  const warm = typeof navigator !== "undefined" && navigator.serviceWorker && navigator.serviceWorker.controller;
  diag.startRun(warm ? "warm" : "cold");
}
