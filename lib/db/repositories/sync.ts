import { eq } from "drizzle-orm";

import type { ThreadlineDatabase } from "@/lib/db/client";
import { syncRuns, type NewSyncRun, type SyncRun } from "@/lib/db/schema";

type SyncRunCompletion = Pick<
  SyncRun,
  | "status"
  | "completedAt"
  | "cursorAfterCiphertext"
  | "discoveredCount"
  | "insertedCount"
  | "updatedCount"
  | "skippedCount"
  | "failedCount"
  | "errorCode"
  | "errorMessage"
  | "metadata"
>;

export function createSyncRepository(database: ThreadlineDatabase) {
  return {
    async start(input: NewSyncRun) {
      const [run] = await database
        .insert(syncRuns)
        .values({ ...input, status: "running", startedAt: input.startedAt ?? new Date() })
        .onConflictDoNothing({ target: syncRuns.idempotencyKey })
        .returning();

      if (run) return run;

      const [existing] = await database
        .select()
        .from(syncRuns)
        .where(eq(syncRuns.idempotencyKey, input.idempotencyKey))
        .limit(1);

      if (!existing) throw new Error("Sync run could not be created or recovered.");
      return existing;
    },

    async complete(id: string, completion: SyncRunCompletion) {
      const [run] = await database
        .update(syncRuns)
        .set({ ...completion, updatedAt: new Date() })
        .where(eq(syncRuns.id, id))
        .returning();

      if (!run) throw new Error(`Sync run ${id} was not found.`);
      return run;
    },
  };
}
