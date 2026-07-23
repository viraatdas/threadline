import { describe, expect, it } from "vitest";

import { extractSignatureFacts } from "@/src/enrichment/signature";

describe("signature fact extraction", () => {
  it("reads 'Title, Company' signature lines", () => {
    const facts = extractSignatureFacts(
      "Sounds interesting — send over the deck.\n\nBest,\nErhan\nHead of Infrastructure, OpenRouter\n+1 (415) 555 0100",
    );
    expect(facts).toEqual({
      title: "Head of Infrastructure",
      company: "OpenRouter",
    });
  });

  it("reads 'Title at Company' and pipe separators", () => {
    expect(
      extractSignatureFacts("Thanks!\nMaya\nCo-founder at Northstar Labs"),
    ).toEqual({ title: "Co-founder", company: "Northstar Labs" });
    expect(
      extractSignatureFacts("Talk soon\nJon\nStaff Engineer | Fieldnote"),
    ).toEqual({ title: "Staff Engineer", company: "Fieldnote" });
  });

  it("returns null when no explicit role appears", () => {
    expect(
      extractSignatureFacts(
        "Hey, saw your launch — congrats!\n\nViraat\n+1 (304) 216 4370\nCal link",
      ),
    ).toBeNull();
    expect(extractSignatureFacts("")).toBeNull();
    expect(extractSignatureFacts(null)).toBeNull();
  });

  it("ignores quoted history and link-heavy footer lines", () => {
    const facts = extractSignatureFacts(
      "Let's do Tuesday.\nPriya\nVP of Engineering, Arcminute\nhttps://arcminute.io\n> On Jun 3, CEO Someone <x@y.z> wrote:\n> I am the CEO of something",
    );
    expect(facts).toEqual({ title: "VP of Engineering", company: "Arcminute" });
  });
});
