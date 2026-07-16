import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { mapPeopleWorkspaceData } from "@/lib/db/workspace";
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
import type { ManualOverride, SourceProvenance } from "@/lib/domain/schemas";

const createdAt = new Date("2026-07-01T12:00:00.000Z");
const updatedAt = new Date("2026-07-02T12:00:00.000Z");
const contactId = "20000000-0000-4000-8000-000000000001";
const companyId = "10000000-0000-4000-8000-000000000001";
const planId = "30000000-0000-4000-8000-000000000001";
const jobId = "40000000-0000-4000-8000-000000000001";

const provenance: SourceProvenance = {
  provider: "gmail",
  externalId: "thread-1",
  collectedAt: "2026-07-02T08:00:00-04:00",
  confidence: 0.94,
  metadata: { access: "read-only" },
};

const titleOverride: ManualOverride = {
  field: "title",
  value: "Founder",
  reason: "Confirmed by the owner.",
  overriddenAt: "2026-07-02T09:00:00-04:00",
  overriddenBy: "owner@example.com",
};

const company: Company = {
  id: companyId,
  name: "Acme",
  normalizedName: "acme",
  domain: "acme.test",
  websiteUrl: null,
  linkedinUrl: null,
  industry: "Developer tools",
  sizeRange: "1–10",
  location: "New York, NY",
  description: "A test company.",
  confidence: 0.9,
  metadata: {},
  sourceExternalId: "company-1",
  sourceUrl: null,
  sourceCollectedAt: updatedAt,
  sourceConfidence: 0.9,
  sourceProvenance: [provenance],
  hasManualOverride: false,
  manualOverrides: [],
  manuallyOverriddenAt: null,
  createdAt,
  updatedAt,
};

const contact: Contact = {
  id: contactId,
  companyId,
  displayName: "Ada Example",
  givenName: "Ada",
  familyName: "Example",
  primaryEmail: "ada@acme.test",
  title: "Founder",
  seniority: null,
  location: "New York, NY",
  relationshipStage: "replied",
  replyState: "replied",
  firstTouchAt: createdAt,
  lastTouchAt: updatedAt,
  lastInboundAt: updatedAt,
  lastOutboundAt: createdAt,
  plannedFollowUpAt: new Date("2026-07-10T12:00:00.000Z"),
  touchCount: 2,
  inboundTouchCount: 1,
  outboundTouchCount: 1,
  confidence: 0.88,
  notes: "Keep this concise.",
  metadata: {},
  sourceExternalId: "contact-1",
  sourceUrl: null,
  sourceCollectedAt: updatedAt,
  sourceConfidence: 0.94,
  sourceProvenance: [provenance],
  hasManualOverride: true,
  manualOverrides: [titleOverride],
  manuallyOverriddenAt: updatedAt,
  createdAt,
  updatedAt,
};

const identity: ChannelIdentity = {
  id: "50000000-0000-4000-8000-000000000001",
  contactId,
  integrationAccountId: null,
  channel: "gmail",
  externalId: "ada@acme.test",
  handle: null,
  address: "ada@acme.test",
  displayName: "Work email",
  profileUrl: null,
  isOwner: false,
  confidence: 0.99,
  metadata: {},
  sourceExternalId: "identity-1",
  sourceUrl: null,
  sourceCollectedAt: updatedAt,
  sourceConfidence: 0.99,
  sourceProvenance: [provenance],
  hasManualOverride: false,
  manualOverrides: [],
  manuallyOverriddenAt: null,
  createdAt,
  updatedAt,
};

const touchpoint: Touchpoint = {
  id: "60000000-0000-4000-8000-000000000001",
  contactId,
  companyId,
  conversationId: null,
  messageId: null,
  outreachPlanId: planId,
  integrationAccountId: null,
  idempotencyKey: "touchpoint-1",
  channel: "gmail",
  direction: "inbound",
  kind: "reply",
  replyState: "replied",
  happenedAt: updatedAt,
  isAutomated: true,
  summary: "Ada replied with interest.",
  metadata: { subject: "Re: intro" },
  sourceExternalId: "message-1",
  sourceUrl: null,
  sourceCollectedAt: updatedAt,
  sourceConfidence: 0.94,
  sourceProvenance: [provenance],
  hasManualOverride: false,
  manualOverrides: [],
  manuallyOverriddenAt: null,
  createdAt,
  updatedAt,
};

const plan: OutreachPlan = {
  id: planId,
  contactId,
  companyId,
  status: "active",
  objective: "Follow up with the product note.",
  preferredChannels: ["gmail"],
  nextTouchAt: new Date("2026-07-10T12:00:00.000Z"),
  cadenceIntervalDays: 7,
  plannedTouchCount: 2,
  completedTouchCount: 1,
  firstTouchAt: createdAt,
  lastTouchAt: updatedAt,
  completedAt: null,
  suggestedDraft: null,
  metadata: {},
  hasManualOverride: false,
  manualOverrides: [],
  manuallyOverriddenAt: null,
  createdAt,
  updatedAt,
};

const analysisJob: AnalysisJob = {
  id: jobId,
  idempotencyKey: "draft-job-1",
  jobType: "draft_outreach",
  status: "succeeded",
  entityType: "outreach_plan",
  entityId: planId,
  inputHash: "0123456789abcdef",
  runner: "codex-cli",
  model: null,
  schemaVersion: 1,
  payload: {},
  attemptCount: 1,
  scheduledAt: createdAt,
  startedAt: createdAt,
  completedAt: updatedAt,
  failedAt: null,
  errorCode: null,
  errorMessage: null,
  createdAt,
  updatedAt,
};

const analysisResult: AnalysisResult = {
  id: "70000000-0000-4000-8000-000000000001",
  jobId,
  entityType: "outreach_plan",
  entityId: planId,
  resultType: "outreach_draft",
  schemaVersion: 1,
  result: { text: "Ada — here is the concise product note I mentioned." },
  evidence: [provenance],
  evidenceMessageIds: ["80000000-0000-4000-8000-000000000001"],
  confidence: 0.91,
  acceptedAt: updatedAt,
  rejectedAt: null,
  hasManualOverride: false,
  manualOverrides: [],
  manuallyOverriddenAt: null,
  createdAt,
  updatedAt,
};

const auditEvent: AuditEvent = {
  id: "90000000-0000-4000-8000-000000000001",
  action: "contact.corrected",
  outcome: "success",
  actorEmail: "owner@example.com",
  entityType: "contact",
  entityId: contactId,
  requestId: null,
  ipHash: null,
  userAgent: null,
  metadata: { detail: "Confirmed the founder title." },
  occurredAt: updatedAt,
};

describe("people workspace database mapping", () => {
  it("maps source evidence, owner overrides, analysis drafts, and audit events", () => {
    const data = mapPeopleWorkspaceData(
      {
        contacts: [contact],
        companies: [company],
        channelIdentities: [identity],
        touchpoints: [touchpoint],
        outreachPlans: [plan],
        analysisJobs: [analysisJob],
        analysisResults: [analysisResult],
        auditEvents: [auditEvent],
      },
      new Date("2026-07-03T12:00:00.000Z"),
    );

    expect(data.generatedAt).toBe("2026-07-03T12:00:00.000Z");
    expect(data.people[0]?.title).toMatchObject({
      value: "Founder",
      kind: "override",
      confidence: 1,
      overrides: [{ reason: "Confirmed by the owner." }],
    });
    expect(data.people[0]?.identities[0]?.lastObservedAt).toBe(
      "2026-07-02T12:00:00.000Z",
    );
    expect(data.people[0]?.timeline[0]).toMatchObject({
      channel: "gmail",
      direction: "inbound",
      kind: "reply",
      title: "Re: intro",
      provenance: { kind: "observed", channel: "gmail" },
    });
    expect(data.people[0]?.audit[0]?.detail).toBe(
      "Confirmed the founder title.",
    );
    expect(data.companies[0]).toMatchObject({
      peopleIds: [contactId],
      activeRelationshipCount: 1,
      repliedCount: 1,
      channelMix: ["gmail"],
    });
    expect(data.plans[0]?.suggestedDraft).toMatchObject({
      status: "succeeded",
      text: "Ada — here is the concise product note I mentioned.",
      generatedAt: "2026-07-02T12:00:00.000Z",
      evidenceCount: 1,
      runner: "codex-cli",
    });
    expect(() => JSON.stringify(data)).not.toThrow();
  });

  it("ignores rejected results and keeps plan drafts and evidence isolated", () => {
    const secondPlanId = "30000000-0000-4000-8000-000000000002";
    const secondPlan: OutreachPlan = {
      ...plan,
      id: secondPlanId,
      suggestedDraft: null,
      createdAt: new Date("2026-07-03T10:00:00.000Z"),
      updatedAt: new Date("2026-07-03T10:00:00.000Z"),
    };
    const contactDraftJob: AnalysisJob = {
      ...analysisJob,
      id: "40000000-0000-4000-8000-000000000002",
      idempotencyKey: "legacy-contact-draft-job",
      entityType: "contact",
      entityId: contactId,
      updatedAt: new Date("2026-07-04T12:00:00.000Z"),
    };
    const contactDraftResult: AnalysisResult = {
      ...analysisResult,
      id: "70000000-0000-4000-8000-000000000002",
      jobId: contactDraftJob.id,
      entityType: "contact",
      entityId: contactId,
      result: { text: "This contact-level draft must not leak into a plan." },
      updatedAt: contactDraftJob.updatedAt,
    };
    const unassignedTouchpoint: Touchpoint = {
      ...touchpoint,
      id: "60000000-0000-4000-8000-000000000002",
      outreachPlanId: null,
      idempotencyKey: "unassigned-touchpoint",
    };
    const acceptedCompanyJob: AnalysisJob = {
      ...analysisJob,
      id: "40000000-0000-4000-8000-000000000003",
      idempotencyKey: "accepted-company-job",
      jobType: "classify_outreach",
      entityType: "company",
      entityId: companyId,
    };
    const acceptedCompanyResult: AnalysisResult = {
      ...analysisResult,
      id: "70000000-0000-4000-8000-000000000003",
      jobId: acceptedCompanyJob.id,
      entityType: "company",
      entityId: companyId,
      resultType: "outreach_classification",
      result: { company: { industry: "Developer tools" } },
      confidence: 0.72,
      evidence: [],
      updatedAt: new Date("2026-07-03T12:00:00.000Z"),
    };
    const rejectedCompanyJob: AnalysisJob = {
      ...acceptedCompanyJob,
      id: "40000000-0000-4000-8000-000000000004",
      idempotencyKey: "rejected-company-job",
      updatedAt: new Date("2026-07-04T12:00:00.000Z"),
    };
    const rejectedCompanyResult: AnalysisResult = {
      ...acceptedCompanyResult,
      id: "70000000-0000-4000-8000-000000000004",
      jobId: rejectedCompanyJob.id,
      confidence: 0.99,
      rejectedAt: new Date("2026-07-04T12:00:00.000Z"),
      updatedAt: rejectedCompanyJob.updatedAt,
    };
    const staleCompanyJob: AnalysisJob = {
      ...acceptedCompanyJob,
      id: "40000000-0000-4000-8000-000000000005",
      idempotencyKey: "stale-company-job",
      updatedAt: new Date("2026-07-05T12:00:00.000Z"),
    };
    const staleCompanyResult: AnalysisResult = {
      ...acceptedCompanyResult,
      id: "70000000-0000-4000-8000-000000000005",
      jobId: staleCompanyJob.id,
      confidence: 0.98,
      updatedAt: staleCompanyJob.updatedAt,
    };

    const data = mapPeopleWorkspaceData({
      contacts: [contact],
      companies: [
        {
          ...company,
          metadata: { lastAnalysisJobId: acceptedCompanyJob.id },
        },
      ],
      channelIdentities: [identity],
      touchpoints: [touchpoint, unassignedTouchpoint],
      outreachPlans: [plan, secondPlan],
      analysisJobs: [
        analysisJob,
        contactDraftJob,
        acceptedCompanyJob,
        rejectedCompanyJob,
        staleCompanyJob,
      ],
      analysisResults: [
        analysisResult,
        contactDraftResult,
        acceptedCompanyResult,
        rejectedCompanyResult,
        staleCompanyResult,
      ],
      auditEvents: [],
    });

    expect(data.companies[0]?.industry).toMatchObject({
      kind: "inferred",
      confidence: 0.72,
    });
    expect(data.plans.find(({ id }) => id === planId)?.suggestedDraft).toMatchObject(
      {
        text: "Ada — here is the concise product note I mentioned.",
        evidenceCount: 1,
      },
    );
    expect(
      data.plans.find(({ id }) => id === secondPlanId)?.suggestedDraft,
    ).not.toHaveProperty("text");
  });
});
