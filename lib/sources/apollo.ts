// Optional Apollo.io lookups. Errors carry the HTTP status only — never the
// response body or the API key.
import { z } from "zod";

import { normalizeDomain } from "./domain";
import type { FetchLike, FoundPerson } from "./types";
import { clip, describeFetchError, httpUrl, isUrlOnHost, isValidEmail } from "./util";

const BASE = "https://api.apollo.io/api/v1";
const TIMEOUT_MS = 12_000;

export const DEFAULT_APOLLO_TITLES = [
  "founder",
  "cto",
  "ceo",
  "head of engineering",
  "vp engineering",
  "ios",
  "mobile",
  "platform",
  "devops",
  "infrastructure",
];

const apolloPersonSchema = z.object({
  id: z.string().nullish(),
  has_email: z.boolean().nullish(),
  name: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  title: z.string().nullish(),
  linkedin_url: z.string().nullish(),
  twitter_url: z.string().nullish(),
});
const searchSchema = z.object({ people: z.array(z.unknown()).nullish() });
const matchSchema = z.object({
  person: z
    .object({
      email: z.string().nullish(),
      email_status: z.string().nullish(),
      name: z.string().nullish(),
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
      linkedin_url: z.string().nullish(),
    })
    .nullish(),
});

async function post(path: string, apiKey: string, body: unknown, fetchImpl: FetchLike, label: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${BASE}${path}`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Apollo ${label} ${describeFetchError(error)}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Apollo ${label} failed (HTTP ${res.status})`);
  }
  return res.json().catch(() => {
    throw new Error(`Apollo ${label} returned invalid JSON`);
  });
}

export async function apolloFindPeople(options: {
  apiKey: string;
  domain: string;
  titles?: string[];
  limit?: number;
  fetch?: FetchLike;
}): Promise<FoundPerson[]> {
  const domain = normalizeDomain(options.domain);
  if (!domain) return [];
  const perPage = Math.max(1, Math.min(options.limit ?? 5, 25));
  const data = await post(
    "/mixed_people/api_search",
    options.apiKey,
    { q_organization_domains_list: [domain], person_titles: options.titles ?? DEFAULT_APOLLO_TITLES, per_page: perPage },
    options.fetch ?? fetch,
    "people search",
  );
  const parsed = searchSchema.safeParse(data);
  if (!parsed.success) return [];

  const people: FoundPerson[] = [];
  for (const raw of parsed.data.people ?? []) {
    const person = apolloPersonSchema.safeParse(raw);
    if (!person.success) continue;
    const p = person.data;
    const name = clip(p.name ?? [p.first_name, p.last_name].filter(Boolean).join(" "), 120);
    if (!name) continue;
    const title = clip(p.title, 120);
    const linkedinUrl = httpUrl(p.linkedin_url);
    const twitterUrl = httpUrl(p.twitter_url);
    const apolloId = p.id && /^[a-f0-9]{16,40}$/i.test(p.id) ? p.id : undefined;
    people.push({
      name,
      ...(title ? { title } : {}),
      ...(apolloId ? { apolloId } : {}),
      ...(typeof p.has_email === "boolean" ? { apolloHasEmail: p.has_email } : {}),
      ...(linkedinUrl && isUrlOnHost(linkedinUrl, "linkedin.com") ? { linkedinUrl } : {}),
      ...(twitterUrl && isUrlOnHost(twitterUrl, "twitter.com", "x.com") ? { twitterUrl } : {}),
    });
    if (people.length >= perPage) break;
  }
  return people;
}

// Looks a person up (one Apollo credit when it returns an email). By Apollo id
// when we have one, which is the only reliable way for people from its search:
// those come with first names only.
export async function apolloRevealEmail(options: {
  apiKey: string;
  name: string;
  apolloId?: string | undefined;
  domain?: string | undefined;
  linkedinUrl?: string | undefined;
  fetch?: FetchLike;
}): Promise<{ email?: string; name?: string; linkedinUrl?: string } | undefined> {
  const name = clip(options.name, 120);
  if (!name && !options.apolloId) return undefined;
  const domain = normalizeDomain(options.domain);
  const linkedinUrl = httpUrl(options.linkedinUrl);
  const data = await post(
    "/people/match",
    options.apiKey,
    {
      ...(options.apolloId
        ? { id: options.apolloId }
        : { name, ...(domain ? { domain } : {}), ...(linkedinUrl ? { linkedin_url: linkedinUrl } : {}) }),
      reveal_personal_emails: false,
    },
    options.fetch ?? fetch,
    "people match",
  );
  const parsed = matchSchema.safeParse(data);
  if (!parsed.success || !parsed.data.person) return undefined;
  const person = parsed.data.person;
  const fullName = clip(person.name ?? [person.first_name, person.last_name].filter(Boolean).join(" "), 120);
  const profile = httpUrl(person.linkedin_url);
  const email = person.email?.trim().toLowerCase();
  // Apollo returns a placeholder address for emails the plan hasn't unlocked.
  const usable = isValidEmail(email) && !email.startsWith("email_not_unlocked@") && person.email_status !== "unavailable";
  return {
    ...(usable ? { email } : {}),
    ...(fullName ? { name: fullName } : {}),
    ...(profile && isUrlOnHost(profile, "linkedin.com") ? { linkedinUrl: profile } : {}),
  };
}
