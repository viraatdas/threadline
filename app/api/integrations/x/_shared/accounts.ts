import { asc, eq } from "drizzle-orm";

import type { ThreadlineDatabase } from "@/lib/db/client";
import { integrationAccounts } from "@/lib/db/schema";

export async function resolveXIntegrationAccountId(
  database: ThreadlineDatabase,
  requestedId?: string,
) {
  if (requestedId) return requestedId;
  const accounts = await database
    .select({ id: integrationAccounts.id })
    .from(integrationAccounts)
    .where(eq(integrationAccounts.provider, "x"))
    .orderBy(asc(integrationAccounts.createdAt))
    .limit(2);
  if (accounts.length === 0) return undefined;
  if (accounts.length > 1) {
    throw new Error(
      "Multiple X integrations exist; provide integrationAccountId.",
    );
  }
  return accounts[0]!.id;
}
