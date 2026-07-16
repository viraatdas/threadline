import { describe, expect, it } from "vitest";

import { runGmailSync } from "@/src/integrations/gmail/sync";
import {
  FixtureGmailApi,
  gmailAccount,
  MemoryGmailStore,
} from "@/tests/gmail/fakes";

describe("Gmail synchronization", () => {
  it("performs initial and incremental syncs exactly once and remains idempotent", async () => {
    const api = new FixtureGmailApi();
    const store = new MemoryGmailStore();
    const initial = await runGmailSync({
      account: gmailAccount,
      api,
      store,
      ownerEmail: gmailAccount.accountEmail,
      trigger: "backfill",
      now: new Date("2026-07-15T18:00:00.000Z"),
    });

    expect(initial.mode).toBe("initial");
    expect(initial.discoveredCount).toBe(2);
    expect(initial.analysisEnqueuedCount).toBe(2);
    expect(store.messages.size).toBe(3);
    expect(store.cursor?.historyId).toBe("100");

    api.phase = "incremental";
    api.profileHistoryId = "120";
    const incremental = await runGmailSync({
      account: gmailAccount,
      api,
      store,
      ownerEmail: gmailAccount.accountEmail,
      now: new Date("2026-07-15T19:00:00.000Z"),
    });

    expect(incremental.mode).toBe("incremental");
    expect(incremental.discoveredCount).toBe(1);
    expect(incremental.analysisEnqueuedCount).toBe(1);
    expect(store.analysisJobs.size).toBe(3);
    expect(store.messages.size).toBe(4);
    expect(store.cursor?.historyId).toBe("120");
    expect(
      api.calls.threads.filter((threadId) => threadId === "thread-outreach"),
    ).toHaveLength(2);
    expect(api.calls.historyPages.slice(0, 2)).toEqual([
      { startHistoryId: "100" },
      { startHistoryId: "100", pageToken: "history-page-2" },
    ]);

    store.cursor = {
      historyId: "100",
      mailboxEmail: gmailAccount.accountEmail,
      updatedAt: "2026-07-15T18:00:00.000Z",
    };
    const replay = await runGmailSync({
      account: gmailAccount,
      api,
      store,
      ownerEmail: gmailAccount.accountEmail,
      now: new Date("2026-07-15T20:00:00.000Z"),
    });
    expect(replay.discoveredCount).toBe(1);
    expect(replay.skippedCount).toBe(1);
    expect(replay.analysisEnqueuedCount).toBe(0);
    expect(store.analysisJobs.size).toBe(3);
    expect(store.messages.size).toBe(4);
    expect(store.cursor.historyId).toBe("120");

    const noChanges = await runGmailSync({
      account: gmailAccount,
      api,
      store,
      ownerEmail: gmailAccount.accountEmail,
      now: new Date("2026-07-15T21:00:00.000Z"),
    });
    expect(noChanges.discoveredCount).toBe(0);
    expect(noChanges.analysisEnqueuedCount).toBe(0);
  });

  it("recovers an expired History API cursor with a full backfill", async () => {
    const api = new FixtureGmailApi();
    api.profileHistoryId = "120";
    api.staleHistoryIds.add("50");
    const store = new MemoryGmailStore();
    store.cursor = {
      historyId: "50",
      mailboxEmail: gmailAccount.accountEmail,
      updatedAt: "2026-07-01T00:00:00.000Z",
    };
    const result = await runGmailSync({
      account: gmailAccount,
      api,
      store,
      ownerEmail: gmailAccount.accountEmail,
      now: new Date("2026-07-15T18:00:00.000Z"),
    });
    expect(result.mode).toBe("recovery");
    expect(result.cursor.historyId).toBe("120");
    expect(result.discoveredCount).toBe(2);
  });

  it("marks revoked credentials as requiring attention without advancing the cursor", async () => {
    const api = new FixtureGmailApi();
    api.revoked = true;
    const store = new MemoryGmailStore();
    store.cursor = {
      historyId: "100",
      mailboxEmail: gmailAccount.accountEmail,
      updatedAt: "2026-07-15T17:00:00.000Z",
    };
    await expect(
      runGmailSync({
        account: gmailAccount,
        api,
        store,
        ownerEmail: gmailAccount.accountEmail,
        now: new Date("2026-07-15T18:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(store.attention?.code).toBe("authorization_required");
    expect(store.cursor.historyId).toBe("100");
  });
});
