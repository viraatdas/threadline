import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import injectionContext from "./fixtures/prompt-injection-thread.json";
import injectedOutput from "./fixtures/model-injected-output.json";
import validOutput from "./fixtures/valid-output.json";
import { FakeCodexExecutable } from "../../worker/codex/executable";
import { WorkerHealth } from "../../worker/codex/health";
import { CodexCliAnalysisRunner } from "../../worker/codex/runner";
import type { AnalysisContext } from "../../worker/codex/types";
import { CodexWorker } from "../../worker/codex/worker";
import {
  FixedClock,
  InMemoryAnalysisJobStore,
  RecordingLogger,
  workerConfig,
} from "./helpers";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_ACCESS_TOKEN;
  delete process.env.DATABASE_URL;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function setupWorker(
  responses: ConstructorParameters<typeof FakeCodexExecutable>[0],
  store = new InMemoryAnalysisJobStore(injectionContext as AnalysisContext),
) {
  const root = await mkdtemp(join(tmpdir(), "threadline-worker-test-"));
  temporaryDirectories.push(root);
  const config = workerConfig({
    CODEX_HOME: join(root, "codex-home"),
    CODEX_WORKDIR: join(root, "empty-workdir"),
  });
  const executable = new FakeCodexExecutable(responses);
  const runner = new CodexCliAnalysisRunner(config, executable);
  const clock = new FixedClock();
  const logger = new RecordingLogger();
  const health = new WorkerHealth(clock.now());
  const worker = new CodexWorker(config, store, runner, clock, logger, health);
  return { executable, health, logger, store, worker };
}

describe("serialized analysis worker", () => {
  it("claims a mocked job exactly once and commits normalized output transactionally", async () => {
    const store = new InMemoryAnalysisJobStore(injectionContext as AnalysisContext, [
      {
        field: "isCustomerOutreach",
        value: false,
        reason: "Owner marked this thread manually.",
        overriddenAt: "2026-07-15T18:09:00.000Z",
        overriddenBy: "owner@example.com",
      },
    ]);
    const { worker } = await setupWorker([{ output: validOutput }], store);
    const signal = new AbortController().signal;

    await expect(Promise.all([worker.runOne(signal), worker.runOne(signal)])).resolves.toEqual(
      expect.arrayContaining(["processed", "idle"]),
    );

    expect(store.claimCount).toBe(1);
    expect(store.results).toHaveLength(1);
    expect(store.status).toBe("succeeded");
    expect(store.conversation.isCustomerOutreach).toBe(false);
    expect(store.conversation.replyState).toBe("replied");
  });

  it("rolls back normalized writes when transactional completion fails", async () => {
    const store = new InMemoryAnalysisJobStore(injectionContext as AnalysisContext);
    store.throwDuringComplete = true;
    const { worker } = await setupWorker([{ output: validOutput }], store);

    await expect(worker.runOne(new AbortController().signal)).resolves.toBe("failed");
    expect(store.status).toBe("failed");
    expect(store.failureCode).toBe("worker_internal");
    expect(store.results).toHaveLength(0);
    expect(store.conversation).toMatchObject({
      isCustomerOutreach: false,
      replyState: "unknown",
    });
  });

  it("dead-letters schema-invalid model-injected output without normalizing it", async () => {
    const { store, worker } = await setupWorker([{ output: injectedOutput }]);

    await expect(worker.runOne(new AbortController().signal)).resolves.toBe("failed");
    expect(store.status).toBe("failed");
    expect(store.failureCode).toBe("invalid_model_output");
    expect(store.results).toHaveLength(0);
  });

  it("aborts Codex and requeues the active claim during shutdown", async () => {
    const { executable, store, worker } = await setupWorker([{ waitForAbort: true }]);
    const controller = new AbortController();
    const outcome = worker.runOne(controller.signal);
    await vi.waitFor(() => expect(executable.requests).toHaveLength(1));

    controller.abort(new DOMException("shutdown", "AbortError"));

    await expect(outcome).resolves.toBe("released");
    expect(store.status).toBe("queued");
    expect(store.attemptCount).toBe(0);
    expect(store.results).toHaveLength(0);
  });
});
