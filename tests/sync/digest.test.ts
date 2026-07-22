import { describe, expect, it } from "vitest";

import {
  buildDigestPrompt,
  conversationDigestSchema,
} from "@/src/enrichment/digest";

describe("conversation digest", () => {
  it("builds a compact prompt with direction markers and clipped text", () => {
    const prompt = buildDigestPrompt({
      displayName: "Erhan Example",
      primaryEmail: "erhan@openrouter.ai",
      messages: [
        {
          direction: "outbound",
          at: "2026-06-25T23:10:00.000Z",
          subject: "Curious if an agent that catches prod regressions is useful?",
          snippet: "x".repeat(400),
        },
        {
          direction: "inbound",
          at: "2026-06-26T01:00:00.000Z",
          subject: null,
          snippet: "Sounds interesting, send more details.",
        },
      ],
    });

    expect(prompt).toContain("Erhan Example <erhan@openrouter.ai>");
    expect(prompt).toContain("2026-06-25 me →");
    expect(prompt).toContain("2026-06-26 → me");
    expect(prompt).toContain("…");
    expect(prompt).not.toContain("x".repeat(300));
  });

  it("caps the prompt at eight messages", () => {
    const prompt = buildDigestPrompt({
      displayName: "Busy Thread",
      primaryEmail: null,
      messages: Array.from({ length: 20 }, (_, index) => ({
        direction: "outbound",
        at: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        subject: `msg-${index}`,
        snippet: null,
      })),
    });
    expect(prompt.match(/msg-\d+/g)).toHaveLength(8);
  });

  it("rejects oversized or unknown model output", () => {
    expect(
      conversationDigestSchema.safeParse({
        summary: "Cold pitch; two follow-ups, no reply yet.",
        kind: "outreach",
      }).success,
    ).toBe(true);
    expect(
      conversationDigestSchema.safeParse({
        summary: "y".repeat(300),
        kind: "outreach",
      }).success,
    ).toBe(false);
    expect(
      conversationDigestSchema.safeParse({
        summary: "fine",
        kind: "sales-ish",
      }).success,
    ).toBe(false);
  });
});
