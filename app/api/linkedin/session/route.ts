import { NextResponse } from "next/server";
import { z } from "zod";

import { hasBearer } from "@/lib/auth/machine";
import { browserCookiesSchema, LinkedinClient, LinkedinError, workerConfig } from "@/lib/linkedin";

export const maxDuration = 120;

// `pnpm linkedin-login` posts the owner's LinkedIn cookies here (IMPORT_TOKEN);
// they are passed straight to the browser worker, which keeps the session.
// Nothing is stored or logged on this side.
export async function POST(request: Request) {
  if (!hasBearer(request, process.env.IMPORT_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const config = workerConfig();
  if (!config) return NextResponse.json({ error: "BROWSER_WORKER_URL/TOKEN aren't set." }, { status: 503 });
  const parsed = z.object({ cookies: browserCookiesSchema }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Expected { cookies: [...] }." }, { status: 400 });
  try {
    return NextResponse.json(await new LinkedinClient(config).importSession(parsed.data.cookies));
  } catch (error) {
    const status = error instanceof LinkedinError && error.status === 422 ? 422 : 502;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Worker failed." }, { status });
  }
}
