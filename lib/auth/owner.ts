import type { Session } from "next-auth";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isOwnerEmail(email: string | null | undefined, ownerEmail = process.env.OWNER_EMAIL) {
  if (!email || !ownerEmail) return false;
  return normalizeEmail(email) === normalizeEmail(ownerEmail);
}

export function isOwnerSession(session: Session | null): session is Session {
  return isOwnerEmail(session?.user?.email);
}
