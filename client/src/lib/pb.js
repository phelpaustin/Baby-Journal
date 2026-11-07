import PocketBase from "pocketbase";

// In production the app is served by the same host as the API. In development Vite
// proxies /api to the local server, so the origin works there too.
const base = import.meta.env?.VITE_PB_URL || (typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8090");
export const pb = new PocketBase(base);
pb.autoCancellation(false);
