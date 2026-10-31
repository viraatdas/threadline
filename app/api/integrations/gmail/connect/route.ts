import { NextRequest, NextResponse } from "next/server";

import { auth, isOwnerSession } from "@/lib/auth";
import { createAuthorization, GMAIL_STATE_COOKIE, gmailRedirectUri } from "@/lib/gmail";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!isOwnerSession(session)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { url, nonce } = createAuthorization({
    redirectUri: gmailRedirectUri(request.url),
    returnTo: request.nextUrl.searchParams.get("returnTo") ?? "/settings",
    ...(session.user?.email ? { loginHint: session.user.email } : {}),
  });
  const response = NextResponse.redirect(url);
  response.cookies.set(GMAIL_STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/api/integrations/gmail/callback",
    maxAge: 600,
  });
  return response;
}
