import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { ConnectorHealth } from "@/lib/domain/contracts";
import { DEFAULT_X_WEB_ENDPOINTS } from "@/src/integrations/x/endpoints";
import {
  classifyXResponseFailure,
  XIntegrationError,
} from "@/src/integrations/x/errors";
import type {
  BirdDmConversation,
  BirdDmEvent,
  BirdDmsResponse,
  BirdDmUser,
  XAccountIdentity,
  XCredentials,
  XDmReadTransport,
  XDmTransportPage,
  XDmTransportRequest,
  XSyncCursor,
  XWebEndpointConfig,
} from "@/src/integrations/x/types";

const execFileAsync = promisify(execFile);
const DEFAULT_PAGE_SIZE = 100;
const MAX_CONVERSATION_PAGES = 50;

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function eventTimestamp(value: string | undefined): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function valuesOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const object = objectValue(value);
  return object ? Object.values(object) : [];
}

function encodeCursor(cursor: XSyncCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeXSyncCursor(
  value: string | undefined,
): XSyncCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    const object = objectValue(parsed);
    if (
      object?.version !== 1 ||
      (object.transport !== "bird-cli" && object.transport !== "x-web")
    ) {
      return undefined;
    }
    return {
      version: 1,
      transport: object.transport,
      complete: object.complete === true,
      ...(Array.isArray(object.remainingConversationIds)
        ? {
            remainingConversationIds: object.remainingConversationIds.filter(
              (item): item is string =>
                typeof item === "string" && item.length > 0,
            ),
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function parseBirdUser(
  value: unknown,
  fallbackId?: string,
): BirdDmUser | undefined {
  const object = objectValue(value);
  const legacy = objectValue(object?.legacy);
  const core = objectValue(object?.core);
  const id =
    stringValue(object?.id) ??
    stringValue(object?.id_str) ??
    stringValue(object?.rest_id) ??
    fallbackId;
  if (!id) return undefined;
  const username =
    stringValue(object?.username) ??
    stringValue(object?.screen_name) ??
    stringValue(legacy?.screen_name) ??
    stringValue(core?.screen_name);
  const name =
    stringValue(object?.name) ??
    stringValue(legacy?.name) ??
    stringValue(core?.name);
  const profileImageUrl =
    stringValue(object?.profileImageUrl) ??
    stringValue(object?.profile_image_url_https) ??
    stringValue(legacy?.profile_image_url_https);

  return {
    id,
    ...(username ? { username } : {}),
    ...(name ? { name } : {}),
    ...(profileImageUrl ? { profileImageUrl } : {}),
  };
}

function parseBirdEvent(
  value: unknown,
  fallbackConversationId?: string,
): BirdDmEvent | undefined {
  const object = objectValue(value);
  if (!object) return undefined;
  const message = objectValue(object.message) ?? object;
  const data =
    objectValue(message.message_data) ?? objectValue(message.messageData);
  const id =
    stringValue(message.id) ??
    stringValue(message.id_str) ??
    stringValue(object.id) ??
    stringValue(object.entry_id);
  if (!id) return undefined;
  const senderId =
    stringValue(message.sender_id) ??
    stringValue(data?.sender_id) ??
    stringValue(object.senderId);
  const recipientId =
    stringValue(message.recipient_id) ??
    stringValue(data?.recipient_id) ??
    stringValue(object.recipientId);
  const text =
    stringValue(data?.text) ??
    stringValue(message.text) ??
    stringValue(object.text);
  const createdAt =
    stringValue(message.time) ??
    stringValue(message.created_at) ??
    stringValue(object.createdAt);
  const conversationId =
    stringValue(message.conversation_id) ??
    stringValue(object.conversationId) ??
    fallbackConversationId;
  const replyData =
    objectValue(data?.reply_data) ?? objectValue(data?.replyData);
  const sender = parseBirdUser(object.sender, senderId);
  const recipient = parseBirdUser(object.recipient, recipientId);
  const unavailable =
    booleanValue(object.unavailable) ??
    Boolean(!text && (object.message === undefined || data === undefined));

  return {
    id,
    ...(conversationId ? { conversationId } : {}),
    ...(text ? { text } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(senderId ? { senderId } : {}),
    ...(recipientId ? { recipientId } : {}),
    ...(sender ? { sender } : {}),
    ...(recipient ? { recipient } : {}),
    ...(stringValue(replyData?.id)
      ? { replyToEventId: stringValue(replyData?.id)! }
      : {}),
    ...(object.inboxKind === "request" || object.inboxKind === "accepted"
      ? { inboxKind: object.inboxKind }
      : {}),
    ...(typeof object.isMessageRequest === "boolean"
      ? { isMessageRequest: object.isMessageRequest }
      : {}),
    unavailable,
    raw: value,
  };
}

function parseBirdConversation(value: unknown): BirdDmConversation | undefined {
  const object = objectValue(value);
  const id = stringValue(object?.id) ?? stringValue(object?.conversation_id);
  if (!object || !id) return undefined;
  const participants = valuesOf(object.participants)
    .map((participant) => {
      const participantObject = objectValue(participant);
      const participantId =
        stringValue(participantObject?.user_id) ??
        stringValue(participantObject?.id);
      return parseBirdUser(participantObject, participantId);
    })
    .filter((participant): participant is BirdDmUser => Boolean(participant));
  const messages = valuesOf(object.messages)
    .map((message) => parseBirdEvent(message, id))
    .filter((message): message is BirdDmEvent => Boolean(message));

  return {
    id,
    participants,
    messages,
    ...(stringValue(object.lastMessageAt)
      ? { lastMessageAt: stringValue(object.lastMessageAt)! }
      : {}),
    ...(stringValue(object.lastMessagePreview)
      ? { lastMessagePreview: stringValue(object.lastMessagePreview)! }
      : {}),
    ...(object.inboxKind === "request" || object.inboxKind === "accepted"
      ? { inboxKind: object.inboxKind }
      : {}),
    ...(typeof object.isMessageRequest === "boolean"
      ? { isMessageRequest: object.isMessageRequest }
      : {}),
    ...((stringValue(object.conversationType) ?? stringValue(object.type))
      ? {
          conversationType:
            stringValue(object.conversationType) ?? stringValue(object.type)!,
        }
      : {}),
  };
}

export function parseBirdDmsResponse(payload: unknown): BirdDmsResponse {
  const object = objectValue(payload);
  if (object?.success !== true || !Array.isArray(object.conversations)) {
    throw new XIntegrationError(
      "X_INVALID_RESPONSE",
      "Bird returned unexpected DM JSON; refusing to advance the sync cursor.",
    );
  }
  const conversations = object.conversations
    .map(parseBirdConversation)
    .filter((conversation): conversation is BirdDmConversation =>
      Boolean(conversation),
    );
  const events = Array.isArray(object.events)
    ? object.events
        .map((event) => parseBirdEvent(event))
        .filter((event): event is BirdDmEvent => Boolean(event))
    : conversations.flatMap((conversation) => conversation.messages);
  return { success: true, conversations, events };
}

export interface BirdCommandRunner {
  (options: {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }): Promise<{ stdout: string; stderr: string }>;
}

async function defaultBirdCommandRunner(options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) {
  const result = await execFileAsync(options.command, options.args, {
    env: options.env,
    maxBuffer: 128 * 1024 * 1024,
    timeout: 120_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export class BirdCliDmTransport implements XDmReadTransport {
  readonly name = "bird-cli" as const;
  private readonly command: string;
  private readonly credentials: XCredentials;
  private readonly runner: BirdCommandRunner;

  constructor(options: {
    credentials: XCredentials;
    command?: string;
    runner?: BirdCommandRunner;
  }) {
    this.credentials = options.credentials;
    this.command =
      options.command ??
      process.env.BIRD_DM_COMMAND ??
      path.join(process.cwd(), "node_modules", ".bin", "bird");
    this.runner = options.runner ?? defaultBirdCommandRunner;
  }

  private async run(args: string[], signal?: AbortSignal) {
    const env = {
      ...process.env,
      AUTH_TOKEN: this.credentials.authToken,
      CT0: this.credentials.ct0,
      NO_COLOR: "1",
    };
    try {
      return await this.runner({
        command: this.command,
        args,
        env,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stderr =
        error &&
        typeof error === "object" &&
        "stderr" in error &&
        typeof error.stderr === "string"
          ? error.stderr
          : "";
      const combined = `${message}\n${stderr}`;
      if (/enoent|not found|cannot execute/i.test(combined)) {
        throw new XIntegrationError(
          "X_BIRD_UNAVAILABLE",
          "The pinned Bird CLI is unavailable.",
          {
            cause: error,
          },
        );
      }
      if (
        /unknown command|unknown option|invalid command|dms.*not found/i.test(
          combined,
        )
      ) {
        throw new XIntegrationError(
          "X_BIRD_DM_UNSUPPORTED",
          "The pinned Bird CLI does not expose read-only DM JSON.",
          { cause: error },
        );
      }
      if (/auth|cookie|unauthorized|forbidden/i.test(combined)) {
        throw new XIntegrationError(
          "X_AUTH_EXPIRED",
          "Bird could not authenticate the X session cookies.",
          { cause: error },
        );
      }
      throw new XIntegrationError("X_UPSTREAM_FAILED", "Bird DM read failed.", {
        cause: error,
        retryable: true,
      });
    }
  }

  async checkConnection(signal?: AbortSignal) {
    try {
      const { stdout } = await this.run(["whoami"], signal);
      const username = stdout.match(/@([A-Za-z0-9_]{1,15})\b/)?.[1];
      const id = stdout.match(/(?:user_?id|🪪)[^\d]*(\d{2,})/i)?.[1];
      if (!username) {
        throw new XIntegrationError(
          "X_INVALID_RESPONSE",
          "Bird whoami omitted the X username.",
        );
      }
      const account: XAccountIdentity = {
        id: id ?? username.toLowerCase(),
        username,
        ...(stdout.match(/@[A-Za-z0-9_]{1,15}\s*\(([^)]+)\)/)?.[1]?.trim()
          ? {
              name: stdout
                .match(/@[A-Za-z0-9_]{1,15}\s*\(([^)]+)\)/)![1]!
                .trim(),
            }
          : {}),
      };
      return {
        ok: true,
        checkedAt: new Date(),
        accountLabel: `@${username}`,
        detail: "Authenticated through the pinned Bird CLI.",
        account,
      };
    } catch (error) {
      const integrationError =
        error instanceof XIntegrationError
          ? error
          : new XIntegrationError(
              "X_UPSTREAM_FAILED",
              "Bird connection check failed.",
              {
                cause: error,
              },
            );
      return {
        ok: false,
        checkedAt: new Date(),
        detail: `${integrationError.code}: ${integrationError.message}`,
      };
    }
  }

  async fetchPage(request: XDmTransportRequest): Promise<XDmTransportPage> {
    const result = await this.run(
      [
        "dms",
        "-n",
        String(request.limit ?? DEFAULT_PAGE_SIZE),
        "--json",
        "--all-pages",
      ],
      request.signal,
    );
    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch (error) {
      throw new XIntegrationError(
        "X_INVALID_RESPONSE",
        "Bird returned non-JSON DM output.",
        {
          cause: error,
        },
      );
    }
    const parsed = parseBirdDmsResponse(payload);
    return {
      conversations: parsed.conversations,
      nextCursor: encodeCursor({
        version: 1,
        transport: "bird-cli",
        complete: true,
      }),
      hasMore: false,
      collectedAt: new Date(),
      source: "bird-cli",
    };
  }
}

interface XInboxSnapshot {
  conversationIds: string[];
  conversations: Map<string, BirdDmConversation>;
  users: Map<string, BirdDmUser>;
  inlineEvents: BirdDmEvent[];
}

function addUsers(target: Map<string, BirdDmUser>, value: unknown) {
  const object = objectValue(value);
  if (object) {
    for (const [id, user] of Object.entries(object)) {
      const parsed = parseBirdUser(user, id);
      if (parsed)
        target.set(parsed.id, { ...target.get(parsed.id), ...parsed });
    }
  }
  if (Array.isArray(value)) {
    for (const user of value) {
      const parsed = parseBirdUser(user);
      if (parsed)
        target.set(parsed.id, { ...target.get(parsed.id), ...parsed });
    }
  }
}

function parseInboxSnapshot(payload: unknown): XInboxSnapshot {
  const root = objectValue(payload);
  if (root?.errors) {
    throw classifyXResponseFailure(200, JSON.stringify(root.errors));
  }
  const state = objectValue(root?.inbox_initial_state);
  if (!state) {
    throw new XIntegrationError(
      "X_ENDPOINT_ROTATED",
      "X inbox JSON no longer contains inbox_initial_state.",
    );
  }
  const users = new Map<string, BirdDmUser>();
  addUsers(users, state.users);
  addUsers(users, root?.users);
  const conversations = new Map<string, BirdDmConversation>();
  for (const rawConversation of valuesOf(state.conversations)) {
    const parsed = parseBirdConversation(rawConversation);
    if (parsed) conversations.set(parsed.id, parsed);
  }
  const inlineEvents = valuesOf(state.entries)
    .map((entry) => parseBirdEvent(entry))
    .filter((event): event is BirdDmEvent => Boolean(event));
  for (const event of inlineEvents) {
    if (!event.conversationId) continue;
    const existing = conversations.get(event.conversationId) ?? {
      id: event.conversationId,
      participants: [],
      messages: [],
    };
    existing.messages.push(event);
    conversations.set(existing.id, existing);
  }
  return {
    conversationIds: [...conversations.keys()],
    conversations,
    users,
    inlineEvents,
  };
}

function parseConversationTimeline(payload: unknown, conversationId: string) {
  const root = objectValue(payload);
  if (root?.errors) {
    throw classifyXResponseFailure(200, JSON.stringify(root.errors));
  }
  const timeline = objectValue(root?.conversation_timeline);
  if (!timeline) {
    throw new XIntegrationError(
      "X_ENDPOINT_ROTATED",
      "X conversation JSON no longer contains conversation_timeline.",
    );
  }
  const events = valuesOf(timeline.entries)
    .map((entry) => parseBirdEvent(entry, conversationId))
    .filter((event): event is BirdDmEvent => Boolean(event));
  const users = new Map<string, BirdDmUser>();
  addUsers(users, root?.users);
  addUsers(users, timeline.users);
  return {
    events,
    users,
    nextMaxId: stringValue(timeline.min_entry_id),
  };
}

export class XWebDmTransport implements XDmReadTransport {
  readonly name = "x-web" as const;
  private readonly credentials: XCredentials;
  private readonly endpoints: XWebEndpointConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly owner: XAccountIdentity | undefined;

  constructor(options: {
    credentials: XCredentials;
    endpoints?: XWebEndpointConfig;
    fetchImpl?: typeof fetch;
    owner?: XAccountIdentity;
  }) {
    this.credentials = options.credentials;
    this.endpoints = options.endpoints ?? DEFAULT_X_WEB_ENDPOINTS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.owner = options.owner;
  }

  private headers() {
    return {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      authorization: `Bearer ${this.endpoints.bearerToken}`,
      cookie: `auth_token=${this.credentials.authToken}; ct0=${this.credentials.ct0}`,
      "x-csrf-token": this.credentials.ct0,
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-client-language": "en",
      origin: "https://x.com",
      referer: "https://x.com/messages",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };
  }

  private async getJson(
    rawUrl: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(rawUrl);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers(),
      cache: "no-store",
      redirect: "manual",
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw classifyXResponseFailure(response.status, text);
    if (
      /^\s*</.test(text) ||
      response.headers.get("content-type")?.includes("text/html")
    ) {
      throw new XIntegrationError(
        "X_AUTH_EXPIRED",
        "X returned a login page instead of DM JSON. Refresh the session cookies.",
      );
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new XIntegrationError(
        "X_INVALID_RESPONSE",
        "X returned invalid JSON.",
        {
          cause: error,
        },
      );
    }
  }

  async checkConnection(signal?: AbortSignal) {
    try {
      const payload = objectValue(
        await this.getJson(this.endpoints.accountSettingsUrl, {}, signal),
      );
      const nestedUser = objectValue(payload?.user);
      const id =
        stringValue(payload?.user_id) ??
        stringValue(payload?.user_id_str) ??
        stringValue(nestedUser?.id_str) ??
        stringValue(nestedUser?.id) ??
        this.owner?.id;
      const username =
        stringValue(payload?.screen_name) ??
        stringValue(nestedUser?.screen_name) ??
        this.owner?.username;
      if (!id || !username) {
        throw new XIntegrationError(
          "X_INVALID_RESPONSE",
          "X account settings omitted the authenticated account identity.",
        );
      }
      const account: XAccountIdentity = {
        id,
        username,
        ...((stringValue(payload?.name) ?? stringValue(nestedUser?.name))
          ? {
              name:
                stringValue(payload?.name) ?? stringValue(nestedUser?.name)!,
            }
          : {}),
      };
      return {
        ok: true,
        checkedAt: new Date(),
        accountLabel: `@${username}`,
        detail: "Cookie-authenticated X web reads are healthy.",
        account,
      };
    } catch (error) {
      const integrationError =
        error instanceof XIntegrationError
          ? error
          : new XIntegrationError(
              "X_UPSTREAM_FAILED",
              "X connection check failed.",
              {
                cause: error,
              },
            );
      return {
        ok: false,
        checkedAt: new Date(),
        detail: `${integrationError.code}: ${integrationError.message}`,
      };
    }
  }

  private async getInbox(signal?: AbortSignal) {
    return parseInboxSnapshot(
      await this.getJson(
        this.endpoints.inboxInitialStateUrl,
        { ...this.endpoints.dmParams },
        signal,
      ),
    );
  }

  private async getConversation(
    conversationId: string,
    signal: AbortSignal | undefined,
    limit: number,
  ) {
    const events = new Map<string, BirdDmEvent>();
    const users = new Map<string, BirdDmUser>();
    let maxId: string | undefined;

    for (let page = 0; page < MAX_CONVERSATION_PAGES; page += 1) {
      const payload = await this.getJson(
        this.endpoints.conversationUrl(conversationId),
        {
          ...this.endpoints.dmParams,
          count: String(limit),
          ...(maxId ? { max_id: maxId } : {}),
        },
        signal,
      );
      const timeline = parseConversationTimeline(payload, conversationId);
      for (const event of timeline.events) events.set(event.id, event);
      for (const user of timeline.users.values()) users.set(user.id, user);
      if (
        !timeline.nextMaxId ||
        timeline.events.length === 0 ||
        timeline.nextMaxId === maxId
      ) {
        return { events: [...events.values()], users };
      }
      maxId = timeline.nextMaxId;
    }

    throw new XIntegrationError(
      "X_PAGE_LIMIT_EXCEEDED",
      `X conversation ${conversationId} exceeded ${MAX_CONVERSATION_PAGES} pages; no cursor was advanced.`,
      { retryable: true },
    );
  }

  async fetchPage(request: XDmTransportRequest): Promise<XDmTransportPage> {
    const cursor = decodeXSyncCursor(request.cursor);
    const inbox = await this.getInbox(request.signal);
    const remaining =
      cursor?.transport === "x-web" &&
      !cursor.complete &&
      cursor.remainingConversationIds?.length
        ? [...cursor.remainingConversationIds]
        : [...inbox.conversationIds];
    const conversationId = remaining.shift();
    const collectedAt = new Date();

    if (!conversationId) {
      return {
        conversations: [],
        nextCursor: encodeCursor({
          version: 1,
          transport: "x-web",
          complete: true,
        }),
        hasMore: false,
        collectedAt,
        source: "x-web",
      };
    }

    const definition = inbox.conversations.get(conversationId) ?? {
      id: conversationId,
      participants: [],
      messages: [],
    };
    const history = await this.getConversation(
      conversationId,
      request.signal,
      Math.min(Math.max(request.limit ?? DEFAULT_PAGE_SIZE, 1), 100),
    );
    const users = new Map(inbox.users);
    for (const user of history.users.values()) users.set(user.id, user);
    const events =
      history.events.length > 0 ? history.events : definition.messages;
    const participantIds = new Set<string>();
    for (const participant of definition.participants)
      participantIds.add(participant.id);
    for (const event of events) {
      if (event.senderId) participantIds.add(event.senderId);
      if (event.recipientId) participantIds.add(event.recipientId);
    }
    const participants = [...participantIds].map(
      (id) => users.get(id) ?? { id },
    );
    const messages = request.since
      ? events.filter(
          (event) =>
            !event.createdAt ||
            new Date(event.createdAt).getTime() >= request.since!.getTime(),
        )
      : events;
    const ordered = [...messages].sort(
      (left, right) =>
        eventTimestamp(left.createdAt) - eventTimestamp(right.createdAt),
    );
    const latest = ordered.at(-1);
    const hasMore = remaining.length > 0;

    return {
      conversations: [
        {
          ...definition,
          participants,
          messages: ordered,
          ...(latest?.createdAt ? { lastMessageAt: latest.createdAt } : {}),
          ...(latest?.text ? { lastMessagePreview: latest.text } : {}),
          conversationType:
            definition.conversationType ??
            (participants.length > 2 ? "GROUP_DM" : "ONE_TO_ONE"),
        },
      ],
      nextCursor: encodeCursor({
        version: 1,
        transport: "x-web",
        complete: !hasMore,
        ...(hasMore ? { remainingConversationIds: remaining } : {}),
      }),
      hasMore,
      collectedAt,
      source: "x-web",
    };
  }
}

export class BirdWithWebFallbackTransport implements XDmReadTransport {
  readonly name = "bird-with-web-fallback" as const;
  private readonly bird: BirdCliDmTransport;
  private readonly web: XWebDmTransport;

  constructor(options: {
    credentials: XCredentials;
    owner?: XAccountIdentity;
    endpoints?: XWebEndpointConfig;
    fetchImpl?: typeof fetch;
    birdCommand?: string;
    birdRunner?: BirdCommandRunner;
  }) {
    this.bird = new BirdCliDmTransport({
      credentials: options.credentials,
      ...(options.birdCommand ? { command: options.birdCommand } : {}),
      ...(options.birdRunner ? { runner: options.birdRunner } : {}),
    });
    this.web = new XWebDmTransport({
      credentials: options.credentials,
      ...(options.owner ? { owner: options.owner } : {}),
      ...(options.endpoints ? { endpoints: options.endpoints } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  async checkConnection(
    signal?: AbortSignal,
  ): Promise<ConnectorHealth & { account?: XAccountIdentity }> {
    const birdHealth = await this.bird.checkConnection(signal);
    if (birdHealth.ok) return birdHealth;
    if (
      birdHealth.detail?.startsWith("X_BIRD_UNAVAILABLE") ||
      birdHealth.detail?.startsWith("X_BIRD_DM_UNSUPPORTED")
    ) {
      return this.web.checkConnection(signal);
    }
    return birdHealth;
  }

  async fetchPage(request: XDmTransportRequest): Promise<XDmTransportPage> {
    const cursor = decodeXSyncCursor(request.cursor);
    if (cursor?.transport === "x-web" && !cursor.complete) {
      return this.web.fetchPage(request);
    }
    try {
      return await this.bird.fetchPage(request);
    } catch (error) {
      if (
        error instanceof XIntegrationError &&
        (error.code === "X_BIRD_UNAVAILABLE" ||
          error.code === "X_BIRD_DM_UNSUPPORTED")
      ) {
        return this.web.fetchPage({
          ...(request.limit ? { limit: request.limit } : {}),
          ...(request.since ? { since: request.since } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      }
      throw error;
    }
  }
}
