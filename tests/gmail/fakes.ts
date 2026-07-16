import type { CredentialVault } from "@/lib/domain/contracts";
import type { ConversationCandidate } from "@/lib/domain/schemas";
import { createIdempotencyKey } from "@/lib/security/idempotency";
import { GmailHistoryExpiredError } from "@/src/integrations/gmail/errors";
import type {
  GmailApi,
  GmailHistoryPage,
  GmailIntegrationAccountRecord,
  GmailPersistResult,
  GmailProfile,
  GmailSyncCounts,
  GmailSyncCursor,
  GmailSyncRunRecord,
  GmailSyncStore,
  GmailThread,
  GmailThreadListPage,
} from "@/src/integrations/gmail/types";
import fixture from "@/tests/gmail/fixtures/gmail-sync.json";

export class FixtureGmailApi implements GmailApi {
  phase: "initial" | "incremental" = "initial";
  revoked = false;
  staleHistoryIds = new Set<string>();
  profileHistoryId = fixture.profile.historyId;
  readonly calls = {
    threadPages: [] as Array<string | undefined>,
    historyPages: [] as Array<{ startHistoryId: string; pageToken?: string }>,
    threads: [] as string[],
  };

  async getProfile(): Promise<GmailProfile> {
    if (this.revoked)
      throw { response: { status: 401 }, message: "Invalid Credentials" };
    return { ...fixture.profile, historyId: this.profileHistoryId };
  }

  async listThreads(input: {
    query: string;
    pageToken?: string;
    maxResults: number;
  }): Promise<GmailThreadListPage> {
    void input.query;
    void input.maxResults;
    this.calls.threadPages.push(input.pageToken);
    const page = fixture.threadPages.find(
      (candidate) => candidate.pageToken === input.pageToken,
    );
    if (!page)
      throw new Error(
        `Missing thread fixture page ${input.pageToken ?? "first"}.`,
      );
    return {
      threadIds: page.threadIds,
      ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
      resultSizeEstimate: page.resultSizeEstimate,
    };
  }

  async getThread(input: { threadId: string }): Promise<GmailThread | null> {
    this.calls.threads.push(input.threadId);
    const threads =
      this.phase === "incremental"
        ? fixture.incrementalThreads
        : fixture.initialThreads;
    return (threads as Record<string, GmailThread>)[input.threadId] ?? null;
  }

  async listHistory(input: {
    startHistoryId: string;
    pageToken?: string;
    maxResults: number;
  }): Promise<GmailHistoryPage> {
    void input.maxResults;
    this.calls.historyPages.push({
      startHistoryId: input.startHistoryId,
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    });
    if (this.staleHistoryIds.has(input.startHistoryId))
      throw new GmailHistoryExpiredError();
    const pages = (
      fixture.historyPages as Record<
        string,
        Array<GmailHistoryPage & { pageToken?: string }>
      >
    )[input.startHistoryId];
    const page = pages?.find(
      (candidate) => candidate.pageToken === input.pageToken,
    );
    if (!page)
      throw new Error(
        `Missing history fixture ${input.startHistoryId}/${input.pageToken ?? "first"}.`,
      );
    return page;
  }
}

export class MemoryGmailStore implements GmailSyncStore {
  cursor: GmailSyncCursor | null = null;
  readonly conversations = new Map<string, ConversationCandidate>();
  readonly messages = new Set<string>();
  readonly analysisJobs = new Set<string>();
  readonly runs: GmailSyncRunRecord[] = [];
  attention: { code: string; message: string } | null = null;

  async getCursor(): Promise<GmailSyncCursor | null> {
    return this.cursor;
  }

  async startSyncRun(): Promise<GmailSyncRunRecord> {
    const run = { id: crypto.randomUUID(), status: "running" as const };
    this.runs.push(run);
    return run;
  }

  async persistConversation(
    account: GmailIntegrationAccountRecord,
    conversation: ConversationCandidate,
  ): Promise<GmailPersistResult> {
    const existing = this.conversations.get(
      conversation.externalConversationId,
    );
    const existingHash = existing?.metadata.gmailInputHash;
    const inputHash = conversation.metadata.gmailInputHash;
    if (existingHash === inputHash) {
      return {
        conversationId: conversation.externalConversationId,
        changed: false,
        insertedMessages: 0,
        updatedMessages: 0,
        analysisEnqueued: false,
      };
    }
    let insertedMessages = 0;
    let updatedMessages = 0;
    for (const message of conversation.messages) {
      if (this.messages.has(message.externalMessageId)) updatedMessages += 1;
      else {
        insertedMessages += 1;
        this.messages.add(message.externalMessageId);
      }
    }
    this.conversations.set(
      conversation.externalConversationId,
      structuredClone(conversation),
    );
    const analysisKey = createIdempotencyKey(
      "gmail-analysis",
      account.id,
      conversation.externalConversationId,
      inputHash,
    );
    const analysisEnqueued = !this.analysisJobs.has(analysisKey);
    this.analysisJobs.add(analysisKey);
    return {
      conversationId: conversation.externalConversationId,
      changed: true,
      insertedMessages,
      updatedMessages,
      analysisEnqueued,
    };
  }

  async saveCursor(
    _account: GmailIntegrationAccountRecord,
    cursor: GmailSyncCursor,
  ): Promise<void> {
    if (this.cursor && BigInt(this.cursor.historyId) > BigInt(cursor.historyId))
      return;
    this.cursor = cursor;
  }

  async completeSyncRun(input: {
    runId: string;
    status: "succeeded" | "partial" | "failed";
    cursorAfter: GmailSyncCursor | null;
    counts: GmailSyncCounts;
  }): Promise<void> {
    void input;
  }

  async markConnected(): Promise<void> {}

  async markAttentionRequired(
    _accountId: string,
    code: string,
    message: string,
  ): Promise<void> {
    this.attention = { code, message };
  }
}

export class TestCredentialVault implements CredentialVault {
  async seal(value: unknown, context: string): Promise<string> {
    return Buffer.from(JSON.stringify({ context, value }), "utf8").toString(
      "base64url",
    );
  }

  async open<T>(envelope: string, context: string): Promise<T> {
    const parsed = JSON.parse(
      Buffer.from(envelope, "base64url").toString("utf8"),
    ) as {
      context: string;
      value: T;
    };
    if (parsed.context !== context)
      throw new Error("Credential context mismatch.");
    return parsed.value;
  }
}

export const gmailAccount: GmailIntegrationAccountRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  externalAccountId: "owner@example.com",
  displayName: "owner@example.com",
  accountEmail: "owner@example.com",
  status: "connected",
  syncEnabled: true,
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  credentialCiphertext: "encrypted",
  credentialKeyVersion: 1,
  connectedAt: new Date("2026-07-15T00:00:00.000Z"),
  lastSyncedAt: null,
  lastErrorAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  metadata: { backfillDays: 120 },
};
