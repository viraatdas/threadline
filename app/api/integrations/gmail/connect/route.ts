import { randomBytes } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { EnvironmentCredentialVault } from "@/lib/security/credentials";
import {
  clampBackfillDays,
  GMAIL_OAUTH_STATE_COOKIE,
  GMAIL_OAUTH_STATE_MAX_AGE_SECONDS,
} from "@/src/integrations/gmail/constants";
import {
  createGmailAuthorization,
  gmailRedirectUri,
  sanitizeReturnTo,
} from "@/src/integrations/gmail/oauth";
import {
  getApiOwnerSession,
  parseOptionalNumber,
} from "@/app/api/integrations/gmail/_shared";

export async function GET(request: NextRequest) {
  const session = await getApiOwnerSession();
  const ownerEmail = session?.user?.email;
  if (!ownerEmail)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const backfillDays = clampBackfillDays(
    parseOptionalNumber(request.nextUrl.searchParams.get("backfillDays")),
  );
  const authorization = await createGmailAuthorization({
    vault: new EnvironmentCredentialVault(),
    redirectUri: gmailRedirectUri(request.url),
    ownerEmail,
    nonce: randomBytes(24).toString("base64url"),
    returnTo: sanitizeReturnTo(request.nextUrl.searchParams.get("returnTo")),
    backfillDays,
    now: new Date(),
  });
  const response = NextResponse.redirect(authorization.authorizationUrl);
  response.cookies.set(GMAIL_OAUTH_STATE_COOKIE, authorization.cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/api/integrations/gmail/callback",
    maxAge: GMAIL_OAUTH_STATE_MAX_AGE_SECONDS,
  });
  return response;
}
