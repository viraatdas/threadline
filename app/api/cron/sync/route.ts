import { NextResponse } from "next/server";

import { boundedInvocationId, isAuthorizedCronRequest } from "@/src/sync/auth";
import {
  continueBackfillIfPending,
  readChainCount,
} from "@/src/sync/continuation";
import {
  normalizeRequestedChannels,
  unifiedSyncInputSchema,
} from "@/src/sync/request";
import { runUnifiedSync } from "@/src/sync/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  return handleScheduledSync(request, {});
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  return handleScheduledSync(request, body);
}

async function handleScheduledSync(request: Request, body: unknown) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const queryChannels = url.searchParams
    .get("channels")
    ?.split(",")
    .map((channel) => channel.trim())
    .filter(Boolean);
  const queryBackfillDaysRaw = url.searchParams.get("gmailBackfillDays");
  const queryBackfillDays = queryBackfillDaysRaw
    ? Number.parseInt(queryBackfillDaysRaw, 10)
    : undefined;
  const queryForceBackfill = ["1", "true", "yes"].includes(
    (url.searchParams.get("gmailForceBackfill") ?? "").toLowerCase(),
  );
  const parsed = unifiedSyncInputSchema.safeParse({
    ...(typeof body === "object" && body !== null ? body : {}),
    ...(queryChannels?.length ? { channels: queryChannels } : {}),
    ...(queryBackfillDays !== undefined && Number.isFinite(queryBackfillDays)
      ? { gmailBackfillDays: queryBackfillDays }
      : {}),
    ...(queryForceBackfill ? { gmailForceBackfill: true } : {}),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid scheduled sync request.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const now = new Date();
  const minuteBucket = new Date(now);
  minuteBucket.setUTCSeconds(0, 0);
  const invocationId = boundedInvocationId(
    request.headers.get("x-threadline-idempotency-key") ??
      request.headers.get("x-vercel-id"),
    `scheduled:${minuteBucket.toISOString()}`,
  );
  const channels = normalizeRequestedChannels(parsed.data.channels);
  // A self-chained link runs detached: the parent that dispatched it gives up
  // its connection after a few seconds, so honoring the request signal would
  // abort the run. The scheduled (chain 0) invocation keeps the platform signal.
  const chainCount = readChainCount(url);
  const summary = await runUnifiedSync({
    trigger: "scheduled",
    invocationId,
    ...(chainCount === 0 ? { signal: request.signal } : {}),
    maxConcurrency: 3,
    maxAttempts: 2,
    timeoutMs: 270_000,
    ...(channels ? { channels } : {}),
    ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.since ? { since: new Date(parsed.data.since) } : {}),
    ...(parsed.data.gmailBackfillDays
      ? { gmailBackfillDays: parsed.data.gmailBackfillDays }
      : {}),
    ...(parsed.data.gmailForceBackfill ? { gmailForceBackfill: true } : {}),
  });
  const ok = summary.status !== "failed";
  // Counts/status only — never message content. Lets operators verify a run.
  console.log(`[threadline-sync] scheduled ${JSON.stringify(summary)}`);
  continueBackfillIfPending(request, summary, chainCount);
  return NextResponse.json({ ok, summary }, { status: ok ? 200 : 502 });
}
