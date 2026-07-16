import { NextResponse } from "next/server";

import { getDatabase } from "@/lib/db";
import {
  findLinkedinAccount,
  safeLinkedinStatus,
} from "@/src/integrations/linkedin/account";
import { getLinkedinApiOwnerSession } from "@/app/api/integrations/linkedin/_shared";

export const runtime = "nodejs";

export async function GET() {
  if (!(await getLinkedinApiOwnerSession())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(safeLinkedinStatus(await findLinkedinAccount(getDatabase())));
}
