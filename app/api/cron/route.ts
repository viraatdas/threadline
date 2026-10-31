import { NextResponse } from "next/server";

import { hasBearer } from "@/lib/auth/machine";
import { refresh } from "@/lib/engine";

export const maxDuration = 300;

// Hourly (Fly scheduled machine threadline-hourly-sync) and daily (vercel.json):
// confirm queued LinkedIn sends, detect replies/bounces, read the LinkedIn
// inbox when due, draft follow-ups that came due, and keep the CRM filled
// (fillPipeline). Never sends or enrolls anything.
export async function GET(request: Request) {
  if (!hasBearer(request, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const summary = await refresh({ inboxWaitMs: 120_000, fill: true });
  console.info("cron refresh", {
    replies: summary.replies,
    drafted: summary.drafted,
    closed: summary.closed,
    filled: summary.filled,
    problems: summary.problems.length,
  });
  return NextResponse.json({ ok: true, ...summary, problems: summary.problems.length });
}
