import type { ConversationCandidate } from "@/lib/domain/schemas";

export interface GmailHeader {
  name?: string | null;
  value?: string | null;
}

export interface GmailMessagePartBody {
  attachmentId?: string | null;
  data?: string | null;
  size?: number | null;
}

export interface GmailMessagePart {
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  headers?: GmailHeader[] | null;
  body?: GmailMessagePartBody | null;
  parts?: GmailMessagePart[] | null;
}

export interface GmailMessage {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
  snippet?: string | null;
  historyId?: string | null;
  internalDate?: string | null;
  payload?: GmailMessagePart | null;
  sizeEstimate?: number | null;
}

export interface GmailThread {
  id?: string | null;
  historyId?: string | null;
  messages?: GmailMessage[] | null;
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
  messagesTotal?: number;
  threadsTotal?: number;
}

export interface GmailThreadListPage {
  threadIds: string[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailHistoryMessageReference {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
}

export interface GmailHistoryRecord {
  id?: string | null;
  messages?: GmailHistoryMessageReference[] | null;
  messagesAdded?: Array<{
    message?: GmailHistoryMessageReference | null;
  }> | null;
  messagesDeleted?: Array<{
    message?: GmailHistoryMessageReference | null;
  }> | null;
  labelsAdded?: Array<{ message?: GmailHistoryMessageReference | null }> | null;
  labelsRemoved?: Array<{
    message?: GmailHistoryMessageReference | null;
  }> | null;
}

export interface GmailHistoryPage {
  history?: GmailHistoryRecord[];
  historyId: string;
  nextPageToken?: string;
}

export interface GmailApi {
  getProfile(signal?: AbortSignal): Promise<GmailProfile>;
  listThreads(input: {
    query: string;
    pageToken?: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<GmailThreadListPage>;
  getThread(input: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<GmailThread | null>;
  listHistory(input: {
    startHistoryId: string;
    pageToken?: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<GmailHistoryPage>;
}

export interface GmailStoredCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiryDate?: number;
  tokenType?: string;
  scopes: string[];
}

export interface GmailIntegrationAccountRecord {
  id: string;
  externalAccountId: string;
  displayName: string;
  accountEmail: string;
  status: "pending" | "connected" | "attention_required" | "disabled";
  syncEnabled: boolean;
  scopes: string[];
  credentialCiphertext: string;
  credentialKeyVersion: number;
  connectedAt: Date | null;
  lastSyncedAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  metadata: Record<string, unknown>;
}

export interface GmailSyncCursor {
  historyId: string;
  mailboxEmail: string;
  updatedAt: string;
}

export interface GmailPersistResult {
  conversationId: string;
  changed: boolean;
  insertedMessages: number;
  updatedMessages: number;
  analysisEnqueued: boolean;
}

export interface GmailSyncRunRecord {
  id: string;
  status:
    "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
}

export interface GmailSyncCounts {
  discoveredCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  analysisEnqueuedCount: number;
}

export interface GmailSyncStore {
  getCursor(
    account: GmailIntegrationAccountRecord,
  ): Promise<GmailSyncCursor | null>;
  startSyncRun(input: {
    account: GmailIntegrationAccountRecord;
    idempotencyKey: string;
    trigger: "manual" | "scheduled" | "webhook" | "backfill";
    cursorBefore: GmailSyncCursor | null;
    now: Date;
  }): Promise<GmailSyncRunRecord>;
  persistConversation(
    account: GmailIntegrationAccountRecord,
    conversation: ConversationCandidate,
    now: Date,
  ): Promise<GmailPersistResult>;
  saveCursor(
    account: GmailIntegrationAccountRecord,
    cursor: GmailSyncCursor,
  ): Promise<void>;
  completeSyncRun(input: {
    runId: string;
    status: "succeeded" | "partial" | "failed";
    cursorAfter: GmailSyncCursor | null;
    counts: GmailSyncCounts;
    completedAt: Date;
    errorCode?: string;
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  markConnected(accountId: string, syncedAt: Date): Promise<void>;
  markAttentionRequired(
    accountId: string,
    code: string,
    message: string,
    at: Date,
  ): Promise<void>;
}

export interface GmailSyncResult extends GmailSyncCounts {
  mode: "initial" | "incremental" | "recovery";
  cursor: GmailSyncCursor;
  runId: string;
}
