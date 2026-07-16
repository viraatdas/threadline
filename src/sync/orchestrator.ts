import type { Channel } from "@/lib/domain/constants";

import { runWithRetry } from "@/src/sync/retry";
import type {
  ChannelSyncCounts,
  ChannelSyncOutcome,
  SyncChannelExecutor,
  SyncCoordinatorStore,
  SyncReconciler,
  UnifiedSyncAccount,
  UnifiedSyncRequest,
  UnifiedSyncSummary,
} from "@/src/sync/types";

const EMPTY_COUNTS: ChannelSyncCounts = {
  discoveredCount: 0,
  insertedCount: 0,
  updatedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  analysisEnqueuedCount: 0,
};

export class UnifiedSyncOrchestrator {
  private readonly executors: ReadonlyMap<Channel, SyncChannelExecutor>;

  constructor(
    private readonly store: SyncCoordinatorStore,
    executors: readonly SyncChannelExecutor[],
    private readonly reconciler: SyncReconciler,
  ) {
    this.executors = new Map(
      executors.map((executor) => [executor.channel, executor]),
    );
  }

  async run(request: UnifiedSyncRequest): Promise<UnifiedSyncSummary> {
    const startedAt = new Date();
    const accounts = await this.store.listAccounts(request.channels);
    const maxConcurrency = clamp(request.maxConcurrency ?? 2, 1, 3);

    const outcomes = await mapWithConcurrency(
      accounts,
      maxConcurrency,
      (account) => this.runAccount(account, request),
    );
    const acquiredAccountIds = outcomes.flatMap((outcome) =>
      outcome.runId ? [outcome.accountId] : [],
    );

    let reconciliation: UnifiedSyncSummary["reconciliation"];
    let reconciliationError: string | undefined;
    if (acquiredAccountIds.length > 0) {
      try {
        reconciliation = await this.reconciler.reconcile({
          integrationAccountIds: acquiredAccountIds,
          now: new Date(),
        });
      } catch (error) {
        reconciliationError = errorMessage(error);
      }
    }

    const status = summaryStatus(outcomes, reconciliationError);
    return {
      invocationId: request.invocationId,
      trigger: request.trigger,
      status,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      outcomes,
      ...(reconciliation ? { reconciliation } : {}),
      ...(reconciliationError ? { reconciliationError } : {}),
    };
  }

  private async runAccount(
    account: UnifiedSyncAccount,
    request: UnifiedSyncRequest,
  ): Promise<ChannelSyncOutcome> {
    if (!account.syncEnabled || account.status === "disabled") {
      return skippedOutcome(account, "disabled");
    }

    const executor = this.executors.get(account.channel);
    if (!executor) return skippedOutcome(account, "unsupported");

    const timeoutMs = clamp(request.timeoutMs ?? 120_000, 1_000, 240_000);
    const maxAttempts = clamp(request.maxAttempts ?? 3, 1, 5);
    const claim = await this.store.claimRun({
      account,
      resource: executor.resource,
      trigger: request.trigger,
      invocationId: request.invocationId,
      now: new Date(),
      leaseMs: timeoutMs * maxAttempts + 30_000,
    });
    if (!claim.acquired) {
      return {
        ...EMPTY_COUNTS,
        accountId: account.id,
        channel: account.channel,
        displayName: account.displayName,
        status: "skipped",
        reason: claim.reason,
        ...(claim.runId ? { runId: claim.runId } : {}),
        attempts: 0,
      };
    }

    try {
      const executed = await runWithRetry({
        maxAttempts,
        timeoutMs,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(executor.isRetryable
          ? { isRetryable: executor.isRetryable.bind(executor) }
          : {}),
        operation: (signal) =>
          executor.execute({
            account,
            trigger: request.trigger,
            now: new Date(),
            signal,
            ...(request.limit ? { limit: request.limit } : {}),
            ...(request.since ? { since: request.since } : {}),
            ...(request.gmailBackfillDays
              ? { gmailBackfillDays: request.gmailBackfillDays }
              : {}),
          }),
      });
      const result = executed.value;
      await this.store.completeRun({
        runId: claim.runId,
        account,
        resource: executor.resource,
        status: result.status,
        counts: result,
        completedAt: new Date(),
        metadata: {
          attempts: executed.attempts,
          readOnly: true,
          ...(result.metadata ?? {}),
          ...(result.childRunId ? { childRunId: result.childRunId } : {}),
        },
      });
      return {
        ...result,
        accountId: account.id,
        channel: account.channel,
        displayName: account.displayName,
        runId: claim.runId,
        attempts: executed.attempts,
      };
    } catch (error) {
      const normalized = normalizeError(error);
      await this.store.completeRun({
        runId: claim.runId,
        account,
        resource: executor.resource,
        status: "failed",
        counts: { ...EMPTY_COUNTS, failedCount: 1 },
        completedAt: new Date(),
        errorCode: normalized.code,
        errorMessage: normalized.message,
        metadata: { readOnly: true },
      });
      return {
        ...EMPTY_COUNTS,
        failedCount: 1,
        accountId: account.id,
        channel: account.channel,
        displayName: account.displayName,
        status: "failed",
        runId: claim.runId,
        attempts: normalized.attempts,
        errorCode: normalized.code,
        errorMessage: normalized.message,
      };
    }
  }
}

function skippedOutcome(
  account: UnifiedSyncAccount,
  reason: Extract<ChannelSyncOutcome["reason"], "disabled" | "unsupported">,
): ChannelSyncOutcome {
  return {
    ...EMPTY_COUNTS,
    accountId: account.id,
    channel: account.channel,
    displayName: account.displayName,
    status: "skipped",
    reason,
    attempts: 0,
  };
}

function summaryStatus(
  outcomes: readonly ChannelSyncOutcome[],
  reconciliationError: string | undefined,
): UnifiedSyncSummary["status"] {
  if (reconciliationError)
    return outcomes.some((outcome) => outcome.status === "succeeded")
      ? "partial"
      : "failed";
  const attempted = outcomes.filter((outcome) => outcome.status !== "skipped");
  if (attempted.length === 0) return "succeeded";
  if (attempted.every((outcome) => outcome.status === "failed"))
    return "failed";
  return attempted.some(
    (outcome) => outcome.status === "failed" || outcome.status === "partial",
  )
    ? "partial"
    : "succeeded";
}

async function mapWithConcurrency<TInput, TOutput>(
  input: readonly TInput[],
  concurrency: number,
  operation: (value: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const output = new Array<TOutput>(input.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < input.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await operation(input[index]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, input.length) }, () => worker()),
  );
  return output;
}

function normalizeError(error: unknown) {
  const value = error as {
    code?: unknown;
    message?: unknown;
    attempts?: unknown;
  };
  return {
    code:
      typeof value?.code === "string"
        ? value.code.slice(0, 120)
        : "sync_failed",
    message: errorMessage(error).slice(0, 500),
    attempts: typeof value?.attempts === "number" ? value.attempts : 1,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Channel synchronization failed.";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
