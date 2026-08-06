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
// A backfill run walks history newest-first and saves a durable watermark after
// EVERY page, so progress survives even on a huge mailbox. The soft budget stops
// the run well under the orchestrator/serverless cap (240s) — checked between
// pages so the run resolves as a partial success instead of being killed
// mid-flight by the hard timer (which would discard the result). The next run (a
// click or the daily cron) resumes from the saved watermark. The margin below
// the cap must exceed the time a single page can take to fetch and persist.
const BACKFILL_SOFT_BUDGET_MS = 120_000;
// Threads per backfill page. Each thread costs a Gmail fetch plus several
// database round trips, ~2s in prod, and the watermark only advances after a
// whole page. 100-thread pages ran ~200s and tripped the orchestrator's 240s
// cap with nothing checkpointed (2026-09-09); 25 keeps every page well inside
// the soft budget so a stop always lands on a durable checkpoint.
const BACKFILL_PAGE_SIZE = 25;

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
    cursorBefore?.historyId ??
      (input.forceBackfill ? "force-backfill" : "initial"),
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
  const mode: GmailSyncResult["mode"] = cursorBefore
    ? "incremental"
    : "initial";

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

// Walks history newest-first in one pass, saving a durable watermark after every
// page so a budget-stopped or killed run resumes cleanly from where it left off.
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
  // A prior run that finished at least this deep means there is nothing left to
  // do — a forced re-run must not restart from "now".
  const alreadyComplete = Boolean(
    priorState?.done &&
    new Date(priorState.targetSince).getTime() <= targetSince.getTime(),
  );
  // Otherwise resume the upper bound from the oldest instant already covered;
  // start at "now" on a fresh backfill. A prior state whose target is shallower
  // than this request still resumes from its watermark and keeps going deeper.
  const coverEnd =
    !alreadyComplete &&
    priorState &&
    new Date(priorState.oldestCoveredAt).getTime() < input.now.getTime()
      ? new Date(priorState.oldestCoveredAt)
      : input.now;
  let pendingHistoryId = priorState?.pendingHistoryId;

  // Gmail returns threads ordered by their most-recent message, descending. The
  // safe resume boundary is therefore the minimum, across processed threads, of
  // each thread's newest-message time: everything newer than that is covered.
  let watermark = coverEnd;
  let done = alreadyComplete || coverEnd.getTime() <= targetSince.getTime();
  let budgetHit = false;

  if (!done) {
    try {
      for await (const page of input.connector.pull(
        {
          integrationAccountId: input.account.id,
          now: input.now,
          ...(input.signal ? { signal: input.signal } : {}),
        },
        {
          resource: GMAIL_CURSOR_RESOURCE,
          since: targetSince,
          until: coverEnd,
          limit: BACKFILL_PAGE_SIZE,
        },
      )) {
        if (page.cursor && !pendingHistoryId) pendingHistoryId = page.cursor;
        for (const conversation of page.conversations) {
          input.counts.discoveredCount += 1;
          const newestAt = conversation.messages.reduce(
            (newest, message) => Math.max(newest, Date.parse(message.sentAt)),
            0,
          );
          if (newestAt > 0 && newestAt < watermark.getTime())
            watermark = new Date(newestAt);
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
        // Checkpoint after every page so progress is durable even if the run is
        // killed before the next page.
        await input.store.saveBackfillState(input.account, {
          oldestCoveredAt: watermark.toISOString(),
          targetSince: targetSince.toISOString(),
          ...(pendingHistoryId ? { pendingHistoryId } : {}),
          done: false,
          updatedAt: input.now.toISOString(),
        });
        if (
          input.signal?.aborted ||
          Date.now() - startedAtMs > BACKFILL_SOFT_BUDGET_MS
        ) {
          budgetHit = true;
          break;
        }
      }
      // The pull ran to completion without stopping for the budget → the whole
      // window down to targetSince is covered.
      if (!budgetHit) done = true;
    } catch (error) {
      // A parent abort (hit the run cap) leaves the last checkpoint intact and
      // stops cleanly. Any other error is real and should fail the run.
      if (input.signal?.aborted) budgetHit = true;
      else throw error;
    }
  }

  const finalWatermark = done ? targetSince : watermark;
  await input.store.saveBackfillState(input.account, {
    oldestCoveredAt: finalWatermark.toISOString(),
    targetSince: targetSince.toISOString(),
    ...(pendingHistoryId ? { pendingHistoryId } : {}),
    done,
    updatedAt: input.now.toISOString(),
  });

  const resolvedCursor: GmailSyncCursor = {
    historyId: pendingHistoryId ?? "0",
    mailboxEmail: input.account.accountEmail,
    updatedAt: input.now.toISOString(),
  };
  // A completed backfill keeps its entry-point name (initial/recovery); one that
  // still has older mail to cover reports "backfill" so callers know to run
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
      oldestCoveredAt: finalWatermark.toISOString(),
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
