import { resolve } from "node:path";

import { z } from "zod";

const workerEnvironmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  ANALYSIS_RUNNER: z.literal("codex-cli").default("codex-cli"),
  CODEX_COMMAND: z.string().trim().min(1).default("codex"),
  CODEX_MODEL: z.string().trim().min(1).default("gpt-5.6-luna"),
  CODEX_HOME: z.string().trim().min(1).default("/data/codex"),
  CODEX_WORKDIR: z.string().trim().min(1).default("/var/empty/threadline-codex"),
  CODEX_OUTPUT_SCHEMA_PATH: z
    .string()
    .trim()
    .min(1)
    .default(resolve(process.cwd(), "worker/codex/classification-output.schema.json")),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(2_000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  WORKER_RETRY_DELAY_MS: z.coerce.number().int().min(100).max(3_600_000).default(30_000),
  WORKER_STALE_AFTER_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(600_000),
  WORKER_MAX_INPUT_BYTES: z.coerce.number().int().min(4_096).max(262_144).default(65_536),
  WORKER_MAX_MESSAGES: z.coerce.number().int().min(1).max(100).default(40),
  WORKER_MAX_MESSAGE_BYTES: z.coerce.number().int().min(256).max(32_768).default(6_000),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8_080),
  WORKER_CONCURRENCY: z.coerce.number().int().default(1),
});

export type WorkerConfig = z.infer<typeof workerEnvironmentSchema>;

export function getWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const config = workerEnvironmentSchema.parse(environment);
  if (config.WORKER_CONCURRENCY !== 1) {
    throw new Error("The subscription Codex worker requires WORKER_CONCURRENCY=1.");
  }
  return config;
}
