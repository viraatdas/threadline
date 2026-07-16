import type { Channel } from "@/lib/domain/constants";

export type DashboardMode = "live" | "demo";

export type ActionKind = "planned_outreach" | "follow_up" | "awaiting_reply";
export type ActionUrgency = "overdue" | "today" | "upcoming" | "watch";

export interface DashboardMetrics {
  planned: number;
  followUpsDue: number;
  contacted: number;
  replied: number;
  unreplied: number;
  replyRate: number;
}

export interface DashboardNextAction {
  id: string;
  contactId: string;
  contactName: string;
  companyName: string | null;
  role: string | null;
  channel: Channel | null;
  kind: ActionKind;
  urgency: ActionUrgency;
  dueAt: string | null;
  lastTouchAt: string | null;
  touchCount: number;
  rationale: string;
  rationaleSource: "model" | "rule";
  confidence: number | null;
  suggestedDraft: string | null;
}

export interface DashboardChannelMix {
  channel: Channel;
  count: number;
  share: number;
}

export interface DashboardStaleRelationship {
  contactId: string;
  contactName: string;
  companyName: string | null;
  role: string | null;
  replyState: "unknown" | "awaiting_reply" | "replied" | "not_applicable";
  lastTouchAt: string;
  touchCount: number;
}

export interface DashboardConversation {
  id: string;
  contactId: string | null;
  contactName: string;
  companyName: string | null;
  channel: Channel;
  subject: string | null;
  preview: string | null;
  lastMessageAt: string;
  replyState: "unknown" | "awaiting_reply" | "replied" | "not_applicable";
  touchCount: number;
}

export type SyncHealthStatus =
  "healthy" | "syncing" | "attention" | "not_connected";

export interface DashboardSyncHealth {
  id: string;
  channel: Channel;
  displayName: string;
  status: SyncHealthStatus;
  statusLabel: string;
  lastSyncedAt: string | null;
  detail: string;
}

export interface DashboardAnalysisHealth {
  status: "idle" | "working" | "attention";
  queued: number;
  running: number;
  failed: number;
  succeeded: number;
  oldestQueuedAt: string | null;
  detail: string;
}

export interface DashboardSnapshot {
  generatedAt: string;
  metrics: DashboardMetrics;
  nextActions: DashboardNextAction[];
  channelMix: DashboardChannelMix[];
  staleRelationships: DashboardStaleRelationship[];
  recentConversations: DashboardConversation[];
  syncHealth: DashboardSyncHealth[];
  analysisHealth: DashboardAnalysisHealth;
}
