import { google, gmail_v1 } from "googleapis";

import {
  GmailHistoryExpiredError,
  isNotFoundGmailError,
  normalizeGmailError,
} from "@/src/integrations/gmail/errors";
import {
  withGmailRetry,
  type GmailRetryOptions,
} from "@/src/integrations/gmail/retry";
import type {
  GmailApi,
  GmailHistoryPage,
  GmailProfile,
  GmailStoredCredentials,
  GmailThread,
  GmailThreadListPage,
} from "@/src/integrations/gmail/types";

interface GoogleGmailApiOptions {
  oauth2Client: ReturnType<typeof createOAuth2Client>;
  credentials: GmailStoredCredentials;
  onCredentials?: (credentials: GmailStoredCredentials) => Promise<void>;
  retry?: GmailRetryOptions;
}

interface GoogleCredentialLike {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  token_type?: string | null;
  scope?: string;
}

export class GoogleGmailApi implements GmailApi {
  private readonly gmail: gmail_v1.Gmail;
  private credentialWrite: Promise<void> = Promise.resolve();
  private credentials: GmailStoredCredentials;

  constructor(private readonly options: GoogleGmailApiOptions) {
    this.credentials = options.credentials;
    options.oauth2Client.setCredentials(
      toGoogleCredentials(options.credentials),
    );
    options.oauth2Client.on("tokens", (tokens) => {
      this.credentials = mergeGoogleCredentials(this.credentials, tokens);
      if (options.onCredentials) {
        this.credentialWrite = this.credentialWrite.then(() =>
          options.onCredentials!(this.credentials),
        );
      }
    });
    this.gmail = google.gmail({
      version: "v1",
      auth: options.oauth2Client as never,
    });
  }

  async getProfile(signal?: AbortSignal): Promise<GmailProfile> {
    const response = await this.request(
      () => this.gmail.users.getProfile({ userId: "me" }),
      signal,
    );
    const emailAddress = response.data.emailAddress?.trim().toLowerCase();
    const historyId = response.data.historyId?.trim();
    if (!emailAddress || !historyId)
      throw new Error("Gmail profile omitted required account fields.");
    return {
      emailAddress,
      historyId,
      ...(response.data.messagesTotal !== null &&
      response.data.messagesTotal !== undefined
        ? { messagesTotal: response.data.messagesTotal }
        : {}),
      ...(response.data.threadsTotal !== null &&
      response.data.threadsTotal !== undefined
        ? { threadsTotal: response.data.threadsTotal }
        : {}),
    };
  }

  async listThreads(input: {
    query: string;
    pageToken?: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<GmailThreadListPage> {
    const response = await this.request(
      () =>
        this.gmail.users.threads.list({
          userId: "me",
          q: input.query,
          maxResults: input.maxResults,
          includeSpamTrash: false,
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
        }),
      input.signal,
    );
    return {
      threadIds: (response.data.threads ?? []).flatMap((thread) =>
        thread.id ? [thread.id] : [],
      ),
      ...(response.data.nextPageToken
        ? { nextPageToken: response.data.nextPageToken }
        : {}),
      ...(response.data.resultSizeEstimate !== null &&
      response.data.resultSizeEstimate !== undefined
        ? { resultSizeEstimate: response.data.resultSizeEstimate }
        : {}),
    };
  }

  async getThread(input: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<GmailThread | null> {
    try {
      const response = await this.request(
        () =>
          this.gmail.users.threads.get({
            userId: "me",
            id: input.threadId,
            format: "full",
          }),
        input.signal,
      );
      return response.data as GmailThread;
    } catch (error) {
      if (isNotFoundGmailError(error)) return null;
      throw error;
    }
  }

  async listHistory(input: {
    startHistoryId: string;
    pageToken?: string;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<GmailHistoryPage> {
    try {
      const response = await this.request(
        () =>
          this.gmail.users.history.list({
            userId: "me",
            startHistoryId: input.startHistoryId,
            maxResults: input.maxResults,
            historyTypes: [
              "messageAdded",
              "messageDeleted",
              "labelAdded",
              "labelRemoved",
            ],
            ...(input.pageToken ? { pageToken: input.pageToken } : {}),
          }),
        input.signal,
      );
      const historyId = response.data.historyId?.trim();
      if (!historyId)
        throw new Error("Gmail history response omitted historyId.");
      return {
        history: response.data.history
          ? (response.data.history as NonNullable<GmailHistoryPage["history"]>)
          : [],
        historyId,
        ...(response.data.nextPageToken
          ? { nextPageToken: response.data.nextPageToken }
          : {}),
      };
    } catch (error) {
      if (isNotFoundGmailError(error)) throw new GmailHistoryExpiredError();
      throw error;
    }
  }

  private async request<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      const result = await withGmailRetry(operation, {
        ...this.options.retry,
        ...(signal ? { signal } : {}),
      });
      await this.credentialWrite;
      return result;
    } catch (error) {
      await this.credentialWrite;
      throw normalizeGmailError(error);
    }
  }
}

export function createOAuth2Client(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) {
  return new google.auth.OAuth2(
    input.clientId,
    input.clientSecret,
    input.redirectUri,
  );
}

export function mergeGoogleCredentials(
  existing: GmailStoredCredentials | undefined,
  incoming: GoogleCredentialLike,
): GmailStoredCredentials {
  const scopes =
    incoming.scope?.split(/\s+/).filter(Boolean) ?? existing?.scopes ?? [];
  return {
    ...(incoming.access_token
      ? { accessToken: incoming.access_token }
      : existing?.accessToken
        ? { accessToken: existing.accessToken }
        : {}),
    ...(incoming.refresh_token
      ? { refreshToken: incoming.refresh_token }
      : existing?.refreshToken
        ? { refreshToken: existing.refreshToken }
        : {}),
    ...(incoming.expiry_date !== null && incoming.expiry_date !== undefined
      ? { expiryDate: incoming.expiry_date }
      : existing?.expiryDate
        ? { expiryDate: existing.expiryDate }
        : {}),
    ...(incoming.token_type
      ? { tokenType: incoming.token_type }
      : existing?.tokenType
        ? { tokenType: existing.tokenType }
        : {}),
    scopes,
  };
}

function toGoogleCredentials(
  credentials: GmailStoredCredentials,
): GoogleCredentialLike {
  return {
    ...(credentials.accessToken
      ? { access_token: credentials.accessToken }
      : {}),
    ...(credentials.refreshToken
      ? { refresh_token: credentials.refreshToken }
      : {}),
    ...(credentials.expiryDate ? { expiry_date: credentials.expiryDate } : {}),
    ...(credentials.tokenType ? { token_type: credentials.tokenType } : {}),
    ...(credentials.scopes.length > 0
      ? { scope: credentials.scopes.join(" ") }
      : {}),
  };
}
