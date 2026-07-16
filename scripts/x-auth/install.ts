#!/usr/bin/env node
import "dotenv/config";

import type { CookieSource } from "@jtsang/bird";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/lib/db/schema";
import { getDatabaseEnvironment } from "@/lib/security/env";
import { installXIntegrationAccount } from "@/src/integrations/x/database";

type Options = {
  cookieSources: CookieSource[];
  chromeProfile?: string;
  edgeProfile?: string;
  firefoxProfile?: string;
  cookieTimeoutMs?: number;
};

function usage() {
  return [
    "Usage: pnpm tsx scripts/x-auth/install.ts [options]",
    "",
    "Options:",
    "  --cookie-source <chrome|safari|edge|firefox>  Repeat to set lookup order",
    "  --chrome-profile <name-or-path>               Chrome profile name or Chromium profile directory",
    "  --chrome-profile-dir <path>                   Alias for --chrome-profile; useful for Arc/Brave",
    "  --edge-profile <name-or-path>                 Edge profile name or directory",
    "  --firefox-profile <name>                      Firefox profile name",
    "  --cookie-timeout <ms>                         Browser/keychain timeout",
    "  --help                                        Show this help",
    "",
    "AUTH_TOKEN and CT0 environment variables are also accepted. Token values are never printed.",
  ].join("\n");
}

function parseArgs(argv: string[]): Options {
  const options: Options = { cookieSources: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }
    if (argument === "--cookie-source") {
      if (
        !(["chrome", "safari", "edge", "firefox"] as const).includes(
          value as CookieSource,
        )
      ) {
        throw new Error(`Unsupported cookie source: ${value}.`);
      }
      options.cookieSources.push(value as CookieSource);
    } else if (
      argument === "--chrome-profile" ||
      argument === "--chrome-profile-dir"
    ) {
      options.chromeProfile = value;
    } else if (argument === "--edge-profile") {
      options.edgeProfile = value;
    } else if (argument === "--firefox-profile") {
      options.firefoxProfile = value;
    } else if (argument === "--cookie-timeout") {
      const timeout = Number(value);
      if (!Number.isFinite(timeout) || timeout <= 0)
        throw new Error("Cookie timeout must be positive.");
      options.cookieTimeoutMs = timeout;
    } else {
      throw new Error(`Unknown option: ${argument}.`);
    }
    index += 1;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { resolveCredentials, TwitterClient } = await import("@jtsang/bird");
  const extraction = await resolveCredentials({
    ...(options.cookieSources.length > 0
      ? { cookieSource: options.cookieSources }
      : {}),
    ...(options.chromeProfile ? { chromeProfile: options.chromeProfile } : {}),
    ...(options.edgeProfile ? { edgeProfile: options.edgeProfile } : {}),
    ...(options.firefoxProfile
      ? { firefoxProfile: options.firefoxProfile }
      : {}),
    ...(options.cookieTimeoutMs
      ? { cookieTimeoutMs: options.cookieTimeoutMs }
      : {}),
  });

  if (!extraction.cookies.authToken || !extraction.cookies.ct0) {
    for (const warning of extraction.warnings)
      process.stderr.write(`x-auth: ${warning}\n`);
    throw new Error("Could not find both auth_token and ct0 cookies.");
  }

  const client = new TwitterClient({
    cookies: extraction.cookies,
    timeoutMs: 20_000,
  });
  const currentUser = await client.getCurrentUser();
  if (!currentUser.success || !currentUser.user) {
    throw new Error(currentUser.error ?? "X rejected the extracted cookies.");
  }

  const sql = postgres(getDatabaseEnvironment().DATABASE_URL, {
    max: 1,
    prepare: false,
  });
  try {
    const database = drizzle(sql, { schema });
    const account = await installXIntegrationAccount({
      database,
      account: currentUser.user,
      credentials: {
        authToken: extraction.cookies.authToken,
        ct0: extraction.cookies.ct0,
      },
      authSource: extraction.cookies.source ?? "environment",
    });
    process.stdout.write(
      `Connected @${currentUser.user.username} as read-only X integration ${account.id}. Credentials were encrypted; no cookie values were printed.\n`,
    );
  } finally {
    await sql.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `x-auth: ${error instanceof Error ? error.message : "setup failed"}\n`,
  );
  process.exitCode = 1;
});
