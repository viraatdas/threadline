import { NextResponse } from "next/server";

import { hasBearer } from "@/lib/auth/machine";
import { findResultSchema, ingest } from "@/lib/ingest";

export const maxDuration = 120;

// Lets the local CLI (`pnpm scout yc …`, `pnpm scout github`) push what it found
// with the owner's own YC / GitHub logins, which never leave their machine.
export async function POST(request: Request) {
  if (!hasBearer(request, process.env.IMPORT_TOKEN, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = findResultSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }
  const summary = await ingest(parsed.data);
  return NextResponse.json({ ok: true, ...summary, companyIds: undefined });
}
