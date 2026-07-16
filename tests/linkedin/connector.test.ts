import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LinkedApiClient } from "@/src/integrations/linkedin/client";
import { LinkedinConnector } from "@/src/integrations/linkedin/connector";
import { normalizeLinkedinInbox } from "@/src/integrations/linkedin/normalize";
import { buildLinkedinAnalysisJobs } from "@/src/integrations/linkedin/persistence";
import type { LinkedinIngestionSink } from "@/src/integrations/linkedin/sync";
import { syncLinkedin } from "@/src/integrations/linkedin/sync";
import {
  LinkedinWorkflowCoordinator,
  MemoryWorkflowRegistry,
} from "@/src/integrations/linkedin/workflow";

import { MockLinkedApiServer } from "@/tests/linkedin/mock-server";

const integrationAccountId = "3b9e52fb-f0cb-410b-8c2d-a7eac0ee6ae5";
const conversationId = "f42cf56f-5270-44e4-93e6-67f2f8f7ba16";

describe("LinkedIn connector normalization", () => {
  let server: MockLinkedApiServer;
  let client: LinkedApiClient;
  let connector: LinkedinConnector;

  beforeEach(async () => {
    server = new MockLinkedApiServer();
    server.defaultWorkflowStatuses = ["completed"];
    server.inboxMessages = [
      message("out-1", "thread-1", "ada", "us", "Intro", "2026-07-15T17:00:00.000Z"),
      message("in-1", "thread-1", "ada", "them", "Interested", "2026-07-15T18:00:00.000Z"),
      message("out-2", "thread-2", "grace", "us", "Hello", "2026-07-15T19:00:00.000Z"),
      message("in-2", "thread-3", "linus", "them", "Question", "2026-07-15T20:00:00.000Z"),
    ];
    for (const slug of ["ada", "grace", "linus"]) {
      const profileUrl = `https://www.linkedin.com/in/${slug}`;
      const companyUrl = `https://www.linkedin.com/company/${slug}-labs`;
      server.personByUrl.set(profileUrl, {
        name: `${slug[0]!.toUpperCase()}${slug.slice(1)} Person`,
        publicUrl: profileUrl,
        hashedUrl: `https://www.linkedin.com/in/hashed-${slug}`,
        headline: "Founder",
        location: "California",
        countryCode: "US",
        position: "CEO",
        companyName: `${slug} Labs`,
        companyHashedUrl: companyUrl,
        followersCount: 100,
        about: "Builder",
        experiences: [],
      });
      server.companyByUrl.set(companyUrl, {
        name: `${slug} Labs`,
        publicUrl: companyUrl,
        description: "Software company",
        location: "California",
        headquarters: "San Francisco",
        industry: "Software",
        specialties: "AI",
        website: `https://${slug}.example.com`,
        employeesCount: 12,
        ventureFinancing: false,
        jobsCount: 0,
      });
    }
    await server.start();
    client = new LinkedApiClient(
      { linkedApiToken: "linked-token", identificationToken: "identification-token" },
      { baseUrl: server.baseUrl, sleep: async () => undefined },
    );
    connector = new LinkedinConnector(client, {
      ownerExternalId: "owner-linkedin",
      workflowCoordinator: new LinkedinWorkflowCoordinator(
        client,
        new MemoryWorkflowRegistry(),
        { maxPolls: 1, sleep: async () => undefined, minPollDelayMs: 1, maxPollDelayMs: 1 },
      ),
      maxProfileEnrichments: 20,
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  it("paginates conversations and normalizes profiles, employers, directions, and replies", async () => {
    const pages = [];
    for await (const page of connector.pull(
      { integrationAccountId, now: new Date("2026-07-15T21:00:00.000Z") },
      { resource: "inbox", limit: 2 },
    )) {
      pages.push(page);
    }

    expect(pages).toHaveLength(2);
    expect(pages[0]?.hasMore).toBe(true);
    expect(pages[1]?.hasMore).toBe(false);
    const resumedPages = normalizeLinkedinInbox(server.inboxMessages, {
      integrationAccountId,
      ownerExternalId: "owner-linkedin",
      collectedAt: new Date("2026-07-15T21:00:00.000Z"),
      limit: 2,
      cursor: pages[0]!.cursor,
    });
    expect(resumedPages.flatMap((page) => page.conversations)).toHaveLength(1);
    const conversations = pages.flatMap((page) => page.conversations);
    expect(conversations.find((item) => item.externalConversationId === "thread-1")?.metadata.replyState).toBe("replied");
    expect(conversations.find((item) => item.externalConversationId === "thread-2")?.metadata.replyState).toBe("awaiting_reply");
    expect(conversations.find((item) => item.externalConversationId === "thread-3")?.metadata.replyState).toBe("not_applicable");
    expect(conversations[0]?.messages.some((item) => item.direction === "inbound")).toBe(true);
    expect(pages.flatMap((page) => page.contacts).every((contact) => contact.company?.name)).toBe(true);
    expect(server.workflowStartCount("fetchPerson")).toBe(3);
    expect(server.workflowStartCount("fetchCompany")).toBe(3);
  });

  it("keeps profile-opening enrichment and every mutation disabled by default", async () => {
    const safeConnector = new LinkedinConnector(client, {
      ownerExternalId: "owner-linkedin",
      workflowCoordinator: new LinkedinWorkflowCoordinator(
        client,
        new MemoryWorkflowRegistry(),
        { maxPolls: 1, sleep: async () => undefined },
      ),
    });
    for await (const page of safeConnector.pull(
      { integrationAccountId, now: new Date("2026-07-15T21:00:00.000Z") },
      { resource: "inbox" },
    )) {
      void page;
    }

    expect(safeConnector.capabilities).toMatchObject({
      read: true,
      send: false,
      modify: false,
      connect: false,
      post: false,
      reply: false,
    });
    expect(server.workflowStartCount("fetchPerson")).toBe(0);
    expect(server.workflowStartCount("fetchCompany")).toBe(0);
  });

  it("replays normalized pages without enqueueing duplicate analysis jobs", async () => {
    const sink = new MemorySink();
    const context = { integrationAccountId, now: new Date("2026-07-15T21:00:00.000Z") };
    await syncLinkedin({ connector, sink, context, request: { resource: "inbox", limit: 10 } });
    const firstCount = sink.analysisKeys.size;
    await syncLinkedin({ connector, sink, context, request: { resource: "inbox", limit: 10 } });

    expect(firstCount).toBe(9);
    expect(sink.analysisKeys.size).toBe(9);
    expect(sink.messageKeys.size).toBe(4);
  });
});

class MemorySink implements LinkedinIngestionSink {
  readonly messageKeys = new Set<string>();
  readonly analysisKeys = new Set<string>();

  async ingest(page: Parameters<LinkedinIngestionSink["ingest"]>[0]) {
    let inserted = 0;
    let skipped = 0;
    let analysisJobsEnqueued = 0;
    for (const conversation of page.conversations) {
      for (const message of conversation.messages) {
        if (this.messageKeys.has(message.idempotencyKey)) skipped += 1;
        else {
          this.messageKeys.add(message.idempotencyKey);
          inserted += 1;
        }
      }
      for (const job of buildLinkedinAnalysisJobs(conversationId, conversation)) {
        if (!this.analysisKeys.has(job.idempotencyKey)) {
          this.analysisKeys.add(job.idempotencyKey);
          analysisJobsEnqueued += 1;
        }
      }
    }
    return {
      discovered: page.conversations.reduce((count, item) => count + item.messages.length, 0),
      inserted,
      updated: 0,
      skipped,
      failed: 0,
      analysisJobsEnqueued,
    };
  }
}

function message(
  id: string,
  threadId: string,
  slug: string,
  sender: "us" | "them",
  text: string,
  time: string,
) {
  return {
    id,
    type: "st" as const,
    threadId,
    personUrl: `https://www.linkedin.com/in/${slug}`,
    sender,
    text,
    time,
  };
}
