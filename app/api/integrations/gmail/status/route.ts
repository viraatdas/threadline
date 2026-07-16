import { NextResponse } from "next/server";

import { createGmailStore } from "@/src/integrations/gmail/runtime";
import { getApiOwnerSession } from "@/app/api/integrations/gmail/_shared";

export async function GET() {
  const session = await getApiOwnerSession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const account = await createGmailStore().getAccount();
  if (!account)
    return NextResponse.json({ connected: false, status: "pending" });
  return NextResponse.json({
    connected: account.status === "connected" && account.syncEnabled,
    status: account.status,
    accountEmail: account.accountEmail,
    scopes: account.scopes,
    backfillDays: account.metadata.backfillDays ?? null,
    connectedAt: account.connectedAt?.toISOString() ?? null,
    lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
    lastErrorAt: account.lastErrorAt?.toISOString() ?? null,
    lastErrorCode: account.lastErrorCode,
    lastErrorMessage: account.lastErrorMessage,
  });
}
