import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { openCredential, sealCredential } from "@/lib/security/credentials";
import { createIdempotencyKey, hashContent } from "@/lib/security/idempotency";
import {
  assertExternalActionAllowed,
  assertReadOnlyCapabilities,
  READ_ONLY_CAPABILITIES,
} from "@/lib/security/read-only";

describe("credential encryption", () => {
  const encodedKey = randomBytes(32).toString("base64");

  it("round-trips structured credentials with context-bound AES-GCM", () => {
    const credentials = { accessToken: "secret", scopes: ["mail.readonly"] };
    const envelope = sealCredential(credentials, "integration:gmail:owner", {
      encodedKey,
      keyVersion: 7,
    });

    expect(envelope).not.toContain("secret");
    expect(
      openCredential<typeof credentials>(envelope, "integration:gmail:owner", {
        encodedKey,
        expectedKeyVersion: 7,
      }),
    ).toEqual(credentials);
  });

  it("rejects a different credential context", () => {
    const envelope = sealCredential({ token: "secret" }, "integration:gmail:owner", {
      encodedKey,
      keyVersion: 1,
    });

    expect(() =>
      openCredential(envelope, "integration:x:owner", {
        encodedKey,
        expectedKeyVersion: 1,
      }),
    ).toThrow();
  });
});

describe("safety and idempotency", () => {
  it("allows reads and drafts but blocks external mutations", () => {
    expect(() => assertExternalActionAllowed("read")).not.toThrow();
    expect(() => assertExternalActionAllowed("draft")).not.toThrow();
    expect(() => assertExternalActionAllowed("send")).toThrow(/prohibited/);
    expect(() => assertReadOnlyCapabilities(READ_ONLY_CAPABILITIES)).not.toThrow();
  });

  it("produces stable, namespaced keys independent of object key order", () => {
    const first = createIdempotencyKey("gmail-message", { a: 1, b: 2 }, "external-1");
    const second = createIdempotencyKey("gmail-message", { b: 2, a: 1 }, "external-1");

    expect(first).toBe(second);
    expect(first).toMatch(/^gmail-message:[a-f0-9]{64}$/);
    expect(hashContent({ a: 1 })).not.toBe(hashContent({ a: 2 }));
  });
});
