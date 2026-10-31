// Signs the self-hosted browser worker in to LinkedIn as you: reads your
// linkedin.com cookies from the browser you're signed in with on this Mac and
// sends them, over HTTPS with IMPORT_TOKEN, to the app, which passes them to
// the worker. Cookie values are never printed.
//
//   pnpm linkedin-login                 Chrome, then Safari, then Firefox
//   pnpm linkedin-login --browser arc   chrome | arc | brave | safari | firefox
//
// Env (.env.local): OUTBOUND_URL, IMPORT_TOKEN.
import { config } from "dotenv";
import { getCookies } from "@steipete/sweet-cookie";

config({ path: [".env.local", ".env"], quiet: true });

const flag = process.argv.indexOf("--browser");
const choice = flag >= 0 ? process.argv[flag + 1] : undefined;
const CHROMIUM = ["chrome", "arc", "brave", "chromium", "dia"] as const;

async function main() {
  const chromium = CHROMIUM.find((name) => name === choice);
  const { cookies, warnings } = await getCookies({
    url: "https://www.linkedin.com/",
    origins: ["https://linkedin.com", "https://www.linkedin.com"],
    // One browser's session, never a mix of two accounts' cookies.
    mode: "first",
    ...(chromium
      ? { browsers: ["chrome"], ...(chromium !== "chrome" ? { chromiumBrowser: chromium } : {}) }
      : choice === "safari" || choice === "firefox"
        ? { browsers: [choice] }
        : {}),
  });
  for (const warning of warnings) console.warn(`  ! ${warning}`);
  const linkedin = cookies
    .map((cookie) => ({ ...cookie, domain: cookie.domain ?? (cookie.url ? new URL(cookie.url).hostname : "www.linkedin.com") }))
    .filter((cookie) => /(^|\.)linkedin\.com$/i.test(cookie.domain.replace(/^\./, "")));
  if (!linkedin.some((cookie) => cookie.name === "li_at")) {
    throw new Error("No LinkedIn session found. Sign in to linkedin.com in that browser first (or pass --browser arc|brave|safari|firefox).");
  }
  console.log(`Found ${linkedin.length} LinkedIn cookies${linkedin[0]?.source ? ` in ${linkedin[0].source.browser}` : ""}. Sending to the worker…`);

  const url = (process.env.OUTBOUND_URL ?? "https://threadline.viraat.dev").replace(/\/$/, "");
  const token = process.env.IMPORT_TOKEN;
  if (!token) throw new Error("Set IMPORT_TOKEN in .env.local (the same value as the deployment's IMPORT_TOKEN).");
  const response = await fetch(`${url}/api/linkedin/session`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      cookies: linkedin.map(({ name, value, domain, hostOnly, path, expires, secure, httpOnly, sameSite }) => ({
        name,
        value,
        domain,
        hostOnly,
        path,
        expires,
        secure,
        httpOnly,
        sameSite,
      })),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { signedIn?: boolean; detail?: string; error?: string };
  if (!response.ok) throw new Error(`Login failed (HTTP ${response.status}): ${body.error ?? ""}`);
  console.log(body.signedIn ? `✓ ${body.detail ?? "Signed in."}` : `✗ ${body.detail ?? "Not signed in."}`);
  if (!body.signedIn) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
