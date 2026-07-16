import { describe, expect, it } from "vitest";

import { GmailConnector } from "@/src/integrations/gmail/connector";
import { FixtureGmailApi, gmailAccount } from "@/tests/gmail/fakes";

describe("Gmail thread normalization", () => {
  it("paginates threads and normalizes aliases, replies, bodies, and attachments", async () => {
    const api = new FixtureGmailApi();
    const connector = new GmailConnector({
      api,
      ownerEmail: gmailAccount.accountEmail,
    });
    const pages = [];
    for await (const page of connector.pull(
      {
        integrationAccountId: gmailAccount.id,
        now: new Date("2026-07-15T18:00:00.000Z"),
      },
      {
        resource: "gmail-history",
        since: new Date("2026-03-17T18:00:00.000Z"),
      },
    )) {
      pages.push(page);
    }

    expect(api.calls.threadPages).toEqual([undefined, "threads-page-2"]);
    expect(pages).toHaveLength(2);
    const outreach = pages[0]?.conversations[0];
    expect(outreach?.messages.map((message) => message.direction)).toEqual([
      "outbound",
      "inbound",
    ]);
    expect(outreach?.metadata.deterministicReplyState).toBe("replied");
    expect(outreach?.messages[0]?.bodyText).toBe(
      "Hi Ada,\n\nWould you be open to a quick call?",
    );
    expect(outreach?.messages[1]?.bodyText).toBe("Yes, Thursday works.");
    expect(outreach?.messages[1]?.replyToExternalMessageId).toBe(
      "message-outbound",
    );
    expect(outreach?.messages[0]?.metadata.attachments).toEqual([
      {
        attachmentId: "attachment-brief",
        filename: "brief.pdf",
        mimeType: "application/pdf",
        size: 4096,
        partId: "1",
      },
    ]);
    expect(
      outreach?.participants.find(
        (participant) =>
          participant.externalParticipantId === "sales@example.com",
      )?.role,
    ).toBe("owner");
    expect(
      outreach?.participants.find(
        (participant) =>
          participant.externalParticipantId === "ada@analytical.example",
      )?.role,
    ).toBe("contact");
    const missingBody = pages[1]?.conversations[0]?.messages[0];
    expect(missingBody?.bodyText).toBeUndefined();
    expect(missingBody?.snippet).toBe("Following up from the conference");
  });
});
