import {
  conversationCandidateSchema,
  type ConversationCandidate,
  type ParticipantCandidate,
} from "@/lib/domain/schemas";
import { createIdempotencyKey } from "@/lib/security/idempotency";
import type {
  BirdDmConversation,
  BirdDmEvent,
  BirdDmUser,
  XAccountIdentity,
} from "@/src/integrations/x/types";

function normalizedTimestamp(
  value: string | undefined,
  fallback: Date,
): string {
  if (!value) return fallback.toISOString();
  const numeric = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime())
    ? fallback.toISOString()
    : date.toISOString();
}

function timestampMillis(value: string | undefined): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function participantCandidate(
  user: BirdDmUser,
  owner: XAccountIdentity,
  integrationAccountId: string,
  collectedAt: Date,
): ParticipantCandidate {
  const isOwner =
    user.id === owner.id ||
    user.username?.toLowerCase() === owner.username.toLowerCase();
  const handle = user.username
    ? `@${user.username.replace(/^@/, "")}`
    : undefined;

  return {
    externalParticipantId: user.id,
    role: isOwner ? "owner" : "contact",
    displayName: user.name ?? user.username ?? user.id,
    address: handle,
    identity: {
      channel: "x",
      externalId: user.id,
      ...(handle ? { handle } : {}),
      ...(user.name ? { displayName: user.name } : {}),
      ...(user.username
        ? { profileUrl: `https://x.com/${user.username.replace(/^@/, "")}` }
        : {}),
      isOwner,
      provenance: {
        provider: "x",
        integrationAccountId,
        externalId: user.id,
        collectedAt: collectedAt.toISOString(),
        confidence: 1,
        metadata: { transport: "bird-compatible" },
      },
      metadata: {
        ...(user.profileImageUrl
          ? { profileImageUrl: user.profileImageUrl }
          : {}),
      },
    },
  };
}

function eventDirection(event: BirdDmEvent, owner: XAccountIdentity) {
  const senderId = event.senderId ?? event.sender?.id;
  if (senderId === owner.id) return "outbound" as const;
  if (event.sender?.username?.toLowerCase() === owner.username.toLowerCase()) {
    return "outbound" as const;
  }
  return senderId ? ("inbound" as const) : ("unknown" as const);
}

export function deriveReplyMetadata(
  messages: BirdDmEvent[],
  owner: XAccountIdentity,
) {
  const ordered = [...messages].sort(
    (left, right) =>
      timestampMillis(left.createdAt) - timestampMillis(right.createdAt),
  );
  const firstOutboundIndex = ordered.findIndex(
    (message) => eventDirection(message, owner) === "outbound",
  );
  const firstReply =
    firstOutboundIndex < 0
      ? undefined
      : ordered
          .slice(firstOutboundIndex + 1)
          .find((message) => eventDirection(message, owner) === "inbound");
  const lastDirection = ordered.at(-1)
    ? eventDirection(ordered.at(-1)!, owner)
    : "unknown";
  const replyState = firstReply
    ? "replied"
    : firstOutboundIndex >= 0 && lastDirection === "outbound"
      ? "awaiting_reply"
      : firstOutboundIndex < 0
        ? "not_applicable"
        : "unknown";

  return {
    replyState,
    ...(firstReply?.createdAt ? { firstReplyAt: firstReply.createdAt } : {}),
    inboundCount: ordered.filter(
      (message) => eventDirection(message, owner) === "inbound",
    ).length,
    outboundCount: ordered.filter(
      (message) => eventDirection(message, owner) === "outbound",
    ).length,
  };
}

export function normalizeBirdDmConversation(options: {
  conversation: BirdDmConversation;
  owner: XAccountIdentity;
  integrationAccountId: string;
  collectedAt: Date;
  transport: "bird-cli" | "x-web";
}): ConversationCandidate {
  const { conversation, owner, integrationAccountId, collectedAt, transport } =
    options;
  const users = new Map<string, BirdDmUser>();
  for (const participant of conversation.participants)
    users.set(participant.id, participant);
  for (const message of conversation.messages) {
    if (message.sender?.id) {
      users.set(message.sender.id, {
        ...users.get(message.sender.id),
        ...message.sender,
      });
    }
    if (message.recipient?.id) {
      users.set(message.recipient.id, {
        ...users.get(message.recipient.id),
        ...message.recipient,
      });
    }
  }
  if (!users.has(owner.id)) {
    users.set(owner.id, {
      id: owner.id,
      username: owner.username,
      ...(owner.name ? { name: owner.name } : {}),
    });
  }

  const orderedMessages = [...conversation.messages].sort(
    (left, right) =>
      timestampMillis(left.createdAt) - timestampMillis(right.createdAt),
  );
  const replyMetadata = deriveReplyMetadata(orderedMessages, owner);
  const participants = [...users.values()].map((user) =>
    participantCandidate(user, owner, integrationAccountId, collectedAt),
  );
  const latestMessage = orderedMessages.at(-1);

  return conversationCandidateSchema.parse({
    idempotencyKey: createIdempotencyKey(
      "x-conversation",
      integrationAccountId,
      conversation.id,
    ),
    integrationAccountId,
    channel: "x",
    externalConversationId: conversation.id,
    subject:
      conversation.conversationType === "GROUP_DM"
        ? participants
            .filter((participant) => participant.role !== "owner")
            .map((participant) => participant.displayName)
            .filter(Boolean)
            .join(", ") || "X group conversation"
        : undefined,
    preview:
      latestMessage?.text ??
      conversation.lastMessagePreview ??
      (latestMessage?.unavailable ? "[Message unavailable]" : undefined),
    participants,
    messages: orderedMessages.map((message) => {
      const direction = eventDirection(message, owner);
      const sentAt = normalizedTimestamp(message.createdAt, collectedAt);
      const reply =
        direction === "outbound"
          ? orderedMessages.find(
              (candidate) =>
                timestampMillis(candidate.createdAt) >
                  new Date(sentAt).getTime() &&
                eventDirection(candidate, owner) === "inbound",
            )
          : undefined;

      return {
        idempotencyKey: createIdempotencyKey(
          "x-message",
          integrationAccountId,
          message.id,
        ),
        integrationAccountId,
        channel: "x" as const,
        externalConversationId: conversation.id,
        externalMessageId: message.id,
        direction,
        sentAt,
        ...(direction === "inbound" ? { receivedAt: sentAt } : {}),
        ...(message.text
          ? { bodyText: message.text, snippet: message.text.slice(0, 4000) }
          : {}),
        ...(!message.text && message.unavailable
          ? { snippet: "[Message unavailable]" }
          : {}),
        ...(message.replyToEventId
          ? { replyToExternalMessageId: message.replyToEventId }
          : {}),
        ...((message.senderId ?? message.sender?.id)
          ? {
              senderExternalParticipantId:
                message.senderId ?? message.sender!.id,
            }
          : {}),
        participants,
        provenance: {
          provider: "x" as const,
          integrationAccountId,
          externalId: message.id,
          sourceUrl: `https://x.com/messages/${encodeURIComponent(conversation.id)}`,
          collectedAt: collectedAt.toISOString(),
          confidence: message.unavailable ? 0.7 : 1,
          metadata: { transport },
        },
        metadata: {
          transport,
          inboxKind: message.inboxKind ?? conversation.inboxKind ?? "accepted",
          isMessageRequest:
            message.isMessageRequest ?? conversation.isMessageRequest ?? false,
          unavailable: message.unavailable ?? false,
          hasReply: Boolean(reply),
          ...(reply?.createdAt
            ? {
                replyReceivedAt: normalizedTimestamp(
                  reply.createdAt,
                  collectedAt,
                ),
              }
            : {}),
          ...(message.recipientId ? { recipientId: message.recipientId } : {}),
        },
      };
    }),
    provenance: {
      provider: "x",
      integrationAccountId,
      externalId: conversation.id,
      sourceUrl: `https://x.com/messages/${encodeURIComponent(conversation.id)}`,
      collectedAt: collectedAt.toISOString(),
      confidence: 1,
      metadata: { transport },
    },
    metadata: {
      transport,
      inboxKind: conversation.inboxKind ?? "accepted",
      isMessageRequest: conversation.isMessageRequest ?? false,
      conversationType: conversation.conversationType ?? "UNKNOWN",
      ...replyMetadata,
    },
  });
}
