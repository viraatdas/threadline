import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LinkedApiClient } from "@/src/integrations/linkedin/client";
import {
  LinkedinWorkflowCoordinator,
  MemoryWorkflowRegistry,
} from "@/src/integrations/linkedin/workflow";

import { MockLinkedApiServer } from "@/tests/linkedin/mock-server";

describe("Linked API queued workflows", () => {
  let server: MockLinkedApiServer;
  let client: LinkedApiClient;

  beforeEach(async () => {
    server = new MockLinkedApiServer();
    await server.start();
    client = new LinkedApiClient(
      { linkedApiToken: "linked-token", identificationToken: "identification-token" },
      { baseUrl: server.baseUrl, sleep: async () => undefined },
    );
  });

  afterEach(async () => {
    await server.stop();
  });

  it("resumes the exact queued workflow ID instead of starting duplicate work", async () => {
    server.defaultWorkflowStatuses = ["pending", "completed"];
    const registry = new MemoryWorkflowRegistry();
    const firstCoordinator = coordinator(registry, 1);
    const first = await firstCoordinator.runOnce<void>({
      key: "sync-inbox",
      operationName: "syncInbox",
      start: () => client.startSyncInbox(),
    });
    expect(first.status).toBe("pending");

    const second = await coordinator(registry, 1).runOnce<void>({
      key: "sync-inbox",
      operationName: "syncInbox",
      start: () => client.startSyncInbox(),
    });
    expect(second.status).toBe("completed");
    expect(server.workflowStartCount("syncInbox")).toBe(1);
    expect(new Set(server.workflowReads).size).toBe(1);
  });

  it("bounds human-like polling when a workflow remains queued", async () => {
    server.defaultWorkflowStatuses = ["pending"];
    const result = await coordinator(new MemoryWorkflowRegistry(), 2).runOnce<void>({
      key: "profile:ada",
      operationName: "fetchPerson",
      start: () => client.startFetchPerson("https://www.linkedin.com/in/ada"),
    });

    expect(result.status).toBe("pending");
    expect(server.workflowStartCount("fetchPerson")).toBe(1);
    expect(server.workflowReads).toHaveLength(2);
  });

  function coordinator(registry: MemoryWorkflowRegistry, maxPolls: number) {
    return new LinkedinWorkflowCoordinator(client, registry, {
      maxPolls,
      maxElapsedMs: 10_000,
      minPollDelayMs: 10,
      maxPollDelayMs: 20,
      sleep: async () => undefined,
      random: () => 0.5,
    });
  }
});
