import { describe, expect, it } from "vitest";

import {
  deriveRelationshipMetrics,
  isAnalysisCovered,
  planConservativeIdentityMerges,
} from "@/src/sync/reconcile";

describe("sync reconciliation", () => {
  it("merges only exact authoritative email identities", () => {
    const contacts = [
      contact("gmail", "Person@Example.com", "2026-01-01"),
      contact("linkedin", "person@example.com", "2026-02-01"),
      contact("same-name-only", null, "2026-03-01"),
      {
        ...contact("manual", "person@example.com", "2026-04-01"),
        hasManualOverride: true,
      },
      contact("conflict", null, "2026-05-01"),
    ];
    const plans = planConservativeIdentityMerges(contacts, [
      identity("gmail", "gmail", "person@example.com"),
      identity("linkedin", "linkedin", "person@example.com"),
      identity("same-name-only", "x", "person"),
      identity("manual", "gmail", "person@example.com"),
      identity("conflict", "gmail", "person@example.com"),
      identity("conflict", "gmail", "different@example.com"),
    ]);

    expect(plans).toEqual([
      {
        email: "person@example.com",
        canonicalContactId: "gmail",
        duplicateContactIds: ["linkedin"],
      },
    ]);
  });

  it("derives cross-channel relationship metrics from ordered touch aggregates", () => {
    const outbound = new Date("2026-07-15T10:00:00.000Z");
    const inbound = new Date("2026-07-15T11:00:00.000Z");
    expect(
      deriveRelationshipMetrics({
        touchCount: 4,
        inboundTouchCount: 1,
        outboundTouchCount: 3,
        firstTouchAt: outbound,
        lastTouchAt: inbound,
        lastInboundAt: inbound,
        lastOutboundAt: outbound,
      }),
    ).toMatchObject({
      replyState: "replied",
      relationshipStage: "replied",
      touchCount: 4,
    });
    expect(deriveRelationshipMetrics(undefined)).toMatchObject({
      replyState: "unknown",
      relationshipStage: "unreviewed",
      touchCount: 0,
    });
  });

  it("recognizes existing semantic analysis coverage across idempotency namespaces", () => {
    const candidate = {
      jobType: "classify_outreach",
      inputHash: "new-hash",
      messageExternalIds: ["m1", "m2"],
    };
    expect(
      isAnalysisCovered(candidate, [
        {
          jobType: "classify_outreach",
          inputHash: "channel-specific-hash",
          payload: {
            messages: [
              { externalMessageId: "m2" },
              { externalMessageId: "m1" },
            ],
          },
        },
      ]),
    ).toBe(true);
    expect(
      isAnalysisCovered(candidate, [
        {
          jobType: "detect_reply",
          inputHash: "new-hash",
          payload: {},
        },
      ]),
    ).toBe(false);
  });
});

function contact(id: string, primaryEmail: string | null, createdAt: string) {
  return {
    id,
    primaryEmail,
    companyId: null,
    hasManualOverride: false,
    createdAt: new Date(createdAt),
  };
}

function identity(
  contactId: string,
  channel: "gmail" | "linkedin" | "x",
  address: string,
) {
  return { contactId, channel, address, isOwner: false };
}
