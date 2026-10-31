import "server-only";

import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { campaigns, companies, messages, people, signals } from "@/lib/db/schema";
import { CHANNEL_LABELS, DEFAULT_CAMPAIGN, readInTouch, X_CAMPAIGN, type Channel } from "@/lib/domain";
import { LinkedinClient, workerConfig } from "@/lib/linkedin";
import { learnLifts, rankInputFor, rankPerson, STAKEHOLDER_LABELS, stakeholderOf, type GroupStat } from "@/lib/rank";
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
        twitterUrl: people.twitterUrl,
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

  // The hourly job (Fly machine threadline-hourly-sync) records what it found
  // broken in runtime.health; if it stops running, that's a problem too.
  const runtime = await loadRuntimeState();
  const stale = !runtime.lastRefreshAt || now.getTime() - Date.parse(runtime.lastRefreshAt) > 3 * 60 * 60 * 1000;

  return {
    queue,
    replies,
    stats: {
      sentWeek: stats?.sentWeek ?? 0,
      repliesWeek: stats?.repliesWeek ?? 0,
      active: active?.value ?? 0,
      nextDueAt: nextDue?.at ?? null,
    },
    runtime,
    attention: [
      ...(runtime.health?.problems ?? []),
      ...(stale ? ["Background checks haven't run in over 3 hours, so replies and problems aren't being picked up."] : []),
    ],
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

// ── People (the CRM) ─────────────────────────────────────────────────────────
// Everyone on file, ranked by rankPerson. "best" is who to contact next: not
// yet in a sequence, not held back as already in touch.

export const PEOPLE_VIEWS = ["best", "active", "replied", "held", "closed", "all"] as const;
export type PeopleView = (typeof PEOPLE_VIEWS)[number];

export async function loadPeople(filters: { view?: string | undefined; q?: string | undefined; campaignId?: string | undefined; limit?: number }) {
  const database = getDatabase();
  const view: PeopleView = (PEOPLE_VIEWS as readonly string[]).includes(filters.view ?? "") ? (filters.view as PeopleView) : "best";
  const q = filters.q?.trim().replace(/[%_\\]/g, "");
  const held = sql`(${people.metadata}->'inTouch' is not null and coalesce(${people.metadata}->>'inTouchOverride', '') <> 'true')`;
  const rows = await database
    .select({ person: people, company: companies, campaign: { id: campaigns.id, name: campaigns.name, steps: campaigns.steps } })
    .from(people)
    .leftJoin(companies, eq(companies.id, people.companyId))
    .leftJoin(campaigns, eq(campaigns.id, people.campaignId))
    .where(
      and(
        view === "best" ? and(eq(people.stage, "new"), sql`not ${held}`, or(isNull(companies.status), sql`${companies.status} <> 'archived'`)) : undefined,
        view === "active" ? eq(people.stage, "active") : undefined,
        view === "replied" ? inArray(people.stage, ["replied", "meeting"]) : undefined,
        view === "held" ? and(inArray(people.stage, ["new", "active"]), held) : undefined,
        view === "closed" ? eq(people.stage, "closed") : undefined,
        filters.campaignId ? eq(people.campaignId, filters.campaignId) : undefined,
        q ? or(ilike(people.name, `%${q}%`), ilike(people.title, `%${q}%`), ilike(companies.name, `%${q}%`)) : undefined,
      ),
    )
    .orderBy(desc(people.updatedAt))
    .limit(1000);
  const learning = await loadLearning();
  const ranked = rows.map(({ person, company, campaign }) => ({
    id: person.id,
    name: person.name,
    title: person.title,
    email: person.email,
    emailStatus: person.emailStatus,
    linkedinUrl: person.linkedinUrl,
    twitterUrl: person.twitterUrl,
    stage: person.stage,
    closedReason: person.closedReason,
    nextStep: person.nextStep,
    nextStepAt: person.nextStepAt,
    lastContactedAt: person.lastContactedAt,
    repliedAt: person.repliedAt,
    inTouch: readInTouch(person.metadata),
    included: person.metadata.inTouchOverride === true,
    company: company ? { id: company.id, name: company.name, score: company.score, domain: company.domain } : null,
    campaign: campaign ? { id: campaign.id, name: campaign.name, steps: campaign.steps.length } : null,
    rank: rankPerson(rankInputFor(person, company), learning.lifts),
  }));
  const time = (value: Date | null) => value?.getTime() ?? 0;
  ranked.sort(
    view === "active"
      ? (a, b) => (time(a.nextStepAt) || Infinity) - (time(b.nextStepAt) || Infinity)
      : view === "replied"
        ? (a, b) => time(b.repliedAt) - time(a.repliedAt)
        : view === "closed"
          ? () => 0
          : (a, b) => b.rank.score - a.rank.score,
  );
  return { view, rows: ranked.slice(0, filters.limit ?? 300), total: ranked.length, learning };
}

export type PeopleData = Awaited<ReturnType<typeof loadPeople>>;
export type PersonRow = PeopleData["rows"][number];

// Reply rates among everyone Threadline has written to, by role, by the
// channel of the first message, and by campaign. The role lifts feed ranking.
async function loadLearning() {
  const contacted = await getDatabase()
    .select({
      title: people.title,
      stage: people.stage,
      repliedAt: people.repliedAt,
      campaign: campaigns.name,
      firstChannel: sql<Channel | null>`(select m.channel from messages m where m.person_id = "people"."id" and m.direction = 'out' and m.status = 'sent' order by m.sent_at asc limit 1)`,
    })
    .from(people)
    .leftJoin(campaigns, eq(campaigns.id, people.campaignId))
    .where(isNotNull(people.lastContactedAt));
  const group = (keyOf: (row: (typeof contacted)[number]) => string) => {
    const groups = new Map<string, GroupStat>();
    for (const row of contacted) {
      const key = keyOf(row);
      const stat = groups.get(key) ?? { key, contacted: 0, replied: 0 };
      stat.contacted += 1;
      if (row.repliedAt || row.stage === "replied" || row.stage === "meeting") stat.replied += 1;
      groups.set(key, stat);
    }
    return [...groups.values()].sort((a, b) => b.contacted - a.contacted);
  };
  const byRole = group((row) => stakeholderOf(row.title));
  return {
    contacted: contacted.length,
    replied: byRole.reduce((sum, stat) => sum + stat.replied, 0),
    byRole: byRole.map((stat) => ({ ...stat, label: STAKEHOLDER_LABELS[stat.key as keyof typeof STAKEHOLDER_LABELS] ?? stat.key })),
    byChannel: group((row) => row.firstChannel ?? "none").map((stat) => ({
      ...stat,
      label: stat.key === "none" ? "Unknown" : CHANNEL_LABELS[stat.key as Channel],
    })),
    byCampaign: group((row) => row.campaign ?? "No campaign").map((stat) => ({ ...stat, label: stat.key })),
    lifts: learnLifts(byRole),
  };
}

export async function loadCampaign(id: string) {
  await ensureDefaultCampaign();
  const [campaign] = await getDatabase().select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  if (!campaign) return null;
  const [members, suggestions, runtime] = await Promise.all([
    loadPeople({ view: "all", campaignId: id }),
    loadPeople({ view: "best", limit: 15 }),
    loadRuntimeState(),
  ]);
  return { campaign, members: members.rows, suggestions: suggestions.rows, sourcedAt: runtime.sourcedAt?.[id] ?? null };
}

export type CampaignData = NonNullable<Awaited<ReturnType<typeof loadCampaign>>>;

// A fresh install gets one sensible campaign so Enroll works on day one.
async function ensureDefaultCampaign() {
  const database = getDatabase();
  const [existing] = await database.select({ id: campaigns.id }).from(campaigns).limit(1);
  if (!existing) await database.insert(campaigns).values([DEFAULT_CAMPAIGN, X_CAMPAIGN]);
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
  const [settings, connections, runtime, github, apollo, linkedin] = await Promise.all([
    loadSettings(),
    listConnections(),
    loadRuntimeState(),
    loadApiKey("github"),
    loadApiKey("apollo"),
    linkedinWorkerState(),
  ]);
  return {
    settings,
    runtime,
    gmail: connections.gmail ? { label: connections.gmail.label, lastError: connections.gmail.lastError } : null,
    linkedin,
    keys: {
      github: github ? (connections.github ? "stored" : "env") : null,
      apollo: apollo ? (connections.apollo ? "stored" : "env") : null,
    },
  } as const;
}

export type SettingsData = Awaited<ReturnType<typeof loadSettingsData>>;

export async function sourceAvailability() {
  const [connections, github, apollo, linkedin] = await Promise.all([
    listConnections(),
    loadApiKey("github"),
    loadApiKey("apollo"),
    linkedinWorkerState(),
  ]);
  return {
    github: Boolean(github),
    apollo: Boolean(apollo),
    linkedin: linkedin.state === "signed_in",
    gmail: Boolean(connections.gmail),
  };
}

// The worker is the source of truth for LinkedIn: it holds the session.
async function linkedinWorkerState(): Promise<
  | { state: "unconfigured" }
  | { state: "unreachable"; error: string }
  | {
      state: "signed_in" | "signed_out";
      expiresAt: string | null;
      verifiedAt: string | null;
      lastCheck: string | null;
      busy: boolean;
      home: { online: boolean; detail: string } | null;
    }
> {
  const config = workerConfig();
  if (!config) return { state: "unconfigured" };
  try {
    const status = await new LinkedinClient(config).status();
    return {
      state: status.linkedin.signedIn ? "signed_in" : "signed_out",
      expiresAt: status.linkedin.expiresAt ?? null,
      verifiedAt: status.linkedin.verifiedAt ?? null,
      lastCheck: status.linkedin.lastCheck ?? null,
      busy: Boolean(status.busy),
      home: status.home ?? null,
    };
  } catch (error) {
    return { state: "unreachable", error: error instanceof Error ? error.message : "unreachable" };
  }
}
