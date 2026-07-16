import { z } from "zod";

import {
  ANALYSIS_JOB_STATUS_VALUES,
  ANALYSIS_JOB_TYPE_VALUES,
  AUDIT_OUTCOME_VALUES,
  CHANNEL_VALUES,
  ENTITY_TYPE_VALUES,
  INTEGRATION_PROVIDER_VALUES,
  INTEGRATION_STATUS_VALUES,
  MESSAGE_DIRECTION_VALUES,
  OUTREACH_PLAN_STATUS_VALUES,
  PARTICIPANT_ROLE_VALUES,
  RELATIONSHIP_STAGE_VALUES,
  REPLY_STATE_VALUES,
  SYNC_RUN_STATUS_VALUES,
  SYNC_TRIGGER_VALUES,
  TOUCHPOINT_KIND_VALUES,
} from "@/lib/domain/constants";

export const channelSchema = z.enum(CHANNEL_VALUES);
export const integrationProviderSchema = z.enum(INTEGRATION_PROVIDER_VALUES);
export const integrationStatusSchema = z.enum(INTEGRATION_STATUS_VALUES);
export const messageDirectionSchema = z.enum(MESSAGE_DIRECTION_VALUES);
export const replyStateSchema = z.enum(REPLY_STATE_VALUES);
export const relationshipStageSchema = z.enum(RELATIONSHIP_STAGE_VALUES);
export const participantRoleSchema = z.enum(PARTICIPANT_ROLE_VALUES);
export const outreachPlanStatusSchema = z.enum(OUTREACH_PLAN_STATUS_VALUES);
export const touchpointKindSchema = z.enum(TOUCHPOINT_KIND_VALUES);
export const analysisJobStatusSchema = z.enum(ANALYSIS_JOB_STATUS_VALUES);
export const analysisJobTypeSchema = z.enum(ANALYSIS_JOB_TYPE_VALUES);
export const syncRunStatusSchema = z.enum(SYNC_RUN_STATUS_VALUES);
export const syncTriggerSchema = z.enum(SYNC_TRIGGER_VALUES);
export const auditOutcomeSchema = z.enum(AUDIT_OUTCOME_VALUES);
export const entityTypeSchema = z.enum(ENTITY_TYPE_VALUES);

export const isoDateTimeSchema = z.string().datetime({ offset: true });
export const confidenceSchema = z.number().min(0).max(1);
export const idempotencyKeySchema = z.string().trim().min(8).max(255);
export const metadataSchema = z.record(z.string(), z.unknown());

export const entityReferenceSchema = z.object({
  type: entityTypeSchema,
  id: z.string().uuid(),
});

export const sourceProvenanceSchema = z.object({
  provider: integrationProviderSchema,
  integrationAccountId: z.string().uuid().optional(),
  externalId: z.string().trim().min(1).max(512),
  sourceUrl: z.string().url().optional(),
  collectedAt: isoDateTimeSchema,
  confidence: confidenceSchema.default(1),
  metadata: metadataSchema.default({}),
});

export const manualOverrideSchema = z.object({
  field: z.string().trim().min(1).max(128),
  value: z.unknown(),
  reason: z.string().trim().max(1000).optional(),
  overriddenAt: isoDateTimeSchema,
  overriddenBy: z.string().email(),
});

export const readOnlyCapabilitiesSchema = z.object({
  read: z.literal(true),
  draft: z.boolean().default(true),
  send: z.literal(false),
  modify: z.literal(false),
  delete: z.literal(false),
  connect: z.literal(false),
  post: z.literal(false),
  reply: z.literal(false),
});

export const integrationAccountInputSchema = z.object({
  provider: integrationProviderSchema,
  externalAccountId: z.string().trim().min(1).max(512),
  displayName: z.string().trim().min(1).max(255),
  accountEmail: z.string().email().optional(),
  scopes: z.array(z.string().trim().min(1)).default([]),
  credentials: metadataSchema,
  capabilities: readOnlyCapabilitiesSchema,
  metadata: metadataSchema.default({}),
});

export const contactCandidateSchema = z.object({
  displayName: z.string().trim().min(1).max(255),
  givenName: z.string().trim().max(120).optional(),
  familyName: z.string().trim().max(120).optional(),
  primaryEmail: z.string().email().optional(),
  title: z.string().trim().max(255).optional(),
  seniority: z.string().trim().max(120).optional(),
  location: z.string().trim().max(255).optional(),
  relationshipStage: relationshipStageSchema.default("unreviewed"),
  company: z
    .object({
      name: z.string().trim().min(1).max(255),
      domain: z.string().trim().toLowerCase().max(255).optional(),
      externalId: z.string().trim().max(512).optional(),
    })
    .optional(),
  provenance: sourceProvenanceSchema,
  confidence: confidenceSchema,
  metadata: metadataSchema.default({}),
});

export const channelIdentityCandidateSchema = z.object({
  channel: channelSchema,
  externalId: z.string().trim().min(1).max(512),
  handle: z.string().trim().max(255).optional(),
  address: z.string().trim().max(320).optional(),
  displayName: z.string().trim().max(255).optional(),
  profileUrl: z.string().url().optional(),
  isOwner: z.boolean().default(false),
  provenance: sourceProvenanceSchema,
  metadata: metadataSchema.default({}),
});

export const participantCandidateSchema = z.object({
  externalParticipantId: z.string().trim().min(1).max(512),
  role: participantRoleSchema,
  displayName: z.string().trim().max(255).optional(),
  address: z.string().trim().max(320).optional(),
  identity: channelIdentityCandidateSchema.optional(),
});

export const messageCandidateSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  integrationAccountId: z.string().uuid(),
  channel: channelSchema,
  externalConversationId: z.string().trim().min(1).max(512),
  externalMessageId: z.string().trim().min(1).max(512),
  direction: messageDirectionSchema,
  sentAt: isoDateTimeSchema,
  receivedAt: isoDateTimeSchema.optional(),
  subject: z.string().max(1000).optional(),
  bodyText: z.string().max(1_000_000).optional(),
  bodyHtml: z.string().max(2_000_000).optional(),
  snippet: z.string().max(4000).optional(),
  replyToExternalMessageId: z.string().trim().max(512).optional(),
  senderExternalParticipantId: z.string().trim().max(512).optional(),
  participants: z.array(participantCandidateSchema).default([]),
  provenance: sourceProvenanceSchema,
  metadata: metadataSchema.default({}),
});

export const conversationCandidateSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  integrationAccountId: z.string().uuid(),
  channel: channelSchema,
  externalConversationId: z.string().trim().min(1).max(512),
  subject: z.string().trim().max(1000).optional(),
  preview: z.string().max(4000).optional(),
  participants: z.array(participantCandidateSchema).default([]),
  messages: z.array(messageCandidateSchema),
  provenance: sourceProvenanceSchema,
  metadata: metadataSchema.default({}),
});

export const outreachPlanInputSchema = z.object({
  contactId: z.string().uuid(),
  companyId: z.string().uuid().optional(),
  status: outreachPlanStatusSchema.default("draft"),
  objective: z.string().trim().min(1).max(2000),
  preferredChannels: z.array(channelSchema).min(1),
  nextTouchAt: isoDateTimeSchema.optional(),
  cadenceIntervalDays: z.number().int().positive().max(365).optional(),
  plannedTouchCount: z.number().int().nonnegative().default(1),
  suggestedDraft: z.string().max(100_000).optional(),
  metadata: metadataSchema.default({}),
});

export const analysisJobInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  jobType: analysisJobTypeSchema,
  entity: entityReferenceSchema,
  inputHash: z.string().trim().min(16).max(255),
  runner: z.string().trim().min(1).max(120).default("codex-cli"),
  model: z.string().trim().max(120).optional(),
  schemaVersion: z.number().int().positive().default(1),
  payload: metadataSchema,
});

export const analysisResultInputSchema = z.object({
  jobId: z.string().uuid(),
  entity: entityReferenceSchema,
  resultType: z.string().trim().min(1).max(120),
  schemaVersion: z.number().int().positive(),
  result: metadataSchema,
  evidence: z.array(sourceProvenanceSchema).default([]),
  confidence: confidenceSchema,
});

export const syncPageSchema = z.object({
  integrationAccountId: z.string().uuid(),
  resource: z.string().trim().min(1).max(120),
  cursor: z.string().max(10_000).optional(),
  hasMore: z.boolean(),
  conversations: z.array(conversationCandidateSchema).default([]),
  contacts: z.array(contactCandidateSchema).default([]),
  collectedAt: isoDateTimeSchema,
});

export const auditEventInputSchema = z.object({
  action: z.string().trim().min(1).max(160),
  outcome: auditOutcomeSchema,
  actorEmail: z.string().email(),
  entity: entityReferenceSchema.optional(),
  requestId: z.string().trim().max(255).optional(),
  metadata: metadataSchema.default({}),
});

export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>;
export type ManualOverride = z.infer<typeof manualOverrideSchema>;
export type ReadOnlyCapabilities = z.infer<typeof readOnlyCapabilitiesSchema>;
export type IntegrationAccountInput = z.infer<typeof integrationAccountInputSchema>;
export type ContactCandidate = z.infer<typeof contactCandidateSchema>;
export type ChannelIdentityCandidate = z.infer<typeof channelIdentityCandidateSchema>;
export type ParticipantCandidate = z.infer<typeof participantCandidateSchema>;
export type MessageCandidate = z.infer<typeof messageCandidateSchema>;
export type ConversationCandidate = z.infer<typeof conversationCandidateSchema>;
export type OutreachPlanInput = z.infer<typeof outreachPlanInputSchema>;
export type AnalysisJobInput = z.infer<typeof analysisJobInputSchema>;
export type AnalysisResultInput = z.infer<typeof analysisResultInputSchema>;
export type SyncPage = z.infer<typeof syncPageSchema>;
export type AuditEventInput = z.infer<typeof auditEventInputSchema>;
