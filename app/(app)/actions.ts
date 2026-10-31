"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { assertOwner } from "@/lib/auth";
import { getDatabase } from "@/lib/db/client";
import { campaigns, companies, people } from "@/lib/db/schema";
import { campaignStepSchema, PERSON_STAGES, settingsSchema } from "@/lib/domain";
import {
  enroll,
  findPeopleForCompany,
  redraft,
  refresh,
  researchCompanyById,
  revealEmail,
  sendMessage,
  skipMessage,
  stopSequence,
  type SendOutcome,
} from "@/lib/engine";
import { ingest, upsertPerson, type IngestSummary } from "@/lib/ingest";
import { LinkedinClient, workerConfig } from "@/lib/linkedin";
import { linkedinLoginInputSchema } from "@/lib/linkedin-login";
import { parseManualImport } from "@/lib/manual-import";
import { findMacCiTeams } from "@/lib/sources/github";
import { searchHackerNews } from "@/lib/sources/hn";
import type { FindResult } from "@/lib/sources/types";
import { parseYcCliOutput, searchYcDirectory } from "@/lib/sources/yc";
import { deleteConnection, loadApiKey, saveConnection, saveSettings } from "@/lib/store";

export type ActionResult<T = undefined> = { ok: true; data: T; message?: string } | { ok: false; error: string };

async function run<T>(work: () => Promise<T>, paths: string[] = []): Promise<ActionResult<T>> {
  try {
    await assertOwner();
    const data = await work();
    for (const path of paths) revalidatePath(path, path === "/" ? "layout" : "page");
    return { ok: true, data };
  } catch (error) {
    // Messages are ours (validation, provider status lines), never payloads.
    const message =
      error instanceof z.ZodError
        ? (error.issues[0]?.message ?? "Invalid input.")
        : error instanceof Error
          ? error.message.slice(0, 300)
          : "Something went wrong.";
    return { ok: false, error: message };
  }
}

const uuid = z.string().uuid();
const uuids = z.array(uuid).min(1).max(200);

// ── Find ────────────────────────────────────────────────────────────────────

const findInput = z.discriminatedUnion("source", [
  z.object({ source: z.literal("yc"), query: z.string().trim().min(2).max(300), limit: z.number().int().min(1).max(100).default(30) }),
  z.object({ source: z.literal("github"), maxOrgs: z.number().int().min(1).max(100).default(30) }),
  z.object({ source: z.literal("hn"), query: z.string().trim().max(300).default("") }),
  z.object({ source: z.literal("yc_cli"), json: z.string().min(2).max(2_000_000) }),
  z.object({ source: z.literal("manual"), text: z.string().min(3).max(200_000) }),
]);

export async function findAction(
  input: z.input<typeof findInput>,
): Promise<ActionResult<IngestSummary & { warnings: string[] }>> {
  return run(async () => {
    const parsed = findInput.parse(input);
    let result: FindResult;
    switch (parsed.source) {
      case "yc":
        result = await searchYcDirectory({ query: parsed.query, limit: parsed.limit });
        break;
      case "github": {
        const token = await loadApiKey("github");
        if (!token) throw new Error("Add a GitHub token in Settings to search workflows.");
        result = await findMacCiTeams({ token, maxOrgs: parsed.maxOrgs });
        break;
      }
      case "hn": {
        const queries = parsed.query
          .split(",")
          .map((q) => q.trim())
          .filter(Boolean);
        result = await searchHackerNews(queries.length ? { queries } : {});
        break;
      }
      case "yc_cli":
        result = parseYcCliOutput(parsed.json);
        break;
      case "manual":
        result = parseManualImport(parsed.text);
        break;
    }
    const summary = await ingest(result);
    return { ...summary, warnings: result.warnings };
  }, ["/prospects", "/find"]);
}

// ── Companies & people ──────────────────────────────────────────────────────

export async function researchAction(companyIds: string[]) {
  return run(async () => {
    const ids = uuids.max(15).parse(companyIds);
    const failures: string[] = [];
    let done = 0;
    // Three at a time keeps a batch of 15 well inside the function budget.
    for (let index = 0; index < ids.length; index += 3) {
      await Promise.all(
        ids.slice(index, index + 3).map((id) =>
          researchCompanyById(id)
            .then(() => {
              done += 1;
            })
            .catch((error: unknown) => {
              failures.push(error instanceof Error ? error.message.slice(0, 120) : "Research failed");
            }),
        ),
      );
    }
    return { done, failures };
  }, ["/prospects", "/prospects/[id]"]);
}

export async function findPeopleAction(companyId: string) {
  return run(() => findPeopleForCompany(uuid.parse(companyId)), ["/prospects/[id]", "/prospects"]);
}

const personInput = z.object({
  name: z.string().trim().min(1).max(200),
  title: z.string().trim().max(200).optional(),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email()]).optional(),
  linkedinUrl: z.union([z.literal(""), z.string().trim().url()]).optional(),
});

export async function addPersonAction(companyId: string, input: z.input<typeof personInput>) {
  return run(async () => {
    const parsed = personInput.parse(input);
    await upsertPerson(
      uuid.parse(companyId),
      {
        name: parsed.name,
        ...(parsed.title ? { title: parsed.title } : {}),
        ...(parsed.email ? { email: parsed.email, emailStatus: "found" as const } : {}),
        ...(parsed.linkedinUrl ? { linkedinUrl: parsed.linkedinUrl } : {}),
      },
      "manual",
    );
  }, ["/prospects/[id]"]);
}

const personPatch = z.object({
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email()]).optional(),
  linkedinUrl: z.union([z.literal(""), z.string().trim().url()]).optional(),
  title: z.string().trim().max(200).optional(),
  stage: z.enum(PERSON_STAGES).optional(),
  notes: z.string().max(4000).optional(),
});

export async function updatePersonAction(personId: string, input: z.input<typeof personPatch>) {
  return run(async () => {
    const parsed = personPatch.parse(input);
    const id = uuid.parse(personId);
    if (parsed.stage === "closed") await stopSequence(id, "owner");
    await getDatabase()
      .update(people)
      .set({
        ...(parsed.email !== undefined
          ? { email: parsed.email || null, emailStatus: parsed.email ? ("found" as const) : null }
          : {}),
        ...(parsed.linkedinUrl !== undefined ? { linkedinUrl: parsed.linkedinUrl || null } : {}),
        ...(parsed.title !== undefined ? { title: parsed.title || null } : {}),
        ...(parsed.notes !== undefined ? { notes: parsed.notes || null } : {}),
        // Resuming a sequence picks up at the step it stopped on, due now.
        ...(parsed.stage === "active" ? { stage: "active" as const, nextStepAt: new Date(), closedReason: null } : {}),
        ...(parsed.stage && !["active", "closed"].includes(parsed.stage) ? { stage: parsed.stage } : {}),
        updatedAt: new Date(),
      })
      .where(eq(people.id, id));
  }, ["/", "/prospects/[id]"]);
}

export async function deletePersonAction(personId: string) {
  return run(async () => {
    await getDatabase().delete(people).where(eq(people.id, uuid.parse(personId)));
  }, ["/prospects/[id]", "/"]);
}

export async function revealEmailAction(personId: string) {
  return run(() => revealEmail(uuid.parse(personId)), ["/prospects/[id]"]);
}

// One Apollo credit per person looked up, so it's capped per click.
export async function findEmailsAction(personIds: string[]) {
  return run(async () => {
    let found = 0;
    for (const id of uuids.max(25).parse(personIds)) {
      if (await revealEmail(id)) found += 1;
    }
    return { found, checked: personIds.length };
  }, ["/people", "/campaigns/[id]", "/prospects/[id]"]);
}

export async function setCompanyStatusAction(companyIds: string[], status: "new" | "target" | "archived") {
  return run(async () => {
    await getDatabase()
      .update(companies)
      .set({ status: z.enum(["new", "target", "archived"]).parse(status), updatedAt: new Date() })
      .where(inArray(companies.id, uuids.parse(companyIds)));
  }, ["/prospects", "/prospects/[id]"]);
}

// ── Sequences ───────────────────────────────────────────────────────────────

export async function enrollAction(personIds: string[], campaignId: string) {
  return withHeldBack(
    await run(() => enroll(uuids.max(25).parse(personIds), uuid.parse(campaignId)), [
      "/",
      "/prospects/[id]",
      "/campaigns",
      "/campaigns/[id]",
      "/people",
    ]),
  );
}

// Enroll holds back people the owner is already in touch with; say who.
function withHeldBack<T extends { enrolled: number; heldBack: string[] }>(result: ActionResult<T>): ActionResult<T> {
  if (!result.ok || !result.data.heldBack.length) return result;
  const { enrolled, heldBack } = result.data;
  const names = heldBack.length > 3 ? `${heldBack.slice(0, 3).join(", ")} and ${heldBack.length - 3} more` : heldBack.join(", ");
  return {
    ...result,
    message: `${enrolled ? `Enrolled ${enrolled}. ` : ""}Held back ${names}: you're already in touch. Choose "Include anyway" on their row to enroll them.`,
  };
}

// The owner knows this person and wants them in a sequence anyway: the "already
// in touch" check stops holding them back and stops blocking their sends.
export async function includeAnywayAction(personId: string) {
  return run(async () => {
    await getDatabase()
      .update(people)
      .set({ metadata: sql`${people.metadata} || '{"inTouchOverride": true}'::jsonb`, updatedAt: new Date() })
      .where(eq(people.id, uuid.parse(personId)));
  }, ["/", "/prospects/[id]"]);
}

// Enrolls every person at the given companies who has a usable channel.
export async function enrollCompaniesAction(companyIds: string[], campaignId: string) {
  return withHeldBack(await run(async () => {
    const rows = await getDatabase()
      .select({ id: people.id })
      .from(people)
      .where(and(inArray(people.companyId, uuids.max(25).parse(companyIds)), eq(people.stage, "new")))
      .limit(25);
    if (!rows.length) throw new Error("No new people at those companies yet. Use Find people first.");
    return enroll(
      rows.map((r) => r.id),
      uuid.parse(campaignId),
    );
  }, ["/", "/prospects", "/campaigns"]));
}

export async function sendAction(
  messageId: string,
  edits: { subject?: string | null; body: string },
): Promise<ActionResult<SendOutcome>> {
  return run(async () => {
    const parsed = z
      .object({ subject: z.string().trim().max(200).nullable().optional(), body: z.string().trim().min(1).max(5000) })
      .parse(edits);
    return sendMessage(uuid.parse(messageId), parsed);
  }, ["/", "/prospects/[id]"]);
}

export async function skipAction(messageId: string) {
  return run(() => skipMessage(uuid.parse(messageId)), ["/"]);
}

export async function redraftAction(messageId: string) {
  return run(() => redraft(uuid.parse(messageId)), ["/"]);
}

export async function refreshAction() {
  return run(() => refresh(), ["/"]);
}

// ── Campaigns ───────────────────────────────────────────────────────────────

const campaignInput = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(120),
  angle: z.string().trim().min(1).max(3000),
  steps: z.array(campaignStepSchema).min(1).max(8),
  active: z.boolean().default(true),
});

export async function saveCampaignAction(input: z.input<typeof campaignInput>) {
  return run(async () => {
    const parsed = campaignInput.parse(input);
    const database = getDatabase();
    if (parsed.id) {
      await database
        .update(campaigns)
        .set({ name: parsed.name, angle: parsed.angle, steps: parsed.steps, active: parsed.active, updatedAt: new Date() })
        .where(eq(campaigns.id, parsed.id));
      return parsed.id;
    }
    const [created] = await database
      .insert(campaigns)
      .values({ name: parsed.name, angle: parsed.angle, steps: parsed.steps, active: parsed.active })
      .returning({ id: campaigns.id });
    return created!.id;
  }, ["/campaigns", "/prospects"]);
}

// The YC directory phrases the hourly job sources new companies from.
export async function saveAudienceAction(campaignId: string, audience: string) {
  return run(async () => {
    const value = z.string().trim().max(500).parse(audience);
    await getDatabase()
      .update(campaigns)
      .set({ audience: value || null, updatedAt: new Date() })
      .where(eq(campaigns.id, uuid.parse(campaignId)));
  }, ["/campaigns", "/campaigns/[id]"]);
}

// ── Settings ────────────────────────────────────────────────────────────────

export async function saveSettingsAction(input: z.input<typeof settingsSchema>) {
  return run(() => saveSettings(settingsSchema.parse(input)), ["/settings"]);
}

function workerClient() {
  const config = workerConfig();
  if (!config) throw new Error("The browser worker isn't configured.");
  return new LinkedinClient(config);
}

// The sign-in view: the owner signs in to LinkedIn inside the worker's own
// browser (LinkedIn revokes sessions copied from another browser). Typed text
// goes straight through to the worker; it is never stored or logged.
export async function openLinkedinLoginAction() {
  return run(() => workerClient().openLogin());
}

export async function linkedinLoginInputAction(events: unknown) {
  return run(() => workerClient().loginInput(linkedinLoginInputSchema.parse(events)));
}

export async function finishLinkedinLoginAction() {
  return run(async () => {
    const result = await workerClient().finishLogin();
    if (!result.signedIn) throw new Error(result.detail);
  }, ["/settings"]);
}

export async function cancelLinkedinLoginAction() {
  return run(() => workerClient().cancelLogin(), ["/settings"]);
}

export async function signOutLinkedinAction() {
  return run(() => workerClient().signOut(), ["/settings"]);
}

export async function saveApiKeyAction(provider: "github" | "apollo", token: string) {
  return run(async () => {
    const parsedProvider = z.enum(["github", "apollo"]).parse(provider);
    const parsedToken = z.string().trim().min(8).max(500).parse(token);
    await saveConnection(parsedProvider, parsedProvider === "github" ? "GitHub token" : "Apollo key", {
      token: parsedToken,
    });
  }, ["/settings", "/find"]);
}

export async function disconnectAction(provider: "gmail" | "github" | "apollo") {
  return run(() => deleteConnection(z.enum(["gmail", "github", "apollo"]).parse(provider)), ["/settings"]);
}
