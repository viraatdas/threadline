import { NextRequest, NextResponse } from "next/server";

import { auth, isOwnerSession } from "@/lib/auth";
import { completeAuthorization, GMAIL_STATE_COOKIE, gmailRedirectUri, validateState } from "@/lib/gmail";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!isOwnerSession(session)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const destination = new URL("/settings", request.nextUrl.origin);
  try {
    const state = params.get("state");
    const code = params.get("code");
    if (!state || !code) throw new Error(params.get("error") ?? "Missing OAuth parameters.");
    const parsed = validateState(state, request.cookies.get(GMAIL_STATE_COOKIE)?.value);
    destination.pathname = parsed.returnTo;
    await completeAuthorization(code, gmailRedirectUri(request.url));
    destination.searchParams.set("gmail", "connected");
  } catch (error) {
    destination.searchParams.set("gmail", "error");
    destination.searchParams.set("reason", error instanceof Error ? error.message.slice(0, 120) : "unknown");
  }
  const response = NextResponse.redirect(destination);
  response.cookies.set(GMAIL_STATE_COOKIE, "", { path: "/api/integrations/gmail/callback", maxAge: 0 });
  return response;
}
