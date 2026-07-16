import type { ChannelConnector } from "@/lib/domain/contracts";
import type { SyncPage } from "@/lib/domain/schemas";
import { toXIntegrationError } from "@/src/integrations/x/errors";
import { X_DM_RESOURCE } from "@/src/integrations/x/types";

export interface XPageApplyResult {
  discoveredCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  analysisEnqueuedCount: number;
}

export interface XSyncStore {
  loadCursor(
    integrationAccountId: string,
    resource: string,
  ): Promise<string | undefined>;
  applyPage(page: SyncPage): Promise<XPageApplyResult>;
  saveCursor(options: {
    integrationAccountId: string;
    resource: string;
    cursor: string;
    lastSeenExternalId?: string;
    lastSeenAt?: Date;
  }): Promise<void>;
}

export interface XSyncSummary extends XPageApplyResult {
  pages: number;
  cursorBefore?: string;
  cursorAfter?: string;
}

function emptySummary(cursorBefore?: string): XSyncSummary {
  return {
    pages: 0,
    discoveredCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    analysisEnqueuedCount: 0,
    ...(cursorBefore ? { cursorBefore } : {}),
  };
}

export async function syncXDirectMessages(options: {
  connector: ChannelConnector;
  store: XSyncStore;
  integrationAccountId: string;
  now: Date;
  limit?: number;
  since?: Date;
  signal?: AbortSignal;
}): Promise<XSyncSummary> {
  const cursorBefore = await options.store.loadCursor(
    options.integrationAccountId,
    X_DM_RESOURCE,
  );
  const summary = emptySummary(cursorBefore);

  try {
    for await (const page of options.connector.pull(
      {
        integrationAccountId: options.integrationAccountId,
        now: options.now,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      {
        resource: X_DM_RESOURCE,
        ...(cursorBefore ? { cursor: cursorBefore } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
        ...(options.since ? { since: options.since } : {}),
      },
    )) {
      const applied = await options.store.applyPage(page);
      summary.pages += 1;
      summary.discoveredCount += applied.discoveredCount;
      summary.insertedCount += applied.insertedCount;
      summary.updatedCount += applied.updatedCount;
      summary.skippedCount += applied.skippedCount;
      summary.analysisEnqueuedCount += applied.analysisEnqueuedCount;

      if (page.cursor) {
        const latestMessage = page.conversations
          .flatMap((conversation) => conversation.messages)
          .sort((left, right) => right.sentAt.localeCompare(left.sentAt))[0];
        await options.store.saveCursor({
          integrationAccountId: options.integrationAccountId,
          resource: X_DM_RESOURCE,
          cursor: page.cursor,
          ...(latestMessage
            ? { lastSeenExternalId: latestMessage.externalMessageId }
            : {}),
          ...(latestMessage
            ? { lastSeenAt: new Date(latestMessage.sentAt) }
            : {}),
        });
        summary.cursorAfter = page.cursor;
      }
    }
    return summary;
  } catch (error) {
    throw toXIntegrationError(error);
  }
}
