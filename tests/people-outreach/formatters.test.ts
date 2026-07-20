import { describe, expect, it } from "vitest";

import {
  followUpStatus,
  formatTimeAgo,
} from "@/components/people/formatters";

const NOW = "2026-07-20T12:00:00.000Z";

describe("formatTimeAgo", () => {
  it("scales from minutes through years", () => {
    expect(formatTimeAgo("2026-07-20T11:59:40.000Z", NOW)).toBe("just now");
    expect(formatTimeAgo("2026-07-20T11:12:00.000Z", NOW)).toBe("48m ago");
    expect(formatTimeAgo("2026-07-20T05:00:00.000Z", NOW)).toBe("7h ago");
    expect(formatTimeAgo("2026-07-17T12:00:00.000Z", NOW)).toBe("3d ago");
    expect(formatTimeAgo("2026-06-29T12:00:00.000Z", NOW)).toBe("3w ago");
    expect(formatTimeAgo("2026-02-20T12:00:00.000Z", NOW)).toBe("5mo ago");
    expect(formatTimeAgo("2024-05-20T12:00:00.000Z", NOW)).toBe("2y ago");
    expect(formatTimeAgo(null, NOW)).toBe("never");
  });
});

describe("followUpStatus", () => {
  it("flags a follow-up waiting more than a week as needing attention", () => {
    const status = followUpStatus(
      {
        replyState: "awaiting_reply",
        lastOutboundAt: "2026-07-10T12:00:00.000Z",
        lastInboundAt: null,
        lastTouchAt: "2026-07-10T12:00:00.000Z",
      },
      NOW,
    );
    expect(status.label).toBe("You followed up 10d ago · no reply yet");
    expect(status.tone).toBe("attention");
  });

  it("keeps a fresh follow-up neutral", () => {
    const status = followUpStatus(
      {
        replyState: "awaiting_reply",
        lastOutboundAt: "2026-07-19T12:00:00.000Z",
        lastInboundAt: null,
        lastTouchAt: "2026-07-19T12:00:00.000Z",
      },
      NOW,
    );
    expect(status.tone).toBe("neutral");
  });

  it("marks an unanswered reply as your turn", () => {
    const status = followUpStatus(
      {
        replyState: "replied",
        lastOutboundAt: "2026-07-15T12:00:00.000Z",
        lastInboundAt: "2026-07-18T12:00:00.000Z",
        lastTouchAt: "2026-07-18T12:00:00.000Z",
      },
      NOW,
    );
    expect(status.label).toBe("They replied 2d ago · your turn");
    expect(status.tone).toBe("positive");
  });

  it("shows your reply when you answered last", () => {
    const status = followUpStatus(
      {
        replyState: "replied",
        lastOutboundAt: "2026-07-19T12:00:00.000Z",
        lastInboundAt: "2026-07-18T12:00:00.000Z",
        lastTouchAt: "2026-07-19T12:00:00.000Z",
      },
      NOW,
    );
    expect(status.label).toBe("You replied 1d ago");
    expect(status.tone).toBe("neutral");
  });

  it("falls back to last touch, then to no activity", () => {
    expect(
      followUpStatus(
        {
          replyState: "unknown",
          lastOutboundAt: null,
          lastInboundAt: null,
          lastTouchAt: "2026-07-01T12:00:00.000Z",
        },
        NOW,
      ).label,
    ).toBe("Last touch 3w ago");
    expect(
      followUpStatus(
        {
          replyState: "unknown",
          lastOutboundAt: null,
          lastInboundAt: null,
          lastTouchAt: null,
        },
        NOW,
      ).label,
    ).toBe("No activity yet");
  });
});
