import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

import { GMAIL_BACKFILL_TARGET_DAYS } from "@/src/integrations/gmail/constants";
import {
  BACKFILL_QUERY,
  gmailBackfillPending,
  readChainCount,
} from "@/src/sync/continuation";
import type { UnifiedSyncSummary } from "@/src/sync/types";

function summary(outcomes: UnifiedSyncSummary["outcomes"]): UnifiedSyncSummary {
  return {
    invocationId: "test",
    trigger: "manual",
    status: "succeeded",
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:01:00.000Z",
    outcomes,
  };
}

describe("backfill continuation", () => {
  it("detects a pending gmail backfill from outcome metadata", () => {
    expect(
      gmailBackfillPending(
        summary([
          {
            accountId: "a",
            channel: "gmail",
            displayName: "viraat@exla.ai",
            status: "succeeded",
            attempts: 1,
            discoveredCount: 10,
            insertedCount: 10,
            updatedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            analysisEnqueuedCount: 10,
            metadata: { mode: "backfill", backfillPending: true },
          },
        ]),
      ),
    ).toBe(true);
  });

  it("does not continue once the backfill reports itself finished", () => {
    expect(
      gmailBackfillPending(
        summary([
          {
            accountId: "a",
            channel: "gmail",
            displayName: "viraat@exla.ai",
            status: "succeeded",
            attempts: 1,
            discoveredCount: 4,
            insertedCount: 4,
            updatedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            analysisEnqueuedCount: 4,
            metadata: { mode: "initial", backfillPending: false },
          },
        ]),
      ),
    ).toBe(false);
  });

  it("does not continue a failed or locked run", () => {
    expect(gmailBackfillPending(summary([]))).toBe(false);
    expect(
      gmailBackfillPending(
        summary([
          {
            accountId: "a",
            channel: "gmail",
            displayName: "viraat@exla.ai",
            status: "skipped",
            reason: "locked",
            attempts: 0,
            discoveredCount: 0,
            insertedCount: 0,
            updatedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            analysisEnqueuedCount: 0,
          },
        ]),
      ),
    ).toBe(false);
  });

  it("reads and defaults the chain counter safely", () => {
    expect(readChainCount(new URL("https://x.dev/api/cron/sync"))).toBe(0);
    expect(
      readChainCount(new URL("https://x.dev/api/cron/sync?_chain=5")),
    ).toBe(5);
    expect(
      readChainCount(new URL("https://x.dev/api/cron/sync?_chain=-3")),
    ).toBe(0);
    expect(
      readChainCount(new URL("https://x.dev/api/cron/sync?_chain=abc")),
    ).toBe(0);
  });

  it("keeps the chain link, the cron, and the target depth in step", () => {
    const cron = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      crons: { path: string }[];
    };
    expect(GMAIL_BACKFILL_TARGET_DAYS).toBe(548);
    expect(BACKFILL_QUERY).toContain(
      `gmailBackfillDays=${GMAIL_BACKFILL_TARGET_DAYS}`,
    );
    expect(cron.crons.map((c) => c.path)).toContain(
      `/api/cron/sync?${BACKFILL_QUERY}`,
    );
  });
});
