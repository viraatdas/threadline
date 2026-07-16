import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LinkedApiClient, LinkedApiError } from "@/src/integrations/linkedin/client";

import { MockLinkedApiServer } from "@/tests/linkedin/mock-server";

describe("Linked API HTTPS client", () => {
  let server: MockLinkedApiServer;

  beforeEach(async () => {
    server = new MockLinkedApiServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("retries safe reads after rate limits and retrieves conversation messages", async () => {
    server.rateLimitInboxRequests = 1;
    server.inboxMessages = [
      {
        id: "message-1",
        type: "st",
        threadId: "thread-1",
        personUrl: "https://www.linkedin.com/in/ada",
        sender: "them",
        text: "Hello",
        time: "2026-07-15T18:00:00.000Z",
      },
    ];
    const client = createClient(server);

    await expect(client.pollInbox()).resolves.toHaveLength(1);
    const conversations = await client.pollConversations([
      { personUrl: "https://www.linkedin.com/in/ada", type: "st" },
    ]);
    expect(conversations[0]?.messages[0]?.text).toBe("Hello");
  });

  it("surfaces token failures without retrying or exposing credentials", async () => {
    const client = new LinkedApiClient(
      { linkedApiToken: "wrong", identificationToken: "wrong" },
      { baseUrl: server.baseUrl, maxReadRetries: 0 },
    );

    await expect(client.pollInbox()).rejects.toMatchObject({
      code: "invalidIdentificationToken",
      status: 401,
    } satisfies Partial<LinkedApiError>);
    await expect(client.pollInbox()).rejects.not.toThrow(/wrong/);
  });
});

function createClient(server: MockLinkedApiServer) {
  return new LinkedApiClient(
    { linkedApiToken: "linked-token", identificationToken: "identification-token" },
    { baseUrl: server.baseUrl, sleep: async () => undefined, random: () => 0 },
  );
}
