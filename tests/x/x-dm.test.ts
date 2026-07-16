import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { ChannelConnector } from "@/lib/domain/contracts";
import type { SyncPage } from "@/lib/domain/schemas";
import { createIdempotencyKey, hashContent } from "@/lib/security/idempotency";
import { XDirectMessageConnector } from "@/src/integrations/x/connector";
import { XIntegrationError } from "@/src/integrations/x/errors";
import { normalizeBirdDmConversation } from "@/src/integrations/x/normalize";
import {
  syncXDirectMessages,
  type XSyncStore,
} from "@/src/integrations/x/sync";
import {
  BirdCliDmTransport,
  BirdWithWebFallbackTransport,
  parseBirdDmsResponse,
  XWebDmTransport,
} from "@/src/integrations/x/transport";
import type { XWebEndpointConfig } from "@/src/integrations/x/types";

function fixture(name: string) {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

const owner = { id: "100", username: "owner", name: "Owner" };
const integrationAccountId = "3b9e52fb-f0cb-410b-8c2d-a7eac0ee6ae5";
const endpoints: XWebEndpointConfig = {
  accountSettingsUrl: "https://x.test/account",
  inboxInitialStateUrl: "https://x.test/dm/inbox_initial_state.json",
  conversationUrl: (conversationId) =>
    `https://x.test/dm/conversation/${conversationId}.json`,
  bearerToken: "public-bearer",
  dmParams: { include_groups: "true" },
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Bird-compatible X DM normalization", () => {
  it("normalizes inbound/outbound replies and group participants", () => {
    const payload = parseBirdDmsResponse(fixture("bird-dms.json"));
    const direct = normalizeBirdDmConversation({
      conversation: payload.conversations[0]!,
      owner,
      integrationAccountId,
      collectedAt: new Date("2026-07-15T00:00:00.000Z"),
      transport: "bird-cli",
    });
    const group = normalizeBirdDmConversation({
      conversation: payload.conversations[1]!,
      owner,
      integrationAccountId,
      collectedAt: new Date("2026-07-15T00:00:00.000Z"),
      transport: "bird-cli",
    });

    expect(direct.messages.map((message) => message.direction)).toEqual([
      "outbound",
      "inbound",
    ]);
    expect(direct.metadata.replyState).toBe("replied");
    expect(direct.messages[0]?.metadata.hasReply).toBe(true);
    expect(
      direct.participants.find((participant) => participant.role === "contact")
        ?.identity?.handle,
    ).toBe("@alice");
    expect(group.participants).toHaveLength(3);
    expect(group.subject).toContain("Ben Cho");
    expect(group.metadata.conversationType).toBe("GROUP_DM");
  });

  it("passes cookies only through the Bird child environment", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const transport = new BirdCliDmTransport({
      credentials: { authToken: "auth-secret", ct0: "csrf-secret" },
      command: "/tmp/bird",
      runner: async ({ args, env }) => {
        calls.push({ args, env });
        return { stdout: JSON.stringify(fixture("bird-dms.json")), stderr: "" };
      },
    });

    await transport.fetchPage({ limit: 25 });
    expect(calls[0]?.args.join(" ")).not.toContain("auth-secret");
    expect(calls[0]?.args.join(" ")).not.toContain("csrf-secret");
    expect(calls[0]?.env.AUTH_TOKEN).toBe("auth-secret");
    expect(calls[0]?.env.CT0).toBe("csrf-secret");
  });
});

describe("X web DM pagination", () => {
  it("bypasses the Bird CLI in serverless-compatible mode", async () => {
    const birdRunner = vi.fn(async () => {
      throw new Error("Bird must not run in serverless mode.");
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("inbox_initial_state.json")) {
        return jsonResponse({
          inbox_initial_state: {
            users: {},
            conversations: {},
            entries: [],
          },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const transport = new BirdWithWebFallbackTransport({
      credentials: { authToken: "auth", ct0: "ct0" },
      owner,
      endpoints,
      fetchImpl,
      birdRunner,
      preferWeb: true,
    });

    await expect(transport.checkConnection()).resolves.toMatchObject({
      ok: true,
      accountLabel: "@owner",
    });
    await expect(transport.fetchPage({})).resolves.toMatchObject({
      source: "x-web",
      conversations: [],
      hasMore: false,
    });
    expect(birdRunner).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("collects paginated history, deduplicates boundaries, and preserves group DMs", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("inbox_initial_state.json")) {
        return jsonResponse(fixture("x-inbox-initial.json"));
      }
      if (url.pathname.includes("100-200")) {
        return jsonResponse(
          url.searchParams.has("max_id")
            ? fixture("x-conversation-page-2.json")
            : fixture("x-conversation-page-1.json"),
        );
      }
      if (url.pathname.includes("group-100-300-400")) {
        return jsonResponse(fixture("x-group-conversation.json"));
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const transport = new XWebDmTransport({
      credentials: { authToken: "auth", ct0: "ct0" },
      owner,
      endpoints,
      fetchImpl,
    });
    const connector = new XDirectMessageConnector({ owner, transport });
    const pages: SyncPage[] = [];

    for await (const page of connector.pull(
      { integrationAccountId, now: new Date("2026-07-15T00:00:00.000Z") },
      { resource: "direct_messages", limit: 100 },
    )) {
      pages.push(page);
    }

    expect(pages).toHaveLength(2);
    expect(
      pages[0]?.conversations[0]?.messages.map(
        (message) => message.externalMessageId,
      ),
    ).toEqual(["web-1", "web-2", "web-3"]);
    expect(pages[0]?.conversations[0]?.metadata.replyState).toBe("replied");
    expect(pages[1]?.conversations[0]?.participants).toHaveLength(3);
    expect(pages[1]?.hasMore).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("stops conversation pagination after crossing the requested cutoff", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("inbox_initial_state.json")) {
        return jsonResponse(fixture("x-inbox-initial.json"));
      }
      if (url.pathname.includes("100-200")) {
        if (url.searchParams.has("max_id")) {
          throw new Error("The cutoff should prevent an older page request.");
        }
        return jsonResponse(fixture("x-conversation-page-1.json"));
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const transport = new XWebDmTransport({
      credentials: { authToken: "auth", ct0: "ct0" },
      owner,
      endpoints,
      fetchImpl,
    });

    const page = await transport.fetchPage({
      limit: 5,
      since: new Date("2026-07-14T20:15:00.000Z"),
    });

    expect(
      page.conversations[0]?.messages.map((message) => message.id),
    ).toEqual(["web-3"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps deleted or unavailable message events without inventing body text", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("inbox_initial_state.json")
        ? jsonResponse({
            inbox_initial_state: {
              users: (
                fixture("x-inbox-initial.json") as {
                  inbox_initial_state: { users: unknown };
                }
              ).inbox_initial_state.users,
              conversations: {
                "100-200": {
                  id: "100-200",
                  participants: {
                    "100": { user_id: "100" },
                    "200": { user_id: "200" },
                  },
                },
              },
              entries: [],
            },
          })
        : jsonResponse(fixture("x-unavailable-message.json"));
    }) as typeof fetch;
    const connector = new XDirectMessageConnector({
      owner,
      transport: new XWebDmTransport({
        credentials: { authToken: "auth", ct0: "ct0" },
        owner,
        endpoints,
        fetchImpl,
      }),
    });
    const pages: SyncPage[] = [];
    for await (const page of connector.pull(
      { integrationAccountId, now: new Date() },
      { resource: "direct_messages" },
    )) {
      pages.push(page);
    }

    const message = pages[0]?.conversations[0]?.messages[0];
    expect(message?.bodyText).toBeUndefined();
    expect(message?.snippet).toBe("[Message unavailable]");
    expect(message?.metadata.unavailable).toBe(true);
  });
});

describe("X failure reporting and replay safety", () => {
  it("surfaces expired cookies and rotated GraphQL query IDs through the transport", async () => {
    const expiredTransport = new XWebDmTransport({
      credentials: { authToken: "expired", ct0: "expired" },
      owner,
      endpoints,
      fetchImpl: vi.fn(async () =>
        jsonResponse(fixture("x-expired-cookie.json"), 401),
      ),
    });
    const rotatedTransport = new XWebDmTransport({
      credentials: { authToken: "auth", ct0: "ct0" },
      owner,
      endpoints,
      fetchImpl: vi.fn(async () =>
        jsonResponse(fixture("x-graphql-rotated-query-id.json")),
      ),
    });

    await expect(expiredTransport.fetchPage({})).rejects.toMatchObject({
      code: "X_AUTH_EXPIRED",
    });
    await expect(rotatedTransport.fetchPage({})).rejects.toMatchObject({
      code: "X_ENDPOINT_ROTATED",
    });
  });

  it("replays duplicate pages idempotently and enqueues analysis once", async () => {
    const candidate = normalizeBirdDmConversation({
      conversation: parseBirdDmsResponse(fixture("bird-dms.json"))
        .conversations[0]!,
      owner,
      integrationAccountId,
      collectedAt: new Date("2026-07-15T00:00:00.000Z"),
      transport: "bird-cli",
    });
    const page: SyncPage = {
      integrationAccountId,
      resource: "direct_messages",
      cursor: "terminal-cursor",
      hasMore: false,
      conversations: [candidate],
      contacts: [],
      collectedAt: "2026-07-15T00:00:00.000Z",
    };
    const connector: ChannelConnector = {
      channel: "x",
      capabilities: {
        read: true,
        draft: true,
        send: false,
        modify: false,
        delete: false,
        connect: false,
        post: false,
        reply: false,
      },
      async checkConnection() {
        return { ok: true, checkedAt: new Date() };
      },
      async *pull() {
        yield page;
      },
    };
    const messageKeys = new Set<string>();
    const analysisKeys = new Set<string>();
    let cursor: string | undefined;
    const store: XSyncStore = {
      async loadCursor() {
        return cursor;
      },
      async applyPage(syncPage) {
        let insertedCount = 0;
        let analysisEnqueuedCount = 0;
        for (const conversation of syncPage.conversations) {
          for (const message of conversation.messages) {
            if (!messageKeys.has(message.idempotencyKey)) insertedCount += 1;
            messageKeys.add(message.idempotencyKey);
          }
          const inputHash = hashContent(conversation.messages);
          const key = createIdempotencyKey(
            "x-analysis",
            conversation.idempotencyKey,
            inputHash,
          );
          if (!analysisKeys.has(key)) analysisEnqueuedCount += 1;
          analysisKeys.add(key);
        }
        return {
          discoveredCount: syncPage.conversations.flatMap(
            (conversation) => conversation.messages,
          ).length,
          insertedCount,
          updatedCount: 0,
          skippedCount:
            syncPage.conversations.flatMap(
              (conversation) => conversation.messages,
            ).length - insertedCount,
          analysisEnqueuedCount,
        };
      },
      async saveCursor(options) {
        cursor = options.cursor;
      },
    };

    const first = await syncXDirectMessages({
      connector,
      store,
      integrationAccountId,
      now: new Date(),
    });
    const second = await syncXDirectMessages({
      connector,
      store,
      integrationAccountId,
      now: new Date(),
    });

    expect(first.insertedCount).toBe(2);
    expect(first.analysisEnqueuedCount).toBe(1);
    expect(second.insertedCount).toBe(0);
    expect(second.skippedCount).toBe(2);
    expect(second.analysisEnqueuedCount).toBe(0);
    expect(messageKeys).toHaveLength(2);
    expect(analysisKeys).toHaveLength(1);
  });

  it("does not advance the cursor when an endpoint rotates", async () => {
    let cursor = "last-good-cursor";
    const connector: ChannelConnector = {
      channel: "x",
      capabilities: {
        read: true,
        draft: true,
        send: false,
        modify: false,
        delete: false,
        connect: false,
        post: false,
        reply: false,
      },
      async checkConnection() {
        return { ok: true, checkedAt: new Date() };
      },
      async *pull() {
        throw new XIntegrationError("X_ENDPOINT_ROTATED", "rotated");
      },
    };
    const store: XSyncStore = {
      async loadCursor() {
        return cursor;
      },
      async applyPage() {
        throw new Error("not reached");
      },
      async saveCursor(options) {
        cursor = options.cursor;
      },
    };

    await expect(
      syncXDirectMessages({
        connector,
        store,
        integrationAccountId,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: "X_ENDPOINT_ROTATED" });
    expect(cursor).toBe("last-good-cursor");
  });
});
