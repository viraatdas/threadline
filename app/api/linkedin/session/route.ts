import { NextResponse } from "next/server";
import { z } from "zod";

import { hasBearer } from "@/lib/auth/machine";
import { LinkedinClient, LinkedinError, workerConfig } from "@/lib/linkedin";

export const maxDuration = 120;

const cookieSchema = z.object({
  name: z.string().min(1).max(200),
  value: z.string().max(8192),
  domain: z.string().max(253).optional(),
  hostOnly: z.boolean().optional(),
  path: z.string().max(1024).optional(),
  expires: z.number().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  sameSite: z.string().max(10).optional(),
});

// `pnpm linkedin-login` posts the owner's LinkedIn cookies here (IMPORT_TOKEN);
// they are passed straight to the browser worker, which keeps the session.
// Nothing is stored or logged on this side.
export async function POST(request: Request) {
  if (!hasBearer(request, process.env.IMPORT_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const config = workerConfig();
  if (!config) return NextResponse.json({ error: "BROWSER_WORKER_URL/TOKEN aren't set." }, { status: 503 });
  const parsed = z
    .object({ cookies: z.array(cookieSchema).min(1).max(300) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Expected { cookies: [...] }." }, { status: 400 });
  const linkedin = parsed.data.cookies.filter((cookie) => /(^|\.)linkedin\.com$/i.test((cookie.domain ?? "").replace(/^\./, "")));
  try {
    return NextResponse.json(await new LinkedinClient(config).importSession(linkedin));
  } catch (error) {
    const status = error instanceof LinkedinError && error.status === 422 ? 422 : 502;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Worker failed." }, { status });
  }
}
