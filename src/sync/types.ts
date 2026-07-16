import type {
  Channel,
  SyncRunStatus,
  SyncTrigger,
} from "@/lib/domain/constants";

export const SYNC_CHANNELS = ["gmail", "linkedin", "x"] as const;

export interface UnifiedSyncAccount {
  id: string;
  channel: Channel;
  displayName: string;
  status: "pending" | "connected" | "attention_required" | "disabled";
  syncEnabled: boolean;
}

export interface ChannelSyncCounts {
  discoveredCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  analysisEnqueuedCount: number;
}

export interface ChannelSyncResult extends ChannelSyncCounts {
  status: "succeeded" | "partial";
  childRunId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelSyncContext {
  account: UnifiedSyncAccount;
  trigger: Extract<SyncTrigger, "manual" | "scheduled">;
  now: Date;
  limit?: number;
  since?: Date;
  gmailBackfillDays?: number;
  signal: AbortSignal;
}

export interface SyncChannelExecutor {
  readonly channel: Channel;
  readonly resource: string;
  execute(context: ChannelSyncContext): Promise<ChannelSyncResult>;
  isRetryable?(error: unknown): boolean;
}

export type SyncRunClaim =
  | {
      acquired: true;
      runId: string;
    }
  | {
      acquired: false;
      reason: "duplicate" | "locked";
      runId?: string;
      status?: SyncRunStatus;
    };

export interface SyncCoordinatorStore {
  listAccounts(channels?: readonly Channel[]): Promise<UnifiedSyncAccount[]>;
  claimRun(input: {
    account: UnifiedSyncAccount;
    resource: string;
    trigger: Extract<SyncTrigger, "manual" | "scheduled">;
    invocationId: string;
    now: Date;
    leaseMs: number;
  }): Promise<SyncRunClaim>;
  completeRun(input: {
    runId: string;
    account: UnifiedSyncAccount;
    resource: string;
    status: Extract<SyncRunStatus, "succeeded" | "partial" | "failed">;
    counts: ChannelSyncCounts;
    completedAt: Date;
    errorCode?: string;
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface SyncReconciliationSummary {
  contactsMerged: number;
  contactsRecomputed: number;
  analysisJobsEnqueued: number;
}

export interface SyncReconciler {
  reconcile(input: {
    integrationAccountIds: readonly string[];
    now: Date;
  }): Promise<SyncReconciliationSummary>;
}

export interface ChannelSyncOutcome extends ChannelSyncCounts {
  accountId: string;
  channel: Channel;
  displayName: string;
  status: "succeeded" | "partial" | "failed" | "skipped";
  reason?: "disabled" | "duplicate" | "locked" | "unsupported";
  runId?: string;
  childRunId?: string;
  attempts: number;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface UnifiedSyncSummary {
  invocationId: string;
  trigger: Extract<SyncTrigger, "manual" | "scheduled">;
  status: "succeeded" | "partial" | "failed";
  startedAt: string;
  completedAt: string;
  outcomes: ChannelSyncOutcome[];
  reconciliation?: SyncReconciliationSummary;
  reconciliationError?: string;
}

export interface UnifiedSyncRequest {
  trigger: Extract<SyncTrigger, "manual" | "scheduled">;
  invocationId: string;
  channels?: readonly Channel[];
  limit?: number;
  since?: Date;
  gmailBackfillDays?: number;
  maxConcurrency?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
