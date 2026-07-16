import type {
  ContactCandidate,
  ConversationCandidate,
  MessageCandidate,
  ParticipantCandidate,
  SyncPage,
} from "@/lib/domain/schemas";
import { createIdempotencyKey } from "@/lib/security/idempotency";

import type {
  LinkedinCompany,
  LinkedinCursor,
  LinkedinMessage,
  LinkedinProfileEnrichment,
} from "@/src/integrations/linkedin/types";

interface NormalizeOptions {
  integrationAccountId: string;
  ownerExternalId: string;
  collectedAt: Date;
  cursor?: string | undefined;
  limit?: number | undefined;
  enrichments?: ReadonlyMap<string, LinkedinProfileEnrichment> | undefined;
}

export function normalizeLinkedinInbox(
  messages: readonly LinkedinMessage[],
  options: NormalizeOptions,
): SyncPage[] {
  const cursor = decodeLinkedinCursor(options.cursor);
  const grouped = groupByThread(messages)
    .map(([threadId, threadMessages]) =>
      normalizeConversation(threadId, threadMessages, options, options.enrichments),
    )
    .sort((left, right) =>
      String(right.metadata.lastMessageAt).localeCompare(String(left.metadata.lastMessageAt)),
    );
  const pageSize = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const collectedAt = options.collectedAt.toISOString();
  const pages: SyncPage[] = [];

  for (let offset = cursor.offset; offset < grouped.length; offset += pageSize) {
    const conversations = grouped.slice(offset, offset + pageSize);
    const contacts = uniqueContacts(conversations, options.enrichments);
    const nextOffset = offset + conversations.length;
    const hasMore = nextOffset < grouped.length;
    const nextSince = latestMessageTime(messages) ?? cursor.since;

    pages.push({
      integrationAccountId: options.integrationAccountId,
      resource: "inbox",
      cursor: encodeLinkedinCursor(
        hasMore
          ? { ...(cursor.since ? { since: cursor.since } : {}), offset: nextOffset }
          : { ...(nextSince ? { since: nextSince } : {}), offset: 0 },
      ),
      hasMore,
      conversations,
      contacts,
      collectedAt,
    });
  }

  if (pages.length === 0) {
    pages.push({
      integrationAccountId: options.integrationAccountId,
      resource: "inbox",
      cursor: encodeLinkedinCursor({ ...(cursor.since ? { since: cursor.since } : {}), offset: 0 }),
      hasMore: false,
      conversations: [],
      contacts: [],
      collectedAt,
    });
  }

  return pages;
}

function normalizeConversation(
  threadId: string,
  rawMessages: readonly LinkedinMessage[],
  options: NormalizeOptions,
  enrichments?: ReadonlyMap<string, LinkedinProfileEnrichment>,
): ConversationCandidate {
  const sorted = [...rawMessages].sort((left, right) => left.time.localeCompare(right.time));
  const contactProfileUrl = canonicalizeLinkedinUrl(sorted[0]?.personUrl ?? "");
  const enrichment = enrichments?.get(contactProfileUrl);
  const contactExternalId = enrichment?.person?.hashedUrl || contactProfileUrl;
  const contactName = enrichment?.person?.name || profileSlug(contactProfileUrl);
  const participants = buildParticipants(
    options.integrationAccountId,
    options.ownerExternalId,
    contactExternalId,
    contactName,
    contactProfileUrl,
    options.collectedAt,
  );
  const messages = sorted.map((message) =>
    normalizeMessage(message, options.integrationAccountId, participants, options.collectedAt),
  );
  const stats = conversationStats(messages);
  const preview = messages.at(-1)?.snippet;

  return {
    idempotencyKey: createIdempotencyKey(
      "linkedin-conversation",
      options.integrationAccountId,
      threadId,
    ),
    integrationAccountId: options.integrationAccountId,
    channel: "linkedin",
    externalConversationId: threadId,
    subject: contactName ? `LinkedIn conversation with ${contactName}` : undefined,
    preview,
    participants,
    messages,
    provenance: {
      provider: "linkedin",
      integrationAccountId: options.integrationAccountId,
      externalId: threadId,
      sourceUrl: contactProfileUrl || undefined,
      collectedAt: options.collectedAt.toISOString(),
      confidence: 1,
      metadata: { source: "linked-api", type: sorted[0]?.type ?? "st" },
    },
    metadata: {
      ...stats,
      lastMessageAt: messages.at(-1)?.sentAt,
      linkedinType: sorted[0]?.type ?? "st",
      profileUrl: contactProfileUrl,
      pendingWorkflows: enrichment?.pendingWorkflows ?? [],
      company: enrichment?.company,
    },
  };
}

function normalizeMessage(
  message: LinkedinMessage,
  integrationAccountId: string,
  participants: readonly ParticipantCandidate[],
  collectedAt: Date,
): MessageCandidate {
  const direction = message.sender === "us" ? "outbound" : "inbound";
  const sender = participants.find((participant) =>
    message.sender === "us" ? participant.role === "owner" : participant.role === "contact",
  );

  return {
    idempotencyKey: createIdempotencyKey(
      "linkedin-message",
      integrationAccountId,
      message.id,
    ),
    integrationAccountId,
    channel: "linkedin",
    externalConversationId: message.threadId,
    externalMessageId: message.id,
    direction,
    sentAt: new Date(message.time).toISOString(),
    receivedAt: direction === "inbound" ? new Date(message.time).toISOString() : undefined,
    bodyText: message.text,
    snippet: message.text.slice(0, 4000),
    senderExternalParticipantId: sender?.externalParticipantId,
    participants: [...participants],
    provenance: {
      provider: "linkedin",
      integrationAccountId,
      externalId: message.id,
      sourceUrl: canonicalizeLinkedinUrl(message.personUrl) || undefined,
      collectedAt: collectedAt.toISOString(),
      confidence: 1,
      metadata: { source: "linked-api", threadId: message.threadId, type: message.type },
    },
    metadata: { sender: message.sender, linkedinType: message.type },
  };
}

function buildParticipants(
  integrationAccountId: string,
  ownerExternalId: string,
  contactExternalId: string,
  contactName: string,
  contactProfileUrl: string,
  collectedAt: Date,
): ParticipantCandidate[] {
  return [
    {
      externalParticipantId: ownerExternalId,
      role: "owner",
      displayName: "You",
      identity: {
        channel: "linkedin",
        externalId: ownerExternalId,
        displayName: "You",
        isOwner: true,
        provenance: {
          provider: "linkedin",
          integrationAccountId,
          externalId: ownerExternalId,
          collectedAt: collectedAt.toISOString(),
          confidence: 1,
          metadata: { source: "linked-api" },
        },
        metadata: {},
      },
    },
    {
      externalParticipantId: contactExternalId,
      role: "contact",
      displayName: contactName || undefined,
      identity: {
        channel: "linkedin",
        externalId: contactExternalId,
        handle: profileSlug(contactProfileUrl) || undefined,
        displayName: contactName || undefined,
        profileUrl: contactProfileUrl || undefined,
        isOwner: false,
        provenance: {
          provider: "linkedin",
          integrationAccountId,
          externalId: contactExternalId,
          sourceUrl: contactProfileUrl || undefined,
          collectedAt: collectedAt.toISOString(),
          confidence: 1,
          metadata: { source: "linked-api" },
        },
        metadata: {},
      },
    },
  ];
}

function uniqueContacts(
  conversations: readonly ConversationCandidate[],
  enrichments?: ReadonlyMap<string, LinkedinProfileEnrichment>,
): ContactCandidate[] {
  const contacts = new Map<string, ContactCandidate>();
  for (const conversation of conversations) {
    const participant = conversation.participants.find((item) => item.role === "contact");
    const identity = participant?.identity;
    const profileUrl = identity?.profileUrl;
    if (!participant?.externalParticipantId || !profileUrl || !identity) continue;
    const enrichment = enrichments?.get(profileUrl);
    const person = enrichment?.person;
    const company = enrichment?.company;
    const names = splitName(person?.name ?? participant.displayName ?? profileSlug(profileUrl));
    contacts.set(participant.externalParticipantId, {
      displayName: person?.name ?? participant.displayName ?? profileSlug(profileUrl),
      givenName: names.givenName,
      familyName: names.familyName,
      title: person?.position || person?.headline || undefined,
      location: person?.location || undefined,
      relationshipStage: "unreviewed",
      company: company
        ? normalizeCompany(company)
        : person?.companyName
          ? {
              name: person.companyName,
              externalId: person.companyHashedUrl || undefined,
            }
          : undefined,
      provenance: identity.provenance,
      confidence: person ? 0.95 : 0.6,
      metadata: {
        linkedinProfileUrl: profileUrl,
        headline: person?.headline,
        about: person?.about,
        experiences: person?.experiences ?? [],
        company,
      },
    });
  }
  return [...contacts.values()];
}

function normalizeCompany(company: LinkedinCompany) {
  return {
    name: company.name,
    domain: websiteDomain(company.website),
    externalId: canonicalizeLinkedinUrl(company.publicUrl),
  };
}

function conversationStats(messages: readonly MessageCandidate[]) {
  const inbound = messages.filter((message) => message.direction === "inbound");
  const outbound = messages.filter((message) => message.direction === "outbound");
  const last = messages.at(-1);
  const replyState =
    outbound.length === 0
      ? "not_applicable"
      : last?.direction === "inbound"
        ? "replied"
        : "awaiting_reply";

  return {
    replyState,
    touchCount: messages.length,
    inboundTouchCount: inbound.length,
    outboundTouchCount: outbound.length,
    firstMessageAt: messages[0]?.sentAt,
    lastInboundAt: inbound.at(-1)?.sentAt,
    lastOutboundAt: outbound.at(-1)?.sentAt,
  };
}

function groupByThread(messages: readonly LinkedinMessage[]) {
  const grouped = new Map<string, LinkedinMessage[]>();
  for (const message of messages) {
    const existing = grouped.get(message.threadId) ?? [];
    existing.push(message);
    grouped.set(message.threadId, existing);
  }
  return [...grouped.entries()];
}

function latestMessageTime(messages: readonly LinkedinMessage[]) {
  return messages.reduce<string | undefined>(
    (latest, message) => (!latest || message.time > latest ? message.time : latest),
    undefined,
  );
}

export function encodeLinkedinCursor(cursor: LinkedinCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeLinkedinCursor(value?: string): LinkedinCursor {
  if (!value) return { offset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as LinkedinCursor;
    return {
      ...(parsed.since ? { since: parsed.since } : {}),
      offset: Number.isInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0,
    };
  } catch {
    throw new Error("Invalid LinkedIn sync cursor.");
  }
}

export function canonicalizeLinkedinUrl(value: string): string {
  if (!value.trim()) return "";
  try {
    const url = new URL(value.startsWith("http") ? value : `https://${value}`);
    url.protocol = "https:";
    url.hostname = "www.linkedin.com";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

function profileSlug(value: string) {
  try {
    return new URL(value).pathname.split("/").filter(Boolean).at(-1)?.replace(/[-_]+/g, " ") ?? "";
  } catch {
    return "";
  }
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    givenName: parts[0],
    familyName: parts.length > 1 ? parts.slice(1).join(" ") : undefined,
  };
}

function websiteDomain(value: string) {
  if (!value) return undefined;
  try {
    return new URL(value.startsWith("http") ? value : `https://${value}`).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
