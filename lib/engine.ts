import "server-only";

import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";

import { draftStep, researchCompany } from "@/lib/ai";
import { getDatabase } from "@/lib/db/client";
import {
  campaigns,
  companies,
  messages,
  people,
  signals,
  type Campaign,
  type Message,
  type Person,
} from "@/lib/db/schema";
import { LINKEDIN_CHANNELS, type Channel } from "@/lib/domain";
import { GmailClient } from "@/lib/gmail";
import { ingest, upsertPerson } from "@/lib/ingest";
import { LinkedinClient, normalizeLinkedinUrl, parseLinkedinTime, peopleFromSearch, repliesFromInbox } from "@/lib/linkedin";
import { apolloFindPeople, apolloRevealEmail } from "@/lib/sources/apollo";
import { domainAcceptsMail, guessEmail } from "@/lib/sources/email-guess";
import { checkOrgForMacCi } from "@/lib/sources/github";
import type { FoundPerson } from "@/lib/sources/types";
import { fetchWebsite } from "@/lib/sources/website";
import { fetchYcCompany } from "@/lib/sources/yc";
import {
  loadApiKey,
  loadRuntimeState,
  loadSettings,
  recordConnectionError,
  saveRuntimeState,
} from "@/lib/store";

const DAY = 24 * 60 * 60 * 1000;
// After the last step, wait this long for a reply before closing as no_reply.
const FINAL_GRACE_DAYS = 7;
const CLOSED_FOR_OUTREACH = ["replied", "meeting", "closed"] as const;

const isLinkedin = (channel: Channel) => (LINKEDIN_CHANNELS as readonly Channel[]).includes(channel);

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

// ── Research ────────────────────────────────────────────────────────────────

export async function researchCompanyById(companyId: string) {
  const database = getDatabase();
  const [company] = await database.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) throw new Error("Company not found.");

  const website = company.website ? await fetchWebsite(company.website).catch(() => null) : null;
  const githubLogin = company.githubLogin ?? githubLoginFrom(website?.links.github);
  const githubToken = githubLogin ? await loadApiKey("github") : null;
  if (githubLogin && githubToken) {
    const found = await checkOrgForMacCi({ token: githubToken, login: githubLogin }).catch(() => []);
    if (found.length) {
      await ingest({
        source: "github",
        warnings: [],
        companies: [{ name: company.name, githubLogin, ...(company.domain ? { domain: company.domain } : {}), signals: found, people: [] }],
      });
    }
  }
  if (website?.mentions.length) {
    await database
      .insert(signals)
      .values({
        companyId,
        kind: "website",
        title: `Website mentions ${website.mentions.slice(0, 5).join(", ")}`,
        url: website.url,
        strength: website.mentions.some((m) => /xcode|testflight|simulator|macos|ios/i.test(m)) ? 2 : 1,
        dedupeKey: `website:${companyId}:${website.mentions.sort().join(",")}`,
      })
      .onConflictDoNothing({ target: signals.dedupeKey });
  }

  const companySignals = await database
    .select()
    .from(signals)
    .where(eq(signals.companyId, companyId))
    .orderBy(desc(signals.strength), desc(signals.observedAt))
    .limit(12);
  const research = await researchCompany({
    settings: await loadSettings(),
    company,
    signals: companySignals,
    website,
  });
  await database
    .update(companies)
    .set({
      score: research.score,
      fitSummary: research.fitSummary,
      hook: research.hook || null,
      researchedAt: new Date(),
      githubLogin: company.githubLogin ?? githubLogin ?? null,
      linkedinUrl: company.linkedinUrl ?? website?.links.linkedin ?? null,
      metadata: sql`${companies.metadata} || ${JSON.stringify({
        targetTitles: research.targetTitles,
        website: website
          ? { title: website.title ?? null, description: website.description ?? null, mentions: website.mentions, emails: website.emails }
          : null,
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, companyId));
  return research;
}

function githubLoginFrom(url: string | undefined) {
  const match = url?.match(/github\.com\/([A-Za-z0-9-]+)/i);
  return match?.[1]?.toLowerCase();
}

// ── People ──────────────────────────────────────────────────────────────────

export async function findPeopleForCompany(companyId: string) {
  const database = getDatabase();
  const [company] = await database.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) throw new Error("Company not found.");
  const found: FoundPerson[] = [];
  const notes: string[] = [];

  if (company.ycSlug) {
    const yc = await fetchYcCompany({ slug: company.ycSlug }).catch(() => null);
    if (yc) {
      found.push(...yc.people);
      await ingest({ source: "yc", warnings: [], companies: [{ ...yc, people: [] }] });
    }
  }
  const apolloKey = await loadApiKey("apollo");
  if (apolloKey && company.domain) {
    try {
      found.push(...(await apolloFindPeople({ apiKey: apolloKey, domain: company.domain, limit: 5 })));
    } catch (error) {
      notes.push(error instanceof Error ? error.message : "Apollo search failed.");
    }
  }
  const pendingSearch = typeof company.metadata.linkedinSearchRun === "string" ? company.metadata.linkedinSearchRun : null;
  if (found.length < 2 || pendingSearch) {
    const linkedin = await LinkedinClient.load();
    if (linkedin) {
      try {
        // A search takes a minute or two in the browser. If it isn't done in
        // time, its run id waits on the company for the next "Find people".
        const workflowId = pendingSearch ?? (await linkedin.startSearchPeople({ company: company.name, limit: 15 }));
        const state = await linkedin.waitFor(workflowId, 100_000);
        const stillRunning = state.status === "pending" || state.status === "running";
        await database
          .update(companies)
          .set({
            metadata: stillRunning
              ? { ...company.metadata, linkedinSearchRun: workflowId }
              : Object.fromEntries(Object.entries(company.metadata).filter(([key]) => key !== "linkedinSearchRun")),
            updatedAt: new Date(),
          })
          .where(eq(companies.id, company.id));
        if (state.status === "completed") found.push(...peopleFromSearch(state.data));
        else if (state.status === "failed") notes.push(`LinkedIn search: ${state.message}`);
        else notes.push("LinkedIn search is still running in the browser. Click Find people again in a minute to collect it.");
      } catch (error) {
        notes.push(error instanceof Error ? error.message : "LinkedIn search failed.");
      }
    }
  }
  if (!found.length && !notes.length) {
    notes.push("No people found. Connect LinkedIn or add an Apollo key in Settings, or add someone by hand.");
  }

  const acceptsMail = company.domain ? await domainAcceptsMail(company.domain) : false;
  let added = 0;
  for (const person of dedupePeople(found)) {
    let email = person.email;
    let emailStatus = person.emailStatus;
    if (!email && company.domain && acceptsMail) {
      const guessed = guessEmail(person.name, company.domain);
      if (guessed) {
        email = guessed;
        emailStatus = "guessed";
      }
    }
    if (await upsertPerson(companyId, { ...person, ...(email ? { email, emailStatus } : {}) }, "find-people")) {
      added += 1;
    }
  }
  return { found: found.length, added, notes };
}

function dedupePeople(found: FoundPerson[]) {
  const seen = new Map<string, FoundPerson>();
  for (const person of found) {
    const key = person.linkedinUrl ? normalizeLinkedinUrl(person.linkedinUrl) : person.name.toLowerCase();
    seen.set(key, { ...seen.get(key), ...person });
  }
  return [...seen.values()];
}

export async function revealEmail(personId: string) {
  const database = getDatabase();
  const [row] = await database
    .select({ person: people, domain: companies.domain })
    .from(people)
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(eq(people.id, personId))
    .limit(1);
  if (!row) throw new Error("Person not found.");
  const apiKey = await loadApiKey("apollo");
  if (!apiKey) throw new Error("Add an Apollo API key in Settings to look up verified emails.");
  const email = await apolloRevealEmail({
    apiKey,
    name: row.person.name,
    ...(row.domain ? { domain: row.domain } : {}),
    ...(row.person.linkedinUrl ? { linkedinUrl: row.person.linkedinUrl } : {}),
  });
  if (!email) return null;
  await database
    .update(people)
    .set({ email: email.toLowerCase(), emailStatus: "found", updatedAt: new Date() })
    .where(eq(people.id, personId));
  return email;
}

// ── Sequences ───────────────────────────────────────────────────────────────

export async function enroll(personIds: string[], campaignId: string) {
  const database = getDatabase();
  const [campaign] = await database.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  if (!campaign) throw new Error("Campaign not found.");
  const enrolled = await database
    .update(people)
    .set({ campaignId, stage: "active", nextStep: 0, nextStepAt: new Date(), closedReason: null, updatedAt: new Date() })
    .where(
      and(
        inArray(people.id, personIds),
        or(inArray(people.stage, ["new", "active"]), and(eq(people.stage, "closed"), eq(people.closedReason, "no_reply"))),
        // Re-enrolling in the same campaign would collide with its own drafts.
        ne(sql`coalesce(${people.campaignId}::text, '')`, campaignId),
      ),
    )
    .returning({ id: people.id });
  for (const { id } of enrolled) await skipOpenDrafts(id, "Moved to another campaign");
  await notePriorThreads(enrolled.map((p) => p.id)).catch(() => undefined);
  const drafted = await draftDue({ personIds: enrolled.map((p) => p.id) });
  return { enrolled: enrolled.length, skipped: personIds.length - enrolled.length, ...drafted };
}

// Live Gmail lookup instead of a synced history: if the owner has already
// emailed someone, drafts must not read as a cold intro.
async function notePriorThreads(personIds: string[]) {
  const gmail = await GmailClient.load();
  if (!gmail || !personIds.length) return;
  const database = getDatabase();
  const rows = await database
    .select({ id: people.id, email: people.email })
    .from(people)
    .where(and(inArray(people.id, personIds), isNotNull(people.email)));
  await mapLimit(rows, 4, async (row) => {
    const priorThreads = await gmail.countThreadsWith(row.email!);
    await database
      .update(people)
      .set({ metadata: sql`${people.metadata} || ${JSON.stringify({ priorThreads })}::jsonb` })
      .where(eq(people.id, row.id));
  });
}

export async function stopSequence(personId: string, reason: string) {
  const database = getDatabase();
  await database
    .update(people)
    .set({ stage: "closed", closedReason: reason, nextStepAt: null, updatedAt: new Date() })
    .where(eq(people.id, personId));
  await skipOpenDrafts(personId, "Sequence stopped");
}

async function skipOpenDrafts(personId: string, why: string) {
  await getDatabase()
    .update(messages)
    .set({ status: "skipped", error: why, updatedAt: new Date() })
    .where(and(eq(messages.personId, personId), inArray(messages.status, ["draft", "failed"])));
}

async function advance(person: Pick<Person, "id">, campaign: Campaign, sentStep: number, from: Date) {
  const next = campaign.steps[sentStep + 1];
  await getDatabase()
    .update(people)
    .set({
      nextStep: sentStep + 1,
      nextStepAt: new Date(from.getTime() + (next ? next.waitDays : FINAL_GRACE_DAYS) * DAY),
      updatedAt: new Date(),
    })
    .where(eq(people.id, person.id));
}

// Writes drafts for every active person whose next step is due. Steps the
// person can't receive (no email, no LinkedIn URL, bounced) are skipped so the
// sequence keeps moving instead of stalling silently.
export async function draftDue(options: { personIds?: string[]; limit?: number } = {}) {
  if (options.personIds && options.personIds.length === 0) return { drafted: 0, closed: 0, errors: [] as string[] };
  const database = getDatabase();
  const now = new Date();
  const due = await database
    .select({ person: people, campaign: campaigns })
    .from(people)
    .innerJoin(campaigns, eq(campaigns.id, people.campaignId))
    .where(
      and(
        eq(people.stage, "active"),
        eq(campaigns.active, true),
        lte(people.nextStepAt, now),
        options.personIds ? inArray(people.id, options.personIds) : undefined,
      ),
    )
    .orderBy(asc(people.nextStepAt))
    .limit(options.limit ?? 25);

  const settings = await loadSettings();
  let drafted = 0;
  let closed = 0;
  const errors: string[] = [];
  await mapLimit(due, 4, async ({ person, campaign }) => {
    let current = person;
    // Bounded: a person can skip through at most every step in one pass.
    for (let guard = 0; guard <= campaign.steps.length; guard += 1) {
      const step = campaign.steps[current.nextStep];
      if (!step) {
        await database
          .update(people)
          .set({ stage: "closed", closedReason: "no_reply", nextStepAt: null, updatedAt: new Date() })
          .where(eq(people.id, current.id));
        closed += 1;
        return;
      }
      const unreachable =
        step.channel === "email"
          ? !current.email || current.emailStatus === "bounced"
            ? "No usable email address"
            : null
          : step.channel === "x_dm"
            ? !current.twitterUrl
              ? "No X profile"
              : null
            : !current.linkedinUrl
              ? "No LinkedIn profile"
              : null;
      const [existing] = await database
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.personId, current.id), eq(messages.campaignId, campaign.id), eq(messages.step, current.nextStep)))
        .limit(1);
      if (existing) return;
      if (unreachable) {
        await database.insert(messages).values({
          personId: current.id,
          campaignId: campaign.id,
          step: current.nextStep,
          channel: step.channel,
          status: "skipped",
          body: "",
          error: unreachable,
        });
        const [updated] = await database
          .update(people)
          .set({ nextStep: current.nextStep + 1, nextStepAt: new Date(), updatedAt: new Date() })
          .where(eq(people.id, current.id))
          .returning();
        current = updated!;
        continue;
      }
      try {
        const context = await draftingContext(current);
        const draft = await draftStep({
          settings,
          campaign,
          stepIndex: current.nextStep,
          person: current,
          company: context.company,
          signals: context.signals,
          history: context.history,
          priorThreads: context.priorThreads,
        });
        await database
          .insert(messages)
          .values({
            personId: current.id,
            campaignId: campaign.id,
            step: current.nextStep,
            channel: step.channel,
            subject: draft.subject,
            body: draft.body,
            dueAt: current.nextStepAt ?? now,
          })
          .onConflictDoNothing();
        drafted += 1;
      } catch (error) {
        errors.push(`${current.name}: ${describeError(error)}`);
      }
      return;
    }
  });
  return { drafted, closed, errors };
}

async function draftingContext(person: Person) {
  const database = getDatabase();
  const [company] = person.companyId
    ? await database.select().from(companies).where(eq(companies.id, person.companyId)).limit(1)
    : [];
  const companySignals = person.companyId
    ? await database
        .select()
        .from(signals)
        .where(eq(signals.companyId, person.companyId))
        .orderBy(desc(signals.strength), desc(signals.observedAt))
        .limit(8)
    : [];
  const history = await database
    .select()
    .from(messages)
    .where(and(eq(messages.personId, person.id), inArray(messages.status, ["sent", "received"])))
    .orderBy(asc(messages.createdAt))
    .limit(12);
  const priorThreads = typeof person.metadata.priorThreads === "number" ? person.metadata.priorThreads : 0;
  return { company: company ?? null, signals: companySignals, history, priorThreads };
}

export async function redraft(messageId: string) {
  const database = getDatabase();
  const [row] = await database
    .select({ message: messages, person: people, campaign: campaigns })
    .from(messages)
    .innerJoin(people, eq(people.id, messages.personId))
    .innerJoin(campaigns, eq(campaigns.id, messages.campaignId))
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!row || row.message.step === null) throw new Error("Draft not found.");
  if (!["draft", "failed"].includes(row.message.status)) throw new Error("Only unsent drafts can be rewritten.");
  const context = await draftingContext(row.person);
  const draft = await draftStep({
    settings: await loadSettings(),
    campaign: row.campaign,
    stepIndex: row.message.step,
    person: row.person,
    company: context.company,
    signals: context.signals,
    history: context.history,
    priorThreads: context.priorThreads,
  });
  await database
    .update(messages)
    .set({ subject: draft.subject, body: draft.body, status: "draft", error: null, updatedAt: new Date() })
    .where(eq(messages.id, messageId));
  return draft;
}

export async function skipMessage(messageId: string) {
  const database = getDatabase();
  const [message] = await database
    .update(messages)
    .set({ status: "skipped", updatedAt: new Date() })
    .where(and(eq(messages.id, messageId), inArray(messages.status, ["draft", "failed"])))
    .returning();
  if (!message || message.step === null) return;
  await database
    .update(people)
    .set({ nextStep: message.step + 1, nextStepAt: new Date(), updatedAt: new Date() })
    .where(and(eq(people.id, message.personId), eq(people.nextStep, message.step)));
}

async function sentInLastDay(linkedin: boolean) {
  const [row] = await getDatabase()
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.direction, "out"),
        inArray(messages.status, ["sent", "sending"]),
        gte(messages.sentAt, new Date(Date.now() - DAY)),
        linkedin ? inArray(messages.channel, LINKEDIN_CHANNELS) : eq(messages.channel, "email"),
      ),
    );
  return row?.count ?? 0;
}

export type SendOutcome =
  | { status: "sent" }
  | { status: "pending"; detail: string }
  | { status: "skipped"; detail: string }
  | { status: "failed"; detail: string };

// The only path that talks to the outside world, and only ever for one draft
// the owner explicitly approved.
export async function sendMessage(
  messageId: string,
  edits?: { subject?: string | null | undefined; body?: string | undefined },
): Promise<SendOutcome> {
  const database = getDatabase();
  const settings = await loadSettings();
  // Claiming the row first makes a double click (or two tabs) send once.
  const [message] = await database
    .update(messages)
    .set({
      status: "sending",
      error: null,
      sentAt: new Date(),
      ...(edits?.body !== undefined ? { body: edits.body } : {}),
      ...(edits?.subject !== undefined ? { subject: edits.subject } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(messages.id, messageId), eq(messages.direction, "out"), inArray(messages.status, ["draft", "failed"])))
    .returning();
  if (!message) return { status: "skipped", detail: "Already sent or no longer a draft." };

  const fail = async (detail: string, status: "failed" | "skipped" = "failed") => {
    await database
      .update(messages)
      .set({ status, error: detail.slice(0, 300), sentAt: null, updatedAt: new Date() })
      .where(eq(messages.id, message.id));
    return { status, detail } as const;
  };

  const [person] = await database.select().from(people).where(eq(people.id, message.personId)).limit(1);
  if (!person) return fail("Person no longer exists.");
  if ((CLOSED_FOR_OUTREACH as readonly string[]).includes(person.stage)) {
    return fail(`Not sent: ${person.name} is ${person.stage}.`, "skipped");
  }
  const linkedin = isLinkedin(message.channel);
  const limit = linkedin ? settings.dailyLinkedinLimit : settings.dailyEmailLimit;
  // The claimed row already counts itself. X DMs are sent by hand inside X.
  if (message.channel !== "x_dm" && (await sentInLastDay(linkedin)) > limit) {
    return fail(`Daily ${linkedin ? "LinkedIn" : "email"} limit (${limit}) reached. Try again tomorrow.`);
  }
  if (person.lastContactedAt) {
    const replied = await checkReplies([person]).catch(() => 0);
    if (replied) return fail(`Not sent: ${person.name} already replied.`, "skipped");
  }
  const [campaign] = message.campaignId
    ? await database.select().from(campaigns).where(eq(campaigns.id, message.campaignId)).limit(1)
    : [];

  try {
    if (message.channel === "email") {
      if (!person.email || person.emailStatus === "bounced") return fail("No usable email address.");
      const gmail = await GmailClient.load();
      if (!gmail) return fail("Connect Gmail in Settings first.");
      const thread = await previousEmails(person.id, message.campaignId);
      const first = thread[0];
      const last = thread.at(-1);
      const subject = first?.subject
        ? first.subject.toLowerCase().startsWith("re:")
          ? first.subject
          : `Re: ${first.subject}`
        : message.subject?.trim() || `${settings.productName} for ${person.name.split(/\s+/)[0]}`;
      const body = settings.signature.trim() ? `${message.body.trim()}\n\n${settings.signature.trim()}` : message.body.trim();
      const sent = await gmail.send({
        fromName: settings.senderName,
        to: person.email,
        toName: person.name,
        subject,
        body,
        threadId: last?.threadId ?? undefined,
        inReplyTo: typeof last?.metadata.rfcMessageId === "string" ? last.metadata.rfcMessageId : undefined,
      });
      await markSent(message, person, campaign, {
        externalId: sent.id,
        threadId: sent.threadId,
        subject,
        metadata: sent.rfcMessageId ? { rfcMessageId: sent.rfcMessageId } : {},
      });
      return { status: "sent" };
    }

    if (message.channel === "x_dm") {
      // Today opened X with this text prefilled; the owner presses send there.
      // There is no X API call here and no way to confirm it beyond their click.
      if (!person.twitterUrl) return fail("No X profile.");
      await markSent(message, person, campaign, {});
      return { status: "sent" };
    }

    if (!person.linkedinUrl) return fail("No LinkedIn profile URL.");
    const client = await LinkedinClient.load();
    if (!client) return fail("LinkedIn isn't signed in on the browser worker. Sign in to LinkedIn in Settings.");
    const workflowId =
      message.channel === "linkedin_invite"
        ? await client.startConnectionRequest(person.linkedinUrl, message.body.slice(0, settings.inviteNoteLimit))
        : await client.startMessage(person.linkedinUrl, message.body);
    await database.update(messages).set({ externalId: workflowId }).where(eq(messages.id, message.id));
    // Browser runs take ~30s–2min; most finish inside this wait.
    return await resolveLinkedinSend({ ...message, externalId: workflowId }, client, 75_000);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Send failed.";
    if (message.channel === "email") await recordConnectionError("gmail", detail);
    return fail(detail);
  }
}

async function previousEmails(personId: string, campaignId: string | null) {
  return getDatabase()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.personId, personId),
        eq(messages.channel, "email"),
        eq(messages.status, "sent"),
        campaignId ? eq(messages.campaignId, campaignId) : undefined,
      ),
    )
    .orderBy(asc(messages.sentAt));
}

async function markSent(
  message: Message,
  person: Person,
  campaign: Campaign | undefined,
  patch: { externalId?: string; threadId?: string; subject?: string; metadata?: Record<string, unknown> },
) {
  const database = getDatabase();
  const sentAt = message.sentAt ?? new Date();
  await database
    .update(messages)
    .set({
      status: "sent",
      sentAt,
      error: null,
      ...(patch.externalId ? { externalId: patch.externalId } : {}),
      ...(patch.threadId ? { threadId: patch.threadId } : {}),
      ...(patch.subject ? { subject: patch.subject } : {}),
      ...(patch.metadata ? { metadata: sql`${messages.metadata} || ${JSON.stringify(patch.metadata)}::jsonb` } : {}),
      updatedAt: new Date(),
    })
    .where(eq(messages.id, message.id));
  await database
    .update(people)
    .set({ lastContactedAt: sentAt, stage: person.stage === "new" ? "active" : person.stage, updatedAt: new Date() })
    .where(eq(people.id, person.id));
  if (campaign && message.step !== null) await advance(person, campaign, message.step, sentAt);
}

// LinkedIn outcomes that mean "this step is moot": its goal is already met, or
// (for a message) they haven't accepted the invite, so the step is passed over.
const LINKEDIN_ALREADY = ["alreadyConnected", "alreadyPending", "notConnected"];

async function resolveLinkedinSend(message: Message, client: LinkedinClient, budgetMs: number): Promise<SendOutcome> {
  const database = getDatabase();
  if (!message.externalId) return { status: "failed", detail: "Missing workflow id." };
  const state = await client.waitFor(message.externalId, budgetMs);
  if (state.status === "pending" || state.status === "running") {
    return { status: "pending", detail: "Queued on LinkedIn; it will be confirmed on the next refresh." };
  }
  const [person] = await database.select().from(people).where(eq(people.id, message.personId)).limit(1);
  const [campaign] = message.campaignId
    ? await database.select().from(campaigns).where(eq(campaigns.id, message.campaignId)).limit(1)
    : [];
  if (!person) return { status: "failed", detail: "Person no longer exists." };
  if (state.status === "completed") {
    await markSent(message, person, campaign, state.detail ? { metadata: { note: state.detail } } : {});
    return { status: "sent" };
  }
  if (LINKEDIN_ALREADY.includes(state.code)) {
    await database
      .update(messages)
      .set({ status: "skipped", error: state.message.slice(0, 300), updatedAt: new Date() })
      .where(eq(messages.id, message.id));
    if (campaign && message.step !== null) await advance(person, campaign, message.step, new Date());
    return { status: "skipped", detail: state.message };
  }
  await database
    .update(messages)
    .set({ status: "failed", error: state.message.slice(0, 300), sentAt: null, updatedAt: new Date() })
    .where(eq(messages.id, message.id));
  return { status: "failed", detail: state.message };
}

// ── Replies ─────────────────────────────────────────────────────────────────

async function markReplied(person: Person, reply: { at: Date; body: string; channel: Channel }) {
  const database = getDatabase();
  await database.insert(messages).values({
    personId: person.id,
    campaignId: person.campaignId,
    channel: reply.channel,
    direction: "in",
    status: "received",
    body: reply.body.slice(0, 2000),
    sentAt: reply.at,
  });
  await database
    .update(people)
    .set({ stage: "replied", repliedAt: reply.at, nextStepAt: null, updatedAt: new Date() })
    .where(eq(people.id, person.id));
  await skipOpenDrafts(person.id, "They replied");
}

async function checkReplies(candidates: Person[]): Promise<number> {
  const gmail = await GmailClient.load();
  if (!gmail || candidates.length === 0) return 0;
  const database = getDatabase();
  const sent = await database
    .select({ personId: messages.personId, threadId: messages.threadId, sentAt: messages.sentAt })
    .from(messages)
    .where(
      and(
        inArray(messages.personId, candidates.map((p) => p.id)),
        eq(messages.channel, "email"),
        eq(messages.status, "sent"),
        isNotNull(messages.sentAt),
      ),
    );
  let replied = 0;
  await mapLimit(candidates, 4, async (person) => {
    const mine = sent.filter((m) => m.personId === person.id);
    if (!mine.length) return;
    const since = new Date(Math.min(...mine.map((m) => m.sentAt!.getTime())));
    const threadIds = [...new Set(mine.map((m) => m.threadId).filter((id): id is string => Boolean(id)))];
    const reply = await gmail.findReply({ email: person.email, threadIds, since });
    if (!reply) return;
    if (reply.bounced) {
      await database
        .update(people)
        .set({ emailStatus: "bounced", updatedAt: new Date() })
        .where(eq(people.id, person.id));
      await database
        .update(messages)
        .set({ status: "skipped", error: "Email bounced", updatedAt: new Date() })
        .where(and(eq(messages.personId, person.id), eq(messages.channel, "email"), inArray(messages.status, ["draft", "failed"])));
      return;
    }
    await markReplied(person, { at: reply.at, body: reply.snippet, channel: "email" });
    replied += 1;
  });
  return replied;
}

// Reading the LinkedIn inbox is a browser run that takes a minute or two, so
// one refresh starts it and a later one (the hourly cron, or the next "Check
// replies") collects it. At most one run every few hours, and only while
// someone we reached on LinkedIn is still in a sequence.
const INBOX_EVERY_MS = 4 * 60 * 60 * 1000;

async function checkLinkedinReplies(): Promise<number> {
  const client = await LinkedinClient.load();
  if (!client) return 0;
  const database = getDatabase();
  const state = await loadRuntimeState();
  const now = new Date();

  if (!state.linkedinInboxRun) {
    const due = !state.linkedinInboxCheckedAt || now.getTime() - Date.parse(state.linkedinInboxCheckedAt) > INBOX_EVERY_MS;
    if (!due) return 0;
    const [anyone] = await database
      .select({ id: people.id })
      .from(people)
      .innerJoin(messages, eq(messages.personId, people.id))
      .where(and(eq(people.stage, "active"), inArray(messages.channel, LINKEDIN_CHANNELS), eq(messages.status, "sent")))
      .limit(1);
    if (!anyone) return 0;
    await saveRuntimeState({ linkedinInboxRun: await client.startInboxCheck(), linkedinInboxCheckedAt: now.toISOString() });
    return 0;
  }

  const run = await client.workflow(state.linkedinInboxRun);
  if (run.status === "pending" || run.status === "running") return 0;
  await saveRuntimeState({ linkedinInboxRun: null });
  if (run.status === "failed") {
    throw new Error(run.message);
  }

  const contacted = await database
    .select({ person: people, firstSentAt: sql<string>`min(${messages.sentAt})` })
    .from(people)
    .innerJoin(messages, eq(messages.personId, people.id))
    .where(and(eq(people.stage, "active"), inArray(messages.channel, LINKEDIN_CHANNELS), eq(messages.status, "sent")))
    .groupBy(people.id);
  // The inbox list shows names, not profile URLs.
  const byName = new Map(contacted.map((row) => [nameKey(row.person.name), row]));
  let replied = 0;
  for (const reply of repliesFromInbox(run.data)) {
    const match = byName.get(nameKey(reply.name));
    if (!match) continue;
    byName.delete(nameKey(reply.name));
    // An older thread where they spoke last isn't a reply to us. When the time
    // can't be read, stop anyway: a missed reply is worse than a paused sequence.
    const at = parseLinkedinTime(reply.when, now);
    if (at && match.firstSentAt && at.getTime() < Date.parse(match.firstSentAt) - DAY) continue;
    await markReplied(match.person, { at: at ?? now, body: reply.preview, channel: "linkedin_message" });
    replied += 1;
  }
  return replied;
}

const nameKey = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");

// Daily cron + the owner's Refresh button: confirm queued LinkedIn sends,
// detect replies and bounces, then draft whatever follow-ups came due.
export async function refresh() {
  const database = getDatabase();
  const problems: string[] = [];

  const pendingLinkedin = await database
    .select()
    .from(messages)
    .where(and(eq(messages.status, "sending"), inArray(messages.channel, LINKEDIN_CHANNELS), isNotNull(messages.externalId)))
    .limit(20);
  if (pendingLinkedin.length) {
    const client = await LinkedinClient.load();
    if (client) {
      for (const message of pendingLinkedin) {
        await resolveLinkedinSend(message, client, 0).catch(() => undefined);
      }
    }
  }

  const active = await database
    .select()
    .from(people)
    .where(and(eq(people.stage, "active"), isNotNull(people.lastContactedAt)));
  const emailReplies = await checkReplies(active).catch((error: unknown) => {
    problems.push(`Gmail: ${error instanceof Error ? error.message : "reply check failed"}`);
    return 0;
  });
  const linkedinReplies = await checkLinkedinReplies().catch((error: unknown) => {
    problems.push(`LinkedIn: ${error instanceof Error ? error.message : "inbox check failed"}`);
    return 0;
  });
  const drafts = await draftDue({ limit: 30 });
  await saveRuntimeState({ lastRefreshAt: new Date().toISOString() });
  return {
    replies: emailReplies + linkedinReplies,
    drafted: drafts.drafted,
    closed: drafts.closed,
    problems: [...problems, ...drafts.errors],
  };
}

// Drizzle wraps driver errors as "Failed query: <sql>"; the cause is the part
// worth showing.
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "drafting failed";
  const cause = error.cause instanceof Error ? error.cause.message : null;
  return (cause ?? error.message).slice(0, 200);
}
