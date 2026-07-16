import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AnalysisRunner, AnalysisRunnerHealth } from "../../lib/domain/contracts";
import type { AnalysisJobInput, AnalysisResultInput } from "../../lib/domain/schemas";

import type { WorkerConfig } from "./config";
import { WorkerError } from "./errors";
import type { CodexExecutable } from "./executable";
import { buildClassificationPrompt, buildDraftOutreachPrompt } from "./prompt";
import {
  assertNoInjectedInstructions,
  classificationWorkerAnalysisResultSchema,
  draftWorkerAnalysisResultSchema,
  parseClassificationOutput,
  parseDraftOutreachOutput,
  workerAnalysisEnvelopeSchema,
} from "./schema";
import type { WorkerAnalysisEnvelope } from "./types";

const MAX_OUTPUT_BYTES = 1024 * 1024;

function safeChildEnvironment(config: WorkerConfig, runtimeHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CODEX_HOME: config.CODEX_HOME,
    HOME: runtimeHome,
    LANG: process.env.LANG ?? "C.UTF-8",
    NODE_ENV: "production",
    PATH: process.env.PATH,
    TMPDIR: tmpdir(),
  };

  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_DIR", "SSL_CERT_FILE"] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }

  return environment;
}

function codexArgs(config: WorkerConfig, schemaPath: string, outputPath: string): string[] {
  return [
    "exec",
    "--strict-config",
    "--model",
    config.CODEX_MODEL,
    "--sandbox",
    "read-only",
    "--cd",
    config.CODEX_WORKDIR,
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "--color",
    "never",
    "-c",
    'forced_login_method="chatgpt"',
    "-c",
    'cli_auth_credentials_store="file"',
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-c",
    "mcp_servers={}",
    "-c",
    "apps={_default={enabled=false}}",
    "-c",
    "include_apps_instructions=false",
    "-c",
    "skills.include_instructions=false",
    "-c",
    "allow_login_shell=false",
    "-c",
    "hooks={}",
    "-",
  ];
}

async function ensureEmptyControlledDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o555 });
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(path);
  if (entries.length > 0) {
    throw new WorkerError("worker_internal", "The controlled Codex working directory is not empty.");
  }
  await chmod(path, 0o555);
}

export class CodexCliAnalysisRunner implements AnalysisRunner {
  readonly name = "codex-cli";

  constructor(
    private readonly config: WorkerConfig,
    private readonly executable: CodexExecutable,
  ) {}

  async checkHealth(signal?: AbortSignal): Promise<AnalysisRunnerHealth> {
    try {
      const authPath = join(this.config.CODEX_HOME, "auth.json");
      const authStat = await stat(authPath);
      if (!authStat.isFile()) throw new Error("auth.json is not a regular file");
      if ((authStat.mode & 0o077) !== 0) throw new Error("auth.json permissions are too broad");
      await access(authPath, fsConstants.R_OK | fsConstants.W_OK);
      await access(this.config.CODEX_OUTPUT_SCHEMA_PATH, fsConstants.R_OK);
      await access(this.config.CODEX_DRAFT_OUTPUT_SCHEMA_PATH, fsConstants.R_OK);

      const runtimeHome = join(tmpdir(), "threadline-codex-health-home");
      await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
      const result = await this.executable.execute(
        {
          command: this.config.CODEX_COMMAND,
          args: ["--version"],
          cwd: runtimeHome,
          environment: safeChildEnvironment(this.config, runtimeHome),
          stdin: "",
          timeoutMs: Math.min(this.config.CODEX_TIMEOUT_MS, 10_000),
        },
        signal,
      );
      if (result.exitCode !== 0) {
        return { ok: false, runner: this.name, detail: "Codex executable health check failed." };
      }

      const login = await this.executable.execute(
        {
          command: this.config.CODEX_COMMAND,
          args: [
            "login",
            "status",
            "-c",
            'forced_login_method="chatgpt"',
            "-c",
            'cli_auth_credentials_store="file"',
          ],
          cwd: runtimeHome,
          environment: safeChildEnvironment(this.config, runtimeHome),
          stdin: "",
          timeoutMs: Math.min(this.config.CODEX_TIMEOUT_MS, 10_000),
        },
        signal,
      );

      return login.exitCode === 0 && /chatgpt/iu.test(login.stdout)
        ? { ok: true, runner: this.name }
        : { ok: false, runner: this.name, detail: "Codex is not logged in with ChatGPT." };
    } catch {
      return {
        ok: false,
        runner: this.name,
        detail: "Codex subscription authentication or executable is unavailable.",
      };
    }
  }

  async run(job: AnalysisJobInput, signal?: AbortSignal): Promise<AnalysisResultInput> {
    const envelope = workerAnalysisEnvelopeSchema.parse(
      job.payload.$threadlineWorker,
    ) as WorkerAnalysisEnvelope;
    const isDraft = job.jobType === "draft_outreach";
    if (isDraft && job.entity.type !== "outreach_plan") {
      throw new WorkerError("job_unsupported", "Draft outreach jobs must target an outreach plan.");
    }
    const promptBuilder = isDraft ? buildDraftOutreachPrompt : buildClassificationPrompt;
    const prompt = promptBuilder(job, envelope.context, {
      maxInputBytes: this.config.WORKER_MAX_INPUT_BYTES,
      maxMessages: this.config.WORKER_MAX_MESSAGES,
      maxMessageBytes: this.config.WORKER_MAX_MESSAGE_BYTES,
    });

    await ensureEmptyControlledDirectory(this.config.CODEX_WORKDIR);
    const executionDirectory = await mkdtemp(join(tmpdir(), "threadline-codex-run-"));
    const runtimeHome = join(executionDirectory, "home");
    const outputPath = join(executionDirectory, isDraft ? "draft.json" : "classification.json");
    const outputSchemaPath = isDraft
      ? this.config.CODEX_DRAFT_OUTPUT_SCHEMA_PATH
      : this.config.CODEX_OUTPUT_SCHEMA_PATH;
    await mkdir(runtimeHome, { recursive: true, mode: 0o700 });

    try {
      const execution = await this.executable.execute(
        {
          command: this.config.CODEX_COMMAND,
          args: codexArgs(this.config, outputSchemaPath, outputPath),
          cwd: this.config.CODEX_WORKDIR,
          environment: safeChildEnvironment(this.config, runtimeHome),
          stdin: prompt,
          timeoutMs: this.config.CODEX_TIMEOUT_MS,
        },
        signal,
      );

      if (execution.exitCode !== 0) {
        throw new WorkerError(
          "codex_exit_failure",
          "Codex exited unsuccessfully. Output was discarded.",
          { retryable: true },
        );
      }

      const outputStat = await stat(outputPath);
      if (!outputStat.isFile() || outputStat.size > MAX_OUTPUT_BYTES) {
        throw new WorkerError("invalid_model_output", "Codex produced an invalid output artifact.");
      }

      const raw = await readFile(outputPath, "utf8");
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch (error) {
        throw new WorkerError("invalid_model_output", "Codex output was not valid JSON.", {
          cause: error,
        });
      }

      const allowedEvidenceIds = new Set(envelope.context.messages.map((message) => message.id));
      const output = isDraft
        ? parseDraftOutreachOutput(decoded)
        : parseClassificationOutput(decoded);
      assertNoInjectedInstructions(output);
      if (output.evidenceMessageIds.some((messageId) => !allowedEvidenceIds.has(messageId))) {
        throw new WorkerError(
          "invalid_model_output",
          "Codex output referenced evidence outside the supplied message set.",
        );
      }

      const result = {
        jobId: envelope.jobId,
        entity: job.entity,
        resultType: isDraft ? "outreach_draft" : "outreach_classification",
        schemaVersion: job.schemaVersion,
        result: output,
        evidence: envelope.context.evidence,
        confidence: output.confidence,
      };
      return isDraft
        ? draftWorkerAnalysisResultSchema.parse(result)
        : classificationWorkerAnalysisResultSchema.parse(result);
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError("invalid_model_output", "Codex output failed strict validation.", {
        cause: error,
      });
    } finally {
      await rm(executionDirectory, { force: true, recursive: true });
    }
  }
}
