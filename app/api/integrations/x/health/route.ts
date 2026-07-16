import { NextResponse } from "next/server";

import { resolveXIntegrationAccountId } from "@/app/api/integrations/x/_shared/accounts";
import { auth, isOwnerSession } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
import { checkDatabaseXIntegrationHealth } from "@/src/integrations/x/database";

export async function GET(request: Request) {
  const session = await auth();
  if (!isOwnerSession(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const database = getDatabase();
  try {
    const requestedId =
      new URL(request.url).searchParams.get("integrationAccountId") ??
      undefined;
    const integrationAccountId = await resolveXIntegrationAccountId(
      database,
      requestedId,
    );
    if (!integrationAccountId) {
      return NextResponse.json(
        {
          ok: false,
          error: "X_NOT_CONNECTED",
          detail: "No X integration is connected.",
        },
        { status: 404 },
      );
    }
    const health = await checkDatabaseXIntegrationHealth({
      database,
      integrationAccountId,
    });
    return NextResponse.json(health, { status: health.ok ? 200 : 503 });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: "X_HEALTH_FAILED",
        detail: error instanceof Error ? error.message : undefined,
      },
      { status: 500 },
    );
  }
}
