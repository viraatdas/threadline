import { NextResponse } from "next/server";

import { auth, isOwnerSession } from "@/lib/auth";
import { LinkedinClient, LinkedinError, workerConfig } from "@/lib/linkedin";

export const dynamic = "force-dynamic";

// One frame of the worker's sign-in view for Settings (owner only). 204 while
// the page is between loads; 409 once the view has closed.
export async function GET() {
  if (!isOwnerSession(await auth())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const config = workerConfig();
  if (!config) return NextResponse.json({ error: "The browser worker isn't configured." }, { status: 503 });
  try {
    const screen = await new LinkedinClient(config).loginScreen();
    if (!screen) return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
    return new NextResponse(screen.image, {
      headers: { "content-type": "image/jpeg", "cache-control": "no-store, private", "x-page-host": screen.host },
    });
  } catch (error) {
    const status = error instanceof LinkedinError && error.status === 422 ? 409 : 502;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Worker failed." }, { status });
  }
}
