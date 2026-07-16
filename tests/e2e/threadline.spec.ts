import { expect, test } from "@playwright/test";

import { installOwnerSession } from "./auth";

const MAYA_ID = "20000000-0000-4000-8000-000000000001";

test("redirects visitors to owner sign-in", async ({ page }) => {
  await page.goto("/?demo=1");

  await expect(page).toHaveURL(/\/api\/auth\/signin/);
  await expect(
    page.getByRole("button", { name: /sign in with google/i }),
  ).toBeVisible();
});

test.describe("owner workspace", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await installOwnerSession(context, baseURL ?? "http://127.0.0.1:3000");
  });

  test("loads core routes and exposes no external send controls", async ({
    page,
  }) => {
    await page.goto("/?demo=1");
    await expect(
      page.getByRole("heading", { name: "Today’s relationship view" }),
    ).toBeVisible();

    await page.goto("/people?demo=1");
    await expect(
      page.getByRole("heading", { name: "People and companies" }),
    ).toBeVisible();

    await page.goto("/outreach?demo=1");
    await expect(
      page.getByRole("heading", { name: "Outreach queue" }),
    ).toBeVisible();
    await expect(page.getByText("Copy-only by design")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^(send|reply|post)(\b|$)/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /^(send|reply|post)(\b|$)/i }),
    ).toHaveCount(0);
  });

  test("preserves reply state and supports an owner correction", async ({
    page,
  }) => {
    await page.goto(`/people/${MAYA_ID}?demo=1`);
    await expect(page.getByRole("heading", { name: "Maya Chen" })).toBeVisible();
    await expect(page.getByText("Replied", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Correct" }).first().click();
    await expect(
      page.getByRole("heading", { name: "Correct title" }),
    ).toBeVisible();
    await page.getByLabel("Resolved value").fill("VP, Product Partnerships");
    await page.getByLabel("Reason, optional").fill("Owner-verified title");
    await page.getByRole("button", { name: "Save correction" }).click();
    await expect(
      page.getByText("VP, Product Partnerships", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Owner correction").first()).toBeVisible();
  });

  test("shows onboarding, degraded integrations, and manual sync", async ({
    page,
  }) => {
    await page.route("**/api/integrations/gmail/status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          connected: true,
          status: "connected",
          accountEmail: "owner@threadline.test",
          lastSyncedAt: "2026-07-16T17:00:00.000Z",
        }),
      });
    });
    await page.route("**/api/integrations/linkedin/status", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          connected: false,
          status: "attention_required",
          lastErrorCode: "linkedin_auth_expired",
          readOnly: true,
        }),
      });
    });
    await page.route("**/api/integrations/x/health", async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "X_NOT_CONNECTED" }),
      });
    });
    await page.route("**/api/sync", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, summary: { status: "succeeded" } }),
      });
    });

    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "Sources and sync" }),
    ).toBeVisible();
    await expect(
      page.getByText("Connected", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Needs attention", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Not connected", { exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Sync all sources" }).click();
    await expect(page.getByText("Sync request completed.")).toBeVisible();
  });

  test("rejects manual sync without an owner session", async ({ browser }) => {
    const context = await browser.newContext();
    const response = await context.request.post("/api/sync", { data: {} });
    expect(response.status()).toBe(401);
    await context.close();
  });
});
