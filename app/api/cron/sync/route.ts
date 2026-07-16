import { NextResponse } from "next/server";

import { boundedInvocationId, isAuthorizedCronRequest } from "@/src/sync/auth";
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
  const parsed = unifiedSyncInputSchema.safeParse({
    ...(typeof body === "object" && body !== null ? body : {}),
    ...(queryChannels?.length ? { channels: queryChannels } : {}),
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
  const summary = await runUnifiedSync({
    trigger: "scheduled",
    invocationId,
    signal: request.signal,
    maxConcurrency: 3,
    maxAttempts: 2,
    timeoutMs: 120_000,
    ...(channels ? { channels } : {}),
    ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.since ? { since: new Date(parsed.data.since) } : {}),
    ...(parsed.data.gmailBackfillDays
      ? { gmailBackfillDays: parsed.data.gmailBackfillDays }
      : {}),
  });
  const ok = summary.status !== "failed";
  return NextResponse.json({ ok, summary }, { status: ok ? 200 : 502 });
}
