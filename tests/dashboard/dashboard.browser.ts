import { expect, test } from "@playwright/test";
import { encode } from "next-auth/jwt";

const authSecret = "threadline-local-browser-secret-2026";

test.beforeEach(async ({ context }) => {
  const sessionToken = await encode({
    token: {
      name: "Viraat",
      email: "owner@example.com",
      sub: "threadline-owner",
    },
    secret: authSecret,
    salt: "authjs.session-token",
  });

  await context.addCookies([
    {
      name: "authjs.session-token",
      value: sessionToken,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
});

test("renders the demo command center without overflow and keeps actions keyboard-safe", async ({
  page,
}) => {
  await page.goto("/?demo=1");

  await expect(
    page.getByRole("heading", { name: "Today’s relationship view" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Next actions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "System health" }),
  ).toBeVisible();

  const nextActionsBox = await page
    .getByRole("heading", { name: "Next actions" })
    .boundingBox();
  const summaryBox = await page
    .getByRole("heading", { name: "Outreach summary" })
    .boundingBox();
  expect(nextActionsBox?.y).toBeLessThan(summaryBox?.y ?? 0);

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(hasHorizontalOverflow).toBe(false);

  const copyButton = page
    .locator('button[aria-label="Copy follow-up suggestion"]')
    .first();
  await copyButton.focus();
  await expect(copyButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.locator('button[aria-label="Follow-up suggestion copied"]').first(),
  ).toBeVisible();
});
