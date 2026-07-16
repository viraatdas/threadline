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

interface RunGmailSyncInput {
  account: GmailIntegrationAccountRecord;
  api: GmailApi;
  store: GmailSyncStore;
  ownerEmail: string;
  trigger?: "manual" | "scheduled" | "webhook" | "backfill";
  backfillDays?: number;
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
  const cursorBefore = await input.store.getCursor(input.account);
  const runKey = createIdempotencyKey(
    "gmail-sync",
    input.account.id,
    cursorBefore?.historyId ?? "initial",
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
  let mode: GmailSyncResult["mode"] = cursorBefore ? "incremental" : "initial";

  try {
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
      if (!(error instanceof GmailHistoryExpiredError) || !cursorBefore)
        throw error;
      mode = "recovery";
      cursorAfter = await consumeConnector({
        connector,
        account: input.account,
        store: input.store,
        cursor: null,
        backfillDays,
        now,
        counts,
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
      metadata: { mode, recoveredHistoryCursor: mode === "recovery" },
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
