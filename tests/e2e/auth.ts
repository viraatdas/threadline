import type { BrowserContext } from "@playwright/test";
import { encode } from "next-auth/jwt";

export const E2E_OWNER_EMAIL = "owner@threadline.test";
export const E2E_AUTH_SECRET = "threadline-e2e-auth-secret-2026-07-16";
export const E2E_GOOGLE_ID = "threadline-e2e-google-id";
export const E2E_GOOGLE_SECRET = "threadline-e2e-google-secret";

const SESSION_COOKIE = "authjs.session-token";

export async function installOwnerSession(
  context: BrowserContext,
  baseURL: string,
) {
  const token = await encode({
    salt: SESSION_COOKIE,
    secret: E2E_AUTH_SECRET,
    token: {
      sub: "threadline-e2e-owner",
      name: "Threadline Owner",
      email: E2E_OWNER_EMAIL,
    },
  });

  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ]);
}
