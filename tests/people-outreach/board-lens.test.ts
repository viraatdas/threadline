import { describe, expect, it } from "vitest";

import { isOutreach } from "@/components/people/people-board";
import { workspaceData } from "@/components/people";
import type { PersonRecord } from "@/components/people/types";

function personWith(overrides: Partial<PersonRecord>): PersonRecord {
  const base = workspaceData.people[0];
  if (!base) throw new Error("sample data has no people");
  return {
    ...base,
    hasManualOverride: false,
    primaryEmail: "erhan@openrouter.ai",
    timeline: [],
    ...overrides,
  };
}

describe("board outreach lens", () => {
  it("uses the server-computed origin direction when the timeline is stripped", () => {
    // List payloads ship timeline: [] — the lens must not go blank (regression:
    // the board rendered empty in production because it derived the origin
    // from an always-empty client timeline).
    expect(
      isOutreach(personWith({ firstMessageDirection: "outbound" }), "exla.ai"),
    ).toBe(true);
    expect(
      isOutreach(personWith({ firstMessageDirection: "inbound" }), "exla.ai"),
    ).toBe(false);
    expect(
      isOutreach(personWith({ firstMessageDirection: null }), "exla.ai"),
    ).toBe(false);
  });

  it("excludes the owner's own domain and bulk senders", () => {
    expect(
      isOutreach(
        personWith({
          firstMessageDirection: "outbound",
          primaryEmail: "teammate@exla.ai",
        }),
        "exla.ai",
      ),
    ).toBe(false);
    expect(
      isOutreach(
        personWith({
          firstMessageDirection: "outbound",
          primaryEmail: "no-reply@updates.example.com",
        }),
        "exla.ai",
      ),
    ).toBe(false);
  });

  it("always keeps manually managed people", () => {
    expect(
      isOutreach(
        personWith({ hasManualOverride: true, firstMessageDirection: null }),
        "exla.ai",
      ),
    ).toBe(true);
  });
});
