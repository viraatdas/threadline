import { getDatabase, type ThreadlineDatabase } from "@/lib/db";
import { createDatabaseChannelExecutors } from "@/src/sync/channels";
import { UnifiedSyncOrchestrator } from "@/src/sync/orchestrator";
import {
  PostgresSyncCoordinatorStore,
  PostgresSyncReconciler,
} from "@/src/sync/postgres";
import type { UnifiedSyncRequest } from "@/src/sync/types";

export function createUnifiedSyncOrchestrator(
  database: ThreadlineDatabase = getDatabase(),
) {
  return new UnifiedSyncOrchestrator(
    new PostgresSyncCoordinatorStore(database),
    createDatabaseChannelExecutors(database),
    new PostgresSyncReconciler(database),
  );
}

export function runUnifiedSync(request: UnifiedSyncRequest) {
  return createUnifiedSyncOrchestrator().run(request);
}
