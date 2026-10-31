import "server-only";

import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { campaigns, companies, messages, people, signals } from "@/lib/db/schema";
import { DEFAULT_CAMPAIGN } from "@/lib/domain";
import { listConnections, loadApiKey, loadRuntimeState, loadSettings } from "@/lib/store";

const DAY = 24 * 60 * 60 * 1000;

export async function loadToday() {
  const database = getDatabase();
  const now = new Date();
  const queue = await database
    .select({
      message: messages,
      person: {
        id: people.id,
        name: people.name,
        title: people.title,
        email: people.email,
        emailStatus: people.emailStatus,
        linkedinUrl: people.linkedinUrl,
        metadata: people.metadata,
      },
      company: { id: companies.id, name: companies.name, domain: companies.domain, hook: companies.hook },
      campaign: { id: campaigns.id, name: campaigns.name, steps: campaigns.steps },
    })
    .from(messages)
    .innerJoin(people, eq(people.id, messages.personId))
    .leftJoin(companies, eq(companies.id, people.companyId))
    .leftJoin(campaigns, eq(campaigns.id, messages.campaignId))
    .where(
      and(
        eq(messages.direction, "out"),
        or(
          and(eq(messages.status, "draft"), or(isNull(messages.dueAt), lte(messages.dueAt, now))),
          inArray(messages.status, ["failed", "sending"]),
        ),
      ),
    )
    .orderBy(asc(messages.dueAt), asc(messages.createdAt))
    .limit(100);

  const replies = await database
    .select({
      person: { id: people.id, name: people.name, title: people.title, stage: people.stage, repliedAt: people.repliedAt },
      company: { id: companies.id, name: companies.name },
      message: { body: messages.body, channel: messages.channel, sentAt: messages.sentAt },
    })
    .from(messages)
    .innerJoin(people, eq(people.id, messages.personId))
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(and(eq(messages.direction, "in"), eq(people.stage, "replied")))
    .orderBy(desc(messages.sentAt))
    .limit(30);

  // Raw sql params bypass column encoders, so timestamps go in as ISO text.
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  const [stats] = await database
    .select({
      sentWeek: sql<number>`count(*) filter (where ${messages.direction} = 'out' and ${messages.status} = 'sent' and ${messages.sentAt} >= ${weekAgo}::timestamptz)::int`,
      repliesWeek: sql<number>`count(*) filter (where ${messages.direction} = 'in' and ${messages.sentAt} >= ${weekAgo}::timestamptz)::int`,
    })
    .from(messages);
  const [active] = await database.select({ value: count() }).from(people).where(eq(people.stage, "active"));
  const [nextDue] = await database
    .select({ at: people.nextStepAt })
    .from(people)
    .where(and(eq(people.stage, "active"), gte(people.nextStepAt, now)))
    .orderBy(asc(people.nextStepAt))
    .limit(1);

  return {
    queue,
    replies,
    stats: {
      sentWeek: stats?.sentWeek ?? 0,
      repliesWeek: stats?.repliesWeek ?? 0,
      active: active?.value ?? 0,
      nextDueAt: nextDue?.at ?? null,
    },
    runtime: await loadRuntimeState(),
  };
}

export type TodayData = Awaited<ReturnType<typeof loadToday>>;

export async function loadProspects(filters: { q?: string | undefined; view?: string | undefined }) {
  const database = getDatabase();
  const q = filters.q?.trim();
  const view = filters.view ?? "all";
  // Correlated subqueries spell out aliases: Drizzle renders column refs
  // inside raw sql unqualified, which would bind them to the inner table.
  const topStrength = sql<number | null>`(select max(s.strength)::int from signals s where s.company_id = "companies"."id")`;
  const rows = await database
    .select({
      id: companies.id,
      name: companies.name,
      domain: companies.domain,
      description: companies.description,
      ycBatch: companies.ycBatch,
      source: companies.source,
      status: companies.status,
      score: companies.score,
      fitSummary: companies.fitSummary,
      researchedAt: companies.researchedAt,
      createdAt: companies.createdAt,
      signalCount: sql<number>`(select count(*)::int from signals s where s.company_id = "companies"."id")`,
      topSignal: sql<string | null>`(select s.title from signals s where s.company_id = "companies"."id" order by s.strength desc, s.observed_at desc limit 1)`,
      topStrength,
      peopleCount: sql<number>`(select count(*)::int from people p where p.company_id = "companies"."id")`,
      activeCount: sql<number>`(select count(*)::int from people p where p.company_id = "companies"."id" and p.stage <> 'new')`,
    })
    .from(companies)
    .where(
      and(
        view === "archived" ? eq(companies.status, "archived") : sql`${companies.status} <> 'archived'`,
        view === "unresearched" ? isNull(companies.researchedAt) : undefined,
        view === "hot" ? gte(companies.score, 70) : undefined,
        q
          ? or(
              ilike(companies.name, `%${q}%`),
              ilike(companies.domain, `%${q}%`),
              ilike(companies.description, `%${q}%`),
            )
          : undefined,
      ),
    )
    .orderBy(sql`${companies.score} desc nulls last`, sql`${topStrength} desc nulls last`, desc(companies.createdAt))
    .limit(300);
  return rows;
}

export type ProspectRow = Awaited<ReturnType<typeof loadProspects>>[number];

export async function loadCompany(id: string) {
  const database = getDatabase();
  const [company] = await database.select().from(companies).where(eq(companies.id, id)).limit(1);
  if (!company) return null;
  const [companySignals, companyPeople] = await Promise.all([
    database
      .select()
      .from(signals)
      .where(eq(signals.companyId, id))
      .orderBy(desc(signals.strength), desc(signals.observedAt)),
    database.select().from(people).where(eq(people.companyId, id)).orderBy(asc(people.createdAt)),
  ]);
  const personMessages = companyPeople.length
    ? await database
        .select()
        .from(messages)
        .where(inArray(messages.personId, companyPeople.map((p) => p.id)))
        .orderBy(asc(messages.createdAt))
    : [];
  return { company, signals: companySignals, people: companyPeople, messages: personMessages };
}

export type CompanyData = NonNullable<Awaited<ReturnType<typeof loadCompany>>>;

// A fresh install gets one sensible campaign so Enroll works on day one.
async function ensureDefaultCampaign() {
  const database = getDatabase();
  const [existing] = await database.select({ id: campaigns.id }).from(campaigns).limit(1);
  if (!existing) await database.insert(campaigns).values(DEFAULT_CAMPAIGN);
}

export async function loadCampaigns() {
  await ensureDefaultCampaign();
  const database = getDatabase();
  const rows = await database.select().from(campaigns).orderBy(desc(campaigns.active), asc(campaigns.createdAt));
  const stats = await database
    .select({
      campaignId: people.campaignId,
      enrolled: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${people.stage} = 'active')::int`,
      replied: sql<number>`count(*) filter (where ${people.stage} in ('replied', 'meeting'))::int`,
    })
    .from(people)
    .groupBy(people.campaignId);
  const sent = await database
    .select({ campaignId: messages.campaignId, sent: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.direction, "out"), eq(messages.status, "sent")))
    .groupBy(messages.campaignId);
  return rows.map((campaign) => {
    const stat = stats.find((s) => s.campaignId === campaign.id);
    return {
      ...campaign,
      enrolled: stat?.enrolled ?? 0,
      inSequence: stat?.active ?? 0,
      replied: stat?.replied ?? 0,
      sent: sent.find((s) => s.campaignId === campaign.id)?.sent ?? 0,
    };
  });
}

export type CampaignRow = Awaited<ReturnType<typeof loadCampaigns>>[number];

export async function loadCampaignOptions() {
  await ensureDefaultCampaign();
  return getDatabase()
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(eq(campaigns.active, true))
    .orderBy(asc(campaigns.createdAt));
}

export async function loadSettingsData() {
  const [settings, connections, runtime, github, apollo] = await Promise.all([
    loadSettings(),
    listConnections(),
    loadRuntimeState(),
    loadApiKey("github"),
    loadApiKey("apollo"),
  ]);
  return {
    settings,
    runtime,
    gmail: connections.gmail ? { label: connections.gmail.label, lastError: connections.gmail.lastError } : null,
    linkedin: connections.linkedin
      ? { label: connections.linkedin.label, lastError: connections.linkedin.lastError }
      : null,
    keys: {
      github: github ? (connections.github ? "stored" : "env") : null,
      apollo: apollo ? (connections.apollo ? "stored" : "env") : null,
    },
  } as const;
}

export type SettingsData = Awaited<ReturnType<typeof loadSettingsData>>;

export async function sourceAvailability() {
  const [connections, github, apollo] = await Promise.all([listConnections(), loadApiKey("github"), loadApiKey("apollo")]);
  return {
    github: Boolean(github),
    apollo: Boolean(apollo),
    linkedin: Boolean(connections.linkedin),
    gmail: Boolean(connections.gmail),
  };
}
