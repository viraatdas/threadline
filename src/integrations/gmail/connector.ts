import type {
  ChannelConnector,
  ConnectorContext,
  ConnectorHealth,
  PullRequest,
} from "@/lib/domain/contracts";
import { normalizeEmail } from "@/lib/auth/owner";
import { syncPageSchema, type SyncPage } from "@/lib/domain/schemas";
import { GMAIL_READ_ONLY_CAPABILITIES } from "@/src/integrations/gmail/constants";
import { GmailAuthorizationError } from "@/src/integrations/gmail/errors";
import { normalizeGmailThread } from "@/src/integrations/gmail/normalize";
import type {
  GmailApi,
  GmailHistoryRecord,
} from "@/src/integrations/gmail/types";

interface GmailConnectorOptions {
  api: GmailApi;
  ownerEmail: string;
  pageSize?: number;
  threadBatchSize?: number;
}

export class GmailConnector implements ChannelConnector {
  readonly channel = "gmail" as const;
  readonly capabilities = GMAIL_READ_ONLY_CAPABILITIES;
  private readonly pageSize: number;
  private readonly threadBatchSize: number;

  constructor(private readonly options: GmailConnectorOptions) {
    this.pageSize = Math.min(500, Math.max(1, options.pageSize ?? 100));
    this.threadBatchSize = Math.min(
      100,
      Math.max(1, options.threadBatchSize ?? 25),
    );
  }

  async checkConnection(context: ConnectorContext): Promise<ConnectorHealth> {
    try {
      const profile = await this.options.api.getProfile(context.signal);
      this.assertOwner(profile.emailAddress);
      return {
        ok: true,
        checkedAt: context.now,
        accountLabel: profile.emailAddress,
      };
    } catch (error) {
      return {
        ok: false,
        checkedAt: context.now,
        detail:
          error instanceof Error
            ? error.message
            : "Gmail connection check failed.",
      };
    }
  }

  async *pull(
    context: ConnectorContext,
    request: PullRequest,
  ): AsyncIterable<SyncPage> {
    const profile = await this.options.api.getProfile(context.signal);
    this.assertOwner(profile.emailAddress);
    if (request.cursor) {
      yield* this.pullHistory(context, request, profile.emailAddress);
      return;
    }
    yield* this.pullInitial(
      context,
      request,
      profile.emailAddress,
      profile.historyId,
    );
  }

  private async *pullInitial(
    context: ConnectorContext,
    request: PullRequest,
    ownerEmail: string,
    startingHistoryId: string,
  ): AsyncIterable<SyncPage> {
    const query = initialQuery(request.since);
    let pageToken: string | undefined;
    do {
      const page = await this.options.api.listThreads({
        query,
        maxResults: Math.min(this.pageSize, request.limit ?? this.pageSize),
        ...(pageToken ? { pageToken } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const conversations = await this.fetchConversations(
        page.threadIds,
        context,
        ownerEmail,
      );
      pageToken = page.nextPageToken;
      yield syncPageSchema.parse({
        integrationAccountId: context.integrationAccountId,
        resource: request.resource,
        cursor: startingHistoryId,
        hasMore: Boolean(pageToken),
        conversations,
        contacts: [],
        collectedAt: context.now.toISOString(),
      });
    } while (pageToken);
  }

  private async *pullHistory(
    context: ConnectorContext,
    request: PullRequest,
    ownerEmail: string,
  ): AsyncIterable<SyncPage> {
    const threadIds = new Set<string>();
    let pageToken: string | undefined;
    let latestHistoryId = request.cursor!;
    do {
      const page = await this.options.api.listHistory({
        startHistoryId: request.cursor!,
        maxResults: Math.min(this.pageSize, request.limit ?? this.pageSize),
        ...(pageToken ? { pageToken } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      for (const history of page.history ?? [])
        collectChangedThreadIds(history, threadIds);
      latestHistoryId = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);

    const batches = chunk([...threadIds], this.threadBatchSize);
    if (batches.length === 0) {
      yield syncPageSchema.parse({
        integrationAccountId: context.integrationAccountId,
        resource: request.resource,
        cursor: latestHistoryId,
        hasMore: false,
        conversations: [],
        contacts: [],
        collectedAt: context.now.toISOString(),
      });
      return;
    }

    for (const [index, batch] of batches.entries()) {
      const conversations = await this.fetchConversations(
        batch,
        context,
        ownerEmail,
      );
      yield syncPageSchema.parse({
        integrationAccountId: context.integrationAccountId,
        resource: request.resource,
        cursor: latestHistoryId,
        hasMore: index < batches.length - 1,
        conversations,
        contacts: [],
        collectedAt: context.now.toISOString(),
      });
    }
  }

  private async fetchConversations(
    threadIds: string[],
    context: ConnectorContext,
    ownerEmail: string,
  ) {
    const conversations = await Promise.all(
      threadIds.map(async (threadId) => {
        const thread = await this.options.api.getThread({
          threadId,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return thread
          ? normalizeGmailThread({
              thread,
              integrationAccountId: context.integrationAccountId,
              ownerEmail,
              collectedAt: context.now,
            })
          : null;
      }),
    );
    return conversations.filter((conversation) => conversation !== null);
  }

  private assertOwner(emailAddress: string): void {
    if (
      normalizeEmail(emailAddress) !== normalizeEmail(this.options.ownerEmail)
    ) {
      throw new GmailAuthorizationError(
        "The connected Gmail mailbox does not belong to the Threadline owner.",
      );
    }
  }
}

function initialQuery(since: Date | undefined): string {
  const mailboxFilter = "{in:sent in:inbox}";
  if (!since) return mailboxFilter;
  return `${mailboxFilter} after:${Math.floor(since.getTime() / 1000)}`;
}

function collectChangedThreadIds(
  history: GmailHistoryRecord,
  target: Set<string>,
): void {
  const references = [
    ...(history.messages ?? []),
    ...(history.messagesAdded ?? []).flatMap((entry) =>
      entry.message ? [entry.message] : [],
    ),
    ...(history.messagesDeleted ?? []).flatMap((entry) =>
      entry.message ? [entry.message] : [],
    ),
    ...(history.labelsAdded ?? []).flatMap((entry) =>
      entry.message ? [entry.message] : [],
    ),
    ...(history.labelsRemoved ?? []).flatMap((entry) =>
      entry.message ? [entry.message] : [],
    ),
  ];
  for (const reference of references) {
    if (reference.threadId) target.add(reference.threadId);
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    batches.push(values.slice(index, index + size));
  return batches;
}
