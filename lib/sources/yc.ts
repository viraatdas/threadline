// Y Combinator sources: the public yc-oss directory dump, individual company
// pages on ycombinator.com, and JSON pasted from the owner's local `yc` CLI.
import { z } from "zod";

import { normalizeDomain, websiteFromDomain } from "./domain";
import type { FetchLike, FindResult, FoundCompany, FoundPerson, FoundSignal } from "./types";
import {
  BROWSER_USER_AGENT,
  clip,
  decodeEntities,
  describeFetchError,
  httpUrl,
  isObject,
  isUrlOnHost,
  isValidEmail,
  readTextCapped,
} from "./util";

const DIRECTORY_URL = "https://yc-oss.github.io/api/companies/all.json";
// Real slugs include underscores ("d_model").
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
const GITHUB_LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const SEASONS = ["winter", "spring", "summer", "fall"] as const;

const ycCompanyUrl = (slug: string) => `https://www.ycombinator.com/companies/${slug}`;

/** Sortable recency for "Winter 2026" style batches; 0 when unparseable. */
export function batchRecency(batch: string | null | undefined): number {
  const match = /^(winter|spring|summer|fall)\s+(\d{4})$/i.exec(batch?.trim() ?? "");
  if (!match) return 0;
  return Number(match[2]) * 4 + SEASONS.indexOf((match[1] as string).toLowerCase() as (typeof SEASONS)[number]);
}

function describe(oneLiner: unknown, long: unknown): string | undefined {
  const parts = [clip(oneLiner, 300), clip(long, 600)].filter((p): p is string => Boolean(p));
  return clip(parts.join(" — "), 600);
}

function teamSizeOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 10_000_000 ? value : undefined;
}

function githubLoginFrom(url: unknown): string | undefined {
  const safe = httpUrl(url);
  if (!safe || !isUrlOnHost(safe, "github.com")) return undefined;
  const segments = new URL(safe).pathname.split("/").filter(Boolean);
  const login = segments[0] === "orgs" ? segments[1] : segments[0];
  return login && GITHUB_LOGIN_RE.test(login) ? login : undefined;
}

function ycSignal(name: string, slug: string | undefined, batch: string | undefined, oneLiner: string | undefined, strength: 1 | 2, detail?: string): FoundSignal {
  const key = slug ?? (name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "unnamed");
  return {
    kind: "yc",
    title: clip(`YC${batch ? ` ${batch}` : ""}: ${oneLiner ?? name}`, 300) as string,
    strength,
    dedupeKey: `yc:${key}`,
    ...(slug ? { url: ycCompanyUrl(slug) } : {}),
    ...(detail ? { detail } : {}),
  };
}

function hiringSignal(name: string, slug: string, detail?: string): FoundSignal {
  return {
    kind: "hiring",
    title: clip(`${name} is hiring`, 300) as string,
    url: `${ycCompanyUrl(slug)}/jobs`,
    strength: 1,
    dedupeKey: `yc-hiring:${slug}`,
    ...(detail ? { detail } : {}),
  };
}

// ---------------------------------------------------------------------------
// Directory search

const directoryEntrySchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().regex(SLUG_RE),
  website: z.string().nullish(),
  one_liner: z.string().nullish(),
  long_description: z.string().nullish(),
  tags: z.array(z.unknown()).nullish(),
  industries: z.array(z.unknown()).nullish(),
  batch: z.string().nullish(),
  status: z.string().nullish(),
  team_size: z.number().nullish(),
  all_locations: z.string().nullish(),
  isHiring: z.boolean().nullish(),
  url: z.string().nullish(),
});
type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

function phraseRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
}

const strings = (values: unknown[] | null | undefined) => (values ?? []).filter((v): v is string => typeof v === "string");

export async function searchYcDirectory(options: { query: string; limit?: number; fetch?: FetchLike }): Promise<FindResult> {
  const fetchImpl = options.fetch ?? fetch;
  const limit = Math.max(1, Math.min(options.limit ?? 30, 200));
  const warnings: string[] = [];
  const result: FindResult = { source: "yc", companies: [], warnings };

  const phrases = [...new Set(options.query.split(",").map((p) => p.trim().toLowerCase().slice(0, 80)).filter(Boolean))].slice(0, 20);
  if (phrases.length === 0) {
    warnings.push("YC search needs at least one phrase.");
    return result;
  }
  const matchers = phrases.map((phrase) => ({ phrase, re: phraseRegex(phrase) }));

  let raw: unknown;
  try {
    // The dump is ~10 MB; give it the full budget.
    const res = await fetchImpl(DIRECTORY_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      warnings.push(`YC directory request failed (HTTP ${res.status}).`);
      return result;
    }
    raw = await res.json();
  } catch (error) {
    warnings.push(`YC directory request failed (${error instanceof SyntaxError ? "invalid JSON" : describeFetchError(error)}).`);
    return result;
  }
  if (!Array.isArray(raw)) {
    warnings.push("YC directory returned an unexpected shape.");
    return result;
  }

  let invalid = 0;
  const matches: { entry: DirectoryEntry; matched: string[]; strong: boolean; recency: number }[] = [];
  for (const item of raw) {
    const parsed = directoryEntrySchema.safeParse(item);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const entry = parsed.data;
    if (entry.status !== "Active") continue;
    const tags = [...strings(entry.tags)];
    const fields = [entry.name, entry.one_liner ?? "", entry.long_description ?? "", ...tags, ...strings(entry.industries)];
    const matched: string[] = [];
    let strong = false;
    for (const { phrase, re } of matchers) {
      if (!fields.some((f) => re.test(f))) continue;
      matched.push(phrase);
      if (re.test(entry.one_liner ?? "") || tags.some((t) => re.test(t))) strong = true;
    }
    if (matched.length > 0) matches.push({ entry, matched, strong, recency: batchRecency(entry.batch) });
  }
  if (invalid > 0) warnings.push(`Skipped ${invalid} malformed YC directory entr${invalid === 1 ? "y" : "ies"}.`);

  matches.sort(
    (a, b) =>
      b.matched.length - a.matched.length ||
      b.recency - a.recency ||
      Number(b.entry.isHiring === true) - Number(a.entry.isHiring === true),
  );

  result.companies = matches.slice(0, limit).map(({ entry, matched, strong, recency }) => {
    const name = clip(entry.name, 120) as string;
    const batch = recency > 0 ? (entry.batch as string) : undefined;
    const domain = normalizeDomain(entry.website);
    const description = describe(entry.one_liner, entry.long_description);
    const teamSize = teamSizeOf(entry.team_size);
    const location = clip(entry.all_locations, 160);
    const signals = [ycSignal(name, entry.slug, batch, clip(entry.one_liner, 200), strong ? 2 : 1, `Matched: ${matched.join(", ")}`)];
    if (entry.isHiring === true) signals.push(hiringSignal(name, entry.slug));
    return {
      name,
      ycSlug: entry.slug,
      signals,
      people: [],
      ...(batch ? { ycBatch: batch } : {}),
      ...(domain ? { domain, website: websiteFromDomain(domain) } : {}),
      ...(description ? { description } : {}),
      ...(teamSize ? { teamSize } : {}),
      ...(location ? { location } : {}),
    } satisfies FoundCompany;
  });
  return result;
}

// ---------------------------------------------------------------------------
// Company page (ycombinator.com/companies/{slug})

const pageCompanySchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(SLUG_RE),
  batch_name: z.string().nullish(),
  website: z.string().nullish(),
  one_liner: z.string().nullish(),
  long_description: z.string().nullish(),
  team_size: z.number().nullish(),
  location: z.string().nullish(),
  linkedin_url: z.string().nullish(),
  twitter_url: z.string().nullish(),
  github_url: z.string().nullish(),
  founders: z.array(z.unknown()).nullish(),
});
const founderSchema = z.object({
  full_name: z.string().min(1),
  title: z.string().nullish(),
  linkedin_url: z.string().nullish(),
  twitter_url: z.string().nullish(),
  is_active: z.boolean().nullish(),
});

/** Parses the `data-page` JSON blob embedded in a YC company page. Exported for tests. */
export function parseYcCompanyPage(html: string): FoundCompany | null {
  const match = /\bdata-page="([^"]*)"/.exec(html);
  if (!match) return null;
  let page: unknown;
  try {
    page = JSON.parse(decodeEntities(match[1] as string));
  } catch {
    return null;
  }
  const props = isObject(page) && isObject(page.props) ? page.props : undefined;
  const parsed = pageCompanySchema.safeParse(props?.company);
  if (!parsed.success) return null;
  const c = parsed.data;

  const people: FoundPerson[] = [];
  for (const raw of c.founders ?? []) {
    const founder = founderSchema.safeParse(raw);
    if (!founder.success || founder.data.is_active === false) continue;
    const name = clip(founder.data.full_name, 120);
    if (!name) continue;
    const linkedinUrl = httpUrl(founder.data.linkedin_url);
    const twitterUrl = httpUrl(founder.data.twitter_url);
    people.push({
      name,
      title: clip(founder.data.title, 120) ?? "Founder",
      ...(linkedinUrl && isUrlOnHost(linkedinUrl, "linkedin.com") ? { linkedinUrl } : {}),
      ...(twitterUrl && isUrlOnHost(twitterUrl, "twitter.com", "x.com") ? { twitterUrl } : {}),
    });
  }

  const name = clip(c.name, 120) as string;
  const batch = clip(c.batch_name, 40);
  const domain = normalizeDomain(c.website);
  const description = describe(c.one_liner, c.long_description);
  const teamSize = teamSizeOf(c.team_size);
  const location = clip(c.location, 160);
  const linkedinUrl = httpUrl(c.linkedin_url);
  const githubLogin = githubLoginFrom(c.github_url);
  const signals = [ycSignal(name, c.slug, batch, clip(c.one_liner, 200), 1)];
  const jobs = Array.isArray(props?.jobPostings) ? props.jobPostings.length : 0;
  if (jobs > 0) signals.push(hiringSignal(name, c.slug, `${jobs} open role${jobs === 1 ? "" : "s"} on YC`));

  return {
    name,
    ycSlug: c.slug,
    signals,
    people,
    ...(batch ? { ycBatch: batch } : {}),
    ...(domain ? { domain, website: websiteFromDomain(domain) } : {}),
    ...(description ? { description } : {}),
    ...(teamSize ? { teamSize } : {}),
    ...(location ? { location } : {}),
    ...(linkedinUrl && isUrlOnHost(linkedinUrl, "linkedin.com") ? { linkedinUrl } : {}),
    ...(githubLogin ? { githubLogin } : {}),
  };
}

/**
 * Fetches one YC company page. Returns null when the company does not exist or
 * the page cannot be parsed; throws (safe message) on network/HTTP failures.
 */
export async function fetchYcCompany(options: { slug: string; fetch?: FetchLike }): Promise<FoundCompany | null> {
  const fetchImpl = options.fetch ?? fetch;
  const slug = options.slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return null;
  let res: Response;
  try {
    res = await fetchImpl(ycCompanyUrl(slug), {
      headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    throw new Error(`YC company page request ${describeFetchError(error)}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`YC company page request failed (HTTP ${res.status})`);
  return parseYcCompanyPage(await readTextCapped(res, 3_000_000));
}

// ---------------------------------------------------------------------------
// Pasted `yc` CLI JSON (schema unknown, so walk it tolerantly)

const MAX_DEPTH = 8;
const MAX_NODES = 2_000;
const COMPANY_KEYS = ["website", "url", "slug", "one_liner", "batch", "company_url"] as const;
// People under these keys belong to someone else (YC partners, investors).
const FOREIGN_PEOPLE_KEYS = /partner|investor|advisor|mentor/i;

interface CompanyDraft {
  company: FoundCompany;
  personNames: Set<string>;
  oneLiner?: string;
}

const str = (obj: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
};

const normalizeName = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function isCompanyShaped(obj: Record<string, unknown>): boolean {
  if (typeof obj.name !== "string" || obj.name.trim() === "") return false;
  // Something that points at a company ("company_name": "Acme") is not one itself.
  if (str(obj, "company_name", "companyName", "company") || isObject(obj.company)) return false;
  return COMPANY_KEYS.some((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== "");
}

function personName(obj: Record<string, unknown>): string | undefined {
  const full = str(obj, "full_name", "fullName");
  if (full) return full;
  const first = str(obj, "first_name", "firstName");
  const last = str(obj, "last_name", "lastName");
  if (first && last) return `${first} ${last}`;
  if (typeof obj.name === "string" && !isCompanyShaped(obj) && ["email", "linkedin", "linkedin_url", "title"].some((k) => typeof obj[k] === "string")) {
    return obj.name;
  }
  return undefined;
}

function toPerson(obj: Record<string, unknown>, name: string): FoundPerson | undefined {
  const clean = clip(name, 120);
  if (!clean) return undefined;
  const email = str(obj, "email", "email_address")?.trim().toLowerCase();
  const linkedinUrl = httpUrl(str(obj, "linkedin_url", "linkedin", "linkedinUrl"));
  const twitterUrl = httpUrl(str(obj, "twitter_url", "twitter", "x_url"));
  const title = clip(str(obj, "title", "role", "position"), 120);
  const location = clip(str(obj, "location"), 120);
  return {
    name: clean,
    ...(title ? { title } : {}),
    ...(isValidEmail(email) ? { email, emailStatus: "found" as const } : {}),
    ...(linkedinUrl && isUrlOnHost(linkedinUrl, "linkedin.com") ? { linkedinUrl } : {}),
    ...(twitterUrl && isUrlOnHost(twitterUrl, "twitter.com", "x.com") ? { twitterUrl } : {}),
    ...(location ? { location } : {}),
  };
}

export function parseYcCliOutput(raw: unknown): FindResult {
  const warnings: string[] = [];
  const result: FindResult = { source: "yc-cli", companies: [], warnings };
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      warnings.push("Could not parse the pasted YC CLI output as JSON.");
      return result;
    }
  }

  const drafts: CompanyDraft[] = [];
  const bySlug = new Map<string, CompanyDraft>();
  const byName = new Map<string, CompanyDraft>();
  let nodes = 0;
  let truncated = false;
  let orphans = 0;

  const draftFor = (name: string, slug?: string): CompanyDraft | undefined => {
    const key = normalizeName(name);
    const existing = (slug ? bySlug.get(slug) : undefined) ?? (key ? byName.get(key) : undefined);
    if (existing) {
      if (slug && !existing.company.ycSlug) {
        existing.company.ycSlug = slug;
        bySlug.set(slug, existing);
      }
      return existing;
    }
    const clean = clip(name, 120);
    if (!clean || !key) return undefined;
    const draft: CompanyDraft = { company: { name: clean, signals: [], people: [], ...(slug ? { ycSlug: slug } : {}) }, personNames: new Set() };
    drafts.push(draft);
    byName.set(key, draft);
    if (slug) bySlug.set(slug, draft);
    return draft;
  };

  const absorbCompany = (obj: Record<string, unknown>): CompanyDraft | undefined => {
    const slugValue = str(obj, "slug");
    const slug = slugValue && SLUG_RE.test(slugValue.trim()) ? slugValue.trim().toLowerCase() : undefined;
    const draft = draftFor(obj.name as string, slug);
    if (!draft) return undefined;
    const c = draft.company;
    const domain = [str(obj, "website"), str(obj, "company_url"), str(obj, "domain"), str(obj, "url")].map(normalizeDomain).find(Boolean);
    if (domain && !c.domain) Object.assign(c, { domain, website: websiteFromDomain(domain) });
    const batch = clip(str(obj, "batch", "batch_name"), 40);
    if (batch && !c.ycBatch) c.ycBatch = batch;
    const description = describe(str(obj, "one_liner", "oneLiner"), str(obj, "long_description", "description"));
    if (description && !c.description) c.description = description;
    const teamSize = teamSizeOf(obj.team_size);
    if (teamSize && !c.teamSize) c.teamSize = teamSize;
    const location = clip(str(obj, "location", "all_locations", "city"), 160);
    if (location && !c.location) c.location = location;
    const linkedinUrl = httpUrl(str(obj, "linkedin_url"));
    if (linkedinUrl && isUrlOnHost(linkedinUrl, "linkedin.com") && !c.linkedinUrl) c.linkedinUrl = linkedinUrl;
    const githubLogin = githubLoginFrom(str(obj, "github_url"));
    if (githubLogin && !c.githubLogin) c.githubLogin = githubLogin;
    const oneLiner = clip(str(obj, "one_liner", "oneLiner"), 200);
    if (oneLiner && !draft.oneLiner) draft.oneLiner = oneLiner;
    return draft;
  };

  const addPerson = (draft: CompanyDraft, person: FoundPerson) => {
    const key = normalizeName(person.name);
    if (!key || draft.personNames.has(key)) return;
    draft.personNames.add(key);
    draft.company.people.push(person);
  };

  const visit = (node: unknown, depth: number, owner: CompanyDraft | undefined): void => {
    if (truncated || depth > MAX_DEPTH || typeof node !== "object" || node === null) return;
    if (++nodes > MAX_NODES) {
      truncated = true;
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1, owner);
      return;
    }
    const obj = node as Record<string, unknown>;
    let nextOwner = owner;
    const name = personName(obj);
    if (name) {
      const person = toPerson(obj, name);
      const companyRef = str(obj, "company_name", "companyName", "company") ?? (isObject(obj.company) ? str(obj.company, "name") : undefined);
      const target = owner ?? (companyRef ? draftFor(companyRef) : undefined);
      if (person && target) addPerson(target, person);
      else if (person) orphans++;
    } else if (isCompanyShaped(obj)) {
      nextOwner = absorbCompany(obj) ?? owner;
    }
    for (const [key, child] of Object.entries(obj)) {
      if (typeof child !== "object" || child === null) continue;
      if (FOREIGN_PEOPLE_KEYS.test(key)) continue;
      visit(child, depth + 1, nextOwner);
    }
  };
  visit(data, 0, undefined);

  if (truncated) warnings.push(`Stopped reading the pasted output after ${MAX_NODES.toLocaleString("en-US")} items.`);
  if (orphans > 0) warnings.push(`Skipped ${orphans} person record(s) with no company.`);

  result.companies = drafts.map(({ company, oneLiner }) => ({
    ...company,
    signals: [ycSignal(company.name, company.ycSlug, company.ycBatch, oneLiner, 2)],
  }));
  if (result.companies.length === 0) warnings.push("No companies found in the pasted YC CLI output.");
  return result;
}
