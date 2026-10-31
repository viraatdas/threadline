// Local finder: runs sources that need the owner's own logins (the `yc` CLI's
// Bookface session, `gh`'s GitHub token) on this machine, then pushes the
// results to the deployed app. Credentials never leave the machine; only the
// found companies/people/signals are sent.
//
//   pnpm scout yc "ios app, mac ci"      Bookface company search via `yc`
//   pnpm scout yc-json results.json       import saved `yc ... --json` output
//   pnpm scout github                     GitHub Actions macOS/Xcode workflows
//   pnpm scout hn                         Hacker News pain-point launches
//   add --dry to print instead of import
//
// Env (.env.local): OUTBOUND_URL (default https://threadline.viraat.dev), IMPORT_TOKEN.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { config } from "dotenv";

import { findMacCiTeams } from "@/lib/sources/github";
import { searchHackerNews } from "@/lib/sources/hn";
import type { FindResult } from "@/lib/sources/types";
import { parseYcCliOutput } from "@/lib/sources/yc";

config({ path: [".env.local", ".env"], quiet: true });

const args = process.argv.slice(2).filter((arg) => arg !== "--dry");
const dry = process.argv.includes("--dry");
const [command, ...rest] = args;

function run(binary: string, argv: string[]): string {
  try {
    return execFileSync(binary, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    throw new Error(
      missing
        ? `\`${binary}\` is not installed. ${binary === "yc" ? "Install: curl -fsSL https://bookface.ycombinator.com/cli/install.sh | bash && yc login" : ""}`
        : `\`${binary} ${argv[0] ?? ""}\` failed.`,
    );
  }
}

async function find(): Promise<FindResult> {
  switch (command) {
    case "yc": {
      const queries = (rest.join(" ") || "ios app, macos app, mobile ci")
        .split(",")
        .map((q) => q.trim())
        .filter(Boolean)
        .slice(0, 8);
      const output = run("yc", ["tools", "run", "search.companies", "--input", JSON.stringify({ queries }), "--json"]);
      return { ...parseYcCliOutput(output), source: "yc-cli" };
    }
    case "yc-json": {
      if (!rest[0]) throw new Error("Usage: pnpm scout yc-json <file.json>");
      return { ...parseYcCliOutput(readFileSync(rest[0], "utf8")), source: "yc-cli" };
    }
    case "github": {
      const token = process.env.GITHUB_TOKEN || run("gh", ["auth", "token"]).trim();
      return findMacCiTeams({ token, maxOrgs: Number(rest[0]) || 40 });
    }
    case "hn":
      return searchHackerNews(rest.length ? { queries: rest.join(" ").split(",").map((q) => q.trim()) } : {});
    default:
      throw new Error("Usage: pnpm scout <yc|yc-json|github|hn> [args] [--dry]");
  }
}

async function main() {
  const result = await find();
  const people = result.companies.reduce((sum, company) => sum + company.people.length, 0);
  console.log(`${result.source}: ${result.companies.length} companies, ${people} people`);
  for (const warning of result.warnings) console.warn(`  ! ${warning}`);
  if (dry) {
    for (const company of result.companies.slice(0, 25)) {
      console.log(`  ${company.name}${company.domain ? ` (${company.domain})` : ""} — ${company.signals[0]?.title ?? ""}`);
    }
    return;
  }
  const url = (process.env.OUTBOUND_URL ?? "https://threadline.viraat.dev").replace(/\/$/, "");
  const token = process.env.IMPORT_TOKEN;
  if (!token) throw new Error("Set IMPORT_TOKEN in .env.local (the same value as the deployment's IMPORT_TOKEN).");
  const response = await fetch(`${url}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(result),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Import failed (HTTP ${response.status}): ${String(body.error ?? "")}`);
  console.log(`Imported: ${body.newCompanies} new companies, ${body.newPeople} new people, ${body.signals} new signals → ${url}/prospects`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
