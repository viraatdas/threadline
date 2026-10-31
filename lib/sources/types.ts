// The contract every prospect source returns. Sources are pure fetch-and-parse
// modules: they never touch the database. `lib/ingest.ts` upserts these.

export const SIGNAL_KINDS = [
  "github_macos_ci",
  "github_ios",
  "yc",
  "hn",
  "website",
  "hiring",
  "linkedin",
  "manual",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface FoundSignal {
  kind: SignalKind;
  title: string;
  detail?: string | undefined;
  url?: string | undefined;
  // 1 = weak context, 2 = relevant, 3 = feeling the pain right now.
  strength: 1 | 2 | 3;
  // ISO timestamp of when the evidence happened, if known.
  observedAt?: string | undefined;
  // Stable across re-runs so re-finding the same evidence is a no-op.
  dedupeKey: string;
}

export interface FoundPerson {
  name: string;
  title?: string | undefined;
  email?: string | undefined;
  emailStatus?: "found" | "guessed" | undefined;
  linkedinUrl?: string | undefined;
  twitterUrl?: string | undefined;
  location?: string | undefined;
}

export interface FoundCompany {
  name: string;
  // Lower-case registrable host without "www.", e.g. "offstage.cloud".
  domain?: string | undefined;
  website?: string | undefined;
  description?: string | undefined;
  location?: string | undefined;
  teamSize?: number | undefined;
  linkedinUrl?: string | undefined;
  githubLogin?: string | undefined;
  ycSlug?: string | undefined;
  ycBatch?: string | undefined;
  signals: FoundSignal[];
  people: FoundPerson[];
}

export interface FindResult {
  source: string;
  companies: FoundCompany[];
  // Human-readable, safe to show the owner (no tokens, no response bodies).
  warnings: string[];
}

export type FetchLike = typeof fetch;
