import { randomBytes } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import * as schema from "@/lib/db/schema";

const harness = vi.hoisted(() => ({
  db: undefined as unknown,
  sent: [] as Record<string, unknown>[],
  reply: null as null | { at: Date; snippet: string; from: string; bounced: boolean },
  replyFrom: "extra@acme.dev",
  linkedinStarts: [] as Record<string, unknown>[],
  linkedinOutcome: { status: "completed", data: null } as Record<string, unknown>,
  inboxRuns: 0,
  inbox: { conversations: [] } as unknown,
  // Gmail threads the owner has outside Threadline, and whether Gmail answers.
  gmailThreads: [] as { email: string; id: string; at: Date }[],
  gmailDown: false,
  // What the YC directory and Apollo return to the hourly fill.
  ycFound: { source: "yc", warnings: [], companies: [] } as Record<string, unknown>,
  ycSearches: 0,
  apolloPeople: [] as { name: string; title: string }[],
  apolloLookups: 0,
}));

vi.mock("@/lib/db/client", () => ({ getDatabase: () => harness.db }));

vi.mock("@/lib/ai", () => ({
  researchCompany: async () => ({ score: 88, fitSummary: "Runs macOS CI.", hook: "Your ios.yml", targetTitles: ["CTO"] }),
  draftStep: async (input: { stepIndex: number; history: unknown[]; campaign: { steps: { channel: string }[] } }) => {
    const channel = input.campaign.steps[input.stepIndex]!.channel;
    const firstEmail = channel === "email" && input.history.length === 0;
    return { subject: firstEmail ? "mac ci at acme" : null, body: `step ${input.stepIndex + 1} body` };
  },
}));

vi.mock("@/lib/gmail", () => ({
  GmailClient: {
    load: async () => ({
      email: "owner@exla.ai",
      send: async (input: Record<string, unknown>) => {
        harness.sent.push(input);
        const n = harness.sent.length;
        return { id: `gm-${n}`, threadId: "thread-1", rfcMessageId: `<msg-${n}@mail.gmail.com>` };
      },
      otherThreadsWith: async (email: string, exclude: string[], since?: Date) => {
        if (harness.gmailDown) throw new Error("Gmail 503");
        const threads = harness.gmailThreads.filter(
          (thread) => thread.email === email && !exclude.includes(thread.id) && (!since || thread.at >= since),
        );
        const last = Math.max(...threads.map((thread) => thread.at.getTime()));
        return { threads: threads.length, lastAt: threads.length ? new Date(last) : null };
      },
      findReply: async (input: { email?: string | null }) => (input.email === harness.replyFrom ? harness.reply : null),
      verify: async () => {
        if (harness.gmailDown) throw new Error("Gmail API request failed (HTTP 401).");
      },
    }),
  },
}));

vi.mock("@/lib/sources/yc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sources/yc")>()),
  searchYcDirectory: async () => {
    harness.ycSearches += 1;
    return harness.ycFound;
  },
}));

vi.mock("@/lib/sources/apollo", () => ({
  apolloFindPeople: async () => harness.apolloPeople,
  apolloRevealEmail: async (input: { name: string; domain?: string }) => {
    harness.apolloLookups += 1;
    return `${input.name.split(" ")[0]!.toLowerCase()}@${input.domain}`;
  },
}));

vi.mock("@/lib/sources/email-guess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sources/email-guess")>()),
  domainAcceptsMail: async () => false,
}));

vi.mock("@/lib/linkedin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/linkedin")>();
  const client = {
    startConnectionRequest: async (personUrl: string, note: string) => {
      harness.linkedinStarts.push({ kind: "invite", personUrl, note });
      return "wf-1";
    },
    startMessage: async (personUrl: string, text: string) => {
      harness.linkedinStarts.push({ kind: "message", personUrl, text });
      return "wf-2";
    },
    waitFor: async (workflowId: string) => ({ workflowId, ...harness.linkedinOutcome }),
    startInboxCheck: async () => {
      harness.inboxRuns += 1;
      return "inbox-run";
    },
    workflow: async (workflowId: string) => ({ workflowId, status: "completed", data: harness.inbox }),
  };
  return { ...actual, LinkedinClient: { load: async () => client } };
});

const { ingest } = await import("@/lib/ingest");
const engine = await import("@/lib/engine");
const queries = await import("@/lib/queries");
const { saveSettings, loadSettings, saveRuntimeState, loadRuntimeState } = await import("@/lib/store");

type Db = ReturnType<typeof drizzle<typeof schema>>;
let db: Db;
let campaignId: string;
let close: () => Promise<void> = async () => undefined;

// In-memory PGlite by default; a real Postgres (as CI and production use) when
// TEST_DATABASE_URL is set. That database is wiped, so it must be a test one.
beforeAll(async () => {
  process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    if (!/test/i.test(url)) throw new Error("TEST_DATABASE_URL must name a disposable *test* database.");
    const client = postgres(url, { max: 4, prepare: false, onnotice: () => undefined });
    const real = drizzlePostgres(client, { schema });
    await real.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
    await migratePostgres(real, { migrationsFolder: "migrations" });
    db = real as unknown as Db;
    close = () => client.end();
  } else {
    db = drizzle(new PGlite(), { schema });
    await migrate(db, { migrationsFolder: "migrations" });
  }
  harness.db = db;
  const [campaign] = await db
    .insert(schema.campaigns)
    .values({
      name: "Mac CI pain",
      angle: "They run macOS CI.",
      steps: [
        { channel: "email", waitDays: 0, guidance: "" },
        { channel: "linkedin_invite", waitDays: 1, guidance: "" },
        { channel: "email", waitDays: 3, guidance: "" },
      ],
    })
    .returning();
  campaignId = campaign!.id;
});

afterAll(() => close());

const person = async (name: string) => {
  const [row] = await db.select().from(schema.people).where(eq(schema.people.name, name));
  return row!;
};
const draftsFor = async (personId: string) =>
  db.select().from(schema.messages).where(eq(schema.messages.personId, personId)).orderBy(schema.messages.step);

describe("ingest", () => {
  it("dedupes companies, signals and people across sources and fills gaps", async () => {
    const found = {
      source: "github",
      warnings: [],
      companies: [
        {
          name: "Acme",
          githubLogin: "acme",
          signals: [{ kind: "github_macos_ci" as const, title: "Runs macOS CI", strength: 3 as const, dedupeKey: "github:acme/app:ci.yml" }],
          people: [],
        },
      ],
    };
    const first = await ingest(found);
    const again = await ingest(found);
    expect(first.newCompanies).toBe(1);
    expect(again).toMatchObject({ newCompanies: 0, signals: 0 });

    const yc = await ingest({
      source: "yc",
      warnings: [],
      companies: [
        {
          name: "Acme Inc",
          domain: "acme.dev",
          githubLogin: "acme",
          ycBatch: "Winter 2026",
          signals: [],
          people: [
            { name: "Ada Founder", title: "CTO", email: "ada@acme.dev", emailStatus: "found" as const },
            { name: "Lin Kedin", title: "Head of Mobile", linkedinUrl: "https://www.linkedin.com/in/linkedin-lin" },
          ],
        },
      ],
    });
    expect(yc.newCompanies).toBe(0);
    expect(yc.newPeople).toBe(2);
    const companies = await db.select().from(schema.companies);
    expect(companies).toHaveLength(1);
    expect(companies[0]).toMatchObject({ name: "Acme", domain: "acme.dev", ycBatch: "Winter 2026", source: "github" });
  });
});

describe("sequence", () => {
  it("drafts the first reachable step for each person on enroll", async () => {
    const ada = await person("Ada Founder");
    const lin = await person("Lin Kedin");
    const result = await engine.enroll([ada.id, lin.id], campaignId);
    expect(result).toMatchObject({ enrolled: 2, drafted: 2 });

    expect((await person("Ada Founder")).metadata).not.toHaveProperty("inTouch");
    const adaDrafts = await draftsFor(ada.id);
    expect(adaDrafts.map((m) => [m.step, m.channel, m.status])).toEqual([[0, "email", "draft"]]);
    // Lin has no email: step 1 is skipped, the LinkedIn invite is drafted.
    const linDrafts = await draftsFor(lin.id);
    expect(linDrafts.map((m) => [m.step, m.status])).toEqual([
      [0, "skipped"],
      [1, "draft"],
    ]);
  });

  it("sends an approved email once, with the owner's edits and signature", async () => {
    const ada = await person("Ada Founder");
    const [draft] = await draftsFor(ada.id);
    const outcome = await engine.sendMessage(draft!.id, { subject: "quick q", body: "Edited body" });
    expect(outcome).toEqual({ status: "sent" });
    expect(await engine.sendMessage(draft!.id)).toMatchObject({ status: "skipped" });
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]).toMatchObject({ to: "ada@acme.dev", subject: "quick q" });
    expect(String(harness.sent[0]!.body)).toContain("Edited body\n\nViraat");

    const after = await person("Ada Founder");
    expect(after.nextStep).toBe(1);
    expect(after.nextStepAt!.getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
  });

  it("threads the follow-up email under the first one", async () => {
    const ada = await person("Ada Founder");
    await db.update(schema.people).set({ nextStepAt: new Date(Date.now() - 1000) }).where(eq(schema.people.id, ada.id));
    await engine.draftDue();
    const drafts = await draftsFor(ada.id);
    // Ada has no LinkedIn, so the invite is skipped and the follow-up drafted.
    expect(drafts.map((m) => [m.step, m.status])).toEqual([
      [0, "sent"],
      [1, "skipped"],
      [2, "draft"],
    ]);
    await engine.sendMessage(drafts[2]!.id);
    expect(harness.sent[1]).toMatchObject({
      subject: "Re: quick q",
      threadId: "thread-1",
      inReplyTo: "<msg-1@mail.gmail.com>",
    });
  });

  it("enforces the daily email limit", async () => {
    await saveSettings({ ...(await loadSettings()), dailyEmailLimit: 1 });
    const [company] = await db.select().from(schema.companies);
    const [extra] = await db
      .insert(schema.people)
      .values({ companyId: company!.id, name: "Extra Person", email: "extra@acme.dev", emailStatus: "found", source: "manual" })
      .returning();
    await engine.enroll([extra!.id], campaignId);
    const [draft] = await draftsFor(extra!.id);
    const outcome = await engine.sendMessage(draft!.id);
    expect(outcome.status).toBe("failed");
    expect(outcome).toMatchObject({ detail: expect.stringContaining("Daily email limit") });
    const [stored] = await draftsFor(extra!.id);
    expect(stored).toMatchObject({ status: "failed", sentAt: null });
    await saveSettings({ ...(await loadSettings()), dailyEmailLimit: 40 });
  });

  it("sends a LinkedIn invite and treats 'already connected' as done", async () => {
    const lin = await person("Lin Kedin");
    const drafts = await draftsFor(lin.id);
    expect(await engine.sendMessage(drafts[1]!.id)).toEqual({ status: "sent" });
    expect(harness.linkedinStarts[0]).toMatchObject({ kind: "invite", personUrl: "https://www.linkedin.com/in/linkedin-lin" });

    const extra = await person("Extra Person");
    await db
      .update(schema.people)
      .set({ linkedinUrl: "https://www.linkedin.com/in/extra" })
      .where(eq(schema.people.id, extra.id));
    const [emailDraft] = await draftsFor(extra.id);
    await engine.skipMessage(emailDraft!.id);
    await engine.draftDue();
    const invite = (await draftsFor(extra.id)).find((m) => m.step === 1)!;
    harness.linkedinOutcome = { status: "failed", code: "alreadyConnected", message: "Already connected." };
    expect(await engine.sendMessage(invite.id)).toMatchObject({ status: "skipped" });
    expect((await person("Extra Person")).nextStep).toBe(2);
    harness.linkedinOutcome = { status: "completed", data: null };
  });

  it("stops the sequence when they reply and never sends after that", async () => {
    const extra = await person("Extra Person");
    // Give Extra a sent email so the reply check has a thread to look at.
    await db.insert(schema.messages).values({
      personId: extra.id,
      campaignId,
      channel: "email",
      status: "sent",
      body: "earlier",
      sentAt: new Date(Date.now() - 3600_000),
      threadId: "thread-x",
    });
    await db
      .update(schema.people)
      .set({ lastContactedAt: new Date(Date.now() - 3600_000), nextStepAt: new Date(Date.now() - 1000) })
      .where(eq(schema.people.id, extra.id));
    await engine.draftDue();
    const pending = (await draftsFor(extra.id)).find((m) => m.status === "draft")!;

    harness.reply = { at: new Date(), snippet: "Sounds interesting, send details", from: "Extra <extra@acme.dev>", bounced: false };
    const summary = await engine.refresh();
    expect(summary.replies).toBeGreaterThanOrEqual(1);
    const after = await person("Extra Person");
    expect(after.stage).toBe("replied");
    const messages = await draftsFor(extra.id);
    expect(messages.find((m) => m.id === pending.id)?.status).toBe("skipped");
    expect(messages.some((m) => m.direction === "in" && m.body.includes("Sounds interesting"))).toBe(true);

    const sentBefore = harness.sent.length;
    expect(await engine.sendMessage(pending.id)).toMatchObject({ status: "skipped" });
    expect(harness.sent).toHaveLength(sentBefore);
    harness.reply = null;
  });

  it("closes the sequence as no_reply after the last step's grace period", async () => {
    const ada = await person("Ada Founder");
    expect(ada.nextStep).toBe(3);
    await db.update(schema.people).set({ nextStepAt: new Date(Date.now() - 1000) }).where(eq(schema.people.id, ada.id));
    const result = await engine.draftDue();
    expect(result.closed).toBe(1);
    expect(await person("Ada Founder")).toMatchObject({ stage: "closed", closedReason: "no_reply" });
  });
});

describe("page loaders", () => {
  it("load every surface from the same data", async () => {
    const today = await queries.loadToday();
    expect(today.stats.sentWeek).toBeGreaterThanOrEqual(3);
    expect(today.stats.repliesWeek).toBe(1);
    expect(today.replies[0]?.person.name).toBe("Extra Person");

    const prospects = await queries.loadProspects({ view: "all" });
    expect(prospects[0]).toMatchObject({ name: "Acme", signalCount: 1, topStrength: 3, peopleCount: 3 });
    expect(await queries.loadProspects({ q: "nomatch" })).toEqual([]);

    const company = await queries.loadCompany(prospects[0]!.id);
    expect(company?.people).toHaveLength(3);
    expect(company?.messages.length).toBeGreaterThan(3);

    const [campaign] = await queries.loadCampaigns();
    expect(campaign).toMatchObject({ enrolled: 3, replied: 1 });
    expect(campaign!.sent).toBeGreaterThanOrEqual(3);

    const settings = await queries.loadSettingsData();
    expect(settings.settings.productName).toBe("Offstage");
    expect(settings.gmail).toBeNull();
  });
});

describe("X", () => {
  it("imports a poster from bird, drafts an X DM, and records it sent without any API call", async () => {
    const { parseBirdSearch } = await import("@/lib/sources/x");
    const found = parseBirdSearch(
      JSON.stringify([
        {
          id: "9001",
          text: "our macos runners are so slow",
          author: { username: "pat_ships", name: "Pat Ships" },
          authorId: "77",
          _raw: { core: { user_results: { result: { legacy: { description: "founder", followers_count: 300 } } } } },
        },
      ]),
    );
    const first = await ingest(found);
    const again = await ingest(found);
    expect(first).toMatchObject({ newCompanies: 1, newPeople: 1 });
    expect(again).toMatchObject({ newCompanies: 0, newPeople: 0, signals: 0 });
    const pat = await person("Pat Ships");
    expect(pat).toMatchObject({ twitterUrl: "https://x.com/pat_ships", metadata: { xUserId: "77" } });

    const [xCampaign] = await db
      .insert(schema.campaigns)
      .values({
        name: "Saw your post",
        angle: "They posted about it.",
        steps: [
          { channel: "x_dm", waitDays: 0, guidance: "" },
          { channel: "email", waitDays: 3, guidance: "" },
        ],
      })
      .returning();
    await engine.enroll([pat.id], xCampaign!.id);
    const [dm] = await draftsFor(pat.id);
    expect(dm).toMatchObject({ channel: "x_dm", status: "draft" });

    const sentBefore = harness.sent.length;
    const startsBefore = harness.linkedinStarts.length;
    expect(await engine.sendMessage(dm!.id, { body: "edited dm" })).toEqual({ status: "sent" });
    expect(harness.sent).toHaveLength(sentBefore);
    expect(harness.linkedinStarts).toHaveLength(startsBefore);
    const [after] = await draftsFor(pat.id);
    expect(after).toMatchObject({ status: "sent", body: "edited dm" });
    expect(await person("Pat Ships")).toMatchObject({ nextStep: 1, stage: "active" });
  });
});

describe("LinkedIn replies", () => {
  it("starts an inbox run on one refresh, collects it on the next, and stops the sequence", async () => {
    await ingest({
      source: "manual",
      warnings: [],
      companies: [
        {
          name: "Replyco",
          domain: "replyco.dev",
          signals: [],
          people: [{ name: "Rae Plier", title: "CTO", linkedinUrl: "https://www.linkedin.com/in/rae" }],
        },
      ],
    });
    const rae = await person("Rae Plier");
    const [linkedinOnly] = await db
      .insert(schema.campaigns)
      .values({ name: "LinkedIn only", angle: "x", steps: [{ channel: "linkedin_invite", waitDays: 0, guidance: "" }, { channel: "linkedin_message", waitDays: 2, guidance: "" }] })
      .returning();
    await engine.enroll([rae.id], linkedinOnly!.id);
    const [invite] = await draftsFor(rae.id);
    harness.linkedinOutcome = { status: "completed", data: null };
    expect(await engine.sendMessage(invite!.id)).toEqual({ status: "sent" });

    await saveRuntimeState({ linkedinInboxRun: null, linkedinInboxCheckedAt: "2020-01-01T00:00:00.000Z" });
    const runsBefore = harness.inboxRuns;
    await engine.refresh();
    expect(harness.inboxRuns).toBe(runsBefore + 1);
    expect((await person("Rae Plier")).stage).toBe("active");

    harness.inbox = { conversations: [{ name: "Rae Plier", lastMessageFromThem: true, preview: "Sure, send details", when: "2:14 PM" }] };
    const second = await engine.refresh();
    expect(second.replies).toBeGreaterThanOrEqual(1);
    expect((await person("Rae Plier")).stage).toBe("replied");
    // The same read keeps the conversation list for the "already in touch" check.
    expect((await loadRuntimeState()).linkedinConversations).toEqual([{ name: "Rae Plier", when: "2:14 PM" }]);
    // The run was collected; the next one waits for the interval.
    await engine.refresh();
    expect(harness.inboxRuns).toBe(runsBefore + 1);
  });
});

describe("already in touch", () => {
  let warmCampaignId: string;
  const addPerson = async (name: string, email: string | null) => {
    const [company] = await db.insert(schema.companies).values({ name: `${name} Co`, source: "manual" }).returning();
    const [row] = await db
      .insert(schema.people)
      .values({ companyId: company!.id, name, email, emailStatus: email ? "found" : null, source: "manual" })
      .returning();
    return row!;
  };
  const includeAnyway = (id: string) =>
    db
      .update(schema.people)
      .set({ metadata: sql`${schema.people.metadata} || '{"inTouchOverride": true}'::jsonb` })
      .where(eq(schema.people.id, id));

  beforeAll(async () => {
    const [campaign] = await db
      .insert(schema.campaigns)
      .values({
        name: "Two emails",
        angle: "x",
        steps: [
          { channel: "email", waitDays: 0, guidance: "" },
          { channel: "email", waitDays: 3, guidance: "" },
        ],
      })
      .returning();
    warmCampaignId = campaign!.id;
  });

  it("holds back someone with an email thread until the owner includes them anyway", async () => {
    const kim = await addPerson("Kim Known", "kim@known.dev");
    harness.gmailThreads.push({ email: "kim@known.dev", id: "t-kim", at: new Date("2026-10-01T17:00:00Z") });

    const held = await engine.enroll([kim.id], warmCampaignId);
    expect(held).toMatchObject({ enrolled: 0, heldBack: ["Kim Known"] });
    const after = await person("Kim Known");
    expect(after.stage).toBe("new");
    expect(after.metadata).toMatchObject({ inTouch: { gmail: { threads: 1, lastAt: "2026-10-01T17:00:00.000Z" } } });
    expect(await draftsFor(kim.id)).toEqual([]);

    await includeAnyway(kim.id);
    expect(await engine.enroll([kim.id], warmCampaignId)).toMatchObject({ enrolled: 1, heldBack: [] });
    const [draft] = await draftsFor(kim.id);
    const sentBefore = harness.sent.length;
    expect(await engine.sendMessage(draft!.id)).toEqual({ status: "sent" });
    expect(harness.sent).toHaveLength(sentBefore + 1);
  });

  it("holds back someone in the latest LinkedIn conversation list", async () => {
    await saveRuntimeState({ linkedinConversations: [{ name: "Lee Linked", when: "Oct 20" }] });
    const lee = await addPerson("Lée Linked", "lee@linked.dev");
    expect(await engine.enroll([lee.id], warmCampaignId)).toMatchObject({ enrolled: 0, heldBack: ["Lée Linked"] });
    expect((await person("Lée Linked")).metadata).toMatchObject({ inTouch: { linkedin: { when: "Oct 20" } } });
  });

  it("checks again before every send, and only counts mail outside the sequence once it starts", async () => {
    const sam = await addPerson("Sam Later", "sam@later.dev");
    expect(await engine.enroll([sam.id], warmCampaignId)).toMatchObject({ enrolled: 1 });
    const [first] = await draftsFor(sam.id);

    // The owner emailed Sam directly after enrolling: the first send stops.
    harness.gmailThreads.push({ email: "sam@later.dev", id: "t-sam-old", at: new Date(Date.now() - 3600_000) });
    const sentBefore = harness.sent.length;
    const blocked = await engine.sendMessage(first!.id);
    expect(blocked).toMatchObject({ status: "failed", detail: expect.stringContaining("already in touch with Sam Later") });
    expect(harness.sent).toHaveLength(sentBefore);
    expect((await draftsFor(sam.id))[0]).toMatchObject({ status: "failed", sentAt: null });
    expect((await person("Sam Later")).metadata).toMatchObject({ inTouch: { gmail: { threads: 1 } } });

    // If the check can't run, nothing is sent.
    harness.gmailThreads = harness.gmailThreads.filter((thread) => thread.email !== "sam@later.dev");
    harness.gmailDown = true;
    expect(await engine.sendMessage(first!.id)).toMatchObject({ status: "failed", detail: expect.stringContaining("Couldn't check") });
    harness.gmailDown = false;
    expect(await engine.sendMessage(first!.id)).toEqual({ status: "sent" });

    // Mail from before the sequence started no longer counts; mail since does.
    harness.gmailThreads.push({ email: "sam@later.dev", id: "t-sam-before", at: new Date(Date.now() - 86_400_000) });
    await db.update(schema.people).set({ nextStepAt: new Date(Date.now() - 1000) }).where(eq(schema.people.id, sam.id));
    await engine.draftDue();
    const followUp = (await draftsFor(sam.id)).find((m) => m.step === 1)!;
    harness.gmailThreads.push({ email: "sam@later.dev", id: "t-sam-since", at: new Date(Date.now() + 1000) });
    expect(await engine.sendMessage(followUp.id)).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("outside this sequence since it started"),
    });

    await includeAnyway(sam.id);
    expect(await engine.sendMessage(followUp.id)).toEqual({ status: "sent" });
  });

  it("holds back a second record of someone Threadline already wrote to", async () => {
    const first = await addPerson("Dee Dupe", "dee@one.dev");
    await engine.enroll([first.id], warmCampaignId);
    const [draft] = await draftsFor(first.id);
    expect(await engine.sendMessage(draft!.id)).toEqual({ status: "sent" });

    const second = await addPerson("Dee Dupe", "dee@two.dev");
    expect(await engine.enroll([second.id], warmCampaignId)).toMatchObject({ enrolled: 0, heldBack: ["Dee Dupe"] });
    const byId = async (id: string) => (await db.select().from(schema.people).where(eq(schema.people.id, id)))[0]!;
    expect((await byId(first.id)).metadata).not.toHaveProperty("inTouch");
    expect((await byId(second.id)).metadata).toMatchObject({ inTouch: { threadline: { company: "Dee Dupe Co" } } });
  });

  it("keeps the last good conversation list when an inbox read comes back empty", async () => {
    await saveRuntimeState({
      linkedinInboxRun: "inbox-run",
      linkedinConversations: [{ name: "Lee Linked", when: "Oct 20" }],
    });
    harness.inbox = { conversations: [] };
    await engine.refresh();
    const state = await loadRuntimeState();
    expect(state.linkedinInboxRun).toBeNull();
    expect(state.linkedinConversations).toEqual([{ name: "Lee Linked", when: "Oct 20" }]);

    // A later read adds newer conversations in front of the ones it no longer shows.
    await saveRuntimeState({ linkedinInboxRun: "inbox-run" });
    harness.inbox = {
      conversations: [
        { name: "Nia New", lastMessageFromThem: false, preview: "", when: "9:02 AM" },
        { name: "Lee Linked", lastMessageFromThem: false, preview: "", when: "Oct 30" },
      ],
    };
    await engine.refresh();
    expect((await loadRuntimeState()).linkedinConversations).toEqual([
      { name: "Nia New", when: "9:02 AM" },
      { name: "Lee Linked", when: "Oct 30" },
    ]);
  });
});

describe("health", () => {
  it("records what's broken on each refresh and clears it once fixed", async () => {
    harness.gmailDown = true;
    await engine.refresh();
    expect((await loadRuntimeState()).health?.problems).toEqual(
      expect.arrayContaining([expect.stringContaining("Gmail stopped working (Gmail API request failed (HTTP 401).)")]),
    );
    harness.gmailDown = false;
    await engine.refresh();
    expect((await loadRuntimeState()).health?.problems.some((problem) => problem.startsWith("Gmail"))).toBe(false);
  });

  it("flags LinkedIn actions stuck in the queue", async () => {
    const [someone] = await db.select().from(schema.people).limit(1);
    const [stuck] = await db
      .insert(schema.messages)
      .values({
        personId: someone!.id,
        channel: "linkedin_message",
        status: "sending",
        body: "x",
        sentAt: new Date(Date.now() - 4 * 3600_000),
      })
      .returning();
    await engine.refresh();
    expect((await loadRuntimeState()).health?.problems).toContain("1 LinkedIn action has been queued for over 3 hours.");
    await db.delete(schema.messages).where(eq(schema.messages.id, stuck!.id));
  });

  it("merges concurrent runtime saves instead of overwriting", async () => {
    await Promise.all([
      saveRuntimeState({ linkedinInboxCheckedAt: "2026-10-31T01:00:00.000Z" }),
      saveRuntimeState({ lastRefreshAt: "2026-10-31T02:00:00.000Z" }),
    ]);
    expect(await loadRuntimeState()).toMatchObject({
      linkedinInboxCheckedAt: "2026-10-31T01:00:00.000Z",
      lastRefreshAt: "2026-10-31T02:00:00.000Z",
    });
  });
});

describe("hourly fill", () => {
  it("sources a campaign's audience, researches, finds people and looks up the best emails, once", async () => {
    // Only what this test adds should need work.
    await db.update(schema.companies).set({ researchedAt: new Date() }).where(sql`researched_at is null`);
    await db.update(schema.companies).set({ metadata: sql`metadata || '{"peopleSearchedAt": "2026-01-01"}'::jsonb` });
    await db.insert(schema.campaigns).values({ name: "iOS teams", angle: "x", audience: "ios", steps: [{ channel: "email", waitDays: 0, guidance: "" }] });
    harness.ycFound = {
      source: "yc",
      warnings: [],
      companies: [{ name: "Sourced Co", domain: "sourced.dev", description: "An iOS app", signals: [], people: [] }],
    };
    harness.apolloPeople = [
      { name: "Cara Cto", title: "CTO" },
      { name: "Ivan Ios", title: "iOS Engineer" },
    ];
    process.env.APOLLO_API_KEY = "test-key";
    try {
      const first = await engine.fillPipeline(Date.now() + 60_000);
      expect(first).toEqual({ sourced: 1, researched: 1, peopleFound: 2, emails: 1, problems: [] });
      expect(await person("Cara Cto")).toMatchObject({ email: "cara@sourced.dev", emailStatus: "found", stage: "new" });
      // Hands-on engineers aren't worth a credit up front.
      expect((await person("Ivan Ios")).email).toBeNull();
      expect(harness.apolloLookups).toBe(1);

      const again = await engine.fillPipeline(Date.now() + 60_000);
      expect(again).toEqual({ sourced: 0, researched: 0, peopleFound: 0, emails: 0, problems: [] });
      expect(harness.ycSearches).toBe(1);
      expect(harness.apolloLookups).toBe(1);
      expect((await loadRuntimeState()).lastFill).toMatchObject({ sourced: 0, researched: 0 });
      // Nobody was enrolled or contacted.
      expect((await person("Cara Cto")).campaignId).toBeNull();
    } finally {
      delete process.env.APOLLO_API_KEY;
    }
  });

  it("ranks the CRM with reasons and learns from who replied", async () => {
    const best = await queries.loadPeople({ view: "best" });
    const cara = best.rows.find((row) => row.name === "Cara Cto")!;
    // Rae, a CTO, replied earlier, so deciders already rank a little higher.
    const lift = best.learning.lifts.decider!;
    expect(lift.lift).toBeGreaterThan(1);
    expect(cara.rank).toMatchObject({ stakeholder: "decider", score: Math.round(Math.min(100, 88 * lift.lift)) });
    expect(cara.rank.reasons).toEqual([
      "CTO: can decide on CI spend",
      "Sourced Co fit 88: Your ios.yml",
      "email found",
      `Decision makers reply ${lift.lift.toFixed(1)}× average so far (${lift.replied}/${lift.contacted})`,
    ]);
    const ivan = best.rows.find((row) => row.name === "Ivan Ios")!;
    expect(best.rows.indexOf(cara)).toBeLessThan(best.rows.indexOf(ivan));
    // Held back people aren't "best next".
    expect(best.rows.some((row) => row.name === "Lée Linked")).toBe(false);
    expect((await queries.loadPeople({ view: "held" })).rows.some((row) => row.name === "Lée Linked")).toBe(true);

    const { learning } = await queries.loadPeople({ view: "all" });
    expect(learning.contacted).toBeGreaterThan(0);
    expect(learning.replied).toBeGreaterThan(0);
    expect(learning.byRole.map((row) => row.key)).toContain("unknown");
  });
});

