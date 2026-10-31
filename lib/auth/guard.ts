import { redirect } from "next/navigation";

import { auth } from "@/lib/auth/auth";
import { isOwnerSession } from "@/lib/auth/owner";

export async function requireOwner() {
  const session = await auth();

  if (!isOwnerSession(session)) {
    redirect("/api/auth/signin?callbackUrl=/");
  }

  return session;
}

// Server actions are public POST endpoints; every one starts here.
export async function assertOwner() {
  const session = await auth();
  if (!isOwnerSession(session)) throw new Error("Unauthorized");
  return session;
}
