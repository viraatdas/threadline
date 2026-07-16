import type { ConnectorContext, PullRequest } from "@/lib/domain/contracts";
import type { SyncPage } from "@/lib/domain/schemas";

import { LinkedinConnector } from "@/src/integrations/linkedin/connector";

export interface LinkedinIngestionStats {
  discovered: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  analysisJobsEnqueued: number;
  cursor?: string | undefined;
}

export interface LinkedinIngestionSink {
  ingest(page: SyncPage): Promise<Omit<LinkedinIngestionStats, "cursor">>;
}

export async function syncLinkedin(input: {
  connector: LinkedinConnector;
  sink: LinkedinIngestionSink;
  context: ConnectorContext;
  request: PullRequest;
}): Promise<LinkedinIngestionStats> {
  const totals: LinkedinIngestionStats = {
    discovered: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    analysisJobsEnqueued: 0,
  };

  for await (const page of input.connector.pull(input.context, input.request)) {
    const result = await input.sink.ingest(page);
    totals.discovered += result.discovered;
    totals.inserted += result.inserted;
    totals.updated += result.updated;
    totals.skipped += result.skipped;
    totals.failed += result.failed;
    totals.analysisJobsEnqueued += result.analysisJobsEnqueued;
    totals.cursor = page.cursor;
  }

  return totals;
}
