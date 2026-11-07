// Starts a throwaway PocketBase (the real server code from ../backend) for the tests.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PB_TEST_PORT || "8098";

export default async function setup() {
  const script = join(here, "../../backend/tests/start-pb.sh");
  const child = spawn(script, [], { env: { ...process.env, PORT, PB_TEST_DIR: "/tmp/pbtest-client" }, stdio: "ignore" });
  process.env.PB_URL = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(process.env.PB_URL + "/api/health");
      if (r.ok) break;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 99) throw new Error("PocketBase did not start");
  }
  return async () => {
    child.kill("SIGTERM");
  };
}
