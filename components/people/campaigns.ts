import type { PersonRecord } from "@/components/people/types";

// A campaign is a named sample message. The board matches conversations whose
// stored subjects/snippets share enough distinctive language with the sample —
// deterministic keyword overlap, computed client-side, no model required.
export interface Campaign {
  id: string;
  name: string;
  sample: string;
  createdAt: string;
}

export const CAMPAIGN_STORAGE_KEY = "threadline.campaigns.v1";

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do for from had has have " +
    "here hi hey how i if in into is it its just let me my of on or our out so " +
    "than that the their them then there they this to us was we were what when " +
    "which who why will with would you your yours thanks thank best regards " +
    "cheers hello would love like really very much more some also about get got " +
    "make made want need know time chat quick reach reaching email"
  ).split(/\s+/),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

// Distinctive vocabulary of the sample: filtered tokens plus their bigrams
// (bigrams weigh phrase matches like "prod regressions" above stray words).
export function extractCampaignTerms(sample: string): string[] {
  const tokens = tokenize(sample);
  const terms = new Set<string>(tokens);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    terms.add(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return [...terms];
}

export function campaignMatchScore(terms: string[], haystack: string): number {
  if (terms.length === 0) return 0;
  const text = tokenize(haystack).join(" ");
  let hits = 0;
  for (const term of terms) {
    if (text.includes(term)) hits += 1;
  }
  return hits / terms.length;
}

const MATCH_THRESHOLD = 0.18;
const MIN_HITS = 3;

export function matchesCampaign(
  person: PersonRecord,
  terms: string[],
): boolean {
  if (terms.length === 0) return false;
  const haystack = person.recentMessages
    .map((message) => `${message.subject} ${message.snippet}`)
    .join(" ");
  if (!haystack.trim()) return false;
  const score = campaignMatchScore(terms, haystack);
  const hits = Math.round(score * terms.length);
  return score >= MATCH_THRESHOLD && hits >= MIN_HITS;
}

export function loadCampaigns(): Campaign[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CAMPAIGN_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Campaign =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Campaign).id === "string" &&
        typeof (entry as Campaign).name === "string" &&
        typeof (entry as Campaign).sample === "string",
    );
  } catch {
    return [];
  }
}

export function saveCampaigns(campaigns: Campaign[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CAMPAIGN_STORAGE_KEY,
      JSON.stringify(campaigns),
    );
  } catch {
    // Storage full or blocked — campaigns simply stay session-local.
  }
}
