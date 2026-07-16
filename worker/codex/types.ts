import type { AnalysisJobInput, AnalysisResultInput, SourceProvenance } from "../../lib/domain/schemas";
import type { AnalysisJobType, Channel, EntityType, MessageDirection } from "../../lib/domain/constants";

export type JsonObject = Record<string, unknown>;

export interface ClaimedAnalysisJob {
  id: string;
  idempotencyKey: string;
  jobType: AnalysisJobType;
  entityType: EntityType;
  entityId: string;
  inputHash: string;
  runner: string;
  model: string | null;
  schemaVersion: number;
  payload: JsonObject;
  attemptCount: number;
  scheduledAt: Date;
  startedAt: Date;
}

export interface AnalysisMessageContext {
  id: string;
  channel: Channel;
  direction: MessageDirection;
  sentAt: string;
  subject?: string;
  bodyText?: string;
  snippet?: string;
}

export interface AnalysisParticipantContext {
  externalParticipantId: string;
  role: "owner" | "contact" | "other";
  displayName?: string;
  address?: string;
  contactId?: string;
  identityId?: string;
}

export interface AnalysisContext {
  channel?: Channel;
  conversationId?: string;
  subject?: string;
  participants: AnalysisParticipantContext[];
  messages: AnalysisMessageContext[];
  entitySnapshot: JsonObject;
  evidence: SourceProvenance[];
}

export interface WorkerAnalysisEnvelope {
  jobId: string;
  context: AnalysisContext;
}

export interface PreparedAnalysisJob {
  claimed: ClaimedAnalysisJob;
  input: AnalysisJobInput;
}

export interface FailureDisposition {
  state: "retry_scheduled" | "dead_letter";
  nextAttemptAt?: Date;
}

export interface StoreHealth {
  ok: boolean;
  detail?: string;
}

export interface AnalysisJobStore {
  checkHealth(): Promise<StoreHealth>;
  recoverStaleJobs(now: Date, staleAfterMs: number, maxAttempts: number): Promise<number>;
  claimNext(now: Date): Promise<ClaimedAnalysisJob | null>;
  prepare(job: ClaimedAnalysisJob): Promise<PreparedAnalysisJob>;
  complete(job: ClaimedAnalysisJob, result: AnalysisResultInput, now: Date): Promise<void>;
  fail(
    job: ClaimedAnalysisJob,
    failure: { code: string; message: string; retryable: boolean },
    now: Date,
    maxAttempts: number,
    retryDelayMs: number,
  ): Promise<FailureDisposition>;
  releaseForShutdown(job: ClaimedAnalysisJob, now: Date): Promise<void>;
  close(): Promise<void>;
}

export interface WorkerClock {
  now(): Date;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface WorkerLogger {
  info(event: string, fields?: JsonObject): void;
  warn(event: string, fields?: JsonObject): void;
  error(event: string, fields?: JsonObject): void;
}
