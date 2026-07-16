import { describe, expect, it } from "vitest";

import {
  conversationCandidateSchema,
  integrationAccountInputSchema,
  readOnlyCapabilitiesSchema,
} from "@/lib/domain";
import { READ_ONLY_CAPABILITIES } from "@/lib/security/read-only";

describe("domain contracts", () => {
  it("accepts only the read-only integration capability boundary", () => {
    expect(readOnlyCapabilitiesSchema.parse(READ_ONLY_CAPABILITIES)).toEqual(
      READ_ONLY_CAPABILITIES,
    );

    expect(() =>
      integrationAccountInputSchema.parse({
        provider: "gmail",
        externalAccountId: "owner@example.com",
        displayName: "Owner Gmail",
        accountEmail: "owner@example.com",
        credentials: { refreshToken: "encrypted-before-storage" },
        capabilities: { ...READ_ONLY_CAPABILITIES, send: true },
      }),
    ).toThrow();
  });

  it("validates a normalized conversation page with provenance and idempotency", () => {
    const collectedAt = "2026-07-15T19:00:00.000Z";
    const integrationAccountId = "3b9e52fb-f0cb-410b-8c2d-a7eac0ee6ae5";

    const conversation = conversationCandidateSchema.parse({
      idempotencyKey: "gmail:thread:abc123",
      integrationAccountId,
      channel: "gmail",
      externalConversationId: "thread-123",
      subject: "Introduction",
      participants: [],
      messages: [
        {
          idempotencyKey: "gmail:message:abc123",
          integrationAccountId,
          channel: "gmail",
          externalConversationId: "thread-123",
          externalMessageId: "message-123",
          direction: "outbound",
          sentAt: collectedAt,
          bodyText: "Hello",
          provenance: {
            provider: "gmail",
            integrationAccountId,
            externalId: "message-123",
            collectedAt,
            confidence: 1,
          },
        },
      ],
      provenance: {
        provider: "gmail",
        integrationAccountId,
        externalId: "thread-123",
        collectedAt,
        confidence: 1,
      },
    });

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]?.direction).toBe("outbound");
    expect(conversation.provenance.metadata).toEqual({});
  });
});
