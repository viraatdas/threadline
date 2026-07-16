import { and, eq } from "drizzle-orm";

import type { ThreadlineDatabase } from "@/lib/db/client";
import { syncCursors } from "@/lib/db/schema";
import { openCredential, sealCredential } from "@/lib/security/credentials";
import { getEncryptionEnvironment } from "@/lib/security/env";

const RESOURCE = "linkedin:inbox";

export async function loadLinkedinCursor(
  database: ThreadlineDatabase,
  integrationAccountId: string,
) {
  const [cursor] = await database
    .select()
    .from(syncCursors)
    .where(
      and(
        eq(syncCursors.integrationAccountId, integrationAccountId),
        eq(syncCursors.resource, RESOURCE),
      ),
    )
    .limit(1);
  if (!cursor) return undefined;
  return openCredential<string>(
    cursor.cursorCiphertext,
    `linkedin:cursor:${integrationAccountId}`,
    { expectedKeyVersion: cursor.cursorKeyVersion },
  );
}

export async function saveLinkedinCursor(
  database: ThreadlineDatabase,
  integrationAccountId: string,
  cursor: string,
) {
  const keyVersion = getEncryptionEnvironment().INTEGRATION_ENCRYPTION_KEY_VERSION;
  const cursorCiphertext = sealCredential(cursor, `linkedin:cursor:${integrationAccountId}`);
  await database
    .insert(syncCursors)
    .values({
      integrationAccountId,
      resource: RESOURCE,
      cursorCiphertext,
      cursorKeyVersion: keyVersion,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [syncCursors.integrationAccountId, syncCursors.resource],
      set: { cursorCiphertext, cursorKeyVersion: keyVersion, lastSeenAt: new Date(), updatedAt: new Date() },
    });
}
