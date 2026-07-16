import type {
  AnalysisJobStatus,
  Channel,
  OutreachPlanStatus,
  RelationshipStage,
  ReplyState,
} from "@/lib/domain/constants";
import type { Company, Contact, OutreachPlan } from "@/lib/db/schema";
import type { ManualOverride, SourceProvenance } from "@/lib/domain/schemas";

export type EvidenceKind = "observed" | "inferred" | "override";
export type TimelineChannel = Channel | "internal";
export type OutreachQueueGroup =
  "planned" | "due" | "waiting" | "replied" | "stale";

export interface EvidenceView {
  id: string;
  kind: EvidenceKind;
  label: string;
  detail: string;
  observedAt: string;
  channel?: Channel;
  confidence?: number;
}

export interface ResolvedField {
  value: string;
  kind: EvidenceKind;
  confidence: number;
  evidence: EvidenceView[];
  overrides: ManualOverride[];
}

export interface ChannelIdentityView {
  id: string;
  channel: Channel;
  label: string;
  address: string;
  profileUrl?: string;
  confidence: number;
  lastObservedAt: string;
}

export interface TimelineItem {
  id: string;
  happenedAt: string;
  channel: TimelineChannel;
  direction: "inbound" | "outbound" | "internal";
  kind: "message" | "reply" | "note" | "planned_follow_up" | "draft";
  title: string;
  summary: string;
  replyState: ReplyState;
  provenance: EvidenceView;
}

export interface AuditEntryView {
  id: string;
  occurredAt: string;
  actor: string;
  action: string;
  detail: string;
  outcome: "success" | "denied" | "failure";
}

export interface DraftSuggestionView {
  status: AnalysisJobStatus;
  text?: string;
  generatedAt?: string;
  evidenceCount: number;
  runner: string;
}

export interface PersonRecord {
  id: Contact["id"];
  displayName: Contact["displayName"];
  primaryEmail: Contact["primaryEmail"];
  companyId: Contact["companyId"];
  title: ResolvedField;
  company: ResolvedField;
  location: ResolvedField;
  relationshipStage: RelationshipStage;
  replyState: ReplyState;
  firstTouchAt: string | null;
  lastTouchAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  plannedFollowUpAt: string | null;
  touchCount: Contact["touchCount"];
  inboundTouchCount: Contact["inboundTouchCount"];
  outboundTouchCount: Contact["outboundTouchCount"];
  confidence: Contact["confidence"];
  notes: Contact["notes"];
  hasManualOverride: Contact["hasManualOverride"];
  identities: ChannelIdentityView[];
  timeline: TimelineItem[];
  audit: AuditEntryView[];
  sourceProvenance: SourceProvenance[];
}

export interface CompanyRecord {
  id: Company["id"];
  name: Company["name"];
  domain: Company["domain"];
  industry: ResolvedField;
  sizeRange: ResolvedField;
  location: ResolvedField;
  description: Company["description"];
  confidence: Company["confidence"];
  hasManualOverride: Company["hasManualOverride"];
  peopleIds: string[];
  activeRelationshipCount: number;
  repliedCount: number;
  awaitingReplyCount: number;
  lastTouchAt: string | null;
  nextTouchAt: string | null;
  channelMix: Channel[];
  sourceProvenance: SourceProvenance[];
  audit: AuditEntryView[];
}

export interface OutreachPlanView {
  id: OutreachPlan["id"];
  contactId: OutreachPlan["contactId"];
  companyId: OutreachPlan["companyId"];
  status: OutreachPlanStatus;
  objective: OutreachPlan["objective"];
  preferredChannels: Channel[];
  nextTouchAt: string | null;
  cadenceIntervalDays: OutreachPlan["cadenceIntervalDays"];
  plannedTouchCount: OutreachPlan["plannedTouchCount"];
  completedTouchCount: OutreachPlan["completedTouchCount"];
  firstTouchAt: string | null;
  lastTouchAt: string | null;
  completedAt: string | null;
  replyState: ReplyState;
  suggestedDraft: DraftSuggestionView;
  hasManualOverride: OutreachPlan["hasManualOverride"];
  createdAt: string;
  audit: AuditEntryView[];
}

export interface PeopleWorkspaceData {
  people: PersonRecord[];
  companies: CompanyRecord[];
  plans: OutreachPlanView[];
  generatedAt: string;
}

export interface PeopleFilters {
  query: string;
  view: "people" | "companies";
  reply: "all" | ReplyState;
  channel: "all" | Channel;
  confidence: "all" | "review" | "confirmed";
}

export interface OutreachFilters {
  query: string;
  channel: "all" | Channel;
  ownerState: "all" | "needs_review" | "overridden";
}
