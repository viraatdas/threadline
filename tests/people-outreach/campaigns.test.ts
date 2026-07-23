import { describe, expect, it } from "vitest";

import {
  campaignMatchScore,
  extractCampaignTerms,
  matchesCampaign,
} from "@/components/people/campaigns";
import { workspaceData } from "@/components/people";
import type { PersonRecord, RecentMessage } from "@/components/people/types";

const SAMPLE = `Hi Erhan!
Here from the W25 batch. I'm reaching out to YC alums who work at companies
with real production infra. We built an agent that watches prod, catches
regressions that never throw an error, and attributes them to the deploy.
Would love a quick chat: https://cal.com/exla-ai/viraat`;

function personWithMessages(messages: RecentMessage[]): PersonRecord {
  const base = workspaceData.people[0];
  if (!base) throw new Error("sample data has no people");
  return { ...base, recentMessages: messages };
}

function message(subject: string, snippet: string): RecentMessage {
  return {
    id: crypto.randomUUID(),
    subject,
    snippet,
    at: "2026-07-01T00:00:00.000Z",
    direction: "outbound",
    channel: "gmail",
  };
}

describe("campaign sample matching", () => {
  it("extracts distinctive terms, not urls or filler", () => {
    const terms = extractCampaignTerms(SAMPLE);
    expect(terms).toContain("regressions");
    expect(terms).toContain("production infra");
    expect(terms.join(" ")).not.toContain("http");
    expect(terms).not.toContain("the");
  });

  it("matches another send of the same campaign", () => {
    const terms = extractCampaignTerms(SAMPLE);
    const person = personWithMessages([
      message(
        "Curious if an agent that catches prod regressions is useful at Vercel?",
        "Here from the W25 batch — we built an agent that watches prod, catches regressions that never throw an error, and attributes them to the deploy.",
      ),
    ]);
    expect(matchesCampaign(person, terms)).toBe(true);
  });

  it("rejects unrelated conversations", () => {
    const terms = extractCampaignTerms(SAMPLE);
    const person = personWithMessages([
      message(
        "Dinner on Saturday?",
        "Hey! Are you free this weekend for dinner at that new ramen place?",
      ),
    ]);
    expect(matchesCampaign(person, terms)).toBe(false);
    expect(campaignMatchScore(terms, "dinner ramen weekend")).toBeLessThan(
      0.05,
    );
  });

  it("never matches people with no stored messages", () => {
    const terms = extractCampaignTerms(SAMPLE);
    expect(matchesCampaign(personWithMessages([]), terms)).toBe(false);
  });
});
