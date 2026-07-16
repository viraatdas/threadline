import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getDatabase, integrationAccounts, syncRuns } from "@/lib/db";
import { findLinkedinAccount } from "@/src/integrations/linkedin/account";
import { LinkedinConnector } from "@/src/integrations/linkedin/connector";
import {
  loadLinkedinCursor,
  saveLinkedinCursor,
} from "@/src/integrations/linkedin/cursor";
import { DatabaseLinkedinIngestionSink } from "@/src/integrations/linkedin/persistence";
import { syncLinkedin } from "@/src/integrations/linkedin/sync";
import { DatabaseWorkflowRegistry, LinkedinWorkflowCoordinator } from "@/src/integrations/linkedin/workflow";

import {
  createLinkedApiClient,
  getLinkedinApiOwnerSession,
  startLinkedinSyncRun,
} from "@/app/api/integrations/linkedin/_shared";

export const runtime = "nodejs";

const requestSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
});

export async function POST(request: Request) {
  if (!(await getLinkedinApiOwnerSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid sync request." }, { status: 400 });

  const database = getDatabase();
  const account = await findLinkedinAccount(database);
  if (!account || !account.syncEnabled) {
    return NextResponse.json({ error: "LinkedIn is not connected." }, { status: 409 });
  }
  if (account.status === "attention_required" || account.status === "disabled") {
    return NextResponse.json({ error: "LinkedIn connection requires attention." }, { status: 409 });
  }

  const client = createLinkedApiClient(account);
  const workflowCoordinator = new LinkedinWorkflowCoordinator(
    client,
    new DatabaseWorkflowRegistry(database, account.id),
  );
  if (account.status === "pending") {
    const setup = await workflowCoordinator.runOnce<void>({
      key: "sync-inbox",
      operationName: "syncInbox",
      start: () => client.startSyncInbox(request.signal),
      signal: request.signal,
    });
    if (setup.status !== "completed") {
      return NextResponse.json(
        { status: setup.status, workflowId: setup.workflowId, operationName: setup.operationName },
        { status: 202 },
      );
    }
    await database
      .update(integrationAccounts)
      .set({ status: "connected", connectedAt: new Date(), updatedAt: new Date() })
      .where(eq(integrationAccounts.id, account.id));
  }

  const started = await startLinkedinSyncRun(
    database,
    account.id,
    request.headers.get("x-threadline-idempotency-key") ?? undefined,
  );
  if (!started.isNew) {
    return NextResponse.json(
      { duplicate: true, runId: started.run.id, status: started.run.status },
      { status: started.run.status === "running" ? 202 : 200 },
    );
  }

  try {
    const connector = new LinkedinConnector(client, {
      ownerExternalId: account.externalAccountId,
      workflowCoordinator,
    });
    const cursor = await loadLinkedinCursor(database, account.id);
    const stats = await syncLinkedin({
      connector,
      sink: new DatabaseLinkedinIngestionSink(database),
      context: { integrationAccountId: account.id, now: new Date(), signal: request.signal },
      request: {
        resource: "inbox",
        ...(cursor ? { cursor } : {}),
        ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
      },
    });
    if (stats.cursor) await saveLinkedinCursor(database, account.id, stats.cursor);
    const status = stats.failed > 0 ? "partial" : "succeeded";
    await database
      .update(syncRuns)
      .set({
        status,
        completedAt: new Date(),
        discoveredCount: stats.discovered,
        insertedCount: stats.inserted,
        updatedCount: stats.updated,
        skippedCount: stats.skipped,
        failedCount: stats.failed,
        metadata: { analysisJobsEnqueued: stats.analysisJobsEnqueued },
        updatedAt: new Date(),
      })
      .where(eq(syncRuns.id, started.run.id));
    const completedAt = new Date();
    await database
      .update(integrationAccounts)
      .set({
        status: stats.failed > 0 ? "attention_required" : "connected",
        lastSyncedAt: completedAt,
        lastErrorAt: stats.failed > 0 ? completedAt : null,
        lastErrorCode: stats.failed > 0 ? "linkedin_ingestion_partial" : null,
        lastErrorMessage:
          stats.failed > 0
            ? "One or more LinkedIn conversations failed ingestion."
            : null,
        updatedAt: completedAt,
      })
      .where(eq(integrationAccounts.id, account.id));
    return NextResponse.json({ runId: started.run.id, status, ...stats });
  } catch (error) {
    const failedAt = new Date();
    await database
      .update(syncRuns)
      .set({
        status: "failed",
        completedAt: failedAt,
        failedCount: 1,
        errorCode: "linkedin_sync_failed",
        errorMessage: error instanceof Error ? error.message : "LinkedIn sync failed.",
        updatedAt: failedAt,
      })
      .where(eq(syncRuns.id, started.run.id));
    await database
      .update(integrationAccounts)
      .set({
        status: "attention_required",
        lastErrorAt: failedAt,
        lastErrorCode: "linkedin_sync_failed",
        lastErrorMessage: "LinkedIn sync failed.",
        updatedAt: failedAt,
      })
      .where(eq(integrationAccounts.id, account.id));
    return NextResponse.json({ error: "LinkedIn sync failed.", runId: started.run.id }, { status: 502 });
  }
}
