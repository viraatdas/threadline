import type { ThreadlineDatabase } from "@/lib/db/client";
import { syncCursors } from "@/lib/db/schema";
import { openCredential, sealCredential } from "@/lib/security/credentials";
import { getEncryptionEnvironment } from "@/lib/security/env";
import { createIdempotencyKey } from "@/lib/security/idempotency";
import { and, eq } from "drizzle-orm";

import { LinkedApiClient } from "@/src/integrations/linkedin/client";
import type {
  LinkedinOperationName,
  WorkflowReference,
  WorkflowResult,
} from "@/src/integrations/linkedin/types";

export interface WorkflowRegistry {
  load(key: string): Promise<WorkflowReference | null>;
  save(key: string, workflow: WorkflowReference): Promise<void>;
  clear(key: string): Promise<void>;
}

export class MemoryWorkflowRegistry implements WorkflowRegistry {
  private readonly workflows = new Map<string, WorkflowReference>();

  async load(key: string) {
    return this.workflows.get(key) ?? null;
  }

  async save(key: string, workflow: WorkflowReference) {
    this.workflows.set(key, workflow);
  }

  async clear(key: string) {
    this.workflows.delete(key);
  }
}

export class DatabaseWorkflowRegistry implements WorkflowRegistry {
  constructor(
    private readonly database: ThreadlineDatabase,
    private readonly integrationAccountId: string,
  ) {}

  async load(key: string): Promise<WorkflowReference | null> {
    const resource = this.resource(key);
    const [cursor] = await this.database
      .select()
      .from(syncCursors)
      .where(
        and(
          eq(syncCursors.integrationAccountId, this.integrationAccountId),
          eq(syncCursors.resource, resource),
        ),
      )
      .limit(1);

    if (!cursor) return null;
    return openCredential<WorkflowReference>(cursor.cursorCiphertext, this.context(resource), {
      expectedKeyVersion: cursor.cursorKeyVersion,
    });
  }

  async save(key: string, workflow: WorkflowReference): Promise<void> {
    const resource = this.resource(key);
    const ciphertext = sealCredential(workflow, this.context(resource));
    const keyVersion = getEncryptionEnvironment().INTEGRATION_ENCRYPTION_KEY_VERSION;
    await this.database
      .insert(syncCursors)
      .values({
        integrationAccountId: this.integrationAccountId,
        resource,
        cursorCiphertext: ciphertext,
        cursorKeyVersion: keyVersion,
        lastSeenExternalId: workflow.workflowId,
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [syncCursors.integrationAccountId, syncCursors.resource],
        set: {
          cursorCiphertext: ciphertext,
          cursorKeyVersion: keyVersion,
          lastSeenExternalId: workflow.workflowId,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        },
      });
  }

  async clear(key: string): Promise<void> {
    await this.database
      .delete(syncCursors)
      .where(
        and(
          eq(syncCursors.integrationAccountId, this.integrationAccountId),
          eq(syncCursors.resource, this.resource(key)),
        ),
      );
  }

  private resource(key: string) {
    return createIdempotencyKey("linkedin-workflow", key).slice(0, 88);
  }

  private context(resource: string) {
    return `linkedin:workflow:${this.integrationAccountId}:${resource}`;
  }
}

interface WorkflowCoordinatorOptions {
  maxPolls?: number | undefined;
  minPollDelayMs?: number | undefined;
  maxPollDelayMs?: number | undefined;
  maxElapsedMs?: number | undefined;
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
  now?: (() => number) | undefined;
}

export class LinkedinWorkflowCoordinator {
  private readonly maxPolls: number;
  private readonly minPollDelayMs: number;
  private readonly maxPollDelayMs: number;
  private readonly maxElapsedMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(
    private readonly client: LinkedApiClient,
    private readonly registry: WorkflowRegistry,
    options: WorkflowCoordinatorOptions = {},
  ) {
    this.maxPolls = options.maxPolls ?? 6;
    this.minPollDelayMs = options.minPollDelayMs ?? 3_500;
    this.maxPollDelayMs = options.maxPollDelayMs ?? 8_000;
    this.maxElapsedMs = options.maxElapsedMs ?? 35_000;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  async runOnce<TResult>(input: {
    key: string;
    operationName: LinkedinOperationName;
    start: () => Promise<WorkflowResult<never>>;
    signal?: AbortSignal | undefined;
  }): Promise<WorkflowResult<TResult>> {
    const existing = await this.registry.load(input.key);
    let current: WorkflowResult<TResult>;

    if (existing) {
      if (existing.operationName !== input.operationName) {
        throw new Error("Stored Linked API workflow operation does not match the requested operation.");
      }
      current = await this.client.getWorkflowResult<TResult>(
        existing.workflowId,
        existing.operationName,
        input.signal,
      );
    } else {
      current = (await input.start()) as WorkflowResult<TResult>;
      if (current.status !== "completed") await this.registry.save(input.key, current);
    }

    const startedAt = this.now();
    let polls = 0;
    while (
      current.status !== "completed" &&
      polls < this.maxPolls &&
      this.now() - startedAt < this.maxElapsedMs
    ) {
      const remaining = this.maxElapsedMs - (this.now() - startedAt);
      if (remaining <= 0) break;
      await this.sleep(Math.min(this.pollDelayMs(), remaining));
      current = await this.client.getWorkflowResult<TResult>(
        current.workflowId,
        current.operationName,
        input.signal,
      );
      polls += 1;
      if (current.status !== "completed") await this.registry.save(input.key, current);
    }

    if (current.status === "completed") await this.registry.clear(input.key);
    return current;
  }

  private pollDelayMs() {
    const spread = this.maxPollDelayMs - this.minPollDelayMs;
    return Math.round(this.minPollDelayMs + spread * this.random());
  }
}
