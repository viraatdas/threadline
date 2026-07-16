import { NextRequest, NextResponse } from "next/server";

import { EnvironmentCredentialVault } from "@/lib/security/credentials";
import { getAuthEnvironment } from "@/lib/security/env";
import { GMAIL_OAUTH_STATE_COOKIE } from "@/src/integrations/gmail/constants";
import {
  assertGmailOwner,
  exchangeGmailAuthorizationCode,
  gmailRedirectUri,
  validateGmailOAuthState,
} from "@/src/integrations/gmail/oauth";
import {
  createGmailStore,
  syncConnectedGmailAccount,
} from "@/src/integrations/gmail/runtime";
import { getApiOwnerSession } from "@/app/api/integrations/gmail/_shared";

export async function GET(request: NextRequest) {
  const session = await getApiOwnerSession();
  const sessionEmail = session?.user?.email;
  if (!sessionEmail)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const stateValue = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  if (!stateValue || !code) {
    return NextResponse.json(
      { error: "Missing Gmail OAuth callback parameters." },
      { status: 400 },
    );
  }

  const vault = new EnvironmentCredentialVault();
  const state = await validateGmailOAuthState({
    vault,
    state: stateValue,
    cookieValue: request.cookies.get(GMAIL_OAUTH_STATE_COOKIE)?.value,
    sessionOwnerEmail: sessionEmail,
    now: new Date(),
  });
  const store = createGmailStore();
  const existing = await store.getAccountByEmail(state.ownerEmail);
  const existingCredentials = existing
    ? await store.getCredentials(existing)
    : undefined;
  const authorization = await exchangeGmailAuthorizationCode({
    code,
    redirectUri: gmailRedirectUri(request.url),
    ...(existingCredentials ? { existingCredentials } : {}),
  });

  try {
    assertGmailOwner(
      authorization.profile.emailAddress,
      getAuthEnvironment().OWNER_EMAIL,
      sessionEmail,
    );
  } catch (error) {
    await authorization.revoke().catch(() => undefined);
    throw error;
  }

  const account = await store.saveConnectedAccount({
    email: authorization.profile.emailAddress,
    credentials: authorization.credentials,
    backfillDays: state.backfillDays,
    now: new Date(),
  });
  let syncStatus = "succeeded";
  try {
    await syncConnectedGmailAccount({
      account,
      trigger: "backfill",
      backfillDays: state.backfillDays,
    });
  } catch {
    syncStatus = "failed";
  }
  const destination = new URL(state.returnTo, request.nextUrl.origin);
  destination.searchParams.set("gmail", "connected");
  destination.searchParams.set("sync", syncStatus);
  const response = NextResponse.redirect(destination);
  response.cookies.set(GMAIL_OAUTH_STATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/api/integrations/gmail/callback",
    maxAge: 0,
  });
  return response;
}
