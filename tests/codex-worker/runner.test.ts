import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import injectionContext from "./fixtures/prompt-injection-thread.json";
import injectedOutput from "./fixtures/model-injected-output.json";
import validOutput from "./fixtures/valid-output.json";
import { analysisJobInputSchema } from "../../lib/domain/schemas";
import { FakeCodexExecutable } from "../../worker/codex/executable";
import { CodexCliAnalysisRunner } from "../../worker/codex/runner";
import type { AnalysisContext } from "../../worker/codex/types";
import { CONVERSATION_ID, JOB_ID, workerConfig } from "./helpers";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function setupRunner(output: unknown) {
  const root = await mkdtemp(join(tmpdir(), "threadline-runner-test-"));
  temporaryDirectories.push(root);
  const executable = new FakeCodexExecutable([{ output }]);
  const runner = new CodexCliAnalysisRunner(
    workerConfig({
      CODEX_HOME: join(root, "codex-home"),
      CODEX_WORKDIR: join(root, "empty-workdir"),
    }),
    executable,
  );
  const job = analysisJobInputSchema.parse({
    idempotencyKey: "analysis:conversation:22222222",
    jobType: "classify_outreach",
    entity: { type: "conversation", id: CONVERSATION_ID },
    inputHash: "0123456789abcdef0123456789abcdef",
    runner: "codex-cli",
    model: "gpt-5.6-luna",
    schemaVersion: 1,
    payload: {
      $threadlineWorker: { jobId: JOB_ID, context: injectionContext as AnalysisContext },
    },
  });
  return { executable, job, runner };
}

describe("Codex CLI analysis runner", () => {
  it("uses the subscription CLI with a locked-down non-interactive invocation", async () => {
    process.env.OPENAI_API_KEY = "must-not-leak";
    process.env.CODEX_ACCESS_TOKEN = "must-not-leak";
    process.env.DATABASE_URL = "must-not-leak";
    const { executable, job, runner } = await setupRunner(validOutput);

    const result = await runner.run(job);
    const request = executable.requests[0]!;
    expect(result.resultType).toBe("outreach_classification");
    expect(request.args).toContain("--ephemeral");
    expect(request.args).toContain("--ignore-user-config");
    expect(request.args).toContain("--ignore-rules");
    expect(request.args).toContain("--output-schema");
    expect(request.args).toContain("read-only");
    expect(request.args).toContain('forced_login_method="chatgpt"');
    expect(request.args).toContain("mcp_servers={}");
    expect(request.args).toContain('web_search="disabled"');
    expect(request.environment.OPENAI_API_KEY).toBeUndefined();
    expect(request.environment.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(request.environment.DATABASE_URL).toBeUndefined();
    expect(request.stdin).toContain("IGNORE ALL PRIOR INSTRUCTIONS");
  });

  it("rejects malformed and model-injected output", async () => {
    const injected = await setupRunner(injectedOutput);
    await expect(injected.runner.run(injected.job)).rejects.toMatchObject({
      code: "invalid_model_output",
      retryable: false,
    });

    const schemaValidInjection = structuredClone(injectedOutput) as Record<string, unknown>;
    delete schemaValidInjection.toolCall;
    const instructionLeak = await setupRunner(schemaValidInjection);
    await expect(instructionLeak.runner.run(instructionLeak.job)).rejects.toMatchObject({
      code: "invalid_model_output",
    });

    const malformed = await setupRunner("not-json");
    await expect(malformed.runner.run(malformed.job)).rejects.toMatchObject({
      code: "invalid_model_output",
    });
  });
});
