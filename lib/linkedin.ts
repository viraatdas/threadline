import "server-only";

import { z } from "zod";

import type { FoundPerson } from "@/lib/sources/types";
import { loadConnection } from "@/lib/store";

// Linked API (linkedapi.io) drives the owner's own LinkedIn account in a cloud
// browser. It is unofficial; it enforces LinkedIn-safe limits and working
// hours itself, and returns `limitExceeded` rather than overrunning them.
const BASE_URL = (process.env.LINKED_API_BASE_URL ?? "https://api.linkedapi.io").replace(/\/$/, "");

export const linkedinCredentialsSchema = z.object({
  linkedApiToken: z.string().trim().min(1),
  identificationToken: z.string().trim().min(1),
});
export type LinkedinCredentials = z.infer<typeof linkedinCredentialsSchema>;

export class LinkedApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LinkedApiError";
  }
}

interface WorkflowAction {
  actionType: string;
  success: boolean;
  data?: unknown;
  error?: { type?: string; message?: string };
}

export type WorkflowState =
  | { status: "pending"; workflowId: string }
  | { status: "running"; workflowId: string }
  | { status: "completed"; workflowId: string; data: unknown }
  | { status: "failed"; workflowId: string; code: string; message: string };

export class LinkedinClient {
  constructor(private readonly credentials: LinkedinCredentials) {}

  static async load(): Promise<LinkedinClient | null> {
    const connection = await loadConnection<unknown>("linkedin");
    if (!connection) return null;
    const parsed = linkedinCredentialsSchema.safeParse(connection.credentials);
    return parsed.success ? new LinkedinClient(parsed.data) : null;
  }

  startSearchPeople(input: { company: string; limit?: number; position?: string }) {
    return this.start({
      actionType: "st.searchPeople",
      limit: input.limit ?? 10,
      filter: {
        currentCompanies: [input.company],
        ...(input.position ? { position: input.position } : {}),
      },
    });
  }

  startConnectionRequest(personUrl: string, note: string, email?: string | null) {
    return this.start({
      actionType: "st.sendConnectionRequest",
      personUrl,
      ...(note ? { note } : {}),
      ...(email ? { email } : {}),
    });
  }

  startMessage(personUrl: string, text: string) {
    return this.start({ actionType: "st.sendMessage", personUrl, text });
  }

  async start(definition: Record<string, unknown>): Promise<string> {
    const result = await this.call<{ workflowId: string }>("/workflows", "POST", definition);
    return result.workflowId;
  }

  async workflow(workflowId: string): Promise<WorkflowState> {
    const result = await this.call<{
      workflowId: string;
      workflowStatus: "pending" | "running" | "completed" | "failed";
      completion?: WorkflowAction | WorkflowAction[];
      failure?: { reason?: string; message?: string };
    }>(`/workflows/${encodeURIComponent(workflowId)}`, "GET");
    if (result.workflowStatus === "pending") return { status: "pending", workflowId };
    if (result.workflowStatus === "running") return { status: "running", workflowId };
    if (result.workflowStatus === "failed") {
      return {
        status: "failed",
        workflowId,
        code: result.failure?.reason ?? "workflowFailed",
        message: result.failure?.message ?? "Linked API workflow failed.",
      };
    }
    const actions = Array.isArray(result.completion)
      ? result.completion
      : result.completion
        ? [result.completion]
        : [];
    const failed = actions.find((action) => !action.success || action.error);
    if (failed) {
      return {
        status: "failed",
        workflowId,
        code: failed.error?.type ?? "actionFailed",
        message: failed.error?.message ?? "LinkedIn action failed.",
      };
    }
    return { status: "completed", workflowId, data: actions[0]?.data };
  }

  // Workflows usually finish in ~20s but queue behind each other per account;
  // wait briefly so the common case resolves inline, otherwise hand back the
  // pending id for the next refresh to pick up.
  async waitFor(workflowId: string, budgetMs = 40_000): Promise<WorkflowState> {
    const deadline = Date.now() + budgetMs;
    let state = await this.workflow(workflowId);
    while ((state.status === "pending" || state.status === "running") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      state = await this.workflow(workflowId);
    }
    return state;
  }

  async inboxSince(since: Date) {
    const result = await this.call<{ messages: unknown[] }>("/inbox/poll", "POST", {
      since: since.toISOString(),
      type: "st",
    });
    return parseEach(
      result.messages,
      z.object({ personUrl: z.string(), sender: z.enum(["us", "them"]), text: z.string(), time: z.string() }),
    );
  }

  private async call<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "linked-api-token": this.credentials.linkedApiToken,
        "identification-token": this.credentials.identificationToken,
        client: "offstage-outbound",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const envelope = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      result?: T;
      error?: { type?: string; message?: string };
    };
    if (!response.ok || !envelope.success || envelope.result === undefined) {
      throw new LinkedApiError(
        envelope.error?.type ?? `http${response.status}`,
        envelope.error?.message ?? `Linked API request failed (HTTP ${response.status}).`,
        response.status,
      );
    }
    return envelope.result;
  }
}

const RELEVANT_TITLE =
  /founder|cto|ceo|chief|head of|vp|director|lead|principal|staff|ios|mobile|platform|devops|infra|sre|release|build/i;

export function peopleFromSearch(data: unknown): FoundPerson[] {
  const rows = parseEach(
    data,
    z.object({
      name: z.string().min(1),
      publicUrl: z.string().min(1),
      headline: z.string().nullable().optional(),
      location: z.string().nullable().optional(),
    }),
  );
  return rows
    .filter((row) => RELEVANT_TITLE.test(row.headline ?? ""))
    .map((row) => ({
      name: row.name,
      linkedinUrl: normalizeLinkedinUrl(row.publicUrl),
      ...(row.headline ? { title: row.headline.slice(0, 160) } : {}),
      ...(row.location ? { location: row.location } : {}),
    }));
}

// One malformed row from an unofficial API should cost that row, not the batch.
function parseEach<T>(value: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function normalizeLinkedinUrl(value: string): string {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/in\/([^/]+)/);
    return match ? `https://www.linkedin.com/in/${decodeURIComponent(match[1]!).toLowerCase()}` : value;
  } catch {
    return value;
  }
}
