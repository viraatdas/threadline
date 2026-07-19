import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { auth, isOwnerSession } from "@/lib/auth";
import { boundedInvocationId } from "@/src/sync/auth";
import {
  normalizeRequestedChannels,
  unifiedSyncInputSchema,
} from "@/src/sync/request";
import { runUnifiedSync } from "@/src/sync/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

type SyncInput = z.infer<typeof unifiedSyncInputSchema>;

async function executeOwnerSync(request: Request, data: SyncInput) {
  const invocationId = boundedInvocationId(
    request.headers.get("x-threadline-idempotency-key"),
    randomUUID(),
  );
  const channels = normalizeRequestedChannels(data.channels);
  const summary = await runUnifiedSync({
    trigger: "manual",
    invocationId,
    signal: request.signal,
    maxConcurrency: 3,
    maxAttempts: 2,
    timeoutMs: 270_000,
    ...(channels ? { channels } : {}),
    ...(data.limit ? { limit: data.limit } : {}),
    ...(data.since ? { since: new Date(data.since) } : {}),
    ...(data.gmailBackfillDays
      ? { gmailBackfillDays: data.gmailBackfillDays }
      : {}),
    ...(data.gmailForceBackfill ? { gmailForceBackfill: true } : {}),
  });
  const ok = summary.status !== "failed";
  console.log(`[threadline-sync] manual ${JSON.stringify(summary)}`);
  return NextResponse.json({ ok, summary }, { status: ok ? 200 : 502 });
}

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
  return executeOwnerSync(request, parsed.data);
}

// Owner-triggerable via a plain browser link, e.g.
// /api/sync?gmailForceBackfill=1&gmailBackfillDays=3650&channels=gmail
// Read-only ingestion only; owner-session gated like POST.
export async function GET(request: Request) {
  const session = await auth();
  if (!isOwnerSession(session)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const channels = url.searchParams
    .get("channels")
    ?.split(",")
    .map((channel) => channel.trim())
    .filter(Boolean);
  const backfillRaw = url.searchParams.get("gmailBackfillDays");
  const backfillDays = backfillRaw ? Number.parseInt(backfillRaw, 10) : undefined;
  const force = ["1", "true", "yes"].includes(
    (url.searchParams.get("gmailForceBackfill") ?? "").toLowerCase(),
  );
  const parsed = unifiedSyncInputSchema.safeParse({
    ...(channels?.length ? { channels } : {}),
    ...(backfillDays !== undefined && Number.isFinite(backfillDays)
      ? { gmailBackfillDays: backfillDays }
      : {}),
    ...(force ? { gmailForceBackfill: true } : {}),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid unified sync request.", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  return executeOwnerSync(request, parsed.data);
}
