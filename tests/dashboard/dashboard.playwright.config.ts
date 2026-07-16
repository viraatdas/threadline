import { defineConfig, devices } from "@playwright/test";

import {
  E2E_AUTH_SECRET,
  E2E_GOOGLE_ID,
  E2E_GOOGLE_SECRET,
  E2E_OWNER_EMAIL,
} from "../e2e/auth";

const baseURL = "http://127.0.0.1:3105";

export default defineConfig({
  testDir: ".",
  testMatch: "dashboard.browser.ts",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL,
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm start --hostname 127.0.0.1 --port 3105",
    url: baseURL,
    env: {
      AUTH_SECRET: E2E_AUTH_SECRET,
      AUTH_GOOGLE_ID: E2E_GOOGLE_ID,
      AUTH_GOOGLE_SECRET: E2E_GOOGLE_SECRET,
      AUTH_URL: baseURL,
      OWNER_EMAIL: E2E_OWNER_EMAIL,
      DATABASE_URL:
        "postgres://threadline:threadline@127.0.0.1:65432/threadline_test",
      INTEGRATION_ENCRYPTION_KEY:
        "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      INTEGRATION_ENCRYPTION_KEY_VERSION: "1",
      CRON_SECRET: "threadline-e2e-cron-secret",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
