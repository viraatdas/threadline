// Finds GitHub organizations whose public workflows run on macOS runners.
// People are deliberately never harvested here: GitHub's Acceptable Use Policy
// forbids using API data for unsolicited email.
import { z } from "zod";

import { normalizeDomain, websiteFromDomain } from "./domain";
import type { FetchLike, FindResult, FoundCompany, FoundSignal } from "./types";
import { clip, describeFetchError, mapLimit } from "./util";

const API = "https://api.github.com";
const TIMEOUT_MS = 12_000;
// Code search allows 10 requests/minute; stay well under it per run.
const MAX_SEARCH_REQUESTS = 3;
const PER_PAGE = 100;
const MAX_SIGNALS_PER_COMPANY = 5;
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
// Only files GitHub Actions would actually run ("ci.yml.old" is not CI).
const WORKFLOW_PATH_RE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;

export const DEFAULT_MAC_CI_QUERIES = [
  '"runs-on: macos" path:.github/workflows',
  "xcodebuild path:.github/workflows",
  '"runs-on: macos" fastlane path:.github/workflows',
];

const codeItemSchema = z.object({
  path: z.string().max(1000),
  html_url: z.string().url().max(2000),
  repository: z.object({
    name: z.string().max(200),
    full_name: z.string().max(300),
    fork: z.boolean().optional(),
    pushed_at: z.string().nullish(),
    owner: z.object({ login: z.string().max(100), type: z.string() }),
  }),
});
const codeSearchSchema = z.object({
  total_count: z.number().optional(),
  items: z.array(z.unknown()),
});
const orgSchema = z.object({
  login: z.string(),
  name: z.string().nullish(),
  blog: z.string().nullish(),
  location: z.string().nullish(),
  description: z.string().nullish(),
  public_repos: z.number().nullish(),
});

interface WorkflowHit {
  owner: string;
  ownerType: string;
  fullName: string;
  path: string;
  htmlUrl: string;
  strength: 2 | 3;
  pushedAt?: string;
}

type SearchOutcome =
  | { ok: true; hits: WorkflowHit[]; totalCount: number; itemCount: number; invalid: number }
  | { ok: false; status: number; message: string };

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function strengthForQuery(query: string): 2 | 3 {
  return /runs-on:\s*macos/i.test(query) ? 3 : 2;
}

async function searchCode(query: string, page: number, token: string, fetchImpl: FetchLike): Promise<SearchOutcome> {
  const url = new URL(`${API}/search/code`);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("page", String(page));
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: headers(token), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    return { ok: false, status: 0, message: describeFetchError(error) };
  }
  if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status}` };

  const parsed = codeSearchSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return { ok: false, status: res.status, message: "unexpected response shape" };

  const strength = strengthForQuery(query);
  const hits: WorkflowHit[] = [];
  let invalid = 0;
  for (const raw of parsed.data.items) {
    const item = codeItemSchema.safeParse(raw);
    if (!item.success) {
      invalid++;
      continue;
    }
    const { path, html_url, repository } = item.data;
    if (repository.fork === true || !WORKFLOW_PATH_RE.test(path)) continue;
    hits.push({
      owner: repository.owner.login,
      ownerType: repository.owner.type,
      fullName: repository.full_name,
      path,
      htmlUrl: html_url,
      strength,
      ...(repository.pushed_at && !Number.isNaN(Date.parse(repository.pushed_at))
        ? { pushedAt: new Date(repository.pushed_at).toISOString() }
        : {}),
    });
  }
  return { ok: true, hits, totalCount: parsed.data.total_count ?? 0, itemCount: parsed.data.items.length, invalid };
}

function hitToSignal(hit: WorkflowHit): FoundSignal {
  return {
    kind: "github_macos_ci",
    title: clip(`Runs macOS CI in ${hit.fullName} (${hit.path})`, 300) as string,
    detail: hit.strength === 3 ? "Workflow targets a macOS runner (runs-on: macos)" : "Workflow invokes xcodebuild/fastlane",
    url: hit.htmlUrl,
    strength: hit.strength,
    dedupeKey: `github:${hit.fullName}:${hit.path}`,
    ...(hit.pushedAt ? { observedAt: hit.pushedAt } : {}),
  };
}

/** One signal per workflow file (strongest match wins), strongest first, capped. */
function signalsFromHits(hits: WorkflowHit[]): FoundSignal[] {
  const byFile = new Map<string, WorkflowHit>();
  for (const hit of hits) {
    const key = `${hit.fullName}:${hit.path}`.toLowerCase();
    const existing = byFile.get(key);
    if (!existing || hit.strength > existing.strength) byFile.set(key, hit);
  }
  return [...byFile.values()]
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_SIGNALS_PER_COMPANY)
    .map(hitToSignal);
}

function searchFailureWarning(status: number, message: string, requests: number): string {
  if (status === 401) return "GitHub rejected the token (HTTP 401); check GH token scopes.";
  if (status === 403 || status === 429) {
    return `GitHub code search rate limit hit (HTTP ${status}) after ${requests} request(s); stopped early. Try again in a minute.`;
  }
  return `GitHub code search failed (${message}).`;
}

export async function findMacCiTeams(options: {
  token: string;
  maxOrgs?: number;
  queries?: string[];
  fetch?: FetchLike;
}): Promise<FindResult> {
  const fetchImpl = options.fetch ?? fetch;
  const maxOrgs = Math.max(0, Math.min(options.maxOrgs ?? 40, 100));
  const queries = (options.queries ?? DEFAULT_MAC_CI_QUERIES).map((q) => q.trim()).filter(Boolean);
  const warnings: string[] = [];
  const result: FindResult = { source: "github", companies: [], warnings };
  if (!options.token) {
    warnings.push("GitHub token missing; code search requires authentication.");
    return result;
  }

  // Round-robin pages across queries so every query gets its first page before
  // any query gets a second one.
  const hits: WorkflowHit[] = [];
  const active = new Set(queries.map((_, i) => i));
  let requests = 0;
  let invalid = 0;
  let stopped = false;
  for (let page = 1; !stopped && active.size > 0 && page <= 10; page++) {
    for (const index of [...active]) {
      if (requests >= MAX_SEARCH_REQUESTS) {
        stopped = true;
        break;
      }
      requests++;
      const outcome = await searchCode(queries[index] as string, page, options.token, fetchImpl);
      if (!outcome.ok) {
        warnings.push(searchFailureWarning(outcome.status, outcome.message, requests));
        if ([401, 403, 429].includes(outcome.status)) {
          stopped = true;
          break;
        }
        active.delete(index);
        continue;
      }
      hits.push(...outcome.hits);
      invalid += outcome.invalid;
      if (outcome.itemCount < PER_PAGE || page * PER_PAGE >= outcome.totalCount) active.delete(index);
    }
  }
  if (invalid > 0) warnings.push(`Skipped ${invalid} malformed GitHub search result(s).`);

  const byOrg = new Map<string, WorkflowHit[]>();
  for (const hit of hits) {
    if (hit.ownerType !== "Organization" || !LOGIN_RE.test(hit.owner)) continue;
    const key = hit.owner.toLowerCase();
    byOrg.set(key, [...(byOrg.get(key) ?? []), hit]);
  }

  const ranked = [...byOrg.values()]
    .map((orgHits) => ({
      login: (orgHits[0] as WorkflowHit).owner,
      signals: signalsFromHits(orgHits),
      files: new Set(orgHits.map((h) => `${h.fullName}:${h.path}`.toLowerCase())).size,
      strongest: Math.max(...orgHits.map((h) => h.strength)),
    }))
    .sort((a, b) => b.files - a.files || b.strongest - a.strongest)
    .slice(0, maxOrgs);

  let orgFailures = 0;
  result.companies = await mapLimit(ranked, 4, async ({ login, signals, files }) => {
    const company: FoundCompany = { name: login, githubLogin: login, signals, people: [] };
    try {
      const res = await fetchImpl(`${API}/orgs/${encodeURIComponent(login)}`, {
        headers: headers(options.token),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const org = res.ok ? orgSchema.safeParse(await res.json().catch(() => null)) : null;
      if (!org?.success) {
        orgFailures++;
        return company;
      }
      const domain = normalizeDomain(org.data.blog);
      const repos = org.data.public_repos;
      const summary = `${files} macOS workflow file(s) found${typeof repos === "number" ? ` · org has ${repos} public repos` : ""}`;
      return {
        ...company,
        signals: signals.map((s, i) => (i === 0 ? { ...s, detail: `${s.detail} · ${summary}` } : s)),
        name: clip(org.data.name, 120) ?? login,
        ...(domain ? { domain, website: websiteFromDomain(domain) } : {}),
        ...(clip(org.data.description, 600) ? { description: clip(org.data.description, 600) } : {}),
        ...(clip(org.data.location, 120) ? { location: clip(org.data.location, 120) } : {}),
      };
    } catch {
      orgFailures++;
      return company;
    }
  });
  if (orgFailures > 0) warnings.push(`Could not load profile details for ${orgFailures} GitHub org(s); kept them by login.`);
  return result;
}

/** Confirms macOS CI for a known org. Returns [] when the org does not exist. */
export async function checkOrgForMacCi(options: { token: string; login: string; fetch?: FetchLike }): Promise<FoundSignal[]> {
  const fetchImpl = options.fetch ?? fetch;
  const login = options.login.trim();
  if (!LOGIN_RE.test(login)) return [];

  const hits: WorkflowHit[] = [];
  for (const query of [`org:${login} "runs-on: macos" path:.github/workflows`, `org:${login} xcodebuild path:.github/workflows`]) {
    const outcome = await searchCode(query, 1, options.token, fetchImpl);
    if (!outcome.ok) {
      if (outcome.status === 404 || outcome.status === 422) return [];
      throw new GitHubError(`GitHub code search failed (${outcome.message})`, outcome.status);
    }
    hits.push(...outcome.hits);
  }
  return signalsFromHits(hits);
}
