import { after } from "next/server";

import type { UnifiedSyncSummary } from "@/src/sync/types";

// Safety ceiling on how many times a single trigger may self-chain. Each link
// advances the backfill by one soft-budget window, so this is far above what any
// mailbox needs; it only exists to bound a pathological loop.
const MAX_BACKFILL_CHAIN = 400;
const BACKFILL_QUERY =
  "gmailForceBackfill=1&gmailBackfillDays=3650&channels=gmail";

export function readChainCount(url: URL): number {
  const raw = url.searchParams.get("_chain");
  const value = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function gmailBackfillPending(summary: UnifiedSyncSummary): boolean {
  return summary.outcomes.some(
    (outcome) =>
      outcome.channel === "gmail" &&
      outcome.metadata?.backfillPending === true,
  );
}

// When a backfill run finishes with older mail still to cover, fire the next run
// server-side (authenticated with the cron secret) after the response is sent.
// The chain self-terminates once the backfill reports nothing pending, and the
// daily cron backstops any dropped link. Owner clicks start the chain at 0.
export function continueBackfillIfPending(
  request: Request,
  summary: UnifiedSyncSummary,
  chainCount: number,
): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  if (chainCount >= MAX_BACKFILL_CHAIN) return;
  if (!gmailBackfillPending(summary)) return;

  const origin = new URL(request.url).origin;
  const nextUrl = `${origin}/api/cron/sync?${BACKFILL_QUERY}&_chain=${chainCount + 1}`;

  after(async () => {
    try {
      // A short timeout releases this parent once the request is dispatched; the
      // child invocation runs independently (it ignores the request signal for
      // chained calls, so the parent giving up cannot cancel it).
      await fetch(nextUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      // Expected: the abort above, or a transient dispatch error. The daily
      // cron will resume the backfill from its saved watermark regardless.
    }
  });
}
