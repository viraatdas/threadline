// Posts on X about Mac build/agent pain, via the owner's local `bird` CLI
// (`bird search "<query>" --json-full`, signed in with their browser cookies).
// Each author becomes a prospect: their profile link names the company when it
// points at a company site; otherwise the person is the account.
import { z } from "zod";

import { normalizeDomain, websiteFromDomain } from "./domain";
import { nameFromDomain } from "./hn";
import type { FindResult, FoundCompany, FoundSignal } from "./types";
import { clip, isObject } from "./util";

export const DEFAULT_X_QUERIES = [
  '"macos runner" OR "macos runners"',
  '"github actions" (macos OR xcode) (slow OR expensive OR queue OR minutes)',
  '"xcode cloud" (slow OR expensive OR broken OR alternative)',
  '"mac mini" (agents OR "computer use" OR "openclaw") -giveaway',
  '"macos ci" OR "ios ci"',
  "xcodebuild (ci OR runner OR flaky)",
];

const PAIN_RE = /\b(?:slow|expensive|cost|costs|pricey|queue[ds]?|waiting|minutes|flaky|broken|hate|pain|ugh|bill|stuck|timeout|10x)\b/i;
const MAC_RE = /\b(?:mac\s?os|macos|mac\s?minis?|xcode|ios|swift|runners?|apple\s?silicon|m[1-5])\b/i;
// Big accounts are news/brands, not buyers who'd answer a DM.
const MAX_FOLLOWERS = 250_000;
const MAX_SIGNALS_PER_AUTHOR = 3;

const tweetSchema = z.object({
  id: z.string().regex(/^\d{1,25}$/),
  text: z.string().min(1).max(10_000),
  createdAt: z.string().max(80).optional(),
  author: z.object({ username: z.string().regex(/^\w{1,30}$/), name: z.string().max(200) }),
  authorId: z.string().regex(/^\d{1,25}$/).optional(),
  likeCount: z.number().optional(),
  replyCount: z.number().optional(),
  _raw: z.unknown().optional(),
});
type Tweet = z.infer<typeof tweetSchema>;

interface Profile {
  bio?: string | undefined;
  url?: string | undefined;
  location?: string | undefined;
  followers?: number | undefined;
}

const get = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((current, key) => (isObject(current) ? current[key] : undefined), value);

/** Bio, profile link, location and follower count from the raw GraphQL user. */
export function profileFromRaw(raw: unknown): Profile {
  const user = get(raw, "core", "user_results", "result");
  const legacy = get(user, "legacy");
  const urls = get(legacy, "entities", "url", "urls");
  const expanded = Array.isArray(urls) ? urls.map((u) => get(u, "expanded_url")).find((u) => typeof u === "string") : undefined;
  const followers = get(legacy, "followers_count");
  return {
    bio: clip(get(legacy, "description"), 300),
    url: typeof expanded === "string" ? expanded : undefined,
    location: clip(get(user, "location", "location"), 120) ?? clip(get(legacy, "location"), 120),
    followers: typeof followers === "number" ? followers : undefined,
  };
}

function toSignal(tweet: Tweet, query: string | undefined): FoundSignal {
  const created = tweet.createdAt && !Number.isNaN(Date.parse(tweet.createdAt)) ? new Date(tweet.createdAt).toISOString() : undefined;
  return {
    kind: "x",
    title: clip(tweet.text, 480) as string,
    detail: [`@${tweet.author.username}`, `${tweet.likeCount ?? 0} likes`, query ? `search: ${clip(query, 120)}` : null]
      .filter(Boolean)
      .join(" · "),
    url: `https://x.com/${tweet.author.username}/status/${tweet.id}`,
    strength: PAIN_RE.test(tweet.text) && MAC_RE.test(tweet.text) ? 3 : MAC_RE.test(tweet.text) ? 2 : 1,
    dedupeKey: `x:${tweet.id}`,
    ...(created ? { observedAt: created } : {}),
  };
}

/** Accepts `bird search --json[-full]` output: an array, or `{ tweets }` when paginated. */
export function parseBirdSearch(output: string, query?: string): FindResult {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { source: "x", companies: [], warnings: ["bird output was not JSON."] };
  }
  const rows = Array.isArray(parsed) ? parsed : isObject(parsed) && Array.isArray(parsed.tweets) ? parsed.tweets : [];
  const byAuthor = new Map<string, { tweets: Tweet[]; profile: Profile }>();
  let dropped = 0;
  for (const row of rows) {
    const result = tweetSchema.safeParse(row);
    if (!result.success) {
      dropped += 1;
      continue;
    }
    const tweet = result.data;
    if (/^RT @/.test(tweet.text)) continue;
    const key = tweet.author.username.toLowerCase();
    const entry = byAuthor.get(key) ?? { tweets: [], profile: profileFromRaw(tweet._raw) };
    entry.tweets.push(tweet);
    byAuthor.set(key, entry);
  }
  if (dropped) warnings.push(`${dropped} post${dropped === 1 ? "" : "s"} skipped (unexpected shape).`);

  const companies: FoundCompany[] = [];
  for (const { tweets, profile } of byAuthor.values()) {
    if (profile.followers !== undefined && profile.followers > MAX_FOLLOWERS) continue;
    const first = tweets[0]!;
    const handle = first.author.username;
    const name = clip(first.author.name, 120) ?? handle;
    const domain = normalizeDomain(profile.url);
    const signals = tweets
      .map((tweet) => toSignal(tweet, query))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, MAX_SIGNALS_PER_AUTHOR);
    // Matched the query but never mentions Macs: search noise.
    if ((signals[0]?.strength ?? 1) < 2) continue;
    companies.push({
      name: domain ? nameFromDomain(domain) : `${name} (@${handle})`,
      ...(domain ? { domain, website: websiteFromDomain(domain) } : {}),
      ...(profile.bio ? { description: profile.bio } : {}),
      ...(profile.location ? { location: profile.location } : {}),
      signals,
      people: [
        {
          name,
          ...(profile.bio ? { title: clip(profile.bio, 200) } : {}),
          twitterUrl: `https://x.com/${handle}`,
          ...(first.authorId ? { xUserId: first.authorId } : {}),
          ...(profile.location ? { location: profile.location } : {}),
        },
      ],
    });
  }
  return { source: "x", companies, warnings };
}

/** Merge several per-query results, keeping one company per author/domain. */
export function mergeResults(results: FindResult[]): FindResult {
  const seen = new Map<string, FoundCompany>();
  for (const company of results.flatMap((result) => result.companies)) {
    const key = company.domain ?? company.people[0]?.twitterUrl?.toLowerCase() ?? company.name.toLowerCase();
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, company);
      continue;
    }
    const keys = new Set(existing.signals.map((signal) => signal.dedupeKey));
    existing.signals.push(...company.signals.filter((signal) => !keys.has(signal.dedupeKey)));
    existing.signals.sort((a, b) => b.strength - a.strength).splice(MAX_SIGNALS_PER_AUTHOR);
    const handles = new Set(existing.people.map((person) => person.twitterUrl));
    existing.people.push(...company.people.filter((person) => !handles.has(person.twitterUrl)));
  }
  return { source: "x", companies: [...seen.values()], warnings: results.flatMap((result) => result.warnings) };
}
