import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth/auth";
import { isOwnerSession } from "@/lib/auth/owner";
import type { ThreadlineDatabase } from "@/lib/db/client";
import { syncRuns } from "@/lib/db/schema";
import { createIdempotencyKey } from "@/lib/security/idempotency";

import { LinkedApiClient } from "@/src/integrations/linkedin/client";
import type { IntegrationAccount } from "@/lib/db/schema";
import { openLinkedinCredentials } from "@/src/integrations/linkedin/account";

export async function getLinkedinApiOwnerSession() {
  const session = await auth();
  return isOwnerSession(session) ? session : null;
}

export function createLinkedApiClient(account: IntegrationAccount) {
  return new LinkedApiClient(openLinkedinCredentials(account), {
    baseUrl: process.env.LINKED_API_BASE_URL,
  });
}

export async function startLinkedinSyncRun(
  database: ThreadlineDatabase,
  integrationAccountId: string,
  requestKey?: string,
) {
  const minuteBucket = new Date();
  minuteBucket.setSeconds(0, 0);
  const idempotencyKey = createIdempotencyKey(
    "linkedin-sync",
    integrationAccountId,
    requestKey ?? minuteBucket.toISOString(),
  );
  const [created] = await database
    .insert(syncRuns)
    .values({
      integrationAccountId,
      idempotencyKey,
      resource: "inbox",
      trigger: "manual",
      status: "running",
      startedAt: new Date(),
      metadata: { provider: "linked-api" },
    })
    .onConflictDoNothing({ target: syncRuns.idempotencyKey })
    .returning();
  if (created) return { run: created, isNew: true };

  const [existing] = await database
    .select()
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.integrationAccountId, integrationAccountId),
        eq(syncRuns.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("LinkedIn sync run could not be created or recovered.");
  return { run: existing, isNew: false };
}
