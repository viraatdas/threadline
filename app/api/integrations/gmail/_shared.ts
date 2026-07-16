import { auth } from "@/lib/auth/auth";
import { isOwnerSession } from "@/lib/auth/owner";

export async function getApiOwnerSession() {
  const session = await auth();
  return isOwnerSession(session) ? session : null;
}

export function parseOptionalNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
