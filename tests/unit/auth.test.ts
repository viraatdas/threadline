import { describe, expect, it } from "vitest";

import { isOwnerEmail, normalizeEmail } from "@/lib/auth/owner";

describe("owner authentication", () => {
  it("matches the configured owner case-insensitively", () => {
    expect(normalizeEmail("  OWNER@Example.COM ")).toBe("owner@example.com");
    expect(isOwnerEmail("owner@example.com", "OWNER@EXAMPLE.COM")).toBe(true);
  });

  it("denies missing and non-owner identities", () => {
    expect(isOwnerEmail(undefined, "owner@example.com")).toBe(false);
    expect(isOwnerEmail("someone@example.com", "owner@example.com")).toBe(false);
  });
});
