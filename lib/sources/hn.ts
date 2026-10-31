// Hacker News stories (via Algolia) about macOS CI / Mac sandbox pain, mapped
// to the company whose site the story links to.
import { z } from "zod";

import { normalizeDomain, websiteFromDomain } from "./domain";
import type { FetchLike, FindResult, FoundCompany, FoundSignal } from "./types";
import { clip, describeFetchError, mapLimit } from "./util";

const SEARCH_URL = "https://hn.algolia.com/api/v1/search";
const MAX_SIGNALS_PER_COMPANY = 5;

export const DEFAULT_HN_QUERIES = [
  "macos runner",
  "github actions macos",
  "xcode cloud",
  "ios ci",
  "mac mini ci",
  "computer use agent mac",
  "macos sandbox",
  "xcodebuild",
];

const hitSchema = z.object({
  objectID: z.string().regex(/^\d{1,12}$/),
  title: z.string().min(1).max(500),
  url: z.string().max(2000).nullish(),
  author: z.string().max(100).nullish(),
  points: z.number().nullish(),
  num_comments: z.number().nullish(),
  created_at: z.string().nullish(),
});
const responseSchema = z.object({ hits: z.array(z.unknown()) });
type Hit = z.infer<typeof hitSchema>;

const STRONG_TITLE_RE = /(?<![a-z0-9])(?:mac\s?os|runners?|xcode|ci)(?![a-z0-9])/i;

/** "Show HN: Foo – bar" → "Foo"; undefined when the title doesn't name a product. */
export function showHnName(title: string): string | undefined {
  const match = /^show hn:\s*(.+?)\s*(?:\s[–—-]\s|:\s|\s\|\s|,\s|\s\(|$)/i.exec(title.trim());
  // "Lume 0.2" / "Foo v2" → the product, not the release.
  const name = match?.[1]?.trim().replace(/\s+(?:v\d+(?:\.\d+)*|\d+\.\d+(?:\.\d+)*)$/i, "");
  if (!name || name.length > 40 || name.split(/\s+/).length > 4) return undefined;
  return name;
}

export function nameFromDomain(domain: string): string {
  const label = domain.split(".")[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function toSignal(hit: Hit): FoundSignal {
  const created = hit.created_at && !Number.isNaN(Date.parse(hit.created_at)) ? new Date(hit.created_at).toISOString() : undefined;
  return {
    kind: "hn",
    title: clip(hit.title, 300) as string,
    detail: `${hit.points ?? 0} points · ${hit.num_comments ?? 0} comments · by ${clip(hit.author, 60) ?? "unknown"}`,
    url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    strength: STRONG_TITLE_RE.test(hit.title) ? 3 : 2,
    dedupeKey: `hn:${hit.objectID}`,
    ...(created ? { observedAt: created } : {}),
  };
}

export async function searchHackerNews(options: { queries?: string[]; days?: number; limit?: number; fetch?: FetchLike } = {}): Promise<FindResult> {
  const fetchImpl = options.fetch ?? fetch;
  const queries = (options.queries ?? DEFAULT_HN_QUERIES).map((q) => q.trim().slice(0, 200)).filter(Boolean).slice(0, 20);
  const days = Math.max(1, Math.min(options.days ?? 365, 3650));
  const limit = Math.max(1, Math.min(options.limit ?? 40, 200));
  const since = Math.floor(Date.now() / 1000) - days * 86_400;
  const warnings: string[] = [];

  const perQuery = await mapLimit(queries, 4, async (query) => {
    const url = new URL(SEARCH_URL);
    url.searchParams.set("query", query);
    url.searchParams.set("tags", "(story,show_hn)");
    url.searchParams.set("numericFilters", `created_at_i>${since}`);
    url.searchParams.set("hitsPerPage", "50");
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        warnings.push(`HN search for "${query}" failed (HTTP ${res.status}).`);
        return [];
      }
      const parsed = responseSchema.safeParse(await res.json().catch(() => null));
      if (!parsed.success) {
        warnings.push(`HN search for "${query}" returned an unexpected shape.`);
        return [];
      }
      return parsed.data.hits;
    } catch (error) {
      warnings.push(`HN search for "${query}" ${describeFetchError(error)}.`);
      return [];
    }
  });

  const seen = new Set<string>();
  const byDomain = new Map<string, { hits: Hit[]; showName?: string | undefined }>();
  let invalid = 0;
  for (const raw of perQuery.flat()) {
    const parsed = hitSchema.safeParse(raw);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const hit = parsed.data;
    if (seen.has(hit.objectID)) continue;
    seen.add(hit.objectID);
    const domain = normalizeDomain(hit.url);
    if (!domain) continue;
    const group = byDomain.get(domain) ?? { hits: [] };
    group.hits.push(hit);
    group.showName ??= showHnName(hit.title);
    byDomain.set(domain, group);
  }
  if (invalid > 0) warnings.push(`Skipped ${invalid} malformed HN result(s).`);

  const companies = [...byDomain.entries()].map(([domain, group]) => {
    const signals = group.hits
      .map(toSignal)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_SIGNALS_PER_COMPANY);
    const points = group.hits.reduce((sum, h) => sum + (h.points ?? 0), 0);
    const company: FoundCompany = {
      name: clip(group.showName, 120) ?? nameFromDomain(domain),
      domain,
      website: websiteFromDomain(domain),
      signals,
      people: [],
    };
    return { company, strongest: signals[0]?.strength ?? 0, points };
  });
  companies.sort((a, b) => b.strongest - a.strongest || b.points - a.points);
  return { source: "hn", companies: companies.slice(0, limit).map((c) => c.company), warnings };
}
