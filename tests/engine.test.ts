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
      countThreadsWith: async (email: string) => (email === "ada@acme.dev" ? 2 : 0),
      findReply: async (input: { email?: string | null }) => (input.email === harness.replyFrom ? harness.reply : null),
    }),
  },
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
    inboxSince: async () => [],
  };
  return { ...actual, LinkedinClient: { load: async () => client } };
});

const { ingest } = await import("@/lib/ingest");
const engine = await import("@/lib/engine");
const queries = await import("@/lib/queries");
const { saveSettings, loadSettings } = await import("@/lib/store");

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

    expect((await person("Ada Founder")).metadata).toMatchObject({ priorThreads: 2 });
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
