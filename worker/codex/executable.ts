import { spawn } from "node:child_process";

import { WorkerError } from "./errors";

export interface CodexExecutionRequest {
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
}

export interface CodexExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodexExecutable {
  execute(request: CodexExecutionRequest, signal?: AbortSignal): Promise<CodexExecutionResult>;
}

const MAX_CAPTURE_BYTES = 64 * 1024;

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) return current;
  const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current);
  return current + chunk.subarray(0, remaining).toString("utf8");
}

export class NodeCodexExecutable implements CodexExecutable {
  execute(request: CodexExecutionRequest, signal?: AbortSignal): Promise<CodexExecutionResult> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const forceKillTimer = { value: undefined as NodeJS.Timeout | undefined };
      const terminate = () => {
        if (child.exitCode !== null || child.killed) return;
        child.kill("SIGTERM");
        forceKillTimer.value = setTimeout(() => child.kill("SIGKILL"), 2_000);
        forceKillTimer.value.unref();
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, request.timeoutMs);
      timeout.unref();

      const onAbort = () => terminate();
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk);
      });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer.value) clearTimeout(forceKillTimer.value);
        signal?.removeEventListener("abort", onAbort);
        reject(
          new WorkerError("codex_exit_failure", "The Codex executable could not be started.", {
            cause: error,
            retryable: true,
          }),
        );
      });

      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer.value) clearTimeout(forceKillTimer.value);
        signal?.removeEventListener("abort", onAbort);

        if (signal?.aborted) {
          reject(new WorkerError("shutdown", "The Codex process was stopped for shutdown.", { retryable: true }));
          return;
        }
        if (timedOut) {
          reject(new WorkerError("codex_timeout", "The Codex process exceeded its hard timeout.", { retryable: true }));
          return;
        }

        resolve({ exitCode: exitCode ?? 1, stdout, stderr });
      });

      child.stdin.end(request.stdin);
    });
  }
}

export interface FakeCodexResponse {
  output?: unknown;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  waitForAbort?: boolean;
}

export class FakeCodexExecutable implements CodexExecutable {
  readonly requests: CodexExecutionRequest[] = [];
  readonly responses: FakeCodexResponse[];

  constructor(responses: FakeCodexResponse[]) {
    this.responses = [...responses];
  }

  async execute(request: CodexExecutionRequest, signal?: AbortSignal): Promise<CodexExecutionResult> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No fake Codex response remains.");

    if (response.waitForAbort) {
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          signal?.removeEventListener("abort", onAbort);
          reject(new WorkerError("shutdown", "Fake Codex execution aborted.", { retryable: true }));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }

    const outputIndex = request.args.indexOf("--output-last-message");
    const outputPath = outputIndex < 0 ? undefined : request.args[outputIndex + 1];
    if (outputPath && response.output !== undefined) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        outputPath,
        typeof response.output === "string" ? response.output : JSON.stringify(response.output),
        { encoding: "utf8", mode: 0o600 },
      );
    }

    return {
      exitCode: response.exitCode ?? 0,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
    };
  }
}
