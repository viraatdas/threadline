import { NextResponse } from "next/server";

import {
  createGmailStore,
  revokeGmailCredentials,
} from "@/src/integrations/gmail/runtime";
import { getApiOwnerSession } from "@/app/api/integrations/gmail/_shared";

export async function POST() {
  const session = await getApiOwnerSession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const store = createGmailStore();
  const account = await store.getAccount();
  if (!account) return NextResponse.json({ connected: false });
  if (account.status !== "disabled") {
    const credentials = await store.getCredentials(account);
    await revokeGmailCredentials(credentials).catch(() => undefined);
    await store.disableAccount(account, new Date());
  }
  return NextResponse.json({ connected: false, status: "disabled" });
}
