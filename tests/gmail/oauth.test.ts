import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mergeGoogleCredentials } from "@/src/integrations/gmail/client";
import { GMAIL_READONLY_SCOPE } from "@/src/integrations/gmail/constants";
import {
  assertGmailOwner,
  createGmailAuthorization,
  validateGmailOAuthState,
} from "@/src/integrations/gmail/oauth";
import { TestCredentialVault } from "@/tests/gmail/fakes";

describe("Gmail OAuth", () => {
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    process.env.AUTH_GOOGLE_ID = "synthetic-client-id";
    process.env.AUTH_GOOGLE_SECRET = "synthetic-client-secret";
  });

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it("requests only read-only Gmail access with offline refresh and bound state", async () => {
    const vault = new TestCredentialVault();
    const authorization = await createGmailAuthorization({
      vault,
      redirectUri: "https://threadline.example/api/integrations/gmail/callback",
      ownerEmail: "OWNER@example.com",
      nonce: "1234567890abcdefghijklmnop",
      returnTo: "/settings/integrations",
      backfillDays: 90,
      now: new Date("2026-07-15T18:00:00.000Z"),
    });
    const url = new URL(authorization.authorizationUrl);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toContain("consent");
    expect(url.searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);
    expect(url.searchParams.get("scope")).not.toMatch(/modify|compose|send/);
    const state = await validateGmailOAuthState({
      vault,
      state: authorization.state,
      cookieValue: authorization.cookieValue,
      sessionOwnerEmail: "owner@example.com",
      now: new Date("2026-07-15T18:05:00.000Z"),
    });
    expect(state.backfillDays).toBe(90);
    expect(state.returnTo).toBe("/settings/integrations");
  });

  it("preserves an existing refresh token when Google rotates only the access token", () => {
    expect(
      mergeGoogleCredentials(
        {
          refreshToken: "refresh",
          accessToken: "old",
          expiryDate: 1,
          scopes: [GMAIL_READONLY_SCOPE],
        },
        { access_token: "new", expiry_date: 2, scope: GMAIL_READONLY_SCOPE },
      ),
    ).toMatchObject({
      refreshToken: "refresh",
      accessToken: "new",
      expiryDate: 2,
    });
  });

  it("rejects a mailbox that does not match the explicit owner", () => {
    expect(() =>
      assertGmailOwner(
        "other@example.com",
        "owner@example.com",
        "owner@example.com",
      ),
    ).toThrow(/does not match/);
  });
});
