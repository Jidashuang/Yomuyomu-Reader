import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://127.0.0.1:8010",
    trace: "on-first-retry",
  },
  webServer: {
    command: "python3 backend/server.py --host 127.0.0.1 --port 8010",
    port: 8010,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
