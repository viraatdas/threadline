import { describe, expect, it } from "vitest";

import { UnifiedSyncOrchestrator } from "@/src/sync/orchestrator";
import type {
  ChannelSyncCounts,
  SyncChannelExecutor,
  SyncCoordinatorStore,
  SyncReconciler,
  UnifiedSyncAccount,
} from "@/src/sync/types";

const COUNTS: ChannelSyncCounts = {
  discoveredCount: 2,
  insertedCount: 1,
  updatedCount: 0,
  skippedCount: 1,
  failedCount: 0,
  analysisEnqueuedCount: 1,
};

describe("UnifiedSyncOrchestrator", () => {
  it("bounds concurrency, retries transient failures, and isolates channel failures", async () => {
    const accounts = [
      account("gmail-account", "gmail"),
      account("linkedin-account", "linkedin"),
      account("x-account", "x"),
    ];
    const store = new FakeStore(accounts);
    const reconciler = new FakeReconciler();
    let active = 0;
    let maximumActive = 0;
    let gmailCalls = 0;
    const executor = (
      channel: UnifiedSyncAccount["channel"],
      execute: SyncChannelExecutor["execute"],
      isRetryable?: SyncChannelExecutor["isRetryable"],
    ): SyncChannelExecutor => ({
      channel,
      resource: `${channel}:resource`,
      execute: async (context) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await execute(context);
        } finally {
          active -= 1;
        }
      },
      ...(isRetryable ? { isRetryable } : {}),
    });
    const orchestrator = new UnifiedSyncOrchestrator(
      store,
      [
        executor(
          "gmail",
          async () => {
            gmailCalls += 1;
            if (gmailCalls === 1)
              throw Object.assign(new Error("retry"), { retryable: true });
            return { ...COUNTS, status: "succeeded" };
          },
          (error) =>
            typeof error === "object" && error !== null && "retryable" in error,
        ),
        executor(
          "linkedin",
          async () => {
            throw Object.assign(new Error("credentials rejected"), {
              code: "linkedin_auth",
            });
          },
          () => false,
        ),
        executor("x", async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { ...COUNTS, status: "succeeded" };
        }),
      ],
      reconciler,
    );

    const summary = await orchestrator.run({
      trigger: "scheduled",
      invocationId: "schedule-1",
      maxConcurrency: 2,
      maxAttempts: 2,
      timeoutMs: 5_000,
    });

    expect(summary.status).toBe("partial");
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(gmailCalls).toBe(2);
    expect(summary.outcomes.map((outcome) => outcome.status)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
    expect(summary.outcomes[0]?.attempts).toBe(2);
    expect(store.completed).toHaveLength(3);
    expect(reconciler.accountIds).toEqual([
      "gmail-account",
      "linkedin-account",
      "x-account",
    ]);
  });

  it("skips disabled accounts and respects distributed lock claims", async () => {
    const disabled = account("disabled", "gmail", false);
    const locked = account("locked", "x");
    const store = new FakeStore([disabled, locked]);
    store.locked.add(locked.id);
    let calls = 0;
    const orchestrator = new UnifiedSyncOrchestrator(
      store,
      [
        {
          channel: "gmail",
          resource: "gmail-history",
          async execute() {
            calls += 1;
            return { ...COUNTS, status: "succeeded" };
          },
        },
        {
          channel: "x",
          resource: "direct_messages",
          async execute() {
            calls += 1;
            return { ...COUNTS, status: "succeeded" };
          },
        },
      ],
      new FakeReconciler(),
    );

    const summary = await orchestrator.run({
      trigger: "manual",
      invocationId: "manual-1",
    });

    expect(calls).toBe(0);
    expect(summary.status).toBe("succeeded");
    expect(summary.outcomes).toMatchObject([
      { accountId: "disabled", status: "skipped", reason: "disabled" },
      { accountId: "locked", status: "skipped", reason: "locked" },
    ]);
  });
});

class FakeStore implements SyncCoordinatorStore {
  readonly completed: { runId: string; status: string }[] = [];
  readonly locked = new Set<string>();

  constructor(private readonly accounts: UnifiedSyncAccount[]) {}

  async listAccounts() {
    return this.accounts;
  }

  async claimRun(input: { account: UnifiedSyncAccount }) {
    if (this.locked.has(input.account.id)) {
      return { acquired: false as const, reason: "locked" as const };
    }
    return { acquired: true as const, runId: `run:${input.account.id}` };
  }

  async completeRun(input: { runId: string; status: string }) {
    this.completed.push({ runId: input.runId, status: input.status });
  }
}

class FakeReconciler implements SyncReconciler {
  accountIds: string[] = [];

  async reconcile(input: { integrationAccountIds: readonly string[] }) {
    this.accountIds = [...input.integrationAccountIds];
    return {
      contactsMerged: 0,
      contactsRecomputed: 2,
      analysisJobsEnqueued: 1,
    };
  }
}

function account(
  id: string,
  channel: UnifiedSyncAccount["channel"],
  syncEnabled = true,
): UnifiedSyncAccount {
  return {
    id,
    channel,
    displayName: id,
    status: syncEnabled ? "connected" : "disabled",
    syncEnabled,
  };
}
