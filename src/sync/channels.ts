import { and, eq } from "drizzle-orm";

import type { ThreadlineDatabase } from "@/lib/db/client";
import { integrationAccounts, type IntegrationAccount } from "@/lib/db/schema";
import { consumeCheckpointedPages } from "@/src/sync/checkpoint";
import type {
  ChannelSyncContext,
  ChannelSyncResult,
  SyncChannelExecutor,
} from "@/src/sync/types";
import { GMAIL_CURSOR_RESOURCE } from "@/src/integrations/gmail/constants";
import { isRetryableGmailError } from "@/src/integrations/gmail/errors";
import { syncConnectedGmailAccount } from "@/src/integrations/gmail/runtime";
import type { GmailIntegrationAccountRecord } from "@/src/integrations/gmail/types";
import { openLinkedinCredentials } from "@/src/integrations/linkedin/account";
import {
  LinkedApiClient,
  LinkedApiError,
} from "@/src/integrations/linkedin/client";
import { LinkedinConnector } from "@/src/integrations/linkedin/connector";
import {
  loadLinkedinCursor,
  saveLinkedinCursor,
} from "@/src/integrations/linkedin/cursor";
import { DatabaseLinkedinIngestionSink } from "@/src/integrations/linkedin/persistence";
import type { LinkedinIngestionStats } from "@/src/integrations/linkedin/sync";
import {
  DatabaseWorkflowRegistry,
  LinkedinWorkflowCoordinator,
} from "@/src/integrations/linkedin/workflow";
import { runDatabaseXSync } from "@/src/integrations/x/database";
import { XIntegrationError } from "@/src/integrations/x/errors";
import { X_DM_RESOURCE } from "@/src/integrations/x/types";

export const LINKEDIN_SYNC_RESOURCE = "linkedin:inbox";

export function createDatabaseChannelExecutors(
  database: ThreadlineDatabase,
): SyncChannelExecutor[] {
  return [
    new GmailSyncExecutor(database),
    new LinkedinSyncExecutor(database),
    new XSyncExecutor(database),
  ];
}

class GmailSyncExecutor implements SyncChannelExecutor {
  readonly channel = "gmail" as const;
  readonly resource = GMAIL_CURSOR_RESOURCE;

  constructor(private readonly database: ThreadlineDatabase) {}

  async execute(context: ChannelSyncContext): Promise<ChannelSyncResult> {
    const account = await requireAccount(
      this.database,
      context.account.id,
      "gmail",
    );
    const result = await syncConnectedGmailAccount({
      account: gmailAccount(account),
      trigger: context.trigger,
      ...(context.gmailBackfillDays !== undefined
        ? { backfillDays: context.gmailBackfillDays }
        : {}),
      signal: context.signal,
    });
    return {
      status: result.failedCount > 0 ? "partial" : "succeeded",
      discoveredCount: result.discoveredCount,
      insertedCount: result.insertedCount,
      updatedCount: result.updatedCount,
      skippedCount: result.skippedCount,
      failedCount: result.failedCount,
      analysisEnqueuedCount: result.analysisEnqueuedCount,
      childRunId: result.runId,
      metadata: { mode: result.mode },
    };
  }

  isRetryable(error: unknown): boolean {
    return isRetryableGmailError(error);
  }
}

class LinkedinSyncExecutor implements SyncChannelExecutor {
  readonly channel = "linkedin" as const;
  readonly resource = LINKEDIN_SYNC_RESOURCE;

  constructor(private readonly database: ThreadlineDatabase) {}

  async execute(context: ChannelSyncContext): Promise<ChannelSyncResult> {
    const account = await requireAccount(
      this.database,
      context.account.id,
      "linkedin",
    );
    const client = new LinkedApiClient(openLinkedinCredentials(account), {
      baseUrl: process.env.LINKED_API_BASE_URL,
    });
    const workflowCoordinator = new LinkedinWorkflowCoordinator(
      client,
      new DatabaseWorkflowRegistry(this.database, account.id),
    );

    try {
      if (account.status === "pending") {
        const setup = await workflowCoordinator.runOnce<void>({
          key: "sync-inbox",
          operationName: "syncInbox",
          start: () => client.startSyncInbox(context.signal),
          signal: context.signal,
        });
        if (setup.status !== "completed") {
          return {
            status: "partial",
            discoveredCount: 0,
            insertedCount: 0,
            updatedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            analysisEnqueuedCount: 0,
            metadata: {
              setupStatus: setup.status,
              workflowId: setup.workflowId,
              operationName: setup.operationName,
            },
          };
        }
      }

      const cursor = await loadLinkedinCursor(this.database, account.id);
      const connector = new LinkedinConnector(client, {
        ownerExternalId: account.externalAccountId,
        workflowCoordinator,
      });
      const sink = new DatabaseLinkedinIngestionSink(this.database);
      const consumed = await consumeCheckpointedPages({
        pages: connector.pull(
          {
            integrationAccountId: account.id,
            now: context.now,
            signal: context.signal,
          },
          {
            resource: "inbox",
            ...(cursor ? { cursor } : {}),
            ...(context.limit ? { limit: context.limit } : {}),
            ...(context.since ? { since: context.since } : {}),
          },
        ),
        apply: (page) => sink.ingest(page),
        cursor: (page) => page.cursor,
        failed: (result) => result.failed,
        checkpoint: (nextCursor) =>
          saveLinkedinCursor(this.database, account.id, nextCursor),
        initial: emptyLinkedinStats(),
        accumulate: addLinkedinStats,
      });
      await this.database
        .update(integrationAccounts)
        .set({
          status:
            consumed.total.failed > 0 ? "attention_required" : "connected",
          connectedAt: account.connectedAt ?? context.now,
          lastSyncedAt: context.now,
          lastErrorAt: consumed.total.failed > 0 ? context.now : null,
          lastErrorCode:
            consumed.total.failed > 0 ? "linkedin_ingestion_partial" : null,
          lastErrorMessage:
            consumed.total.failed > 0
              ? "One or more LinkedIn conversations failed ingestion."
              : null,
          updatedAt: context.now,
        })
        .where(eq(integrationAccounts.id, account.id));
      return {
        status: consumed.total.failed > 0 ? "partial" : "succeeded",
        discoveredCount: consumed.total.discovered,
        insertedCount: consumed.total.inserted,
        updatedCount: consumed.total.updated,
        skippedCount: consumed.total.skipped,
        failedCount: consumed.total.failed,
        analysisEnqueuedCount: consumed.total.analysisJobsEnqueued,
        metadata: {
          ...(consumed.cursor ? { cursorCheckpointed: true } : {}),
          readOnly: true,
        },
      };
    } catch (error) {
      await this.database
        .update(integrationAccounts)
        .set({
          status: "attention_required",
          lastErrorAt: new Date(),
          lastErrorCode: errorCode(error, "linkedin_sync_failed"),
          lastErrorMessage: errorMessage(error).slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(integrationAccounts.id, account.id));
      throw error;
    }
  }

  isRetryable(error: unknown): boolean {
    return (
      error instanceof LinkedApiError &&
      (error.status === 429 ||
        (error.status !== undefined && error.status >= 500))
    );
  }
}

class XSyncExecutor implements SyncChannelExecutor {
  readonly channel = "x" as const;
  readonly resource = X_DM_RESOURCE;

  constructor(private readonly database: ThreadlineDatabase) {}

  async execute(context: ChannelSyncContext): Promise<ChannelSyncResult> {
    const result = await runDatabaseXSync({
      database: this.database,
      integrationAccountId: context.account.id,
      trigger: context.trigger,
      now: context.now,
      ...(context.limit ? { limit: context.limit } : {}),
      ...(context.since ? { since: context.since } : {}),
      signal: context.signal,
    });
    return {
      status: "succeeded",
      discoveredCount: result.discoveredCount,
      insertedCount: result.insertedCount,
      updatedCount: result.updatedCount,
      skippedCount: result.skippedCount,
      failedCount: 0,
      analysisEnqueuedCount: result.analysisEnqueuedCount,
      childRunId: result.runId,
      metadata: { pages: result.pages },
    };
  }

  isRetryable(error: unknown): boolean {
    return error instanceof XIntegrationError && error.retryable;
  }
}

async function requireAccount(
  database: ThreadlineDatabase,
  accountId: string,
  provider: "gmail" | "linkedin",
) {
  const [account] = await database
    .select()
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.id, accountId),
        eq(integrationAccounts.provider, provider),
      ),
    )
    .limit(1);
  if (!account)
    throw new Error(
      `${provider} integration account ${accountId} was not found.`,
    );
  return account;
}

function gmailAccount(
  account: IntegrationAccount,
): GmailIntegrationAccountRecord {
  if (!account.accountEmail)
    throw new Error("Gmail integration account is missing its mailbox email.");
  return {
    id: account.id,
    externalAccountId: account.externalAccountId,
    displayName: account.displayName,
    accountEmail: account.accountEmail,
    status: account.status,
    syncEnabled: account.syncEnabled,
    scopes: account.scopes,
    credentialCiphertext: account.credentialCiphertext,
    credentialKeyVersion: account.credentialKeyVersion,
    connectedAt: account.connectedAt,
    lastSyncedAt: account.lastSyncedAt,
    lastErrorAt: account.lastErrorAt,
    lastErrorCode: account.lastErrorCode,
    lastErrorMessage: account.lastErrorMessage,
    metadata: account.metadata,
  };
}

function emptyLinkedinStats(): Omit<LinkedinIngestionStats, "cursor"> {
  return {
    discovered: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    analysisJobsEnqueued: 0,
  };
}

function addLinkedinStats(
  left: Omit<LinkedinIngestionStats, "cursor">,
  right: Omit<LinkedinIngestionStats, "cursor">,
) {
  return {
    discovered: left.discovered + right.discovered,
    inserted: left.inserted + right.inserted,
    updated: left.updated + right.updated,
    skipped: left.skipped + right.skipped,
    failed: left.failed + right.failed,
    analysisJobsEnqueued:
      left.analysisJobsEnqueued + right.analysisJobsEnqueued,
  };
}

function errorCode(error: unknown, fallback: string): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "LinkedIn synchronization failed.";
}
