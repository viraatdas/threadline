import { NextResponse } from "next/server";

import { hasBearer } from "@/lib/auth/machine";
import { refresh } from "@/lib/engine";

export const maxDuration = 300;

// Daily (vercel.json): confirm queued LinkedIn sends, detect replies/bounces,
// and draft follow-ups that came due. Never sends anything by itself.
export async function GET(request: Request) {
  if (!hasBearer(request, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const summary = await refresh({ inboxWaitMs: 120_000 });
  console.info("cron refresh", {
    replies: summary.replies,
    drafted: summary.drafted,
    closed: summary.closed,
    problems: summary.problems.length,
  });
  return NextResponse.json({ ok: true, ...summary, problems: summary.problems.length });
}
