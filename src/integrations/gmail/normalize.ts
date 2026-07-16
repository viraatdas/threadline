import {
  conversationCandidateSchema,
  type ConversationCandidate,
  type ParticipantCandidate,
} from "@/lib/domain/schemas";
import { createIdempotencyKey, hashContent } from "@/lib/security/idempotency";
import { normalizeGmailBody } from "@/src/integrations/gmail/body";
import {
  decodeRfc2047,
  normalizeEmailAddress,
  parseAddressList,
  type ParsedAddress,
} from "@/src/integrations/gmail/rfc";
import type {
  GmailHeader,
  GmailMessage,
  GmailThread,
} from "@/src/integrations/gmail/types";

interface NormalizeGmailThreadInput {
  thread: GmailThread;
  integrationAccountId: string;
  ownerEmail: string;
  collectedAt: Date;
}

interface MessageDraft {
  message: GmailMessage;
  externalMessageId: string;
  headers: Map<string, string>;
  from: ParsedAddress[];
  to: ParsedAddress[];
  cc: ParsedAddress[];
  bcc: ParsedAddress[];
  sentAt: Date;
  rfcMessageId?: string;
  inReplyTo?: string;
}

export function normalizeGmailThread(
  input: NormalizeGmailThreadInput,
): ConversationCandidate | null {
  const threadId = input.thread.id?.trim();
  if (!threadId) return null;
  const drafts = (input.thread.messages ?? [])
    .map((message) => createMessageDraft(message, input.collectedAt))
    .filter((draft): draft is MessageDraft => draft !== null);
  if (drafts.length === 0) return null;

  drafts.sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime());
  const ownerAliases = discoverOwnerAliases(drafts, input.ownerEmail);
  const rfcMessageIds = new Map(
    drafts.flatMap((draft) =>
      draft.rfcMessageId
        ? [
            [
              normalizeMessageId(draft.rfcMessageId),
              draft.externalMessageId,
            ] as const,
          ]
        : [],
    ),
  );
  const participants = participantCandidates(
    drafts,
    ownerAliases,
    input.integrationAccountId,
    input.collectedAt,
  );

  const messages = drafts.map((draft) => {
    const direction = messageDirection(draft, ownerAliases);
    const normalizedBody = normalizeGmailBody(draft.message.payload);
    const allAddresses = deduplicateAddresses([
      ...draft.from,
      ...draft.to,
      ...draft.cc,
      ...draft.bcc,
    ]);
    const messageParticipants = allAddresses.map((address) =>
      participantFromAddress(
        address,
        ownerAliases,
        input.integrationAccountId,
        input.collectedAt,
      ),
    );
    const sender = draft.from[0];
    const recipientAddresses = deduplicateAddresses([
      ...draft.to,
      ...draft.cc,
      ...draft.bcc,
    ]).map((address) => address.address);
    const rawSubject = headerValue(draft.headers, "subject");
    const subject = rawSubject
      ? decodeRfc2047(rawSubject).trim().slice(0, 1000)
      : undefined;
    const replyToExternalMessageId = draft.inReplyTo
      ? rfcMessageIds.get(normalizeMessageId(draft.inReplyTo))
      : undefined;
    const metadata = {
      gmailThreadId: threadId,
      labelIds: [...(draft.message.labelIds ?? [])].sort(),
      sizeEstimate: draft.message.sizeEstimate ?? null,
      attachments: normalizedBody.attachments,
      rfcMessageId: draft.rfcMessageId ?? null,
      inReplyToHeader: draft.inReplyTo ?? null,
      references: splitMessageIds(headerValue(draft.headers, "references")),
      senderAddress: sender?.address ?? null,
      recipientAddresses,
      ownerAliases: [...ownerAliases].sort(),
    };

    return {
      idempotencyKey: createIdempotencyKey(
        "gmail-message",
        input.integrationAccountId,
        draft.externalMessageId,
      ),
      integrationAccountId: input.integrationAccountId,
      channel: "gmail" as const,
      externalConversationId: threadId,
      externalMessageId: draft.externalMessageId,
      direction,
      sentAt: draft.sentAt.toISOString(),
      ...(direction === "inbound"
        ? { receivedAt: draft.sentAt.toISOString() }
        : {}),
      ...(subject ? { subject } : {}),
      ...normalizedBody,
      ...(draft.message.snippet
        ? { snippet: normalizeWhitespace(draft.message.snippet).slice(0, 4000) }
        : {}),
      ...(replyToExternalMessageId ? { replyToExternalMessageId } : {}),
      ...(sender ? { senderExternalParticipantId: sender.address } : {}),
      participants: messageParticipants,
      provenance: {
        provider: "gmail" as const,
        integrationAccountId: input.integrationAccountId,
        externalId: draft.externalMessageId,
        collectedAt: input.collectedAt.toISOString(),
        confidence: 1,
        metadata: {
          historyId: draft.message.historyId ?? null,
          threadId,
        },
      },
      metadata,
    };
  });

  const firstMessage = messages[0];
  const lastMessage = messages.at(-1);
  if (!firstMessage || !lastMessage) return null;
  const subject = messages.find((message) => message.subject)?.subject;
  const previewSource =
    lastMessage.bodyText ??
    lastMessage.snippet ??
    firstMessage.bodyText ??
    firstMessage.snippet;
  const gmailInputHash = hashContent({
    threadId,
    participants: participants.map(
      ({ externalParticipantId, role, displayName, address }) => ({
        externalParticipantId,
        role,
        displayName,
        address,
      }),
    ),
    messages: messages.map((message) => ({
      externalMessageId: message.externalMessageId,
      direction: message.direction,
      sentAt: message.sentAt,
      subject: message.subject,
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml,
      snippet: message.snippet,
      replyToExternalMessageId: message.replyToExternalMessageId,
      metadata: message.metadata,
    })),
  });

  return conversationCandidateSchema.parse({
    idempotencyKey: createIdempotencyKey(
      "gmail-conversation",
      input.integrationAccountId,
      threadId,
    ),
    integrationAccountId: input.integrationAccountId,
    channel: "gmail",
    externalConversationId: threadId,
    ...(subject
      ? { subject: decodeRfc2047(subject).trim().slice(0, 1000) }
      : {}),
    ...(previewSource
      ? { preview: normalizeWhitespace(previewSource).slice(0, 4000) }
      : {}),
    participants,
    messages,
    provenance: {
      provider: "gmail",
      integrationAccountId: input.integrationAccountId,
      externalId: threadId,
      collectedAt: input.collectedAt.toISOString(),
      confidence: 1,
      metadata: {
        historyId: input.thread.historyId ?? null,
      },
    },
    metadata: {
      gmailInputHash,
      ownerAliases: [...ownerAliases].sort(),
      firstMessageAt: firstMessage.sentAt,
      lastMessageAt: lastMessage.sentAt,
      deterministicReplyState: determineReplyState(messages),
    },
  });
}

function createMessageDraft(
  message: GmailMessage,
  fallbackDate: Date,
): MessageDraft | null {
  const externalMessageId = message.id?.trim();
  if (!externalMessageId) return null;
  const headers = headerMap(message.payload?.headers);
  const internalDate = message.internalDate
    ? Number(message.internalDate)
    : Number.NaN;
  const parsedDate = Date.parse(headerValue(headers, "date") ?? "");
  const sentAt = new Date(
    Number.isFinite(internalDate)
      ? internalDate
      : Number.isNaN(parsedDate)
        ? fallbackDate.getTime()
        : parsedDate,
  );
  const rfcMessageId = headerValue(headers, "message-id");
  const inReplyTo = headerValue(headers, "in-reply-to");
  return {
    message,
    externalMessageId,
    headers,
    from: parseAddressList(headerValue(headers, "from")),
    to: parseAddressList(headerValue(headers, "to")),
    cc: parseAddressList(headerValue(headers, "cc")),
    bcc: parseAddressList(headerValue(headers, "bcc")),
    sentAt,
    ...(rfcMessageId ? { rfcMessageId } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
  };
}

function discoverOwnerAliases(
  drafts: MessageDraft[],
  ownerEmail: string,
): Set<string> {
  const aliases = new Set([normalizeEmailAddress(ownerEmail)]);
  for (const draft of drafts) {
    const labels = new Set(draft.message.labelIds ?? []);
    if (!labels.has("SENT")) continue;
    for (const sender of draft.from) aliases.add(sender.address);
  }
  return aliases;
}

function participantCandidates(
  drafts: MessageDraft[],
  ownerAliases: Set<string>,
  integrationAccountId: string,
  collectedAt: Date,
): ParticipantCandidate[] {
  const addresses = deduplicateAddresses(
    drafts.flatMap((draft) => [
      ...draft.from,
      ...draft.to,
      ...draft.cc,
      ...draft.bcc,
    ]),
  );
  return addresses.map((address) =>
    participantFromAddress(
      address,
      ownerAliases,
      integrationAccountId,
      collectedAt,
    ),
  );
}

function participantFromAddress(
  parsedAddress: ParsedAddress,
  ownerAliases: Set<string>,
  integrationAccountId: string,
  collectedAt: Date,
): ParticipantCandidate {
  const isOwner = ownerAliases.has(parsedAddress.address);
  return {
    externalParticipantId: parsedAddress.address,
    role: isOwner ? "owner" : "contact",
    ...(parsedAddress.displayName
      ? { displayName: parsedAddress.displayName }
      : {}),
    address: parsedAddress.address,
    identity: {
      channel: "gmail",
      externalId: parsedAddress.address,
      address: parsedAddress.address,
      ...(parsedAddress.displayName
        ? { displayName: parsedAddress.displayName }
        : {}),
      isOwner,
      provenance: {
        provider: "gmail",
        integrationAccountId,
        externalId: parsedAddress.address,
        collectedAt: collectedAt.toISOString(),
        confidence: 1,
        metadata: {},
      },
      metadata: {},
    },
  };
}

function messageDirection(
  draft: MessageDraft,
  ownerAliases: Set<string>,
): "inbound" | "outbound" | "unknown" {
  const labels = new Set(draft.message.labelIds ?? []);
  if (labels.has("SENT")) return "outbound";
  if (labels.has("INBOX")) return "inbound";
  const sender = draft.from[0]?.address;
  if (sender && ownerAliases.has(sender)) return "outbound";
  if (sender) return "inbound";
  return "unknown";
}

function determineReplyState(
  messages: ConversationCandidate["messages"],
): "awaiting_reply" | "replied" | "not_applicable" | "unknown" {
  const outbound = messages.filter(
    (message) => message.direction === "outbound",
  );
  if (outbound.length === 0)
    return messages.some((message) => message.direction === "inbound")
      ? "not_applicable"
      : "unknown";
  const latestOutboundAt = Math.max(
    ...outbound.map((message) => Date.parse(message.sentAt)),
  );
  return messages.some(
    (message) =>
      message.direction === "inbound" &&
      Date.parse(message.sentAt) > latestOutboundAt,
  )
    ? "replied"
    : "awaiting_reply";
}

function headerMap(
  headers: GmailHeader[] | null | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const header of headers ?? []) {
    const name = header.name?.trim().toLowerCase();
    const value = header.value?.trim();
    if (!name || !value) continue;
    result.set(
      name,
      result.has(name) ? `${result.get(name)}, ${value}` : value,
    );
  }
  return result;
}

function headerValue(
  headers: Map<string, string>,
  name: string,
): string | undefined {
  return headers.get(name.toLowerCase());
}

function deduplicateAddresses(addresses: ParsedAddress[]): ParsedAddress[] {
  const map = new Map<string, ParsedAddress>();
  for (const address of addresses) {
    const existing = map.get(address.address);
    if (!existing || (!existing.displayName && address.displayName))
      map.set(address.address, address);
  }
  return [...map.values()];
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, "").toLowerCase();
}

function splitMessageIds(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/<([^>]+)>/g)]
    .map((match) => match[1]?.toLowerCase())
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
