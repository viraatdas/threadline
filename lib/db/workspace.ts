import "server-only";

import { and, desc, eq, inArray, or } from "drizzle-orm";
import { cache } from "react";

import type {
  AuditEntryView,
  EvidenceView,
  PeopleWorkspaceData,
  ResolvedField,
  TimelineItem,
} from "@/components/people/types";
import { getDatabase } from "@/lib/db/client";
import {
  analysisJobs as analysisJobsTable,
  analysisResults as analysisResultsTable,
  auditEvents as auditEventsTable,
  channelIdentities as channelIdentitiesTable,
  companies as companiesTable,
  contacts as contactsTable,
  outreachPlans as outreachPlansTable,
  touchpoints as touchpointsTable,
} from "@/lib/db/schema";
import type {
  AnalysisJob,
  AnalysisResult,
  AuditEvent,
  ChannelIdentity,
  Company,
  Contact,
  OutreachPlan,
  Touchpoint,
} from "@/lib/db/schema";
import { CHANNEL_VALUES } from "@/lib/domain/constants";
import type { Channel, EntityType } from "@/lib/domain/constants";
import type { ManualOverride, SourceProvenance } from "@/lib/domain/schemas";

export interface PeopleWorkspaceRows {
  contacts: Contact[];
  companies: Company[];
  channelIdentities: ChannelIdentity[];
  touchpoints: Touchpoint[];
  outreachPlans: OutreachPlan[];
  analysisJobs: AnalysisJob[];
  analysisResults: AnalysisResult[];
  auditEvents: AuditEvent[];
}

interface ResolvedFieldInput {
  value: string | null;
  fallback: string;
  field: string;
  overrideAliases?: string[];
  confidence: number;
  updatedAt: Date;
  provenance: SourceProvenance[];
  overrides: ManualOverride[];
  analysisResults: AnalysisResult[];
  analysisPaths: string[][];
  jobById: Map<string, AnalysisJob>;
}

const ACTIVE_RELATIONSHIP_STAGES = new Set([
  "planned",
  "active",
  "waiting",
  "replied",
  "dormant",
]);

const TIMELINE_KIND_LABELS: Record<Touchpoint["kind"], string> = {
  message: "Message",
  reply: "Reply",
  meeting: "Meeting note",
  note: "Relationship note",
  planned_follow_up: "Planned follow-up",
  draft: "Draft prepared",
};

const CHANNEL_LABELS: Record<Channel, string> = {
  gmail: "Gmail",
  linkedin: "LinkedIn",
  x: "X",
};

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requiredIso(value: Date | string, fallback: string): string {
  return toIso(value) ?? fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function stringAtPath(record: Record<string, unknown>, path: string[]) {
  let value: unknown = record;
  for (const segment of path) {
    const next = asRecord(value);
    if (!next) return null;
    value = next[segment];
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function serializeProvenance(
  provenance: SourceProvenance[],
  fallback: string,
): SourceProvenance[] {
  return provenance.map((source) => ({
    ...source,
    collectedAt: requiredIso(source.collectedAt, fallback),
    metadata: { ...source.metadata },
  }));
}

function serializeOverrides(
  overrides: ManualOverride[],
  fallback: string,
): ManualOverride[] {
  return overrides.map((override) => ({
    ...override,
    overriddenAt: requiredIso(override.overriddenAt, fallback),
  }));
}

function addToGroup<T>(map: Map<string, T[]>, key: string, value: T) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function groupByEntity<T extends { entityType: EntityType; entityId: string }>(
  rows: T[],
) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.entityType}:${row.entityId}`;
    addToGroup(grouped, key, row);
  }
  return grouped;
}

function groupAuditEvents(rows: AuditEvent[]) {
  const grouped = new Map<string, AuditEntryView[]>();
  for (const row of rows) {
    if (!row.entityType || !row.entityId) continue;
    const key = `${row.entityType}:${row.entityId}`;
    const metadataDetail = firstString(row.metadata, [
      "detail",
      "message",
      "summary",
      "reason",
      "description",
    ]);
    const metadataJson =
      Object.keys(row.metadata).length > 0
        ? JSON.stringify(row.metadata)
        : null;
    const entry: AuditEntryView = {
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      actor: row.actorEmail,
      action: row.action,
      detail: metadataDetail ?? metadataJson ?? row.action,
      outcome: row.outcome,
    };
    addToGroup(grouped, key, entry);
  }

  for (const entries of grouped.values()) {
    entries.sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt),
    );
  }
  return grouped;
}

function analysisJobId(metadata: Record<string, unknown>) {
  const analysis = asRecord(metadata.threadlineAnalysis);
  return (
    (analysis && firstString(analysis, ["lastAnalysisJobId", "jobId"])) ??
    firstString(metadata, ["lastAnalysisJobId", "analysisJobId"])
  );
}

function resultsForRecord(
  entityType: EntityType,
  entityId: string,
  metadata: Record<string, unknown>,
  resultByEntity: Map<string, AnalysisResult[]>,
  resultByJobId: Map<string, AnalysisResult[]>,
) {
  const isUsable = (result: AnalysisResult) =>
    result.acceptedAt !== null && result.rejectedAt === null;
  const direct = (
    resultByEntity.get(`${entityType}:${entityId}`) ?? []
  ).filter(isUsable);
  const linkedJobId = analysisJobId(metadata);
  const linked = linkedJobId
    ? (resultByJobId.get(linkedJobId) ?? []).filter(isUsable)
    : [];
  const candidates = linked.length > 0 ? linked : direct;
  const seen = new Set<string>();
  return candidates.filter((result) => {
    if (seen.has(result.id)) return false;
    seen.add(result.id);
    return true;
  });
}

function sourceEvidence(
  source: SourceProvenance,
  id: string,
  kind: EvidenceView["kind"],
): EvidenceView {
  return {
    id,
    kind,
    label: `${CHANNEL_LABELS[source.provider]} source`,
    detail: source.sourceUrl
      ? `Observed at ${source.sourceUrl}`
      : `Observed in source record ${source.externalId}.`,
    observedAt: source.collectedAt,
    channel: source.provider,
    confidence: source.confidence,
  };
}

function createResolvedField(input: ResolvedFieldInput): ResolvedField {
  const aliases = new Set([input.field, ...(input.overrideAliases ?? [])]);
  const overrides = serializeOverrides(
    input.overrides.filter((override) => aliases.has(override.field)),
    input.updatedAt.toISOString(),
  );
  const relevantResults = input.analysisResults
    .filter((analysisResult) =>
      input.analysisPaths.some((path) =>
        stringAtPath(analysisResult.result, path),
      ),
    )
    .toSorted(compareNewest)
    .slice(0, 1);
  const provenance = serializeProvenance(
    input.provenance,
    input.updatedAt.toISOString(),
  );
  const evidence: EvidenceView[] = [];

  for (const [index, override] of overrides.entries()) {
    evidence.push({
      id: `override-${input.field}-${index}-${override.overriddenAt}`,
      kind: "override",
      label: "Owner correction",
      detail:
        override.reason ??
        `The owner set ${input.field} to ${String(override.value)}.`,
      observedAt: override.overriddenAt,
      confidence: 1,
    });
  }

  for (const result of relevantResults) {
    const observedAt =
      toIso(result.acceptedAt) ?? result.createdAt.toISOString();
    const resultEvidence = serializeProvenance(result.evidence, observedAt);
    if (resultEvidence.length > 0) {
      for (const [index, source] of resultEvidence.entries()) {
        evidence.push(
          sourceEvidence(
            source,
            `analysis-${result.id}-${input.field}-${index}`,
            "inferred",
          ),
        );
      }
    } else {
      const job = input.jobById.get(result.jobId);
      evidence.push({
        id: `analysis-${result.id}-${input.field}`,
        kind: "inferred",
        label: "Model extraction",
        detail: `Inferred by ${job?.runner ?? "the configured analysis runner"}.`,
        observedAt,
        confidence: result.confidence,
      });
    }
  }

  for (const [index, source] of provenance.entries()) {
    evidence.push(
      sourceEvidence(source, `source-${input.field}-${index}`, "observed"),
    );
  }

  if (evidence.length === 0) {
    evidence.push({
      id: `record-${input.field}-${input.updatedAt.toISOString()}`,
      kind: "observed",
      label: "Threadline record",
      detail: "Stored on the current relationship record.",
      observedAt: input.updatedAt.toISOString(),
      confidence: input.confidence,
    });
  }

  const kind: ResolvedField["kind"] =
    overrides.length > 0
      ? "override"
      : relevantResults.length > 0
        ? "inferred"
        : "observed";
  const analysisConfidence = relevantResults.reduce(
    (highest, result) => Math.max(highest, result.confidence),
    0,
  );
  const sourceConfidence = provenance.reduce(
    (highest, source) => Math.max(highest, source.confidence),
    0,
  );

  return {
    value: input.value?.trim() || input.fallback,
    kind,
    confidence:
      kind === "override"
        ? 1
        : kind === "inferred"
          ? analysisConfidence || input.confidence
          : sourceConfidence || input.confidence,
    evidence,
    overrides,
  };
}

function timelineProvenance(touchpoint: Touchpoint): EvidenceView {
  const override = touchpoint.manualOverrides.at(-1);
  if (touchpoint.hasManualOverride && override) {
    return {
      id: `touchpoint-override-${touchpoint.id}`,
      kind: "override",
      label: "Owner correction",
      detail: override.reason ?? `The owner corrected ${override.field}.`,
      observedAt:
        toIso(override.overriddenAt) ?? touchpoint.updatedAt.toISOString(),
      confidence: 1,
    };
  }

  const source = serializeProvenance(
    touchpoint.sourceProvenance,
    touchpoint.updatedAt.toISOString(),
  ).at(0);
  if (source) {
    return sourceEvidence(
      source,
      `touchpoint-source-${touchpoint.id}`,
      "observed",
    );
  }

  return {
    id: `touchpoint-record-${touchpoint.id}`,
    kind: "observed",
    label: "Threadline record",
    detail: "Stored inside Threadline.",
    observedAt: touchpoint.updatedAt.toISOString(),
    confidence: touchpoint.sourceConfidence,
  };
}

function mapTimeline(touchpoint: Touchpoint): TimelineItem {
  const metadataTitle = firstString(touchpoint.metadata, [
    "title",
    "subject",
    "label",
  ]);
  const metadataSummary = firstString(touchpoint.metadata, [
    "summary",
    "detail",
    "description",
  ]);
  const channel = touchpoint.channel ?? "internal";
  const direction: TimelineItem["direction"] =
    touchpoint.direction === "inbound" || touchpoint.direction === "outbound"
      ? touchpoint.direction
      : "internal";
  const kind: TimelineItem["kind"] =
    touchpoint.kind === "meeting" ? "note" : touchpoint.kind;
  const channelPrefix =
    channel === "internal" ? "" : `${CHANNEL_LABELS[channel]} `;

  return {
    id: touchpoint.id,
    happenedAt: touchpoint.happenedAt.toISOString(),
    channel,
    direction,
    kind,
    title:
      metadataTitle ??
      `${channelPrefix}${TIMELINE_KIND_LABELS[touchpoint.kind]}`.trim(),
    summary:
      touchpoint.summary ?? metadataSummary ?? "No summary was recorded.",
    replyState: touchpoint.replyState,
    provenance: timelineProvenance(touchpoint),
  };
}

function latestDate(values: Array<Date | null>) {
  return values.reduce<Date | null>(
    (latest, value) =>
      value && (!latest || value.getTime() > latest.getTime()) ? value : latest,
    null,
  );
}

function earliestDate(values: Array<Date | null>) {
  return values.reduce<Date | null>(
    (earliest, value) =>
      value && (!earliest || value.getTime() < earliest.getTime())
        ? value
        : earliest,
    null,
  );
}

function resultDraftText(result: AnalysisResult | undefined) {
  if (!result) return null;
  return firstString(result.result, [
    "text",
    "draft",
    "suggestedDraft",
    "message",
    "body",
  ]);
}

function compareNewest(
  left: { updatedAt: Date; createdAt: Date },
  right: { updatedAt: Date; createdAt: Date },
) {
  return (
    right.updatedAt.getTime() - left.updatedAt.getTime() ||
    right.createdAt.getTime() - left.createdAt.getTime()
  );
}

export function mapPeopleWorkspaceData(
  rows: PeopleWorkspaceRows,
  generatedAt = new Date(),
): PeopleWorkspaceData {
  const generatedAtIso = generatedAt.toISOString();
  const companyById = new Map(
    rows.companies.map((company) => [company.id, company]),
  );
  const contactById = new Map(
    rows.contacts.map((contact) => [contact.id, contact]),
  );
  const jobById = new Map(rows.analysisJobs.map((job) => [job.id, job]));
  const resultByJobId = new Map<string, AnalysisResult[]>();
  for (const result of rows.analysisResults) {
    addToGroup(resultByJobId, result.jobId, result);
  }
  const resultByEntity = groupByEntity(rows.analysisResults);
  const auditByEntity = groupAuditEvents(rows.auditEvents);
  const identitiesByContact = new Map<string, ChannelIdentity[]>();
  for (const identity of rows.channelIdentities) {
    if (!identity.contactId) continue;
    addToGroup(identitiesByContact, identity.contactId, identity);
  }
  const touchpointsByContact = new Map<string, Touchpoint[]>();
  const touchpointsByPlan = new Map<string, Touchpoint[]>();
  for (const touchpoint of rows.touchpoints) {
    addToGroup(touchpointsByContact, touchpoint.contactId, touchpoint);
    if (touchpoint.outreachPlanId)
      addToGroup(touchpointsByPlan, touchpoint.outreachPlanId, touchpoint);
  }
  const draftJobsByTarget = new Map<string, AnalysisJob[]>();
  for (const job of rows.analysisJobs) {
    if (job.jobType !== "draft_outreach") continue;
    addToGroup(draftJobsByTarget, `${job.entityType}:${job.entityId}`, job);
  }
  for (const jobs of draftJobsByTarget.values()) {
    jobs.sort(compareNewest);
  }

  const people = rows.contacts
    .map((contact) => {
      const company = contact.companyId
        ? (companyById.get(contact.companyId) ?? null)
        : null;
      const contactResults = resultsForRecord(
        "contact",
        contact.id,
        contact.metadata,
        resultByEntity,
        resultByJobId,
      );
      const companyResults = company
        ? resultsForRecord(
            "company",
            company.id,
            company.metadata,
            resultByEntity,
            resultByJobId,
          )
        : [];
      const identities = (identitiesByContact.get(contact.id) ?? [])
        .map((identity) => {
          const label =
            firstString(identity.metadata, ["label", "kind"]) ??
            identity.displayName ??
            CHANNEL_LABELS[identity.channel];
          const address =
            identity.address ??
            identity.handle ??
            identity.displayName ??
            identity.externalId;
          return {
            id: identity.id,
            channel: identity.channel,
            label,
            address,
            ...(identity.profileUrl ? { profileUrl: identity.profileUrl } : {}),
            confidence: identity.confidence,
            lastObservedAt:
              toIso(identity.sourceCollectedAt) ??
              identity.updatedAt.toISOString(),
          };
        })
        .sort((left, right) => left.channel.localeCompare(right.channel));
      const timeline = (touchpointsByContact.get(contact.id) ?? [])
        .map(mapTimeline)
        .sort((left, right) => right.happenedAt.localeCompare(left.happenedAt));
      const companyOverrides = company?.manualOverrides ?? [];
      const companyProvenance = company?.sourceProvenance ?? [];

      return {
        id: contact.id,
        displayName: contact.displayName,
        primaryEmail: contact.primaryEmail,
        companyId: contact.companyId,
        title: createResolvedField({
          value: contact.title,
          fallback: "Role not recorded",
          field: "title",
          confidence: contact.confidence,
          updatedAt: contact.updatedAt,
          provenance: contact.sourceProvenance,
          overrides: contact.manualOverrides,
          analysisResults: contactResults,
          analysisPaths: [["role", "title"], ["title"]],
          jobById,
        }),
        company: createResolvedField({
          value: company?.name ?? null,
          fallback: "Independent",
          field: "company",
          overrideAliases: ["companyId", "companyName", "name"],
          confidence: company?.confidence ?? contact.confidence,
          updatedAt: company?.updatedAt ?? contact.updatedAt,
          provenance: [...contact.sourceProvenance, ...companyProvenance],
          overrides: [...contact.manualOverrides, ...companyOverrides],
          analysisResults: [...contactResults, ...companyResults],
          analysisPaths: [["company", "name"], ["companyName"], ["name"]],
          jobById,
        }),
        location: createResolvedField({
          value: contact.location,
          fallback: "Location not recorded",
          field: "location",
          confidence: contact.confidence,
          updatedAt: contact.updatedAt,
          provenance: contact.sourceProvenance,
          overrides: contact.manualOverrides,
          analysisResults: contactResults,
          analysisPaths: [["person", "location"], ["location"]],
          jobById,
        }),
        relationshipStage: contact.relationshipStage,
        replyState: contact.replyState,
        firstTouchAt: toIso(contact.firstTouchAt),
        lastTouchAt: toIso(contact.lastTouchAt),
        lastInboundAt: toIso(contact.lastInboundAt),
        lastOutboundAt: toIso(contact.lastOutboundAt),
        plannedFollowUpAt: toIso(contact.plannedFollowUpAt),
        touchCount: contact.touchCount,
        inboundTouchCount: contact.inboundTouchCount,
        outboundTouchCount: contact.outboundTouchCount,
        confidence: contact.confidence,
        notes: contact.notes,
        hasManualOverride: contact.hasManualOverride,
        identities,
        timeline,
        audit: auditByEntity.get(`contact:${contact.id}`) ?? [],
        sourceProvenance: serializeProvenance(
          contact.sourceProvenance,
          contact.updatedAt.toISOString(),
        ),
      };
    })
    .sort((left, right) => {
      const touchOrder = (right.lastTouchAt ?? "").localeCompare(
        left.lastTouchAt ?? "",
      );
      return touchOrder || left.displayName.localeCompare(right.displayName);
    });

  const contactsByCompany = new Map<string, typeof people>();
  for (const person of people) {
    if (!person.companyId) continue;
    contactsByCompany.set(person.companyId, [
      ...(contactsByCompany.get(person.companyId) ?? []),
      person,
    ]);
  }
  const plansByCompany = new Map<string, OutreachPlan[]>();
  for (const plan of rows.outreachPlans) {
    const contactCompanyId = companyById.has(plan.companyId ?? "")
      ? plan.companyId
      : contactById.get(plan.contactId)?.companyId;
    if (!contactCompanyId) continue;
    addToGroup(plansByCompany, contactCompanyId, plan);
  }

  const companies = rows.companies
    .map((company) => {
      const companyPeople = contactsByCompany.get(company.id) ?? [];
      const companyPlans = plansByCompany.get(company.id) ?? [];
      const analysis = resultsForRecord(
        "company",
        company.id,
        company.metadata,
        resultByEntity,
        resultByJobId,
      );
      const channelSet = new Set<Channel>();
      for (const person of companyPeople) {
        for (const identity of person.identities)
          channelSet.add(identity.channel);
        for (const item of person.timeline) {
          if (item.channel !== "internal") channelSet.add(item.channel);
        }
      }
      for (const plan of companyPlans) {
        for (const channel of plan.preferredChannels) channelSet.add(channel);
      }

      return {
        id: company.id,
        name: company.name,
        domain: company.domain,
        industry: createResolvedField({
          value: company.industry,
          fallback: "Industry not recorded",
          field: "industry",
          confidence: company.confidence,
          updatedAt: company.updatedAt,
          provenance: company.sourceProvenance,
          overrides: company.manualOverrides,
          analysisResults: analysis,
          analysisPaths: [["company", "industry"], ["industry"]],
          jobById,
        }),
        sizeRange: createResolvedField({
          value: company.sizeRange,
          fallback: "Size not recorded",
          field: "sizeRange",
          overrideAliases: ["size"],
          confidence: company.confidence,
          updatedAt: company.updatedAt,
          provenance: company.sourceProvenance,
          overrides: company.manualOverrides,
          analysisResults: analysis,
          analysisPaths: [["company", "sizeRange"], ["sizeRange"], ["size"]],
          jobById,
        }),
        location: createResolvedField({
          value: company.location,
          fallback: "Location not recorded",
          field: "location",
          confidence: company.confidence,
          updatedAt: company.updatedAt,
          provenance: company.sourceProvenance,
          overrides: company.manualOverrides,
          analysisResults: analysis,
          analysisPaths: [["company", "location"], ["location"]],
          jobById,
        }),
        description: company.description,
        confidence: company.confidence,
        hasManualOverride: company.hasManualOverride,
        peopleIds: companyPeople.map((person) => person.id),
        activeRelationshipCount: companyPeople.filter((person) =>
          ACTIVE_RELATIONSHIP_STAGES.has(person.relationshipStage),
        ).length,
        repliedCount: companyPeople.filter(
          (person) => person.replyState === "replied",
        ).length,
        awaitingReplyCount: companyPeople.filter(
          (person) => person.replyState === "awaiting_reply",
        ).length,
        lastTouchAt: toIso(
          latestDate(
            companyPeople.map((person) =>
              person.lastTouchAt ? new Date(person.lastTouchAt) : null,
            ),
          ),
        ),
        nextTouchAt: toIso(
          earliestDate([
            ...companyPeople.map((person) =>
              person.plannedFollowUpAt
                ? new Date(person.plannedFollowUpAt)
                : null,
            ),
            ...companyPlans.map((plan) => plan.nextTouchAt),
          ]),
        ),
        channelMix: CHANNEL_VALUES.filter((channel) => channelSet.has(channel)),
        sourceProvenance: serializeProvenance(
          company.sourceProvenance,
          company.updatedAt.toISOString(),
        ),
        audit: auditByEntity.get(`company:${company.id}`) ?? [],
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const plans = rows.outreachPlans
    .map((plan) => {
      const contact = contactById.get(plan.contactId);
      const draftJobs = (
        draftJobsByTarget.get(`outreach_plan:${plan.id}`) ?? []
      ).toSorted(compareNewest);
      const latestJob = draftJobs[0];
      const latestResult = latestJob
        ? (resultByJobId.get(latestJob.id) ?? [])
            .filter(
              (result) =>
                result.resultType === "outreach_draft" &&
                result.acceptedAt !== null &&
                result.rejectedAt === null,
            )
            .toSorted(compareNewest)[0]
        : undefined;
      const draftText = plan.suggestedDraft ?? resultDraftText(latestResult);
      const planTouchpoints = touchpointsByPlan.get(plan.id) ?? [];
      const evidenceCount = latestResult
        ? Math.max(
            latestResult.evidenceMessageIds.length,
            latestResult.evidence.length,
          )
        : planTouchpoints.length;
      const status = latestJob?.status ?? (draftText ? "succeeded" : "queued");

      return {
        id: plan.id,
        contactId: plan.contactId,
        companyId: plan.companyId,
        status: plan.status,
        objective: plan.objective,
        preferredChannels: [...plan.preferredChannels],
        nextTouchAt: toIso(plan.nextTouchAt),
        cadenceIntervalDays: plan.cadenceIntervalDays,
        plannedTouchCount: plan.plannedTouchCount,
        completedTouchCount: plan.completedTouchCount,
        firstTouchAt: toIso(plan.firstTouchAt),
        lastTouchAt: toIso(plan.lastTouchAt),
        completedAt: toIso(plan.completedAt),
        replyState: contact?.replyState ?? "unknown",
        suggestedDraft: {
          status,
          ...(draftText ? { text: draftText } : {}),
          ...(draftText
            ? {
                generatedAt:
                  toIso(latestResult?.acceptedAt) ??
                  toIso(latestJob?.completedAt) ??
                  plan.updatedAt.toISOString(),
              }
            : {}),
          evidenceCount,
          runner: latestJob?.runner ?? "codex-cli",
        },
        hasManualOverride: plan.hasManualOverride,
        createdAt: plan.createdAt.toISOString(),
        audit: auditByEntity.get(`outreach_plan:${plan.id}`) ?? [],
      };
    })
    .sort((left, right) => {
      if (!left.nextTouchAt && !right.nextTouchAt)
        return left.createdAt.localeCompare(right.createdAt);
      if (!left.nextTouchAt) return 1;
      if (!right.nextTouchAt) return -1;
      return left.nextTouchAt.localeCompare(right.nextTouchAt);
    });

  return { people, companies, plans, generatedAt: generatedAtIso };
}

async function loadPeopleWorkspaceDataUncached() {
  const database = getDatabase();
  const [
    contacts,
    companies,
    channelIdentities,
    touchpoints,
    outreachPlans,
    analysisJobs,
    analysisResults,
    auditEvents,
  ] = await Promise.all([
    database.select().from(contactsTable),
    database.select().from(companiesTable),
    database.select().from(channelIdentitiesTable),
    database.select().from(touchpointsTable),
    database.select().from(outreachPlansTable),
    database.select().from(analysisJobsTable),
    database.select().from(analysisResultsTable),
    database.select().from(auditEventsTable),
  ]);

  return mapPeopleWorkspaceData(
    {
      contacts,
      companies,
      channelIdentities,
      touchpoints,
      outreachPlans,
      analysisJobs,
      analysisResults,
      auditEvents,
    },
    new Date(),
  );
}

export const loadPeopleWorkspaceData = cache(loadPeopleWorkspaceDataUncached);

function stripResolvedFieldDetails(field: ResolvedField): ResolvedField {
  return { ...field, evidence: [], overrides: [] };
}

function stripListOnlyDetails(data: PeopleWorkspaceData): PeopleWorkspaceData {
  return {
    ...data,
    people: data.people.map((person) => ({
      ...person,
      title: stripResolvedFieldDetails(person.title),
      company: stripResolvedFieldDetails(person.company),
      location: stripResolvedFieldDetails(person.location),
      notes: null,
      timeline: [],
      audit: [],
      sourceProvenance: [],
    })),
    companies: data.companies.map((company) => ({
      ...company,
      industry: stripResolvedFieldDetails(company.industry),
      sizeRange: stripResolvedFieldDetails(company.sizeRange),
      location: stripResolvedFieldDetails(company.location),
      description: null,
      sourceProvenance: [],
      audit: [],
    })),
    plans: [],
  };
}

function stripOutreachOnlyDetails(data: PeopleWorkspaceData): PeopleWorkspaceData {
  return {
    ...data,
    people: data.people.map((person) => ({
      ...person,
      title: stripResolvedFieldDetails(person.title),
      company: stripResolvedFieldDetails(person.company),
      location: stripResolvedFieldDetails(person.location),
      primaryEmail: null,
      notes: null,
      identities: [],
      timeline: [],
      audit: [],
      sourceProvenance: [],
    })),
    companies: data.companies.map((company) => ({
      ...company,
      domain: null,
      industry: stripResolvedFieldDetails(company.industry),
      sizeRange: stripResolvedFieldDetails(company.sizeRange),
      location: stripResolvedFieldDetails(company.location),
      description: null,
      sourceProvenance: [],
      audit: [],
    })),
    plans: data.plans.map((plan) => ({
      ...plan,
      audit: plan.audit.map((entry) => ({ ...entry, actor: "Owner" })),
    })),
  };
}

export const loadPeopleListWorkspaceData = cache(async () =>
  stripListOnlyDetails(await loadPeopleWorkspaceDataUncached()),
);

export const loadOutreachWorkspaceData = cache(async () =>
  stripOutreachOnlyDetails(await loadPeopleWorkspaceDataUncached()),
);

function linkedResultJobIds(records: { metadata: Record<string, unknown> }[]) {
  return records
    .map((record) => analysisJobId(record.metadata))
    .filter((jobId): jobId is string => Boolean(jobId));
}

async function loadScopedAnalysis(input: {
  contactIds: string[];
  companyIds: string[];
  planIds: string[];
  linkedJobIds: string[];
}) {
  const database = getDatabase();
  const jobScopes = [
    ...(input.contactIds.length
      ? [
          and(
            eq(analysisJobsTable.entityType, "contact"),
            inArray(analysisJobsTable.entityId, input.contactIds),
          ),
        ]
      : []),
    ...(input.companyIds.length
      ? [
          and(
            eq(analysisJobsTable.entityType, "company"),
            inArray(analysisJobsTable.entityId, input.companyIds),
          ),
        ]
      : []),
    ...(input.planIds.length
      ? [
          and(
            eq(analysisJobsTable.entityType, "outreach_plan"),
            inArray(analysisJobsTable.entityId, input.planIds),
          ),
        ]
      : []),
    ...(input.linkedJobIds.length
      ? [inArray(analysisJobsTable.id, input.linkedJobIds)]
      : []),
  ].filter((scope): scope is NonNullable<typeof scope> => Boolean(scope));
  const resultScopes = [
    ...(input.contactIds.length
      ? [
          and(
            eq(analysisResultsTable.entityType, "contact"),
            inArray(analysisResultsTable.entityId, input.contactIds),
          ),
        ]
      : []),
    ...(input.companyIds.length
      ? [
          and(
            eq(analysisResultsTable.entityType, "company"),
            inArray(analysisResultsTable.entityId, input.companyIds),
          ),
        ]
      : []),
    ...(input.planIds.length
      ? [
          and(
            eq(analysisResultsTable.entityType, "outreach_plan"),
            inArray(analysisResultsTable.entityId, input.planIds),
          ),
        ]
      : []),
    ...(input.linkedJobIds.length
      ? [inArray(analysisResultsTable.jobId, input.linkedJobIds)]
      : []),
  ].filter((scope): scope is NonNullable<typeof scope> => Boolean(scope));
  const auditScopes = [
    ...(input.contactIds.length
      ? [
          and(
            eq(auditEventsTable.entityType, "contact"),
            inArray(auditEventsTable.entityId, input.contactIds),
          ),
        ]
      : []),
    ...(input.companyIds.length
      ? [
          and(
            eq(auditEventsTable.entityType, "company"),
            inArray(auditEventsTable.entityId, input.companyIds),
          ),
        ]
      : []),
    ...(input.planIds.length
      ? [
          and(
            eq(auditEventsTable.entityType, "outreach_plan"),
            inArray(auditEventsTable.entityId, input.planIds),
          ),
        ]
      : []),
  ].filter((scope): scope is NonNullable<typeof scope> => Boolean(scope));

  const [analysisJobs, analysisResults, auditEvents] = await Promise.all([
    jobScopes.length
      ? database.select().from(analysisJobsTable).where(or(...jobScopes))
      : Promise.resolve([] as AnalysisJob[]),
    resultScopes.length
      ? database.select().from(analysisResultsTable).where(or(...resultScopes))
      : Promise.resolve([] as AnalysisResult[]),
    auditScopes.length
      ? database
          .select()
          .from(auditEventsTable)
          .where(or(...auditScopes))
          .orderBy(desc(auditEventsTable.occurredAt))
          .limit(250)
      : Promise.resolve([] as AuditEvent[]),
  ]);
  return { analysisJobs, analysisResults, auditEvents };
}

async function loadPersonWorkspaceDataUncached(personId: string) {
  const database = getDatabase();
  const contacts = await database
    .select()
    .from(contactsTable)
    .where(eq(contactsTable.id, personId))
    .limit(1);
  const contact = contacts[0];
  if (!contact) {
    return mapPeopleWorkspaceData({
      contacts: [],
      companies: [],
      channelIdentities: [],
      touchpoints: [],
      outreachPlans: [],
      analysisJobs: [],
      analysisResults: [],
      auditEvents: [],
    });
  }

  const [companies, channelIdentities, touchpoints, outreachPlans] =
    await Promise.all([
      contact.companyId
        ? database
            .select()
            .from(companiesTable)
            .where(eq(companiesTable.id, contact.companyId))
            .limit(1)
        : Promise.resolve([] as Company[]),
      database
        .select()
        .from(channelIdentitiesTable)
        .where(eq(channelIdentitiesTable.contactId, contact.id)),
      database
        .select()
        .from(touchpointsTable)
        .where(eq(touchpointsTable.contactId, contact.id)),
      database
        .select()
        .from(outreachPlansTable)
        .where(eq(outreachPlansTable.contactId, contact.id)),
    ]);
  const analysis = await loadScopedAnalysis({
    contactIds: [contact.id],
    companyIds: companies.map((company) => company.id),
    planIds: outreachPlans.map((plan) => plan.id),
    linkedJobIds: linkedResultJobIds([contact, ...companies]),
  });

  return mapPeopleWorkspaceData({
    contacts,
    companies,
    channelIdentities,
    touchpoints,
    outreachPlans,
    ...analysis,
  });
}

async function loadCompanyWorkspaceDataUncached(companyId: string) {
  const database = getDatabase();
  const companies = await database
    .select()
    .from(companiesTable)
    .where(eq(companiesTable.id, companyId))
    .limit(1);
  const company = companies[0];
  if (!company) {
    return mapPeopleWorkspaceData({
      contacts: [],
      companies: [],
      channelIdentities: [],
      touchpoints: [],
      outreachPlans: [],
      analysisJobs: [],
      analysisResults: [],
      auditEvents: [],
    });
  }

  const contacts = await database
    .select()
    .from(contactsTable)
    .where(eq(contactsTable.companyId, company.id));
  const contactIds = contacts.map((contact) => contact.id);
  const [channelIdentities, touchpoints, outreachPlans] = contactIds.length
    ? await Promise.all([
        database
          .select()
          .from(channelIdentitiesTable)
          .where(inArray(channelIdentitiesTable.contactId, contactIds)),
        database
          .select()
          .from(touchpointsTable)
          .where(inArray(touchpointsTable.contactId, contactIds)),
        database
          .select()
          .from(outreachPlansTable)
          .where(
            or(
              eq(outreachPlansTable.companyId, company.id),
              inArray(outreachPlansTable.contactId, contactIds),
            ),
          ),
      ])
    : [[], [], []];
  const analysis = await loadScopedAnalysis({
    contactIds,
    companyIds: [company.id],
    planIds: outreachPlans.map((plan) => plan.id),
    linkedJobIds: linkedResultJobIds([...contacts, company]),
  });

  return mapPeopleWorkspaceData({
    contacts,
    companies,
    channelIdentities,
    touchpoints,
    outreachPlans,
    ...analysis,
  });
}

export const loadPersonWorkspaceData = cache(loadPersonWorkspaceDataUncached);
export const loadCompanyWorkspaceData = cache(loadCompanyWorkspaceDataUncached);
