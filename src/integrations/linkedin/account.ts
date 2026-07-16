import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { ThreadlineDatabase } from "@/lib/db/client";
import { integrationAccounts, type IntegrationAccount } from "@/lib/db/schema";
import { openCredential, sealCredential } from "@/lib/security/credentials";
import { getEncryptionEnvironment } from "@/lib/security/env";
import { hashContent } from "@/lib/security/idempotency";
import { READ_ONLY_CAPABILITIES } from "@/lib/security/read-only";

import {
  LINKEDIN_RISK_NOTICE,
  linkedinCredentialsSchema,
  type LinkedinCredentials,
} from "@/src/integrations/linkedin/types";

export const linkedinConnectionInputSchema = linkedinCredentialsSchema.extend({
  displayName: z.string().trim().min(1).max(255).optional(),
  accountEmail: z.string().email().optional(),
});

export type LinkedinConnectionInput = z.infer<typeof linkedinConnectionInputSchema>;

export async function findLinkedinAccount(database: ThreadlineDatabase) {
  const [account] = await database
    .select()
    .from(integrationAccounts)
    .where(eq(integrationAccounts.provider, "linkedin"))
    .orderBy(desc(integrationAccounts.updatedAt))
    .limit(1);
  return account ?? null;
}

export async function upsertLinkedinAccount(
  database: ThreadlineDatabase,
  input: LinkedinConnectionInput,
  status: "pending" | "connected" | "attention_required",
) {
  const credentials = linkedinCredentialsSchema.parse(input);
  const externalAccountId = `linkedapi:${hashContent(credentials.identificationToken).slice(0, 24)}`;
  const context = credentialContext(externalAccountId);
  const credentialCiphertext = sealCredential(credentials, context);
  const keyVersion = getEncryptionEnvironment().INTEGRATION_ENCRYPTION_KEY_VERSION;
  const [account] = await database
    .insert(integrationAccounts)
    .values({
      provider: "linkedin",
      externalAccountId,
      displayName: input.displayName ?? "LinkedIn via Linked API",
      accountEmail: input.accountEmail,
      status,
      syncEnabled: true,
      readOnly: true,
      scopes: ["inbox.read", "conversations.read", "profiles.read", "companies.read"],
      credentialCiphertext,
      credentialKeyVersion: keyVersion,
      connectedAt: status === "connected" ? new Date() : undefined,
      metadata: {
        provider: "Linked API",
        unofficial: true,
        unaffiliatedWithLinkedin: true,
        riskNotice: LINKEDIN_RISK_NOTICE,
        profileEnrichment: "disabled_to_prevent_profile_view_side_effects",
        capabilities: READ_ONLY_CAPABILITIES,
      },
    })
    .onConflictDoUpdate({
      target: [integrationAccounts.provider, integrationAccounts.externalAccountId],
      set: {
        displayName: input.displayName ?? "LinkedIn via Linked API",
        accountEmail: input.accountEmail,
        status,
        syncEnabled: true,
        readOnly: true,
        scopes: ["inbox.read", "conversations.read", "profiles.read", "companies.read"],
        credentialCiphertext,
        credentialKeyVersion: keyVersion,
        connectedAt: status === "connected" ? new Date() : undefined,
        lastErrorAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        metadata: {
          provider: "Linked API",
          unofficial: true,
          unaffiliatedWithLinkedin: true,
          riskNotice: LINKEDIN_RISK_NOTICE,
          profileEnrichment: "disabled_to_prevent_profile_view_side_effects",
          capabilities: READ_ONLY_CAPABILITIES,
        },
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!account) throw new Error("LinkedIn integration account upsert returned no row.");
  return account;
}

export function openLinkedinCredentials(account: IntegrationAccount): LinkedinCredentials {
  return linkedinCredentialsSchema.parse(
    openCredential<LinkedinCredentials>(
      account.credentialCiphertext,
      credentialContext(account.externalAccountId),
      { expectedKeyVersion: account.credentialKeyVersion },
    ),
  );
}

export function safeLinkedinStatus(account: IntegrationAccount | null) {
  return {
    connected: account?.status === "connected",
    status: account?.status ?? "disabled",
    displayName: account?.displayName,
    accountEmail: account?.accountEmail,
    syncEnabled: account?.syncEnabled ?? false,
    lastSyncedAt: account?.lastSyncedAt?.toISOString(),
    lastErrorAt: account?.lastErrorAt?.toISOString(),
    lastErrorCode: account?.lastErrorCode,
    lastErrorMessage: account?.lastErrorMessage,
    provider: "Linked API",
    unofficial: true,
    readOnly: true,
    riskNotice: LINKEDIN_RISK_NOTICE,
    profileEnrichment: "disabled_to_prevent_profile_view_side_effects",
    capabilities: READ_ONLY_CAPABILITIES,
  };
}

function credentialContext(externalAccountId: string) {
  return `linkedin:credentials:${externalAccountId}`;
}
