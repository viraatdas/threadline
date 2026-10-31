import "server-only";

import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "@/lib/db/client";
import { companies, people, signals, type Company } from "@/lib/db/schema";
import { SIGNAL_KINDS, type FindResult, type FoundCompany, type FoundPerson } from "@/lib/sources/types";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max * 4)
    .transform((value) => value.slice(0, max))
    .optional()
    .transform((value) => value || undefined);

// The import route accepts FindResults from the local CLI, so the contract is
// re-validated here rather than trusted.
export const findResultSchema = z.object({
  source: z.string().trim().min(1).max(40),
  warnings: z.array(z.string().max(300)).max(50).default([]),
  companies: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        domain: optionalText(253).transform((value) => value?.toLowerCase()),
        website: optionalText(500),
        description: optionalText(2000),
        location: optionalText(200),
        teamSize: z.number().int().nonnegative().max(10_000_000).optional(),
        linkedinUrl: optionalText(500),
        githubLogin: optionalText(100).transform((value) => value?.toLowerCase()),
        ycSlug: optionalText(200),
        ycBatch: optionalText(40),
        signals: z
          .array(
            z.object({
              kind: z.enum(SIGNAL_KINDS),
              title: z.string().trim().min(1).max(500),
              detail: optionalText(1000),
              url: optionalText(1000),
              strength: z.union([z.literal(1), z.literal(2), z.literal(3)]),
              observedAt: z.string().datetime({ offset: true }).optional(),
              dedupeKey: z.string().trim().min(1).max(500),
            }),
          )
          .max(50)
          .default([]),
        people: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(200),
              title: optionalText(200),
              email: z.string().trim().toLowerCase().email().max(320).optional(),
              emailStatus: z.enum(["found", "guessed"]).optional(),
              linkedinUrl: optionalText(500),
              twitterUrl: optionalText(500),
              xUserId: z.string().regex(/^\d{1,25}$/).optional(),
              location: optionalText(200),
            }),
          )
          .max(50)
          .default([]),
      }),
    )
    .max(500),
});

export interface IngestSummary {
  companies: number;
  newCompanies: number;
  people: number;
  newPeople: number;
  signals: number;
  companyIds: string[];
}

export async function ingest(result: FindResult): Promise<IngestSummary> {
  const summary: IngestSummary = {
    companies: 0,
    newCompanies: 0,
    people: 0,
    newPeople: 0,
    signals: 0,
    companyIds: [],
  };
  for (const found of result.companies) {
    const { company, created } = await upsertCompany(found, result.source);
    summary.companies += 1;
    summary.companyIds.push(company.id);
    if (created) summary.newCompanies += 1;
    summary.signals += await insertSignals(company.id, found);
    for (const person of found.people) {
      const added = await upsertPerson(company.id, person, result.source);
      summary.people += 1;
      if (added) summary.newPeople += 1;
    }
  }
  return summary;
}

async function upsertCompany(found: FoundCompany, source: string): Promise<{ company: Company; created: boolean }> {
  const database = getDatabase();
  const identities: SQL[] = [];
  if (found.domain) identities.push(eq(companies.domain, found.domain));
  if (found.githubLogin) identities.push(eq(companies.githubLogin, found.githubLogin));
  if (found.ycSlug) identities.push(eq(companies.ycSlug, found.ycSlug));
  if (identities.length === 0) identities.push(sql`lower(${companies.name}) = lower(${found.name})`);

  const matches = await database.select().from(companies).where(or(...identities)).limit(3);
  const existing = matches[0];
  if (!existing) {
    const [created] = await database
      .insert(companies)
      .values({
        name: found.name,
        domain: found.domain ?? null,
        website: found.website ?? null,
        description: found.description ?? null,
        location: found.location ?? null,
        teamSize: found.teamSize ?? null,
        linkedinUrl: found.linkedinUrl ?? null,
        githubLogin: found.githubLogin ?? null,
        ycSlug: found.ycSlug ?? null,
        ycBatch: found.ycBatch ?? null,
        source,
      })
      .returning();
    return { company: created!, created: true };
  }

  // Fill gaps only: what the owner (or an earlier, better source) set wins.
  // Identity columns are only filled when no other row already claims them.
  const claimed = (column: "domain" | "githubLogin" | "ycSlug", value: string | undefined) =>
    value && !matches.some((row) => row.id !== existing.id && row[column] === value) ? value : null;
  const [updated] = await database
    .update(companies)
    .set({
      domain: existing.domain ?? claimed("domain", found.domain),
      website: existing.website ?? found.website ?? null,
      description: existing.description ?? found.description ?? null,
      location: existing.location ?? found.location ?? null,
      teamSize: existing.teamSize ?? found.teamSize ?? null,
      linkedinUrl: existing.linkedinUrl ?? found.linkedinUrl ?? null,
      githubLogin: existing.githubLogin ?? claimed("githubLogin", found.githubLogin),
      ycSlug: existing.ycSlug ?? claimed("ycSlug", found.ycSlug),
      ycBatch: existing.ycBatch ?? found.ycBatch ?? null,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, existing.id))
    .returning();
  return { company: updated!, created: false };
}

async function insertSignals(companyId: string, found: FoundCompany): Promise<number> {
  if (found.signals.length === 0) return 0;
  const inserted = await getDatabase()
    .insert(signals)
    .values(
      found.signals.map((signal) => ({
        companyId,
        kind: signal.kind,
        title: signal.title,
        detail: signal.detail ?? null,
        url: signal.url ?? null,
        strength: signal.strength,
        dedupeKey: signal.dedupeKey,
        ...(signal.observedAt ? { observedAt: new Date(signal.observedAt) } : {}),
      })),
    )
    .onConflictDoNothing({ target: signals.dedupeKey })
    .returning({ id: signals.id });
  return inserted.length;
}

export async function upsertPerson(companyId: string | null, found: FoundPerson, source: string): Promise<boolean> {
  const database = getDatabase();
  const email = found.email?.toLowerCase();
  const identities: SQL[] = [];
  if (email) identities.push(eq(people.email, email));
  if (found.linkedinUrl) identities.push(eq(people.linkedinUrl, found.linkedinUrl));
  if (found.twitterUrl) identities.push(sql`lower(${people.twitterUrl}) = lower(${found.twitterUrl})`);
  if (companyId) {
    identities.push(and(eq(people.companyId, companyId), sql`lower(${people.name}) = lower(${found.name})`)!);
  }
  const matches = identities.length
    ? await database.select().from(people).where(or(...identities)).limit(3)
    : [];
  const existing = matches[0];
  if (!existing) {
    await database.insert(people).values({
      companyId,
      name: found.name,
      title: found.title ?? null,
      email: email ?? null,
      emailStatus: email ? (found.emailStatus ?? "found") : null,
      linkedinUrl: found.linkedinUrl ?? null,
      twitterUrl: found.twitterUrl ?? null,
      location: found.location ?? null,
      source,
      ...(found.xUserId ? { metadata: { xUserId: found.xUserId } } : {}),
    });
    return true;
  }
  const emailFree = email && !matches.some((row) => row.id !== existing.id && row.email === email);
  const linkedinFree =
    found.linkedinUrl && !matches.some((row) => row.id !== existing.id && row.linkedinUrl === found.linkedinUrl);
  // A found address beats a guessed one; a bounced one is never resurrected.
  const upgradeEmail =
    emailFree && found.emailStatus !== "guessed" && (existing.emailStatus === "guessed" || !existing.email);
  await database
    .update(people)
    .set({
      companyId: existing.companyId ?? companyId,
      title: existing.title ?? found.title ?? null,
      ...(upgradeEmail
        ? { email, emailStatus: "found" as const }
        : !existing.email && emailFree
          ? { email, emailStatus: found.emailStatus ?? ("found" as const) }
          : {}),
      linkedinUrl: existing.linkedinUrl ?? (linkedinFree ? found.linkedinUrl : null) ?? null,
      twitterUrl: existing.twitterUrl ?? found.twitterUrl ?? null,
      location: existing.location ?? found.location ?? null,
      ...(found.xUserId && !existing.metadata.xUserId ? { metadata: { ...existing.metadata, xUserId: found.xUserId } } : {}),
      updatedAt: new Date(),
    })
    .where(eq(people.id, existing.id));
  return false;
}
