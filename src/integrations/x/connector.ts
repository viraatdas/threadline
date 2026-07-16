import type {
  ChannelConnector,
  ConnectorContext,
  PullRequest,
} from "@/lib/domain/contracts";
import { syncPageSchema } from "@/lib/domain/schemas";
import { READ_ONLY_CAPABILITIES } from "@/lib/security/read-only";
import { XIntegrationError } from "@/src/integrations/x/errors";
import { normalizeBirdDmConversation } from "@/src/integrations/x/normalize";
import type {
  XAccountIdentity,
  XDmReadTransport,
} from "@/src/integrations/x/types";
import { X_DM_RESOURCE } from "@/src/integrations/x/types";

export class XDirectMessageConnector implements ChannelConnector {
  readonly channel = "x" as const;
  readonly capabilities = READ_ONLY_CAPABILITIES;
  private readonly owner: XAccountIdentity;
  private readonly transport: XDmReadTransport;

  constructor(options: {
    owner: XAccountIdentity;
    transport: XDmReadTransport;
  }) {
    this.owner = options.owner;
    this.transport = options.transport;
  }

  async checkConnection(context: ConnectorContext) {
    const health = await this.transport.checkConnection(context.signal);
    if (!health.ok || !health.account) return health;
    const accountMatches =
      health.account.id === this.owner.id ||
      health.account.username.toLowerCase() ===
        this.owner.username.toLowerCase();
    if (!accountMatches) {
      return {
        ok: false,
        checkedAt: context.now,
        ...(health.accountLabel ? { accountLabel: health.accountLabel } : {}),
        detail: `X_ACCOUNT_MISMATCH: Cookies belong to @${health.account.username}, not @${this.owner.username}.`,
      };
    }
    return { ...health, checkedAt: context.now };
  }

  async *pull(context: ConnectorContext, request: PullRequest) {
    if (request.resource !== X_DM_RESOURCE) {
      throw new XIntegrationError(
        "X_INVALID_RESPONSE",
        `X connector only supports the ${X_DM_RESOURCE} resource.`,
      );
    }

    let cursor = request.cursor;
    const seenCursors = new Set<string>();

    while (true) {
      const page = await this.transport.fetchPage({
        ...(cursor ? { cursor } : {}),
        ...(request.limit ? { limit: request.limit } : {}),
        ...(request.since ? { since: request.since } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const syncPage = syncPageSchema.parse({
        integrationAccountId: context.integrationAccountId,
        resource: X_DM_RESOURCE,
        cursor: page.nextCursor,
        hasMore: page.hasMore,
        conversations: page.conversations.map((conversation) =>
          normalizeBirdDmConversation({
            conversation,
            owner: this.owner,
            integrationAccountId: context.integrationAccountId,
            collectedAt: page.collectedAt,
            transport: page.source,
          }),
        ),
        contacts: [],
        collectedAt: page.collectedAt.toISOString(),
      });

      yield syncPage;

      if (!page.hasMore) return;
      if (seenCursors.has(page.nextCursor)) {
        throw new XIntegrationError(
          "X_INVALID_RESPONSE",
          "X DM pagination repeated a cursor; sync stopped without advancing further.",
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
}
