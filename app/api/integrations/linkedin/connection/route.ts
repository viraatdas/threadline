import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getDatabase, integrationAccounts } from "@/lib/db";
import {
  findLinkedinAccount,
  linkedinConnectionInputSchema,
  safeLinkedinStatus,
  upsertLinkedinAccount,
} from "@/src/integrations/linkedin/account";
import { LinkedApiClient } from "@/src/integrations/linkedin/client";
import { LINKEDIN_RISK_NOTICE } from "@/src/integrations/linkedin/types";
import {
  DatabaseWorkflowRegistry,
  LinkedinWorkflowCoordinator,
} from "@/src/integrations/linkedin/workflow";
import { getLinkedinApiOwnerSession } from "@/app/api/integrations/linkedin/_shared";

export const runtime = "nodejs";

export async function GET() {
  if (!(await getLinkedinApiOwnerSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const account = await findLinkedinAccount(getDatabase());
  return NextResponse.json(safeLinkedinStatus(account));
}

export async function POST(request: Request) {
  if (!(await getLinkedinApiOwnerSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = linkedinConnectionInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid Linked API connection details." }, { status: 400 });
  }

  const database = getDatabase();
  const client = new LinkedApiClient(parsed.data, { baseUrl: process.env.LINKED_API_BASE_URL });
  const connection = await client.checkConnection(request.signal);
  if (!connection.ok) {
    return NextResponse.json(
      { error: connection.detail, riskNotice: LINKEDIN_RISK_NOTICE },
      { status: 401 },
    );
  }

  const account = await upsertLinkedinAccount(
    database,
    parsed.data,
    connection.state === "connected" ? "connected" : "pending",
  );
  let workflow;
  if (connection.state === "setup_required") {
    const coordinator = new LinkedinWorkflowCoordinator(
      client,
      new DatabaseWorkflowRegistry(database, account.id),
      { maxPolls: 1, maxElapsedMs: 8_000 },
    );
    workflow = await coordinator.runOnce<void>({
      key: "sync-inbox",
      operationName: "syncInbox",
      start: () => client.startSyncInbox(request.signal),
      signal: request.signal,
    });
    await database
      .update(integrationAccounts)
      .set({
        status: workflow.status === "completed" ? "connected" : "pending",
        connectedAt: workflow.status === "completed" ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .where(eq(integrationAccounts.id, account.id));
  }

  const refreshed = await findLinkedinAccount(database);
  return NextResponse.json(
    {
      ...safeLinkedinStatus(refreshed),
      workflow:
        workflow?.status === "completed"
          ? { status: "completed", operationName: workflow.operationName }
          : workflow,
    },
    { status: 201 },
  );
}
