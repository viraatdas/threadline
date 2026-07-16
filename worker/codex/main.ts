import { getWorkerConfig } from "./config";
import { NodeCodexExecutable } from "./executable";
import { closeHealthServer, startHealthServer, WorkerHealth } from "./health";
import { structuredLogger } from "./logger";
import { PostgresAnalysisJobStore } from "./postgres-store";
import { CodexCliAnalysisRunner } from "./runner";
import { systemWorkerClock } from "./clock";
import { CodexWorker } from "./worker";

async function main(): Promise<void> {
  const config = getWorkerConfig();
  const abortController = new AbortController();
  const health = new WorkerHealth(systemWorkerClock.now());
  const store = new PostgresAnalysisJobStore(config.DATABASE_URL);
  const runner = new CodexCliAnalysisRunner(config, new NodeCodexExecutable());
  const worker = new CodexWorker(
    config,
    store,
    runner,
    systemWorkerClock,
    structuredLogger,
    health,
  );

  const stop = (signal: NodeJS.Signals) => {
    if (abortController.signal.aborted) return;
    health.stopping();
    structuredLogger.info("worker_shutdown_requested", { signal });
    abortController.abort(new DOMException("Worker shutdown requested.", "AbortError"));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const healthServer = await startHealthServer(config.WORKER_HEALTH_PORT, health, structuredLogger);
  try {
    structuredLogger.info("codex_worker_started", {
      runner: runner.name,
      model: config.CODEX_MODEL,
      concurrency: config.WORKER_CONCURRENCY,
    });
    await worker.run(abortController.signal);
  } finally {
    health.stopped();
    await Promise.allSettled([closeHealthServer(healthServer), store.close()]);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    structuredLogger.info("codex_worker_stopped");
  }
}

void main().catch((error: unknown) => {
  structuredLogger.error("codex_worker_crashed", {
    error: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
});
