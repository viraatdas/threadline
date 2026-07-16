import { getDatabase } from "@/lib/db/client";
import { EnvironmentCredentialVault } from "@/lib/security/credentials";
import {
  getAuthEnvironment,
  getEncryptionEnvironment,
} from "@/lib/security/env";
import {
  GoogleGmailApi,
  createOAuth2Client,
} from "@/src/integrations/gmail/client";
import { getGmailOAuthEnvironment } from "@/src/integrations/gmail/oauth";
import { PostgresGmailStore } from "@/src/integrations/gmail/store";
import { runGmailSync } from "@/src/integrations/gmail/sync";
import type {
  GmailIntegrationAccountRecord,
  GmailStoredCredentials,
} from "@/src/integrations/gmail/types";

export function createGmailStore(): PostgresGmailStore {
  const encryption = getEncryptionEnvironment();
  return new PostgresGmailStore(
    getDatabase(),
    new EnvironmentCredentialVault(),
    encryption.INTEGRATION_ENCRYPTION_KEY_VERSION,
  );
}

export async function syncConnectedGmailAccount(input: {
  account?: GmailIntegrationAccountRecord;
  trigger?: "manual" | "scheduled" | "webhook" | "backfill";
  backfillDays?: number;
  signal?: AbortSignal;
}) {
  const store = createGmailStore();
  const account = input.account ?? (await store.getAccount());
  if (!account || !account.syncEnabled || account.status === "disabled") {
    throw new Error("Gmail is not connected for synchronization.");
  }
  const credentials = await store.getCredentials(account);
  const oauthEnvironment = getGmailOAuthEnvironment();
  const oauth2Client = createOAuth2Client({
    clientId: oauthEnvironment.AUTH_GOOGLE_ID,
    clientSecret: oauthEnvironment.AUTH_GOOGLE_SECRET,
    redirectUri:
      oauthEnvironment.GMAIL_OAUTH_REDIRECT_URI ??
      "https://localhost.invalid/api/integrations/gmail/callback",
  });
  const api = new GoogleGmailApi({
    oauth2Client,
    credentials,
    onCredentials: (updated) => store.updateCredentials(account, updated),
  });
  return runGmailSync({
    account,
    api,
    store,
    ownerEmail: getAuthEnvironment().OWNER_EMAIL,
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.backfillDays !== undefined
      ? { backfillDays: input.backfillDays }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export async function revokeGmailCredentials(
  credentials: GmailStoredCredentials,
): Promise<void> {
  const token = credentials.refreshToken ?? credentials.accessToken;
  if (!token) return;
  const environment = getGmailOAuthEnvironment();
  const oauth2Client = createOAuth2Client({
    clientId: environment.AUTH_GOOGLE_ID,
    clientSecret: environment.AUTH_GOOGLE_SECRET,
    redirectUri:
      environment.GMAIL_OAUTH_REDIRECT_URI ??
      "https://localhost.invalid/api/integrations/gmail/callback",
  });
  await oauth2Client.revokeToken(token);
}
