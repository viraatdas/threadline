import { z } from "zod";

import type { CredentialVault } from "@/lib/domain/contracts";
import { normalizeEmail } from "@/lib/auth/owner";
import { hashContent } from "@/lib/security/idempotency";
import {
  createOAuth2Client,
  mergeGoogleCredentials,
} from "@/src/integrations/gmail/client";
import {
  GMAIL_OAUTH_STATE_MAX_AGE_SECONDS,
  GMAIL_READONLY_SCOPE,
} from "@/src/integrations/gmail/constants";
import type {
  GmailProfile,
  GmailStoredCredentials,
} from "@/src/integrations/gmail/types";

const STATE_CONTEXT = "oauth:gmail:state";

const gmailOAuthEnvironmentSchema = z.object({
  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),
  GMAIL_OAUTH_REDIRECT_URI: z.string().url().optional(),
});

const oauthStateSchema = z.object({
  nonce: z.string().min(16),
  ownerEmail: z.string().email(),
  returnTo: z.string().startsWith("/").max(500),
  backfillDays: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
});

export type GmailOAuthState = z.infer<typeof oauthStateSchema>;

export function getGmailOAuthEnvironment() {
  return gmailOAuthEnvironmentSchema.parse(process.env);
}

export function gmailRedirectUri(requestUrl: string): string {
  const environment = getGmailOAuthEnvironment();
  return (
    environment.GMAIL_OAUTH_REDIRECT_URI ??
    new URL("/api/integrations/gmail/callback", requestUrl).toString()
  );
}

export async function createGmailAuthorization(input: {
  vault: CredentialVault;
  redirectUri: string;
  ownerEmail: string;
  nonce: string;
  returnTo: string;
  backfillDays: number;
  now: Date;
}): Promise<{ authorizationUrl: string; state: string; cookieValue: string }> {
  const environment = getGmailOAuthEnvironment();
  const state = await input.vault.seal(
    oauthStateSchema.parse({
      nonce: input.nonce,
      ownerEmail: normalizeEmail(input.ownerEmail),
      returnTo: sanitizeReturnTo(input.returnTo),
      backfillDays: input.backfillDays,
      createdAt: input.now.toISOString(),
    }),
    STATE_CONTEXT,
  );
  const oauth2Client = createOAuth2Client({
    clientId: environment.AUTH_GOOGLE_ID,
    clientSecret: environment.AUTH_GOOGLE_SECRET,
    redirectUri: input.redirectUri,
  });
  const authorizationUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: false,
    login_hint: normalizeEmail(input.ownerEmail),
    scope: [GMAIL_READONLY_SCOPE],
    state,
  });
  return { authorizationUrl, state, cookieValue: hashContent(state) };
}

export async function validateGmailOAuthState(input: {
  vault: CredentialVault;
  state: string;
  cookieValue: string | undefined;
  sessionOwnerEmail: string;
  now: Date;
}): Promise<GmailOAuthState> {
  if (!input.cookieValue || hashContent(input.state) !== input.cookieValue) {
    throw new Error("Gmail OAuth state verification failed.");
  }
  const state = oauthStateSchema.parse(
    await input.vault.open(input.state, STATE_CONTEXT),
  );
  if (
    normalizeEmail(state.ownerEmail) !== normalizeEmail(input.sessionOwnerEmail)
  ) {
    throw new Error("Gmail OAuth state belongs to a different owner.");
  }
  const ageSeconds = (input.now.getTime() - Date.parse(state.createdAt)) / 1000;
  if (ageSeconds < 0 || ageSeconds > GMAIL_OAUTH_STATE_MAX_AGE_SECONDS) {
    throw new Error("Gmail OAuth state expired.");
  }
  return state;
}

export async function exchangeGmailAuthorizationCode(input: {
  code: string;
  redirectUri: string;
  existingCredentials?: GmailStoredCredentials;
}): Promise<{
  credentials: GmailStoredCredentials;
  profile: GmailProfile;
  revoke: () => Promise<void>;
}> {
  const environment = getGmailOAuthEnvironment();
  const oauth2Client = createOAuth2Client({
    clientId: environment.AUTH_GOOGLE_ID,
    clientSecret: environment.AUTH_GOOGLE_SECRET,
    redirectUri: input.redirectUri,
  });
  const tokenResponse = await oauth2Client.getToken(input.code);
  const credentials = mergeGoogleCredentials(
    input.existingCredentials,
    tokenResponse.tokens,
  );
  oauth2Client.setCredentials(tokenResponse.tokens);
  const profileResponse = await oauth2Client.request<{
    emailAddress?: string;
    historyId?: string;
    messagesTotal?: number;
    threadsTotal?: number;
  }>({ url: "https://gmail.googleapis.com/gmail/v1/users/me/profile" });
  const emailAddress = profileResponse.data.emailAddress?.trim().toLowerCase();
  const historyId = profileResponse.data.historyId?.trim();
  if (!emailAddress || !historyId)
    throw new Error("Gmail profile omitted required account fields.");
  return {
    credentials,
    profile: {
      emailAddress,
      historyId,
      ...(profileResponse.data.messagesTotal !== undefined
        ? { messagesTotal: profileResponse.data.messagesTotal }
        : {}),
      ...(profileResponse.data.threadsTotal !== undefined
        ? { threadsTotal: profileResponse.data.threadsTotal }
        : {}),
    },
    revoke: async () => {
      const token = credentials.refreshToken ?? credentials.accessToken;
      if (token) await oauth2Client.revokeToken(token);
    },
  };
}

export function assertGmailOwner(
  profileEmail: string,
  ownerEmail: string,
  sessionEmail: string,
): void {
  const profile = normalizeEmail(profileEmail);
  if (
    profile !== normalizeEmail(ownerEmail) ||
    profile !== normalizeEmail(sessionEmail)
  ) {
    throw new Error(
      "The authorized Gmail account does not match the Threadline owner.",
    );
  }
}

export function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value.slice(0, 500);
}
