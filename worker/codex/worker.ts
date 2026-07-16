import type { AnalysisRunner } from "../../lib/domain/contracts";

import type { WorkerConfig } from "./config";
import { toWorkerError } from "./errors";
import type { WorkerHealth } from "./health";
import type {
  AnalysisJobStore,
  ClaimedAnalysisJob,
  WorkerClock,
  WorkerLogger,
} from "./types";

export type RunOneOutcome = "processed" | "idle" | "released" | "failed";

export class CodexWorker {
  constructor(
    private readonly config: WorkerConfig,
    private readonly store: AnalysisJobStore,
    private readonly runner: AnalysisRunner,
    private readonly clock: WorkerClock,
    private readonly logger: WorkerLogger,
    private readonly health: WorkerHealth,
  ) {}

  async refreshHealth(signal?: AbortSignal): Promise<void> {
    const [database, runner] = await Promise.all([
      this.store.checkHealth(),
      this.runner.checkHealth(signal),
    ]);
    this.health.dependencies(database, runner);
  }

  async runOne(signal: AbortSignal): Promise<RunOneOutcome> {
    const now = this.clock.now();
    const job = await this.store.claimNext(now);
    if (!job) {
      this.health.idle(now);
      return "idle";
    }

    this.health.processing(job.id, now);
    this.logger.info("analysis_job_claimed", {
      jobId: job.id,
      jobType: job.jobType,
      entityType: job.entityType,
      attempt: job.attemptCount,
    });
    return this.process(job, signal);
  }

  private async process(job: ClaimedAnalysisJob, signal: AbortSignal): Promise<RunOneOutcome> {
    try {
      const prepared = await this.store.prepare(job);
      const result = await this.runner.run(prepared.input, signal);
      const completedAt = this.clock.now();
      await this.store.complete(job, result, completedAt);
      this.health.succeeded(completedAt);
      this.logger.info("analysis_job_succeeded", {
        jobId: job.id,
        jobType: job.jobType,
        attempt: job.attemptCount,
      });
      return "processed";
    } catch (error) {
      const failure = toWorkerError(error);
      const failedAt = this.clock.now();
      if (signal.aborted || failure.code === "shutdown") {
        await this.store.releaseForShutdown(job, failedAt);
        this.logger.info("analysis_job_released_for_shutdown", { jobId: job.id });
        return "released";
      }

      const disposition = await this.store.fail(
        job,
        { code: failure.code, message: failure.message, retryable: failure.retryable },
        failedAt,
        this.config.WORKER_MAX_ATTEMPTS,
        this.config.WORKER_RETRY_DELAY_MS,
      );
      this.logger.warn("analysis_job_failed", {
        jobId: job.id,
        jobType: job.jobType,
        attempt: job.attemptCount,
        code: failure.code,
        disposition: disposition.state,
      });
      return "failed";
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    const recovered = await this.store.recoverStaleJobs(
      this.clock.now(),
      this.config.WORKER_STALE_AFTER_MS,
      this.config.WORKER_MAX_ATTEMPTS,
    );
    if (recovered > 0) this.logger.warn("stale_analysis_jobs_recovered", { count: recovered });

    await this.refreshHealth(signal);
    let lastHealthRefresh = this.clock.now().getTime();

    while (!signal.aborted) {
      const outcome = await this.runOne(signal);
      if (signal.aborted) break;

      const currentTime = this.clock.now().getTime();
      if (currentTime - lastHealthRefresh >= 30_000) {
        await this.refreshHealth(signal);
        lastHealthRefresh = currentTime;
      }

      if (outcome === "idle") {
        try {
          await this.clock.sleep(this.config.WORKER_POLL_INTERVAL_MS, signal);
        } catch {
          break;
        }
      }
    }
  }
}
