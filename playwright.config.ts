import { defineConfig, devices } from "@playwright/test";

import {
  E2E_AUTH_SECRET,
  E2E_GOOGLE_ID,
  E2E_GOOGLE_SECRET,
  E2E_OWNER_EMAIL,
} from "./tests/e2e/auth";

const ciOptions = process.env.CI ? { retries: 2, workers: 1 } : { retries: 0 };
const baseURL = "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  ...ciOptions,
  reporter: "html",
  use: {
    baseURL,
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm start --hostname 127.0.0.1",
    url: baseURL,
    env: {
      AUTH_SECRET: E2E_AUTH_SECRET,
      AUTH_GOOGLE_ID: E2E_GOOGLE_ID,
      AUTH_GOOGLE_SECRET: E2E_GOOGLE_SECRET,
      AUTH_URL: baseURL,
      OWNER_EMAIL: E2E_OWNER_EMAIL,
      DATABASE_URL: "postgres://threadline:threadline@127.0.0.1:65432/threadline_test",
      INTEGRATION_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      INTEGRATION_ENCRYPTION_KEY_VERSION: "1",
      CRON_SECRET: "threadline-e2e-cron-secret",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
