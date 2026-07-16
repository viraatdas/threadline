import {
  linkedinCompanySchema,
  linkedinConversationPollResultSchema,
  linkedinCredentialsSchema,
  linkedinInboxResultSchema,
  linkedinOperationNameSchema,
  linkedinPersonSchema,
  type LinkedinCompany,
  type LinkedinConnectionStatus,
  type LinkedinConversationPollResult,
  type LinkedinCredentials,
  type LinkedinMessage,
  type LinkedinOperationName,
  type LinkedinPerson,
  type WorkflowResult,
} from "@/src/integrations/linkedin/types";

interface LinkedApiEnvelope<TResult> {
  success: boolean;
  result?: TResult;
  error?: {
    type?: string;
    message?: string;
  };
}

interface WorkflowCompletionAction {
  actionType: string;
  success: boolean;
  data?: unknown;
  error?: {
    type?: string;
    message?: string;
  };
}

interface WorkflowStatusResponse {
  workflowId: string;
  workflowStatus: "pending" | "running" | "completed" | "failed";
  message?: string;
  completion?: WorkflowCompletionAction | WorkflowCompletionAction[];
  failure?: {
    reason?: string;
    message?: string;
  };
}

interface ClientOptions {
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  requestTimeoutMs?: number | undefined;
  maxReadRetries?: number | undefined;
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
}

interface RequestOptions {
  signal?: AbortSignal | undefined;
  retrySafe: boolean;
}

interface PollInboxRequest {
  since?: string | undefined;
  type?: "st" | "nv" | undefined;
  threadId?: string | undefined;
}

interface PollConversationRequest {
  personUrl: string;
  since?: string | undefined;
  type: "st" | "nv";
}

export class LinkedApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LinkedApiError";
  }
}

export class LinkedApiClient {
  private readonly baseUrl: string;
  private readonly request: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxReadRetries: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly credentials: LinkedinCredentials;

  constructor(credentials: LinkedinCredentials, options: ClientOptions = {}) {
    this.credentials = linkedinCredentialsSchema.parse(credentials);
    this.baseUrl = (options.baseUrl ?? "https://api.linkedapi.io").replace(/\/$/, "");
    this.request = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.maxReadRetries = options.maxReadRetries ?? 3;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
  }

  async checkConnection(signal?: AbortSignal): Promise<LinkedinConnectionStatus> {
    try {
      await this.pollInbox({ since: new Date().toISOString(), type: "st" }, signal);
      return {
        ok: true,
        state: "connected",
        detail: "Linked API credentials are valid and inbox monitoring is available.",
      };
    } catch (error) {
      if (
        error instanceof LinkedApiError &&
        ["inboxNotSynced", "conversationsNotSynced", "workflowNotFound"].includes(error.code)
      ) {
        return {
          ok: true,
          state: "setup_required",
          detail: "Credentials are valid; read-only inbox monitoring still needs to finish setup.",
        };
      }

      return {
        ok: false,
        state: "attention_required",
        detail: error instanceof LinkedApiError ? error.message : "Linked API connection failed.",
      };
    }
  }

  async pollInbox(
    request: PollInboxRequest = {},
    signal?: AbortSignal,
  ): Promise<readonly LinkedinMessage[]> {
    const result = await this.call<unknown>("/inbox/poll", "POST", request, {
      signal,
      retrySafe: true,
    });
    return linkedinInboxResultSchema.parse(result).messages;
  }

  async pollConversations(
    requests: readonly PollConversationRequest[],
    signal?: AbortSignal,
  ): Promise<readonly LinkedinConversationPollResult[]> {
    const result = await this.call<unknown>("/conversations/poll", "POST", requests, {
      signal,
      retrySafe: true,
    });
    return linkedinConversationPollResultSchema.array().parse(result);
  }

  startSyncInbox(signal?: AbortSignal) {
    return this.startWorkflow("syncInbox", { actionType: "st.syncInbox" }, signal);
  }

  startSyncConversation(personUrl: string, signal?: AbortSignal) {
    return this.startWorkflow(
      "syncConversation",
      { actionType: "st.syncConversation", personUrl },
      signal,
    );
  }

  startFetchPerson(personUrl: string, signal?: AbortSignal) {
    return this.startWorkflow(
      "fetchPerson",
      {
        actionType: "st.openPersonPage",
        personUrl,
        basicInfo: true,
        then: [{ actionType: "st.retrievePersonExperience" }],
      },
      signal,
    );
  }

  startFetchCompany(companyUrl: string, signal?: AbortSignal) {
    return this.startWorkflow(
      "fetchCompany",
      { actionType: "st.openCompanyPage", companyUrl, basicInfo: true, then: [] },
      signal,
    );
  }

  async getWorkflowResult<TResult>(
    workflowId: string,
    operationName: LinkedinOperationName,
    signal?: AbortSignal,
  ): Promise<WorkflowResult<TResult>> {
    const exactOperationName = linkedinOperationNameSchema.parse(operationName);
    const result = await this.call<WorkflowStatusResponse>(
      `/workflows/${encodeURIComponent(workflowId)}`,
      "GET",
      undefined,
      { signal, retrySafe: true },
    );

    if (result.workflowId !== workflowId) {
      throw new LinkedApiError("workflowIdMismatch", "Linked API returned a different workflow ID.");
    }

    if (result.workflowStatus === "pending" || result.workflowStatus === "running") {
      return {
        workflowId,
        operationName: exactOperationName,
        status: result.workflowStatus,
        ...(result.message ? { message: result.message } : {}),
      };
    }

    if (result.workflowStatus === "failed") {
      throw new LinkedApiError(
        result.failure?.reason ?? "workflowFailed",
        result.failure?.message ?? "Linked API workflow failed.",
      );
    }

    const data = this.mapWorkflowCompletion(result.completion, exactOperationName);
    return {
      workflowId,
      operationName: exactOperationName,
      status: "completed",
      data: data as TResult,
    };
  }

  private async startWorkflow(
    operationName: LinkedinOperationName,
    definition: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkflowResult<never>> {
    linkedinOperationNameSchema.parse(operationName);
    const result = await this.call<{
      workflowId: string;
      workflowStatus: "pending" | "running";
      message?: string;
    }>("/workflows", "POST", definition, { signal, retrySafe: false });

    return {
      workflowId: result.workflowId,
      operationName,
      status: result.workflowStatus,
      ...(result.message ? { message: result.message } : {}),
    };
  }

  private mapWorkflowCompletion(
    completion: WorkflowStatusResponse["completion"],
    operationName: LinkedinOperationName,
  ): unknown {
    if (!completion) {
      throw new LinkedApiError("invalidWorkflowResult", "Workflow completed without a result.");
    }

    const actions = Array.isArray(completion) ? completion : [completion];
    const failed = actions.find((action) => action.error || !action.success);
    if (failed) {
      throw new LinkedApiError(
        failed.error?.type ?? "workflowActionFailed",
        failed.error?.message ?? "Linked API workflow action failed.",
      );
    }

    if (operationName === "syncInbox" || operationName === "syncConversation") return undefined;

    const base = actions[0]?.data;
    if (!base || typeof base !== "object" || Array.isArray(base)) {
      throw new LinkedApiError("invalidWorkflowResult", "Profile workflow returned invalid data.");
    }

    const merged = { ...(base as Record<string, unknown>) };
    const then = merged.then;
    if (Array.isArray(then)) {
      for (const child of then) {
        if (!child || typeof child !== "object" || Array.isArray(child)) continue;
        const action = child as WorkflowCompletionAction;
        if (action.error || !action.success) continue;
        if (action.actionType === "st.retrievePersonExperience") {
          merged.experiences = action.data;
        }
      }
      delete merged.then;
    }

    if (operationName === "fetchPerson") return linkedinPersonSchema.parse(merged) satisfies LinkedinPerson;
    return linkedinCompanySchema.parse(merged) satisfies LinkedinCompany;
  }

  private async call<TResult>(
    path: string,
    method: "GET" | "POST",
    body: unknown,
    options: RequestOptions,
  ): Promise<TResult> {
    const attempts = options.retrySafe ? this.maxReadRetries + 1 : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), this.requestTimeoutMs);
      const signal = combineSignals(options.signal, timeoutController.signal);

      try {
        const response = await this.request(`${this.baseUrl}${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            "linked-api-token": this.credentials.linkedApiToken,
            "identification-token": this.credentials.identificationToken,
            client: "threadline",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal,
        });

        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        const envelope = await parseEnvelope<TResult>(response);

        if (!response.ok || !envelope.success || envelope.error) {
          const error = new LinkedApiError(
            envelope.error?.type ?? (response.status === 429 ? "tooManyRequests" : "httpError"),
            envelope.error?.message ?? `Linked API request failed with HTTP ${response.status}.`,
            response.status,
            retryAfterMs,
          );

          if (options.retrySafe && shouldRetry(error) && attempt + 1 < attempts) {
            await this.sleep(retryAfterMs ?? this.backoffMs(attempt));
            continue;
          }
          throw error;
        }

        if (envelope.result === undefined) {
          throw new LinkedApiError("invalidResponse", "Linked API response did not contain a result.");
        }
        return envelope.result;
      } catch (error) {
        if (error instanceof LinkedApiError) throw error;
        if (options.retrySafe && attempt + 1 < attempts && !options.signal?.aborted) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw new LinkedApiError(
          timeoutController.signal.aborted ? "requestTimeout" : "networkError",
          timeoutController.signal.aborted
            ? "Linked API request timed out."
            : "Linked API request failed.",
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new LinkedApiError("networkError", "Linked API request failed.");
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(750 * 2 ** attempt, 8_000);
    return Math.round(base * (0.85 + this.random() * 0.3));
  }
}

function shouldRetry(error: LinkedApiError): boolean {
  return error.status === 429 || (error.status !== undefined && error.status >= 500);
}

async function parseEnvelope<TResult>(response: Response): Promise<LinkedApiEnvelope<TResult>> {
  try {
    return (await response.json()) as LinkedApiEnvelope<TResult>;
  } catch {
    return {
      success: false,
      error: {
        type: response.status === 429 ? "tooManyRequests" : "httpError",
        message: `Linked API returned an unreadable HTTP ${response.status} response.`,
      },
    };
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function combineSignals(left: AbortSignal | undefined, right: AbortSignal): AbortSignal {
  if (!left) return right;
  return AbortSignal.any([left, right]);
}
