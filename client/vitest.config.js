import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/global-setup.js"],
    environment: "node",
    env: { VITE_PB_URL: `http://127.0.0.1:${process.env.PB_TEST_PORT || "8098"}` },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    include: ["tests/**/*.test.{js,jsx}"],
  },
});
