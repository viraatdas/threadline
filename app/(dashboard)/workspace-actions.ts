"use server";

import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import type {
  AddContactReceipt,
  CompanyCorrectionField,
  CompanyMutationReceipt,
  ContactCorrectionField,
  ContactMutationReceipt,
  DraftRetryReceipt,
  MergeContactsReceipt,
  PlanMutationReceipt,
  WorkspaceActionResult,
} from "@/components/workspace-actions";
import { requireOwner } from "@/lib/auth";
import { getDatabase } from "@/lib/db/client";
import {
  analysisJobs,
  analysisResults,
  auditEvents,
  channelIdentities,
  companies,
  contacts,
  conversationParticipants,
  outreachPlans,
  touchpoints,
} from "@/lib/db/schema";
import { channelSchema } from "@/lib/domain/schemas";
import type { ManualOverride, SourceProvenance } from "@/lib/domain/schemas";
import { createIdempotencyKey, hashContent } from "@/lib/security/idempotency";

const uuidSchema = z.string().uuid();
const optionalEmailSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().email().max(320).optional(),
);
const optionalText = (maximum: number) =>
  z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().trim().max(maximum).optional(),
  );
const dateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "Choose a valid review date.");

const addContactSchema = z.object({
  displayName: z.string().trim().min(1, "Enter a name.").max(255),
  email: optionalEmailSchema,
  company: optionalText(255),
  title: optionalText(255),
});

const editContactSchema = z.object({
  displayName: z.string().trim().min(1, "Enter a name.").max(255),
  email: optionalEmailSchema,
  notes: optionalText(20_000),
});

const correctionSchema = z.object({
  value: z.string().trim().min(1, "Enter a resolved value.").max(1000),
  reason: optionalText(1000),
});

const editCompanySchema = z.object({
  name: z.string().trim().min(1, "Enter a company name.").max(255),
  domain: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .trim()
      .toLowerCase()
      .max(255)
      .regex(
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u,
        "Enter a valid domain.",
      )
      .optional(),
  ),
  description: optionalText(20_000),
});

const planSchema = z.object({
  objective: z.string().trim().min(1, "Enter an objective.").max(2000),
  nextTouchAt: z.preprocess(
    (value) => (value === "" ? undefined : value),
    dateSchema.optional(),
  ),
  channel: channelSchema,
});

const rescheduleSchema = z.object({ date: dateSchema });

class WorkspaceMutationError extends Error {}

type Database = ReturnType<typeof getDatabase>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function formObject(formData: FormData): Record<string, FormDataEntryValue> {
  return Object.fromEntries(formData.entries());
}

function validationFailure<TData>(result: z.ZodError): WorkspaceActionResult<TData> {
  return {
    ok: false,
    error: result.issues[0]?.message ?? "The submitted values are invalid.",
  };
}

function mutationFailure<TData>(error: unknown, fallback: string): WorkspaceActionResult<TData> {
  return {
    ok: false,
    error: error instanceof WorkspaceMutationError ? error.message : fallback,
  };
}

function actorFromSession(session: Awaited<ReturnType<typeof requireOwner>>): string {
  const email = session.user?.email?.trim().toLowerCase();
  if (!email) throw new WorkspaceMutationError("The owner session has no email address.");
  return email;
}

function normalizeCompanyName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}

function dateAtReviewTime(value: string | undefined): Date | null {
  return value ? new Date(`${value}T09:30:00.000Z`) : null;
}

function manualOverride(
  field: string,
  value: unknown,
  actorEmail: string,
  occurredAt: Date,
  reason: string,
): ManualOverride {
  return {
    field,
    value,
    reason,
    overriddenAt: occurredAt.toISOString(),
    overriddenBy: actorEmail,
  };
}

function prependOverrides(
  existing: readonly ManualOverride[],
  values: readonly { field: string; value: unknown; reason: string }[],
  actorEmail: string,
  occurredAt: Date,
): ManualOverride[] {
  return [
    ...values.map(({ field, value, reason }) =>
      manualOverride(field, value, actorEmail, occurredAt, reason),
    ),
    ...existing,
  ];
}

function mergeProvenance(values: readonly SourceProvenance[]): SourceProvenance[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.provider}:${value.integrationAccountId ?? ""}:${value.externalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeNotes(...values: readonly (string | null)[]): string | null {
  const notes = [
    ...new Set(values.flatMap((value) => (value?.trim() ? [value.trim()] : []))),
  ];
  return notes.length ? notes.join("\n\n") : null;
}

async function findOrCreateCompany(
  transaction: Transaction,
  rawName: string | undefined,
  actorEmail: string,
  occurredAt: Date,
): Promise<string | null> {
  const name = rawName?.trim();
  if (!name || normalizeCompanyName(name) === "independent") return null;
  const normalizedName = normalizeCompanyName(name);
  const [existing] = await transaction
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.normalizedName, normalizedName))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await transaction
    .insert(companies)
    .values({
      name,
      normalizedName,
      confidence: 1,
      hasManualOverride: true,
      manuallyOverriddenAt: occurredAt,
      manualOverrides: [
        manualOverride(
          "name",
          name,
          actorEmail,
          occurredAt,
          "Created from an owner-managed relationship.",
        ),
      ],
      metadata: { createdManually: true },
    })
    .returning({ id: companies.id });
  if (!created) throw new WorkspaceMutationError("The company could not be created.");
  return created.id;
}

async function enqueueDraftJob(
  transaction: Transaction,
  plan: {
    id: string;
    contactId: string;
    companyId: string | null;
    objective: string;
    preferredChannels: readonly string[];
    nextTouchAt: Date | null;
  },
  actorEmail: string,
  occurredAt: Date,
  reason: "plan_saved" | "owner_retry",
) {
  const payload = {
    planId: plan.id,
    contactId: plan.contactId,
    companyId: plan.companyId,
    objective: plan.objective,
    preferredChannels: plan.preferredChannels,
    nextTouchAt: plan.nextTouchAt?.toISOString() ?? null,
    requestedBy: actorEmail,
    requestReason: reason,
  };
  const [job] = await transaction
    .insert(analysisJobs)
    .values({
      idempotencyKey: createIdempotencyKey(
        "workspace-draft",
        plan.id,
        reason,
        occurredAt.toISOString(),
        randomUUID(),
      ),
      jobType: "draft_outreach",
      status: "queued",
      entityType: "outreach_plan",
      entityId: plan.id,
      inputHash: hashContent(payload),
      runner: "codex-cli",
      schemaVersion: 1,
      payload,
      scheduledAt: occurredAt,
    })
    .returning({ id: analysisJobs.id });
  if (!job) throw new WorkspaceMutationError("The draft job could not be queued.");
  return job.id;
}

function revalidateContact(contactId: string, companyId?: string | null) {
  revalidatePath("/people");
  revalidatePath(`/people/${contactId}`);
  revalidatePath("/outreach");
  if (companyId) revalidatePath(`/people/companies/${companyId}`);
}

export async function addContact(
  formData: FormData,
): Promise<WorkspaceActionResult<AddContactReceipt>> {
  const session = await requireOwner();
  const parsed = addContactSchema.safeParse(formObject(formData));
  if (!parsed.success) return validationFailure(parsed.error);
  const actorEmail = actorFromSession(session);
  const occurredAt = new Date();

  try {
    const receipt = await getDatabase().transaction(async (transaction) => {
      const companyId = await findOrCreateCompany(
        transaction,
        parsed.data.company,
        actorEmail,
        occurredAt,
      );
      const title = parsed.data.title ?? "Role not set";
      const [contact] = await transaction
        .insert(contacts)
        .values({
          companyId,
          displayName: parsed.data.displayName,
          primaryEmail: parsed.data.email ?? null,
          title,
          relationshipStage: "planned",
          confidence: 1,
          notes: "Added manually. No source messages are attached yet.",
          hasManualOverride: true,
          manuallyOverriddenAt: occurredAt,
          manualOverrides: prependOverrides(
            [],
            [
              {
                field: "displayName",
                value: parsed.data.displayName,
                reason: "Added manually.",
              },
              {
                field: "primaryEmail",
                value: parsed.data.email ?? null,
                reason: "Added manually.",
              },
              { field: "title", value: title, reason: "Added manually." },
              {
                field: "companyId",
                value: companyId,
                reason: "Added manually.",
              },
              {
                field: "relationshipStage",
                value: "planned",
                reason: "Added manually.",
              },
              {
                field: "notes",
                value: "Added manually. No source messages are attached yet.",
                reason: "Added manually.",
              },
            ],
            actorEmail,
            occurredAt,
          ),
          metadata: { createdManually: true },
        })
        .returning({ id: contacts.id });
      if (!contact) throw new WorkspaceMutationError("The relationship could not be created.");
      await transaction.insert(auditEvents).values({
        action: "contact.created",
        outcome: "success",
        actorEmail,
        entityType: "contact",
        entityId: contact.id,
        metadata: {
          fields: ["displayName", "primaryEmail", "title", "companyId"],
        },
        occurredAt,
      });
      return { contactId: contact.id, companyId };
    });
    revalidateContact(receipt.contactId, receipt.companyId);
    return {
      ok: true,
      data: { ...receipt, actorEmail, occurredAt: occurredAt.toISOString() },
    };
  } catch (error) {
    return mutationFailure(error, "The relationship could not be added. Please try again.");
  }
}

export async function editContact(
  contactIdInput: string,
  formData: FormData,
): Promise<WorkspaceActionResult<ContactMutationReceipt>> {
  const session = await requireOwner();
  const contactId = uuidSchema.safeParse(contactIdInput);
  const parsed = editContactSchema.safeParse(formObject(formData));
  if (!contactId.success) return { ok: false, error: "The relationship ID is invalid." };
  if (!parsed.success) return validationFailure(parsed.error);
  const actorEmail = actorFromSession(session);
  const occurredAt = new Date();

  try {
    const companyId = await getDatabase().transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(contacts)
        .where(eq(contacts.id, contactId.data))
        .limit(1);
      if (!current) throw new WorkspaceMutationError("The relationship no longer exists.");
      await transaction
        .update(contacts)
        .set({
          displayName: parsed.data.displayName,
          primaryEmail: parsed.data.email ?? null,
          notes: parsed.data.notes ?? null,
          hasManualOverride: true,
          manuallyOverriddenAt: occurredAt,
          manualOverrides: prependOverrides(
            current.manualOverrides,
            [
              {
                field: "displayName",
                value: parsed.data.displayName,
                reason: "Edited by the owner.",
              },
              {
                field: "primaryEmail",
                value: parsed.data.email ?? null,
                reason: "Edited by the owner.",
              },
              {
                field: "notes",
                value: parsed.data.notes ?? null,
                reason: "Edited by the owner.",
              },
            ],
            actorEmail,
            occurredAt,
          ),
          updatedAt: occurredAt,
        })
        .where(eq(contacts.id, contactId.data));
      await transaction.insert(auditEvents).values({
        action: "contact.edited",
        outcome: "success",
        actorEmail,
        entityType: "contact",
        entityId: contactId.data,
        metadata: { fields: ["displayName", "primaryEmail", "notes"] },
        occurredAt,
      });
      return current.companyId;
    });
    revalidateContact(contactId.data, companyId);
    return {
      ok: true,
      data: { contactId: contactId.data, actorEmail, occurredAt: occurredAt.toISOString() },
    };
  } catch (error) {
    return mutationFailure(error, "The relationship changes could not be saved.");
  }
}

export async function correctContact(
  contactIdInput: string,
  fieldInput: ContactCorrectionField,
  formData: FormData,
): Promise<WorkspaceActionResult<ContactMutationReceipt>> {
  const session = await requireOwner();
  const contactId = uuidSchema.safeParse(contactIdInput);
  const field = z.enum(["title", "company", "location"]).safeParse(fieldInput);
  const parsed = correctionSchema.safeParse(formObject(formData));
  if (!contactId.success) return { ok: false, error: "The relationship ID is invalid." };
  if (!field.success) return { ok: false, error: "That relationship field cannot be corrected." };
  if (!parsed.success) return validationFailure(parsed.error);
  const actorEmail = actorFromSession(session);
  const occurredAt = new Date();

  try {
    const companyId = await getDatabase().transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(contacts)
        .where(eq(contacts.id, contactId.data))
        .limit(1);
      if (!current) throw new WorkspaceMutationError("The relationship no longer exists.");

      const reason = parsed.data.reason ?? `Corrected ${field.data} to ${parsed.data.value}.`;
      const nextCompanyId =
        field.data === "company"
          ? await findOrCreateCompany(
              transaction,
              parsed.data.value,
              actorEmail,
              occurredAt,
            )
          : current.companyId;
      const persistedField = field.data === "company" ? "companyId" : field.data;
      const persistedValue = field.data === "company" ? nextCompanyId : parsed.data.value;
      await transaction
        .update(contacts)
        .set({
          ...(field.data === "title" ? { title: parsed.data.value } : {}),
          ...(field.data === "location" ? { location: parsed.data.value } : {}),
          ...(field.data === "company" ? { companyId: nextCompanyId } : {}),
          hasManualOverride: true,
          manuallyOverriddenAt: occurredAt,
          manualOverrides: prependOverrides(
            current.manualOverrides,
            [
              { field: persistedField, value: persistedValue, reason },
              ...(field.data === "company"
                ? [{ field: "company", value: parsed.data.value, reason }]
                : []),
            ],
            actorEmail,
            occurredAt,
          ),
          updatedAt: occurredAt,
        })
        .where(eq(contacts.id, contactId.data));
      await transaction.insert(auditEvents).values({
        action: "contact.corrected",
        outcome: "success",
        actorEmail,
        entityType: "contact",
        entityId: contactId.data,
        metadata: { field: field.data, value: parsed.data.value, reason },
        occurredAt,
      });
      return nextCompanyId;
    });
    revalidateContact(contactId.data, companyId);
    return {
      ok: true,
      data: { contactId: contactId.data, actorEmail, occurredAt: occurredAt.toISOString() },
    };
  } catch (error) {
    return mutationFailure(error, "The relationship correction could not be saved.");
  }
}

export async function mergeContacts(
  sourceContactIdInput: string,
  targetContactIdInput: string,
): Promise<WorkspaceActionResult<MergeContactsReceipt>> {
  const session = await requireOwner();
  const sourceId = uuidSchema.safeParse(sourceContactIdInput);
  const targetId = uuidSchema.safeParse(targetContactIdInput);
  if (!sourceId.success || !targetId.success)
    return { ok: false, error: "One of the relationship IDs is invalid." };
  if (sourceId.data === targetId.data)
    return { ok: false, error: "Choose a different relationship to keep." };
  const actorEmail = actorFromSession(session);
  const occurredAt = new Date();

  try {
    const targetCompanyId = await getDatabase().transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from contacts where id = ${sourceId.data} or id = ${targetId.data} order by id for update`,
      );
      const rows = await transaction
        .select()
        .from(contacts)
        .where(inArray(contacts.id, [sourceId.data, targetId.data]));
      const source = rows.find((row) => row.id === sourceId.data);
      const target = rows.find((row) => row.id === targetId.data);
      if (!source || !target)
        throw new WorkspaceMutationError("One of the relationships no longer exists.");

      await transaction
        .update(channelIdentities)
        .set({ contactId: target.id, updatedAt: occurredAt })
        .where(eq(channelIdentities.contactId, source.id));
      await transaction
        .update(conversationParticipants)
        .set({ contactId: target.id, updatedAt: occurredAt })
        .where(eq(conversationParticipants.contactId, source.id));
      await transaction
        .update(touchpoints)
        .set({ contactId: target.id, updatedAt: occurredAt })
        .where(eq(touchpoints.contactId, source.id));
      await transaction
        .update(outreachPlans)
        .set({ contactId: target.id, updatedAt: occurredAt })
        .where(eq(outreachPlans.contactId, source.id));
      await transaction
        .update(analysisJobs)
        .set({ entityId: target.id, updatedAt: occurredAt })
        .where(
          and(eq(analysisJobs.entityType, "contact"), eq(analysisJobs.entityId, source.id)),
        );
      await transaction
        .update(analysisResults)
        .set({ entityId: target.id, updatedAt: occurredAt })
        .where(
          and(
            eq(analysisResults.entityType, "contact"),
            eq(analysisResults.entityId, source.id),
          ),
        );
      await transaction
        .update(auditEvents)
        .set({ entityId: target.id })
        .where(
          and(eq(auditEvents.entityType, "contact"), eq(auditEvents.entityId, source.id)),
        );

      const [metrics] = await transaction
        .select({
          touchCount: sql<number>`count(*)::int`,
          inboundTouchCount: sql<number>`count(*) filter (where ${touchpoints.direction} = 'inbound')::int`,
          outboundTouchCount: sql<number>`count(*) filter (where ${touchpoints.direction} = 'outbound')::int`,
          firstTouchAt:
            sql`min(${touchpoints.happenedAt})`.mapWith(
              touchpoints.happenedAt,
            ),
          lastTouchAt:
            sql`max(${touchpoints.happenedAt})`.mapWith(
              touchpoints.happenedAt,
            ),
          lastInboundAt:
            sql`max(${touchpoints.happenedAt}) filter (where ${touchpoints.direction} = 'inbound')`.mapWith(
              touchpoints.happenedAt,
            ),
          lastOutboundAt:
            sql`max(${touchpoints.happenedAt}) filter (where ${touchpoints.direction} = 'outbound')`.mapWith(
              touchpoints.happenedAt,
            ),
        })
        .from(touchpoints)
        .where(eq(touchpoints.contactId, target.id));

      const mergedOverrides = prependOverrides(
        [...target.manualOverrides, ...source.manualOverrides],
        [
          {
            field: "mergedContactIds",
            value: [source.id],
            reason: `Merged ${source.displayName} into ${target.displayName}.`,
          },
        ],
        actorEmail,
        occurredAt,
      );
      const mergedIds = [
        ...new Set([
          ...((Array.isArray(target.metadata.mergedContactIds)
            ? target.metadata.mergedContactIds
            : []) as unknown[]).filter((value): value is string => typeof value === "string"),
          source.id,
          ...((Array.isArray(source.metadata.mergedContactIds)
            ? source.metadata.mergedContactIds
            : []) as unknown[]).filter((value): value is string => typeof value === "string"),
        ]),
      ];
      await transaction
        .update(contacts)
        .set({
          companyId: target.companyId ?? source.companyId,
          givenName: target.givenName ?? source.givenName,
          familyName: target.familyName ?? source.familyName,
          primaryEmail: target.primaryEmail ?? source.primaryEmail,
          title: target.title ?? source.title,
          seniority: target.seniority ?? source.seniority,
          location: target.location ?? source.location,
          firstTouchAt: metrics?.firstTouchAt ?? null,
          lastTouchAt: metrics?.lastTouchAt ?? null,
          lastInboundAt: metrics?.lastInboundAt ?? null,
          lastOutboundAt: metrics?.lastOutboundAt ?? null,
          touchCount: metrics?.touchCount ?? 0,
          inboundTouchCount: metrics?.inboundTouchCount ?? 0,
          outboundTouchCount: metrics?.outboundTouchCount ?? 0,
          replyState:
            target.replyState === "replied" || source.replyState === "replied"
              ? "replied"
              : target.replyState === "awaiting_reply" || source.replyState === "awaiting_reply"
                ? "awaiting_reply"
                : target.replyState,
          plannedFollowUpAt: target.plannedFollowUpAt ?? source.plannedFollowUpAt,
          notes: mergeNotes(target.notes, source.notes),
          confidence: Math.max(target.confidence, source.confidence),
          sourceProvenance: mergeProvenance([
            ...target.sourceProvenance,
            ...source.sourceProvenance,
          ]),
          hasManualOverride: true,
          manuallyOverriddenAt: occurredAt,
          manualOverrides: mergedOverrides,
          metadata: { ...target.metadata, mergedContactIds: mergedIds },
          updatedAt: occurredAt,
        })
        .where(eq(contacts.id, target.id));
      await transaction.delete(contacts).where(eq(contacts.id, source.id));
      await transaction.insert(auditEvents).values({
        action: "contact.merged",
        outcome: "success",
        actorEmail,
        entityType: "contact",
        entityId: target.id,
        metadata: {
          sourceContactId: source.id,
          sourceDisplayName: source.displayName,
          targetContactId: target.id,
          targetDisplayName: target.displayName,
        },
        occurredAt,
      });
      return target.companyId ?? source.companyId;
    });
    revalidateContact(targetId.data, targetCompanyId);
    revalidatePath(`/people/${sourceId.data}`);
    return {
      ok: true,
      data: {
        sourceContactId: sourceId.data,
        targetContactId: targetId.data,
        actorEmail,
        occurredAt: occurredAt.toISOString(),
      },
    };
  } catch (error) {
    return mutationFailure(error, "The relationships could not be merged safely.");
  }
}

export async function editCompany(
  companyIdInput: string,
  formData: FormData,
): Promise<WorkspaceActionResult<CompanyMutationReceipt>> {
  const session = await requireOwner();
  const companyId = uuidSchema.safeParse(companyIdInput);
  const parsed = editCompanySchema.safeParse(formObject(formData));
  if (!companyId.success) return { ok: false, error: "The company ID is invalid." };
  if (!parsed.success) return validationFailure(parsed.error);
  const actorEmail = actorFromSession(session);
  const occurredAt = new Date();

  try {
    await getDatabase().transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(companies)
        .where(eq(companies.id, companyId.data))
        .limit(1);
      if (!current) throw new WorkspaceMutationError("The company no longer exists.");
      await transaction
        .update(companies)
        .set({
          name: parsed.data.name,
          normalizedName: normalizeCompanyName(parsed.data.name),
          domain: parsed.data.domain ?? null,
          description: parsed.data.description ?? null,
          hasManualOverride: true,
          manuallyOverriddenAt: occurredAt,
          manualOverrides: prependOverrides(
            current.manualOverrides,
            [
              { field: "name", value: parsed.data.name, reason: "Edited by the owner." },
              {
                field: "normalizedName",
                value: normalizeCompanyName(parsed.data.name),
                reason: "Derived from the owner-managed name.",
              },
              {
                field: "domain",
                value: parsed.data.domain ?? null,
                reason: "Edited by the owner.",
              },
              {
                field: "description",
                value: parsed.data.description ?? null,
                reason: "Edited by the owner.",
              },
            ],
            actorEmail,
            occurredAt,
          ),
          updatedAt: occurredAt,
        })
        .where(eq(companies.id, companyId.data));
      await transaction.insert(auditEvents).values({
        action: "company.edited",
        outcome: "success",
        actorEmail,
        entityType: "company",
        entityId: companyId.data,
        metadata: { fields: ["name", "domain", "description"] },
        occurredAt,
      });
    });
    revalidatePath("/people");
    revalidatePath(`/people/companies/${companyId.data}`);
    return {
      ok: true,
      data: { companyId: companyId.data, actorEmail, occurredAt: occurredAt.toISOString() },
    };
  } catch (error) {
    return mutationFailure(error, "The company changes could not be saved.");
  }
}

export async function correctCompany(
  companyIdInput: string,
  fieldInput: CompanyCorrectionField,
  formData: FormData,
): Promise<WorkspaceActionResult<CompanyMutationReceipt>> {
  const session = await requireOwner();
  const companyId = uuidSchema.safeParse(companyIdInput);
  const field = z.enum(["industry", "sizeRange", "location"]).safeParse(fieldInput);
  const parsed = correctionSchema.safeParse(formObject(formData));
  if (!companyId.success) return { ok: false, error: "The company ID is invalid." };
  if (!field.success) return { ok: false, error: "That company field cannot be corrected." };
  if (!parsed.success) return validationFailure(parsed.error);
  const actorEmail = actorFromSession(session);
  const occurredAt = new Date();

  try {
    await getDatabase().transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(companies)
        .where(eq(companies.id, companyId.data))
        .limit(1);
      if (!current) throw new WorkspaceMutationError("The company no longer exists.");
      const reason = parsed.data.reason ?? `Corrected ${field.data} to ${parsed.data.value}.`;
      await transaction
        .update(companies)
        .set({
          [field.data]: parsed.data.value,
          hasManualOverride: true,
          manuallyOverriddenAt: occurredAt,
          manualOverrides: prependOverrides(
            current.manualOverrides,
            [{ field: field.data, value: parsed.data.value, reason }],
            actorEmail,
            occurredAt,
          ),
          updatedAt: occurredAt,
        })
        .where(eq(companies.id, companyId.data));
      await transaction.insert(auditEvents).values({
        action: "company.corrected",
        outcome: "success",
        actorEmail,
        entityType: "company",
        entityId: companyId.data,
        metadata: { field: field.data, value: parsed.data.value, reason },
        occurredAt,
      });
    });
    revalidatePath("/people");
    revalidatePath(`/people/companies/${companyId.data}`);
    return {
      ok: true,
      data: { companyId: companyId.data, actorEmail, occurredAt: occurredAt.toISOString() },
    };
  } catch (error) {
    return mutationFailure(error, "The company correction could not be saved.");
  }
}

export async function upsertOutreachPlan(
  contactIdInput: string,
  planIdInput: string | null,
  formData: FormData,
): Promise<WorkspaceActionResult<PlanMutationReceipt>> {
  const session = await requireOwner();
  const contactId = uuidSchema.safeParse(contactIdInput);
  const planId = planIdInput === null ? null : uuidSchema.safeParse(planIdInput);
  const parsed = planSchema.safeParse(formObject(formData));
  if (!contactId.success) return { ok: false, error: "The relationship ID is invalid." };
  if (planId !== null && !planId.success) return { ok: false, error: "The plan ID is invalid." };
  if (!parsed.success) return validationFailure(parsed.error);
  const actorEmail = actorFromSession(session);
  const occurredAt = new Date();
  const nextTouchAt = dateAtReviewTime(parsed.data.nextTouchAt);

  try {
    const receipt = await getDatabase().transaction(async (transaction) => {
      const [contact] = await transaction
        .select()
        .from(contacts)
        .where(eq(contacts.id, contactId.data))
        .limit(1);
      if (!contact) throw new WorkspaceMutationError("The relationship no longer exists.");

      let savedPlan: typeof outreachPlans.$inferSelect;
      if (planId === null) {
        const [created] = await transaction
          .insert(outreachPlans)
          .values({
            contactId: contact.id,
            companyId: contact.companyId,
            status: "planned",
            objective: parsed.data.objective,
            preferredChannels: [parsed.data.channel],
            nextTouchAt,
            cadenceIntervalDays: 7,
            plannedTouchCount: 1,
            hasManualOverride: true,
            manuallyOverriddenAt: occurredAt,
            manualOverrides: prependOverrides(
              [],
              [
                { field: "objective", value: parsed.data.objective, reason: "Planned by the owner." },
                {
                  field: "preferredChannels",
                  value: [parsed.data.channel],
                  reason: "Planned by the owner.",
                },
                { field: "nextTouchAt", value: nextTouchAt?.toISOString() ?? null, reason: "Planned by the owner." },
                { field: "status", value: "planned", reason: "Planned by the owner." },
              ],
              actorEmail,
              occurredAt,
            ),
          })
          .returning();
        if (!created) throw new WorkspaceMutationError("The outreach plan could not be created.");
        savedPlan = created;
      } else {
        const [current] = await transaction
          .select()
          .from(outreachPlans)
          .where(
            and(eq(outreachPlans.id, planId.data), eq(outreachPlans.contactId, contact.id)),
          )
          .limit(1);
        if (!current) throw new WorkspaceMutationError("The outreach plan no longer exists.");
        const [updated] = await transaction
          .update(outreachPlans)
          .set({
            status: "planned",
            objective: parsed.data.objective,
            preferredChannels: [parsed.data.channel],
            nextTouchAt,
            completedAt: null,
            hasManualOverride: true,
            manuallyOverriddenAt: occurredAt,
            manualOverrides: prependOverrides(
              current.manualOverrides,
              [
                { field: "objective", value: parsed.data.objective, reason: "Updated by the owner." },
                {
                  field: "preferredChannels",
                  value: [parsed.data.channel],
                  reason: "Updated by the owner.",
                },
                { field: "nextTouchAt", value: nextTouchAt?.toISOString() ?? null, reason: "Updated by the owner." },
                { field: "status", value: "planned", reason: "Updated by the owner." },
              ],
              actorEmail,
              occurredAt,
            ),
            updatedAt: occurredAt,
          })
          .where(eq(outreachPlans.id, current.id))
          .returning();
        if (!updated) throw new WorkspaceMutationError("The outreach plan could not be updated.");
        savedPlan = updated;
      }

      await transaction
        .update(contacts)
        .set({
          plannedFollowUpAt: nextTouchAt,
          relationshipStage: "planned",
          hasManualOverride: true,
          manuallyOverriddenAt: occurredAt,
          manualOverrides: prependOverrides(
            contact.manualOverrides,
            [
              {
                field: "plannedFollowUpAt",
                value: nextTouchAt?.toISOString() ?? null,
                reason: "Updated from an owner-managed outreach plan.",
              },
              {
                field: "relationshipStage",
                value: "planned",
                reason: "Updated from an owner-managed outreach plan.",
              },
            ],
            actorEmail,
            occurredAt,
          ),
          updatedAt: occurredAt,
        })
        .where(eq(contacts.id, contact.id));
      await enqueueDraftJob(transaction, savedPlan, actorEmail, occurredAt, "plan_saved");
      await transaction.insert(auditEvents).values({
        action: planId === null ? "outreach_plan.created" : "outreach_plan.updated",
        outcome: "success",
        actorEmail,
        entityType: "outreach_plan",
        entityId: savedPlan.id,
        metadata: {
          contactId: contact.id,
          nextTouchAt: nextTouchAt?.toISOString() ?? null,
          preferredChannels: [parsed.data.channel],
        },
        occurredAt,
      });
      return { planId: savedPlan.id, companyId: contact.companyId };
    });
    revalidateContact(contactId.data, receipt.companyId);
    return {
      ok: true,
      data: {
        planId: receipt.planId,
        nextTouchAt: nextTouchAt?.toISOString() ?? null,
        actorEmail,
        occurredAt: occurredAt.toISOString(),
      },
    };
  } catch (error) {
    return mutationFailure(error, "The outreach plan could not be saved.");
  }
}

export async function rescheduleOutreachPlan(
  planIdInput: string,
  formData: FormData,
): Promise<WorkspaceActionResult<PlanMutationReceipt>> {
  const session = await requireOwner();
  const planId = uuidSchema.safeParse(planIdInput);
  const parsed = rescheduleSchema.safeParse(formObject(formData));
  if (!planId.success) return { ok: false, error: "The plan ID is invalid." };
  if (!parsed.success) return validationFailure(parsed.error);
  const actorEmail = actorFromSession(session);
  const occurredAt = new Date();
  const nextTouchAt = dateAtReviewTime(parsed.data.date);

  try {
    const receipt = await getDatabase().transaction(async (transaction) => {
      const [plan] = await transaction
        .select()
        .from(outreachPlans)
        .where(eq(outreachPlans.id, planId.data))
        .limit(1);
      if (!plan) throw new WorkspaceMutationError("The outreach plan no longer exists.");
      await transaction
        .update(outreachPlans)
        .set({
          nextTouchAt,
          status: "planned",
          completedAt: null,
          hasManualOverride: true,
          manuallyOverriddenAt: occurredAt,
          manualOverrides: prependOverrides(
            plan.manualOverrides,
            [
              { field: "nextTouchAt", value: nextTouchAt?.toISOString() ?? null, reason: "Rescheduled by the owner." },
              { field: "status", value: "planned", reason: "Rescheduled by the owner." },
            ],
            actorEmail,
            occurredAt,
          ),
          updatedAt: occurredAt,
        })
        .where(eq(outreachPlans.id, plan.id));
      const [contact] = await transaction
        .select()
        .from(contacts)
        .where(eq(contacts.id, plan.contactId))
        .limit(1);
      if (!contact) throw new WorkspaceMutationError("The related relationship no longer exists.");
      await transaction
        .update(contacts)
        .set({
          plannedFollowUpAt: nextTouchAt,
          hasManualOverride: true,
          manuallyOverriddenAt: occurredAt,
          manualOverrides: prependOverrides(
            contact.manualOverrides,
            [
              {
                field: "plannedFollowUpAt",
                value: nextTouchAt?.toISOString() ?? null,
                reason: "Rescheduled from the outreach queue.",
              },
            ],
            actorEmail,
            occurredAt,
          ),
          updatedAt: occurredAt,
        })
        .where(eq(contacts.id, contact.id));
      await transaction.insert(auditEvents).values({
        action: "outreach_plan.rescheduled",
        outcome: "success",
        actorEmail,
        entityType: "outreach_plan",
        entityId: plan.id,
        metadata: { contactId: contact.id, nextTouchAt: nextTouchAt?.toISOString() ?? null },
        occurredAt,
      });
      return { contactId: contact.id, companyId: contact.companyId };
    });
    revalidateContact(receipt.contactId, receipt.companyId);
    return {
      ok: true,
      data: {
        planId: planId.data,
        nextTouchAt: nextTouchAt?.toISOString() ?? null,
        actorEmail,
        occurredAt: occurredAt.toISOString(),
      },
    };
  } catch (error) {
    return mutationFailure(error, "The follow-up could not be rescheduled.");
  }
}

export async function completeOutreachPlan(
  planIdInput: string,
): Promise<WorkspaceActionResult<PlanMutationReceipt>> {
  const session = await requireOwner();
  const planId = uuidSchema.safeParse(planIdInput);
  if (!planId.success) return { ok: false, error: "The plan ID is invalid." };
  const actorEmail = actorFromSession(session);
  const occurredAt = new Date();

  try {
    const receipt = await getDatabase().transaction(async (transaction) => {
      const [plan] = await transaction
        .select()
        .from(outreachPlans)
        .where(eq(outreachPlans.id, planId.data))
        .limit(1);
      if (!plan) throw new WorkspaceMutationError("The outreach plan no longer exists.");
      await transaction
        .update(outreachPlans)
        .set({
          status: "completed",
          completedAt: occurredAt,
          hasManualOverride: true,
          manuallyOverriddenAt: occurredAt,
          manualOverrides: prependOverrides(
            plan.manualOverrides,
            [
              { field: "status", value: "completed", reason: "Completed by the owner." },
              {
                field: "completedAt",
                value: occurredAt.toISOString(),
                reason: "Completed by the owner.",
              },
            ],
            actorEmail,
            occurredAt,
          ),
          updatedAt: occurredAt,
        })
        .where(eq(outreachPlans.id, plan.id));
      const [contact] = await transaction
        .select()
        .from(contacts)
        .where(eq(contacts.id, plan.contactId))
        .limit(1);
      if (!contact) throw new WorkspaceMutationError("The related relationship no longer exists.");
      await transaction
        .update(contacts)
        .set({
          plannedFollowUpAt: null,
          hasManualOverride: true,
          manuallyOverriddenAt: occurredAt,
          manualOverrides: prependOverrides(
            contact.manualOverrides,
            [
              {
                field: "plannedFollowUpAt",
                value: null,
                reason: "Cleared when the owner completed the outreach plan.",
              },
            ],
            actorEmail,
            occurredAt,
          ),
          updatedAt: occurredAt,
        })
        .where(eq(contacts.id, contact.id));
      await transaction.insert(auditEvents).values({
        action: "outreach_plan.completed",
        outcome: "success",
        actorEmail,
        entityType: "outreach_plan",
        entityId: plan.id,
        metadata: { contactId: contact.id },
        occurredAt,
      });
      return { contactId: contact.id, companyId: contact.companyId };
    });
    revalidateContact(receipt.contactId, receipt.companyId);
    return {
      ok: true,
      data: {
        planId: planId.data,
        nextTouchAt: null,
        actorEmail,
        occurredAt: occurredAt.toISOString(),
      },
    };
  } catch (error) {
    return mutationFailure(error, "The outreach plan could not be completed.");
  }
}

export async function retryOutreachDraft(
  planIdInput: string,
): Promise<WorkspaceActionResult<DraftRetryReceipt>> {
  const session = await requireOwner();
  const planId = uuidSchema.safeParse(planIdInput);
  if (!planId.success) return { ok: false, error: "The plan ID is invalid." };
  const actorEmail = actorFromSession(session);
  const occurredAt = new Date();

  try {
    const receipt = await getDatabase().transaction(async (transaction) => {
      const [plan] = await transaction
        .select()
        .from(outreachPlans)
        .where(eq(outreachPlans.id, planId.data))
        .limit(1);
      if (!plan) throw new WorkspaceMutationError("The outreach plan no longer exists.");
      const jobId = await enqueueDraftJob(
        transaction,
        plan,
        actorEmail,
        occurredAt,
        "owner_retry",
      );
      await transaction.insert(auditEvents).values({
        action: "outreach_plan.draft_retried",
        outcome: "success",
        actorEmail,
        entityType: "outreach_plan",
        entityId: plan.id,
        metadata: { contactId: plan.contactId, analysisJobId: jobId },
        occurredAt,
      });
      return { jobId, contactId: plan.contactId, companyId: plan.companyId };
    });
    revalidateContact(receipt.contactId, receipt.companyId);
    return {
      ok: true,
      data: {
        jobId: receipt.jobId,
        planId: planId.data,
        scheduledAt: occurredAt.toISOString(),
        actorEmail,
        occurredAt: occurredAt.toISOString(),
      },
    };
  } catch (error) {
    return mutationFailure(error, "The draft retry could not be queued.");
  }
}
