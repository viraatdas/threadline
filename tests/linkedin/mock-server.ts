import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { LinkedinMessage } from "@/src/integrations/linkedin/types";

interface WorkflowDefinition {
  id: string;
  operationName: "syncInbox" | "syncConversation" | "fetchPerson" | "fetchCompany";
  statuses: Array<"pending" | "running" | "completed">;
  data?: unknown;
}

export class MockLinkedApiServer {
  private server?: Server;
  private port?: number;
  private workflowSequence = 0;
  private readonly workflows = new Map<string, WorkflowDefinition & { reads: number }>();
  readonly workflowStarts = new Map<string, number>();
  readonly workflowReads: string[] = [];
  readonly requestBodies: unknown[] = [];
  inboxMessages: LinkedinMessage[] = [];
  validLinkedApiToken = "linked-token";
  validIdentificationToken = "identification-token";
  rateLimitInboxRequests = 0;
  defaultWorkflowStatuses: Array<"pending" | "running" | "completed"> = ["completed"];
  personByUrl = new Map<string, unknown>();
  companyByUrl = new Map<string, unknown>();

  get baseUrl() {
    if (!this.port) throw new Error("Mock Linked API server is not running.");
    return `http://127.0.0.1:${this.port}`;
  }

  async start() {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Mock server has no TCP address.");
    this.port = address.port;
  }

  async stop() {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server!.close((error) => (error ? reject(error) : resolve())),
    );
  }

  workflowStartCount(operationName: string) {
    return this.workflowStarts.get(operationName) ?? 0;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    if (!this.authenticated(request)) {
      this.json(response, 401, {
        success: false,
        error: { type: "invalidIdentificationToken", message: "Identification token is invalid." },
      });
      return;
    }

    const body = await readJson(request);
    if (body !== undefined) this.requestBodies.push(body);

    if (request.method === "POST" && request.url === "/inbox/poll") {
      if (this.rateLimitInboxRequests > 0) {
        this.rateLimitInboxRequests -= 1;
        response.setHeader("retry-after", "0");
        this.json(response, 429, {
          success: false,
          error: { type: "tooManyRequests", message: "Slow down." },
        });
        return;
      }
      this.json(response, 200, { success: true, result: { messages: this.inboxMessages } });
      return;
    }

    if (request.method === "POST" && request.url === "/conversations/poll") {
      const requests = Array.isArray(body) ? body : [];
      this.json(response, 200, {
        success: true,
        result: requests.map((item) => ({
          ...item,
          messages: this.inboxMessages
            .filter((message) => message.personUrl === item.personUrl)
            .map(({ id, sender, text, time, threadId }) => ({ id, sender, text, time, threadId })),
        })),
      });
      return;
    }

    if (request.method === "POST" && request.url === "/workflows") {
      const definition = body as { actionType?: string; personUrl?: string; companyUrl?: string };
      const operationName = operationForAction(definition.actionType);
      const id = `wf-${++this.workflowSequence}`;
      const data =
        operationName === "fetchPerson"
          ? this.personByUrl.get(definition.personUrl ?? "")
          : operationName === "fetchCompany"
            ? this.companyByUrl.get(definition.companyUrl ?? "")
            : undefined;
      this.workflows.set(id, {
        id,
        operationName,
        statuses: [...this.defaultWorkflowStatuses],
        data,
        reads: 0,
      });
      this.workflowStarts.set(operationName, this.workflowStartCount(operationName) + 1);
      this.json(response, 200, {
        success: true,
        result: { workflowId: id, workflowStatus: "pending", message: "Queued" },
      });
      return;
    }

    const workflowMatch = request.url?.match(/^\/workflows\/([^/]+)$/);
    if (request.method === "GET" && workflowMatch) {
      const workflowId = decodeURIComponent(workflowMatch[1]!);
      this.workflowReads.push(workflowId);
      const workflow = this.workflows.get(workflowId);
      if (!workflow) {
        this.json(response, 404, {
          success: false,
          error: { type: "workflowNotFound", message: "Workflow not found." },
        });
        return;
      }
      const status = workflow.statuses[Math.min(workflow.reads, workflow.statuses.length - 1)]!;
      workflow.reads += 1;
      if (status !== "completed") {
        this.json(response, 200, {
          success: true,
          result: { workflowId, workflowStatus: status, message: "Still working" },
        });
        return;
      }
      this.json(response, 200, {
        success: true,
        result: {
          workflowId,
          workflowStatus: "completed",
          completion: {
            actionType: actionForOperation(workflow.operationName),
            success: true,
            data: workflow.data,
          },
        },
      });
      return;
    }

    this.json(response, 404, { success: false, error: { type: "notFound", message: "Not found." } });
  }

  private authenticated(request: IncomingMessage) {
    return (
      request.headers["linked-api-token"] === this.validLinkedApiToken &&
      request.headers["identification-token"] === this.validIdentificationToken
    );
  }

  private json(response: ServerResponse, status: number, body: unknown) {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  }
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function operationForAction(actionType?: string): WorkflowDefinition["operationName"] {
  if (actionType === "st.syncInbox") return "syncInbox";
  if (actionType === "st.syncConversation") return "syncConversation";
  if (actionType === "st.openPersonPage") return "fetchPerson";
  if (actionType === "st.openCompanyPage") return "fetchCompany";
  throw new Error(`Unexpected workflow action ${actionType}.`);
}

function actionForOperation(operationName: WorkflowDefinition["operationName"]) {
  if (operationName === "syncInbox") return "st.syncInbox";
  if (operationName === "syncConversation") return "st.syncConversation";
  if (operationName === "fetchPerson") return "st.openPersonPage";
  return "st.openCompanyPage";
}
