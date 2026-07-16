import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { auth, isOwnerSession } from "@/lib/auth";
import { boundedInvocationId } from "@/src/sync/auth";
import {
  normalizeRequestedChannels,
  unifiedSyncInputSchema,
} from "@/src/sync/request";
import { runUnifiedSync } from "@/src/sync/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const session = await auth();
  if (!isOwnerSession(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = unifiedSyncInputSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid unified sync request.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const invocationId = boundedInvocationId(
    request.headers.get("x-threadline-idempotency-key"),
    randomUUID(),
  );
  const channels = normalizeRequestedChannels(parsed.data.channels);
  const summary = await runUnifiedSync({
    trigger: "manual",
    invocationId,
    signal: request.signal,
    ...(channels ? { channels } : {}),
    ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.since ? { since: new Date(parsed.data.since) } : {}),
    ...(parsed.data.gmailBackfillDays
      ? { gmailBackfillDays: parsed.data.gmailBackfillDays }
      : {}),
  });
  return NextResponse.json({ ok: summary.status !== "failed", summary });
}
