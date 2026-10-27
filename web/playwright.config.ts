import { defineConfig } from "@playwright/test";

const E2E_PORT = process.env.E2E_PORT || "3100";
// Both ports can be overridden, so several checkouts can run the suite at once.
const MOCK_API_PORT = process.env.MOCK_API_PORT || "8099";
const baseURL = `http://localhost:${E2E_PORT}`;

// The dashboard runs against tests/e2e/mock-api.mjs, so the suite needs neither the
// real API, Neon nor Redis. Clerk is bypassed because Playwright cannot drive its UI.
export default defineConfig({
  testDir: "./tests/e2e",
  // One worker: the suite takes seconds, and parallel Chromium instances starve the server on small machines.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL, trace: "on-first-retry", screenshot: "only-on-failure" },
  timeout: 60_000,
  expect: { timeout: 15_000 },
  webServer: [
    {
      command: "node tests/e2e/mock-api.mjs",
      url: `http://127.0.0.1:${MOCK_API_PORT}/health`,
      env: { MOCK_API_PORT },
      reuseExistingServer: !process.env.CI,
    },
    {
      // A production build: dev mode compiles each route on first hit, which times out parallel tests.
      command: `npx next build && npx next start -p ${E2E_PORT}`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        SENTINEL_API_URL: `http://127.0.0.1:${MOCK_API_PORT}`,
        SENTINEL_API_TOKEN: "e2e-token",
        E2E_BYPASS_CLERK: "1",
        NEXT_PUBLIC_E2E_BYPASS: "1",
        // Separate build dir, so the suite can run while `pnpm dev` is up.
        NEXT_DIST_DIR: ".next-e2e",
      },
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
