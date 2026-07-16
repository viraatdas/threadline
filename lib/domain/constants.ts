export const CHANNEL_VALUES = ["gmail", "linkedin", "x"] as const;
export const INTEGRATION_PROVIDER_VALUES = CHANNEL_VALUES;
export const INTEGRATION_STATUS_VALUES = [
  "pending",
  "connected",
  "attention_required",
  "disabled",
] as const;
export const MESSAGE_DIRECTION_VALUES = [
  "inbound",
  "outbound",
  "system",
  "unknown",
] as const;
export const REPLY_STATE_VALUES = [
  "unknown",
  "awaiting_reply",
  "replied",
  "not_applicable",
] as const;
export const RELATIONSHIP_STAGE_VALUES = [
  "unreviewed",
  "planned",
  "active",
  "waiting",
  "replied",
  "dormant",
  "closed",
] as const;
export const PARTICIPANT_ROLE_VALUES = ["owner", "contact", "other"] as const;
export const OUTREACH_PLAN_STATUS_VALUES = [
  "draft",
  "planned",
  "active",
  "paused",
  "completed",
  "cancelled",
] as const;
export const TOUCHPOINT_KIND_VALUES = [
  "message",
  "reply",
  "meeting",
  "note",
  "planned_follow_up",
  "draft",
] as const;
export const ANALYSIS_JOB_STATUS_VALUES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export const ANALYSIS_JOB_TYPE_VALUES = [
  "classify_outreach",
  "extract_contact",
  "resolve_company",
  "summarize_thread",
  "detect_reply",
  "recommend_follow_up",
  "draft_outreach",
] as const;
export const SYNC_RUN_STATUS_VALUES = [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
] as const;
export const SYNC_TRIGGER_VALUES = ["manual", "scheduled", "webhook", "backfill"] as const;
export const AUDIT_OUTCOME_VALUES = ["success", "denied", "failure"] as const;
export const ENTITY_TYPE_VALUES = [
  "integration_account",
  "contact",
  "company",
  "channel_identity",
  "conversation",
  "message",
  "outreach_plan",
  "touchpoint",
  "analysis_job",
  "analysis_result",
  "sync_run",
  "setting",
] as const;

export type Channel = (typeof CHANNEL_VALUES)[number];
export type IntegrationProvider = (typeof INTEGRATION_PROVIDER_VALUES)[number];
export type IntegrationStatus = (typeof INTEGRATION_STATUS_VALUES)[number];
export type MessageDirection = (typeof MESSAGE_DIRECTION_VALUES)[number];
export type ReplyState = (typeof REPLY_STATE_VALUES)[number];
export type RelationshipStage = (typeof RELATIONSHIP_STAGE_VALUES)[number];
export type ParticipantRole = (typeof PARTICIPANT_ROLE_VALUES)[number];
export type OutreachPlanStatus = (typeof OUTREACH_PLAN_STATUS_VALUES)[number];
export type TouchpointKind = (typeof TOUCHPOINT_KIND_VALUES)[number];
export type AnalysisJobStatus = (typeof ANALYSIS_JOB_STATUS_VALUES)[number];
export type AnalysisJobType = (typeof ANALYSIS_JOB_TYPE_VALUES)[number];
export type SyncRunStatus = (typeof SYNC_RUN_STATUS_VALUES)[number];
export type SyncTrigger = (typeof SYNC_TRIGGER_VALUES)[number];
export type AuditOutcome = (typeof AUDIT_OUTCOME_VALUES)[number];
export type EntityType = (typeof ENTITY_TYPE_VALUES)[number];
