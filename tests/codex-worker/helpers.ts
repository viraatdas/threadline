import { analysisJobInputSchema, type AnalysisResultInput, type ManualOverride } from "../../lib/domain/schemas";

import type { WorkerConfig } from "../../worker/codex/config";
import { preserveManualOverrides } from "../../worker/codex/normalization";
import { classificationWorkerAnalysisResultSchema } from "../../worker/codex/schema";
import type {
  AnalysisContext,
  AnalysisJobStore,
  ClaimedAnalysisJob,
  FailureDisposition,
  JsonObject,
  PreparedAnalysisJob,
  StoreHealth,
  WorkerClock,
  WorkerLogger,
} from "../../worker/codex/types";

export const JOB_ID = "11111111-1111-4111-8111-111111111111";
export const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

export function workerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    DATABASE_URL: "postgresql://threadline:threadline@localhost:5432/threadline",
    ANALYSIS_RUNNER: "codex-cli",
    CODEX_COMMAND: "codex",
    CODEX_MODEL: "gpt-5.6-luna",
    CODEX_HOME: "/tmp/threadline-test-codex-home",
    CODEX_WORKDIR: "/tmp/threadline-test-codex-workdir",
    CODEX_OUTPUT_SCHEMA_PATH: `${process.cwd()}/worker/codex/classification-output.schema.json`,
    CODEX_DRAFT_OUTPUT_SCHEMA_PATH: `${process.cwd()}/worker/codex/draft-outreach-output.schema.json`,
    CODEX_TIMEOUT_MS: 5_000,
    WORKER_POLL_INTERVAL_MS: 5,
    WORKER_MAX_ATTEMPTS: 1,
    WORKER_RETRY_DELAY_MS: 10,
    WORKER_STALE_AFTER_MS: 60_000,
    WORKER_MAX_INPUT_BYTES: 65_536,
    WORKER_MAX_MESSAGES: 40,
    WORKER_MAX_MESSAGE_BYTES: 6_000,
    WORKER_HEALTH_PORT: 8_080,
    WORKER_CONCURRENCY: 1,
    ...overrides,
  };
}

export function queuedJob(): ClaimedAnalysisJob {
  return {
    id: JOB_ID,
    idempotencyKey: "analysis:conversation:22222222",
    jobType: "classify_outreach",
    entityType: "conversation",
    entityId: CONVERSATION_ID,
    inputHash: "0123456789abcdef0123456789abcdef",
    runner: "codex-cli",
    model: "gpt-5.6-luna",
    schemaVersion: 1,
    payload: { source: "mocked-analysis-job" },
    attemptCount: 0,
    scheduledAt: new Date("2026-07-15T18:10:00.000Z"),
    startedAt: new Date("2026-07-15T18:10:00.000Z"),
  };
}

interface ConversationSnapshot extends JsonObject {
  isCustomerOutreach: boolean | null;
  replyState: "unknown" | "awaiting_reply" | "replied" | "not_applicable";
  manualOverrides: ManualOverride[];
}

export class InMemoryAnalysisJobStore implements AnalysisJobStore {
  status: "queued" | "running" | "succeeded" | "failed" = "queued";
  attemptCount = 0;
  claimCount = 0;
  results: AnalysisResultInput[] = [];
  failureCode: string | null = null;
  throwDuringComplete = false;
  conversation: ConversationSnapshot;

  constructor(
    private readonly context: AnalysisContext,
    overrides: ManualOverride[] = [],
  ) {
    this.conversation = {
      isCustomerOutreach: false,
      replyState: "unknown",
      manualOverrides: overrides,
    };
  }

  checkHealth(): Promise<StoreHealth> {
    return Promise.resolve({ ok: true });
  }

  recoverStaleJobs(): Promise<number> {
    return Promise.resolve(0);
  }

  claimNext(now: Date): Promise<ClaimedAnalysisJob | null> {
    if (this.status !== "queued") return Promise.resolve(null);
    this.status = "running";
    this.attemptCount += 1;
    this.claimCount += 1;
    return Promise.resolve({ ...queuedJob(), attemptCount: this.attemptCount, startedAt: now });
  }

  prepare(job: ClaimedAnalysisJob): Promise<PreparedAnalysisJob> {
    return Promise.resolve({
      claimed: job,
      input: analysisJobInputSchema.parse({
        idempotencyKey: job.idempotencyKey,
        jobType: job.jobType,
        entity: { type: job.entityType, id: job.entityId },
        inputHash: job.inputHash,
        runner: job.runner,
        model: job.model,
        schemaVersion: job.schemaVersion,
        payload: {
          ...job.payload,
          $threadlineWorker: { jobId: job.id, context: this.context },
        },
      }),
    });
  }

  complete(job: ClaimedAnalysisJob, result: AnalysisResultInput): Promise<void> {
    if (this.status !== "running" || job.attemptCount !== this.attemptCount) {
      throw new Error("stale job lease");
    }
    const parsed = classificationWorkerAnalysisResultSchema.parse(result);
    const stagedConversation = preserveManualOverrides(
      structuredClone(this.conversation),
      {
        isCustomerOutreach: parsed.result.isCustomerOutreach,
        replyState: parsed.result.reply.state,
      },
      this.conversation.manualOverrides,
    );
    const stagedResults = [...this.results, result];
    if (this.throwDuringComplete) throw new Error("simulated transactional failure");
    this.conversation = stagedConversation;
    this.results = stagedResults;
    this.status = "succeeded";
    return Promise.resolve();
  }

  fail(
    job: ClaimedAnalysisJob,
    failure: { code: string; retryable: boolean },
    _now: Date,
    maxAttempts: number,
  ): Promise<FailureDisposition> {
    if (this.status !== "running" || job.attemptCount !== this.attemptCount) {
      throw new Error("stale job lease");
    }
    this.failureCode = failure.code;
    if (!failure.retryable || this.attemptCount >= maxAttempts) {
      this.status = "failed";
      return Promise.resolve({ state: "dead_letter" });
    }
    this.status = "queued";
    return Promise.resolve({ state: "retry_scheduled", nextAttemptAt: new Date() });
  }

  releaseForShutdown(job: ClaimedAnalysisJob): Promise<void> {
    if (this.status === "running" && job.attemptCount === this.attemptCount) {
      this.status = "queued";
      this.attemptCount = Math.max(0, this.attemptCount - 1);
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

export class FixedClock implements WorkerClock {
  constructor(private readonly value = new Date("2026-07-15T18:10:00.000Z")) {}

  now(): Date {
    return new Date(this.value);
  }

  sleep(): Promise<void> {
    return Promise.resolve();
  }
}

export class RecordingLogger implements WorkerLogger {
  readonly events: { level: string; event: string; fields?: JsonObject }[] = [];

  info(event: string, fields?: JsonObject): void {
    this.events.push({ level: "info", event, ...(fields === undefined ? {} : { fields }) });
  }

  warn(event: string, fields?: JsonObject): void {
    this.events.push({ level: "warn", event, ...(fields === undefined ? {} : { fields }) });
  }

  error(event: string, fields?: JsonObject): void {
    this.events.push({ level: "error", event, ...(fields === undefined ? {} : { fields }) });
  }
}
