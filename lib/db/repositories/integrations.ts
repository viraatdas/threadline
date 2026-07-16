import { and, asc, eq } from "drizzle-orm";

import type { ThreadlineDatabase } from "@/lib/db/client";
import {
  integrationAccounts,
  type NewIntegrationAccount,
  syncCursors,
  type NewSyncCursor,
} from "@/lib/db/schema";

export function createIntegrationRepository(database: ThreadlineDatabase) {
  return {
    list() {
      return database.select().from(integrationAccounts).orderBy(asc(integrationAccounts.provider));
    },

    async findByProviderAccount(provider: NewIntegrationAccount["provider"], externalAccountId: string) {
      const [account] = await database
        .select()
        .from(integrationAccounts)
        .where(
          and(
            eq(integrationAccounts.provider, provider),
            eq(integrationAccounts.externalAccountId, externalAccountId),
          ),
        )
        .limit(1);

      return account ?? null;
    },

    async upsert(input: NewIntegrationAccount) {
      const [account] = await database
        .insert(integrationAccounts)
        .values(input)
        .onConflictDoUpdate({
          target: [integrationAccounts.provider, integrationAccounts.externalAccountId],
          set: {
            displayName: input.displayName,
            accountEmail: input.accountEmail,
            status: input.status,
            syncEnabled: input.syncEnabled,
            scopes: input.scopes,
            credentialCiphertext: input.credentialCiphertext,
            credentialKeyVersion: input.credentialKeyVersion,
            metadata: input.metadata,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!account) throw new Error("Integration account upsert did not return a row.");
      return account;
    },

    async getCursor(integrationAccountId: string, resource: string) {
      const [cursor] = await database
        .select()
        .from(syncCursors)
        .where(
          and(
            eq(syncCursors.integrationAccountId, integrationAccountId),
            eq(syncCursors.resource, resource),
          ),
        )
        .limit(1);

      return cursor ?? null;
    },

    async upsertCursor(input: NewSyncCursor) {
      const [cursor] = await database
        .insert(syncCursors)
        .values(input)
        .onConflictDoUpdate({
          target: [syncCursors.integrationAccountId, syncCursors.resource],
          set: {
            cursorCiphertext: input.cursorCiphertext,
            cursorKeyVersion: input.cursorKeyVersion,
            lastSeenExternalId: input.lastSeenExternalId,
            lastSeenAt: input.lastSeenAt,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!cursor) throw new Error("Sync cursor upsert did not return a row.");
      return cursor;
    },
  };
}
