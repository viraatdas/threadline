import { NextRequest, NextResponse } from "next/server";

import { clampBackfillDays } from "@/src/integrations/gmail/constants";
import { normalizeGmailError } from "@/src/integrations/gmail/errors";
import { syncConnectedGmailAccount } from "@/src/integrations/gmail/runtime";
import { getApiOwnerSession } from "@/app/api/integrations/gmail/_shared";

export async function POST(request: NextRequest) {
  const session = await getApiOwnerSession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request
    .json()
    .catch(() => ({}) as Record<string, unknown>);
  const requestedBackfill =
    typeof body === "object" &&
    body !== null &&
    typeof body.backfillDays === "number"
      ? clampBackfillDays(body.backfillDays)
      : undefined;
  try {
    const result = await syncConnectedGmailAccount({
      trigger: "manual",
      ...(requestedBackfill !== undefined
        ? { backfillDays: requestedBackfill }
        : {}),
      signal: request.signal,
    });
    return NextResponse.json(result);
  } catch (error) {
    const normalized = normalizeGmailError(error);
    return NextResponse.json(
      { error: normalized.code, message: normalized.message },
      {
        status:
          normalized.status === 401
            ? 409
            : normalized.status && normalized.status < 500
              ? normalized.status
              : 503,
      },
    );
  }
}
