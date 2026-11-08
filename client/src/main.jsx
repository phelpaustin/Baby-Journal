import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.jsx";
import "./styles.css";
import { beginStartupRun } from "./lib/diag.js";

beginStartupRun(); // User Timing: the clock is the time since navigation started

// Updates download in the background and apply the next time the app is opened. A page is
// never reloaded under someone who is typing an entry.
registerSW({ immediate: true });

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
