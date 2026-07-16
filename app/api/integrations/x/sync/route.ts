import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveXIntegrationAccountId } from "@/app/api/integrations/x/_shared/accounts";
import { auth, isOwnerSession } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
import { XIntegrationError } from "@/src/integrations/x/errors";
import { runDatabaseXSync } from "@/src/integrations/x/database";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  integrationAccountId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  since: z.string().datetime({ offset: true }).optional(),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!isOwnerSession(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof requestSchema>;
  try {
    const raw = await request.text();
    input = requestSchema.parse(raw ? JSON.parse(raw) : {});
  } catch (error) {
    return NextResponse.json(
      {
        error: "Invalid X sync request.",
        detail: error instanceof Error ? error.message : undefined,
      },
      { status: 400 },
    );
  }

  const database = getDatabase();
  try {
    const integrationAccountId = await resolveXIntegrationAccountId(
      database,
      input.integrationAccountId,
    );
    if (!integrationAccountId) {
      return NextResponse.json(
        { error: "No X integration is connected." },
        { status: 404 },
      );
    }
    const summary = await runDatabaseXSync({
      database,
      integrationAccountId,
      trigger: "manual",
      ...(input.limit ? { limit: input.limit } : {}),
      ...(input.since ? { since: new Date(input.since) } : {}),
      signal: request.signal,
    });
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    if (error instanceof XIntegrationError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.code,
          detail: error.message,
          retryable: error.retryable,
        },
        { status: error.code === "X_AUTH_EXPIRED" ? 401 : 502 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: "X_SYNC_FAILED",
        detail: error instanceof Error ? error.message : undefined,
      },
      { status: 500 },
    );
  }
}
