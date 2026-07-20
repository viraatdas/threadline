import { createIdempotencyKey } from "@/lib/security/idempotency";
import {
  GMAIL_CURSOR_RESOURCE,
  clampBackfillDays,
} from "@/src/integrations/gmail/constants";
import { GmailConnector } from "@/src/integrations/gmail/connector";
import {
  GmailAuthorizationError,
  GmailHistoryExpiredError,
  normalizeGmailError,
} from "@/src/integrations/gmail/errors";
import type {
  GmailApi,
  GmailIntegrationAccountRecord,
  GmailSyncCounts,
  GmailSyncCursor,
  GmailSyncResult,
  GmailSyncStore,
} from "@/src/integrations/gmail/types";

const DAY_MS = 24 * 60 * 60 * 1000;
// One backfill run walks history in bounded date windows, newest-first, saving
// a watermark after each. Windows are small so a single one finishes quickly;
// the soft budget stops the run well before the serverless/orchestrator cap
// (240s) so the run returns a partial success instead of being killed mid-flight
// — the next run (a click or the daily cron) resumes from the saved watermark.
const BACKFILL_WINDOW_MS = 30 * DAY_MS;
const BACKFILL_SOFT_BUDGET_MS = 150_000;

interface RunGmailSyncInput {
  account: GmailIntegrationAccountRecord;
  api: GmailApi;
  store: GmailSyncStore;
  ownerEmail: string;
  trigger?: "manual" | "scheduled" | "webhook" | "backfill";
  backfillDays?: number;
  forceBackfill?: boolean;
  now?: Date;
  signal?: AbortSignal;
}

export async function runGmailSync(
  input: RunGmailSyncInput,
): Promise<GmailSyncResult> {
  const now = input.now ?? new Date();
  const trigger = input.trigger ?? "scheduled";
  const backfillDays = clampBackfillDays(
    input.backfillDays ?? metadataBackfillDays(input.account.metadata),
  );
  const storedCursor = await input.store.getCursor(input.account);
  // A forced backfill ignores the stored history cursor so the connector
  // re-pulls the full `backfillDays` window instead of only incremental
  // History API changes. The fresh cursor is still saved afterwards.
  const cursorBefore = input.forceBackfill ? null : storedCursor;
  const runKey = createIdempotencyKey(
    "gmail-sync",
    input.account.id,
    cursorBefore?.historyId ?? (input.forceBackfill ? "force-backfill" : "initial"),
    trigger,
    backfillDays,
  );
  const run = await input.store.startSyncRun({
    account: input.account,
    idempotencyKey: runKey,
    trigger: cursorBefore ? trigger : "backfill",
    cursorBefore,
    now,
  });
  const counts = emptyCounts();
  const connector = new GmailConnector({
    api: input.api,
    ownerEmail: input.ownerEmail,
  });
  let cursorAfter: GmailSyncCursor | null = null;
  const mode: GmailSyncResult["mode"] = cursorBefore ? "incremental" : "initial";

  try {
    // No incremental cursor → walk history in resumable windows. This covers
    // the first-ever sync, a forced backfill, and the recovery below.
    if (!cursorBefore) {
      return await runWindowedBackfill({
        connector,
        account: input.account,
        store: input.store,
        runId: run.id,
        backfillDays,
        now,
        counts,
        recovered: false,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }

    try {
      cursorAfter = await consumeConnector({
        connector,
        account: input.account,
        store: input.store,
        cursor: cursorBefore,
        backfillDays,
        now,
        counts,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (!(error instanceof GmailHistoryExpiredError)) throw error;
      // The stored history cursor aged out; recover by re-walking as a
      // resumable windowed backfill instead of one unbounded pass.
      return await runWindowedBackfill({
        connector,
        account: input.account,
        store: input.store,
        runId: run.id,
        backfillDays,
        now,
        counts,
        recovered: true,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }

    if (!cursorAfter)
      throw new Error(
        "Gmail synchronization completed without a history cursor.",
      );
    await input.store.saveCursor(input.account, cursorAfter);
    await input.store.markConnected(input.account.id, now);
    await input.store.completeSyncRun({
      runId: run.id,
      status: "succeeded",
      cursorAfter,
      counts,
      completedAt: now,
      metadata: { mode, recoveredHistoryCursor: false },
    });
    return { ...counts, mode, cursor: cursorAfter, runId: run.id };
  } catch (error) {
    const normalized = normalizeGmailError(error);
    if (normalized instanceof GmailAuthorizationError) {
      await input.store.markAttentionRequired(
        input.account.id,
        normalized.code,
        normalized.message,
        now,
      );
    }
    await input.store.completeSyncRun({
      runId: run.id,
      status: "failed",
      cursorAfter: cursorBefore,
      counts: { ...counts, failedCount: counts.failedCount + 1 },
      completedAt: now,
      errorCode: normalized.code,
      errorMessage: normalized.message,
      metadata: { mode },
    });
    throw normalized;
  }
}

async function consumeConnector(input: {
  connector: GmailConnector;
  account: GmailIntegrationAccountRecord;
  store: GmailSyncStore;
  cursor: GmailSyncCursor | null;
  backfillDays: number;
  now: Date;
  counts: GmailSyncCounts;
  signal?: AbortSignal;
}): Promise<GmailSyncCursor | null> {
  let latestHistoryId: string | undefined;
  const since = input.cursor
    ? undefined
    : new Date(input.now.getTime() - input.backfillDays * 24 * 60 * 60 * 1000);
  for await (const page of input.connector.pull(
    {
      integrationAccountId: input.account.id,
      now: input.now,
      ...(input.signal ? { signal: input.signal } : {}),
    },
    {
      resource: GMAIL_CURSOR_RESOURCE,
      ...(input.cursor ? { cursor: input.cursor.historyId } : {}),
      ...(since ? { since } : {}),
      limit: 100,
    },
  )) {
    if (page.cursor) latestHistoryId = page.cursor;
    for (const conversation of page.conversations) {
      input.counts.discoveredCount += 1;
      const result = await input.store.persistConversation(
        input.account,
        conversation,
        input.now,
      );
      if (!result.changed) {
        input.counts.skippedCount += 1;
        continue;
      }
      input.counts.insertedCount += result.insertedMessages;
      input.counts.updatedCount += result.updatedMessages;
      if (result.analysisEnqueued) input.counts.analysisEnqueuedCount += 1;
    }
  }
  return latestHistoryId
    ? {
        historyId: latestHistoryId,
        mailboxEmail: input.account.accountEmail,
        updatedAt: input.now.toISOString(),
      }
    : null;
}

// Walks history in bounded, newest-first date windows, persisting a durable
// watermark after each so a killed or budget-stopped run resumes cleanly.
async function runWindowedBackfill(input: {
  connector: GmailConnector;
  account: GmailIntegrationAccountRecord;
  store: GmailSyncStore;
  runId: string;
  backfillDays: number;
  now: Date;
  counts: GmailSyncCounts;
  recovered: boolean;
  signal?: AbortSignal;
}): Promise<GmailSyncResult> {
  const startedAtMs = Date.now();
  const targetSince = new Date(
    input.now.getTime() - input.backfillDays * DAY_MS,
  );
  const priorState = await input.store.getBackfillState(input.account);
  // Resume from the oldest instant already covered; otherwise start at "now".
  // A prior state whose target is shallower than this request still resumes
  // from its watermark and simply keeps going deeper.
  let coverEnd =
    priorState && new Date(priorState.oldestCoveredAt).getTime() < input.now.getTime()
      ? new Date(priorState.oldestCoveredAt)
      : input.now;
  let pendingHistoryId = priorState?.pendingHistoryId;
  let done = coverEnd.getTime() <= targetSince.getTime();

  while (!done && coverEnd.getTime() > targetSince.getTime()) {
    if (input.signal?.aborted) break;
    if (Date.now() - startedAtMs > BACKFILL_SOFT_BUDGET_MS) break;

    const windowStart = new Date(
      Math.max(targetSince.getTime(), coverEnd.getTime() - BACKFILL_WINDOW_MS),
    );

    let windowCompleted = true;
    try {
      for await (const page of input.connector.pull(
        {
          integrationAccountId: input.account.id,
          now: input.now,
          ...(input.signal ? { signal: input.signal } : {}),
        },
        {
          resource: GMAIL_CURSOR_RESOURCE,
          since: windowStart,
          until: coverEnd,
          limit: 100,
        },
      )) {
        if (page.cursor && !pendingHistoryId) pendingHistoryId = page.cursor;
        for (const conversation of page.conversations) {
          input.counts.discoveredCount += 1;
          const result = await input.store.persistConversation(
            input.account,
            conversation,
            input.now,
          );
          if (!result.changed) {
            input.counts.skippedCount += 1;
            continue;
          }
          input.counts.insertedCount += result.insertedMessages;
          input.counts.updatedCount += result.updatedMessages;
          if (result.analysisEnqueued) input.counts.analysisEnqueuedCount += 1;
        }
      }
    } catch (error) {
      // If the parent aborted (hit the run cap), stop cleanly without
      // advancing the watermark past this incomplete window. Any other error
      // is real and should fail the run.
      if (input.signal?.aborted) windowCompleted = false;
      else throw error;
    }

    if (!windowCompleted) break;

    coverEnd = windowStart;
    done = coverEnd.getTime() <= targetSince.getTime();
    await input.store.saveBackfillState(input.account, {
      oldestCoveredAt: coverEnd.toISOString(),
      targetSince: targetSince.toISOString(),
      ...(pendingHistoryId ? { pendingHistoryId } : {}),
      done,
      updatedAt: input.now.toISOString(),
    });
  }

  const resolvedCursor: GmailSyncCursor = {
    historyId: pendingHistoryId ?? "0",
    mailboxEmail: input.account.accountEmail,
    updatedAt: input.now.toISOString(),
  };
  // A completed backfill keeps its entry-point name (initial/recovery); one that
  // still has older windows to cover reports "backfill" so callers know to run
  // again.
  const mode: GmailSyncResult["mode"] = done
    ? input.recovered
      ? "recovery"
      : "initial"
    : "backfill";

  // Promote the mailbox snapshot to the incremental cursor only once the whole
  // window is covered, so unfinished backfills keep resuming (no cursor → the
  // daily cron continues the windows) and a finished one flips to incremental,
  // replaying anything that arrived while the backfill was running.
  if (done && pendingHistoryId) {
    await input.store.saveCursor(input.account, resolvedCursor);
  }
  await input.store.markConnected(input.account.id, input.now);
  await input.store.completeSyncRun({
    runId: input.runId,
    status: done ? "succeeded" : "partial",
    cursorAfter: done && pendingHistoryId ? resolvedCursor : null,
    counts: input.counts,
    completedAt: input.now,
    metadata: {
      mode,
      recoveredHistoryCursor: input.recovered,
      backfillPending: !done,
      oldestCoveredAt: coverEnd.toISOString(),
    },
  });
  return {
    ...input.counts,
    mode,
    cursor: resolvedCursor,
    runId: input.runId,
    backfillPending: !done,
  };
}

function metadataBackfillDays(
  metadata: Record<string, unknown>,
): number | undefined {
  const value = metadata.backfillDays;
  return typeof value === "number" ? value : undefined;
}

function emptyCounts(): GmailSyncCounts {
  return {
    discoveredCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    analysisEnqueuedCount: 0,
  };
}
