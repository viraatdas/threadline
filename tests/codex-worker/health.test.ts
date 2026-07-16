import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FakeCodexExecutable } from "../../worker/codex/executable";
import { CodexCliAnalysisRunner } from "../../worker/codex/runner";
import { workerConfig } from "./helpers";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Codex subscription readiness", () => {
  it("requires a private writable auth file and ChatGPT login mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "threadline-health-test-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome, { mode: 0o700 });
    await writeFile(join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
    await chmod(join(codexHome, "auth.json"), 0o600);

    const executable = new FakeCodexExecutable([
      { exitCode: 0, stdout: "codex-cli 0.144.4" },
      { exitCode: 0, stdout: "Logged in using ChatGPT" },
    ]);
    const runner = new CodexCliAnalysisRunner(
      workerConfig({ CODEX_HOME: codexHome, CODEX_WORKDIR: join(root, "workdir") }),
      executable,
    );

    await expect(runner.checkHealth()).resolves.toEqual({ ok: true, runner: "codex-cli" });
    expect(executable.requests[1]?.args).toContain('forced_login_method="chatgpt"');
  });

  it("rejects API-key login mode without exposing status output", async () => {
    const root = await mkdtemp(join(tmpdir(), "threadline-health-test-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome, { mode: 0o700 });
    await writeFile(join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
    const executable = new FakeCodexExecutable([
      { exitCode: 0, stdout: "codex-cli 0.144.4" },
      { exitCode: 0, stdout: "Logged in using an API key" },
    ]);
    const runner = new CodexCliAnalysisRunner(
      workerConfig({ CODEX_HOME: codexHome, CODEX_WORKDIR: join(root, "workdir") }),
      executable,
    );

    await expect(runner.checkHealth()).resolves.toMatchObject({
      ok: false,
      detail: "Codex is not logged in with ChatGPT.",
    });
  });
});
