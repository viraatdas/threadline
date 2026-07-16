import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import type { ThreadlineDatabase } from "@/lib/db/client";
import { createRepositories } from "@/lib/db/repositories";
import {
  analysisJobs,
  channelIdentities,
  contacts,
  conversationParticipants,
  conversations,
  integrationAccounts,
  messages,
  touchpoints,
  type IntegrationAccount,
} from "@/lib/db/schema";
import type { ReplyState, SyncTrigger } from "@/lib/domain/constants";
import type {
  ConversationCandidate,
  ParticipantCandidate,
  SyncPage,
} from "@/lib/domain/schemas";
import { EnvironmentCredentialVault } from "@/lib/security/credentials";
import { getEncryptionEnvironment } from "@/lib/security/env";
import { createIdempotencyKey, hashContent } from "@/lib/security/idempotency";
import { XDirectMessageConnector } from "@/src/integrations/x/connector";
import {
  toXIntegrationError,
  XIntegrationError,
} from "@/src/integrations/x/errors";
import type { XPageApplyResult, XSyncStore } from "@/src/integrations/x/sync";
import { syncXDirectMessages } from "@/src/integrations/x/sync";
import { BirdWithWebFallbackTransport } from "@/src/integrations/x/transport";
import type {
  XAccountIdentity,
  XCredentials,
  XWebEndpointConfig,
} from "@/src/integrations/x/types";
import { X_DM_RESOURCE } from "@/src/integrations/x/types";

const xCredentialsSchema = z.object({
  authToken: z.string().min(1),
  ct0: z.string().min(1),
});

type ParticipantBinding = {
  participant: ParticipantCandidate;
  contactId?: string;
  identityId: string;
};

export function xCredentialContext(externalAccountId: string) {
  return `integration:x:${externalAccountId}`;
}

export function xCursorContext(integrationAccountId: string, resource: string) {
  return `sync-cursor:x:${integrationAccountId}:${resource}`;
}

function replyStateFromMetadata(value: unknown): ReplyState {
  return value === "awaiting_reply" ||
    value === "replied" ||
    value === "not_applicable" ||
    value === "unknown"
    ? value
    : "unknown";
}

function messageDates(conversation: ConversationCandidate) {
  const messagesByTime = [...conversation.messages].sort((left, right) =>
    left.sentAt.localeCompare(right.sentAt),
  );
  const inbound = messagesByTime.filter(
    (message) => message.direction === "inbound",
  );
  const outbound = messagesByTime.filter(
    (message) => message.direction === "outbound",
  );
  return {
    firstMessageAt: messagesByTime[0]
      ? new Date(messagesByTime[0].sentAt)
      : undefined,
    lastMessageAt: messagesByTime.at(-1)
      ? new Date(messagesByTime.at(-1)!.sentAt)
      : undefined,
    lastInboundAt: inbound.at(-1)
      ? new Date(inbound.at(-1)!.sentAt)
      : undefined,
    lastOutboundAt: outbound.at(-1)
      ? new Date(outbound.at(-1)!.sentAt)
      : undefined,
  };
}

function provenanceColumns(provenance: ConversationCandidate["provenance"]) {
  return {
    sourceExternalId: provenance.externalId,
    sourceUrl: provenance.sourceUrl,
    sourceCollectedAt: new Date(provenance.collectedAt),
    sourceConfidence: provenance.confidence,
    sourceProvenance: [provenance],
  };
}

function nonOwnerBindings(bindings: Map<string, ParticipantBinding>) {
  return [...bindings.values()].filter(
    (binding): binding is ParticipantBinding & { contactId: string } =>
      binding.participant.role !== "owner" && Boolean(binding.contactId),
  );
}

export class DatabaseXSyncStore implements XSyncStore {
  private readonly database: ThreadlineDatabase;
  private readonly vault: EnvironmentCredentialVault;

  constructor(
    database: ThreadlineDatabase,
    vault = new EnvironmentCredentialVault(),
  ) {
    this.database = database;
    this.vault = vault;
  }

  async loadCursor(integrationAccountId: string, resource: string) {
    const repositories = createRepositories(this.database);
    const cursor = await repositories.integrations.getCursor(
      integrationAccountId,
      resource,
    );
    if (!cursor) return undefined;
    const opened = await this.vault.open<{ cursor: string }>(
      cursor.cursorCiphertext,
      xCursorContext(integrationAccountId, resource),
    );
    return opened.cursor;
  }

  async saveCursor(options: {
    integrationAccountId: string;
    resource: string;
    cursor: string;
    lastSeenExternalId?: string;
    lastSeenAt?: Date;
  }) {
    const repositories = createRepositories(this.database);
    const encrypted = await this.vault.seal(
      { cursor: options.cursor },
      xCursorContext(options.integrationAccountId, options.resource),
    );
    await repositories.integrations.upsertCursor({
      integrationAccountId: options.integrationAccountId,
      resource: options.resource,
      cursorCiphertext: encrypted,
      cursorKeyVersion:
        getEncryptionEnvironment().INTEGRATION_ENCRYPTION_KEY_VERSION,
      ...(options.lastSeenExternalId
        ? { lastSeenExternalId: options.lastSeenExternalId }
        : {}),
      ...(options.lastSeenAt ? { lastSeenAt: options.lastSeenAt } : {}),
    });
  }

  async applyPage(page: SyncPage): Promise<XPageApplyResult> {
    return this.database.transaction(async (transaction) => {
      const result: XPageApplyResult = {
        discoveredCount: 0,
        insertedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        analysisEnqueuedCount: 0,
      };

      for (const candidate of page.conversations) {
        const [existingConversation] = await transaction
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(
                conversations.integrationAccountId,
                candidate.integrationAccountId,
              ),
              eq(
                conversations.externalConversationId,
                candidate.externalConversationId,
              ),
            ),
          )
          .limit(1);
        const dates = messageDates(candidate);
        const [conversation] = await transaction
          .insert(conversations)
          .values({
            integrationAccountId: candidate.integrationAccountId,
            channel: "x",
            externalConversationId: candidate.externalConversationId,
            idempotencyKey: candidate.idempotencyKey,
            subject: candidate.subject,
            preview: candidate.preview,
            ...dates,
            touchCount: candidate.messages.length,
            replyState: replyStateFromMetadata(candidate.metadata.replyState),
            metadata: candidate.metadata,
            ...provenanceColumns(candidate.provenance),
          })
          .onConflictDoUpdate({
            target: [
              conversations.integrationAccountId,
              conversations.externalConversationId,
            ],
            set: {
              subject: candidate.subject,
              preview: candidate.preview,
              ...dates,
              touchCount: candidate.messages.length,
              replyState: replyStateFromMetadata(candidate.metadata.replyState),
              metadata: candidate.metadata,
              ...provenanceColumns(candidate.provenance),
              updatedAt: new Date(),
            },
          })
          .returning();
        if (!conversation)
          throw new Error("X conversation upsert did not return a row.");
        if (existingConversation) result.updatedCount += 1;

        const bindings = new Map<string, ParticipantBinding>();
        for (const participant of candidate.participants) {
          const identityCandidate = participant.identity;
          const [existingIdentity] = await transaction
            .select()
            .from(channelIdentities)
            .where(
              and(
                eq(
                  channelIdentities.integrationAccountId,
                  candidate.integrationAccountId,
                ),
                eq(channelIdentities.channel, "x"),
                eq(
                  channelIdentities.externalId,
                  participant.externalParticipantId,
                ),
              ),
            )
            .limit(1);
          let contactId = existingIdentity?.contactId ?? undefined;
          if (participant.role !== "owner" && !contactId) {
            const [contact] = await transaction
              .insert(contacts)
              .values({
                displayName:
                  participant.displayName ??
                  identityCandidate?.displayName ??
                  identityCandidate?.handle ??
                  participant.externalParticipantId,
                relationshipStage: "unreviewed",
                replyState: "unknown",
                confidence: 0.7,
                metadata: {
                  channel: "x",
                  ...(identityCandidate?.handle
                    ? { handle: identityCandidate.handle }
                    : {}),
                },
                ...(identityCandidate
                  ? provenanceColumns(identityCandidate.provenance)
                  : provenanceColumns(candidate.provenance)),
              })
              .returning();
            if (!contact)
              throw new Error("X contact insert did not return a row.");
            contactId = contact.id;
          }
          const identityProvenance =
            identityCandidate?.provenance ?? candidate.provenance;
          const [identity] = await transaction
            .insert(channelIdentities)
            .values({
              contactId,
              integrationAccountId: candidate.integrationAccountId,
              channel: "x",
              externalId: participant.externalParticipantId,
              handle: identityCandidate?.handle,
              address: participant.address ?? identityCandidate?.address,
              displayName:
                participant.displayName ?? identityCandidate?.displayName,
              profileUrl: identityCandidate?.profileUrl,
              isOwner: participant.role === "owner",
              confidence: 1,
              metadata: identityCandidate?.metadata ?? {},
              ...provenanceColumns(identityProvenance),
            })
            .onConflictDoUpdate({
              target: [
                channelIdentities.integrationAccountId,
                channelIdentities.channel,
                channelIdentities.externalId,
              ],
              set: {
                contactId,
                handle: identityCandidate?.handle,
                address: participant.address ?? identityCandidate?.address,
                displayName:
                  participant.displayName ?? identityCandidate?.displayName,
                profileUrl: identityCandidate?.profileUrl,
                isOwner: participant.role === "owner",
                metadata: identityCandidate?.metadata ?? {},
                ...provenanceColumns(identityProvenance),
                updatedAt: new Date(),
              },
            })
            .returning();
          if (!identity)
            throw new Error("X channel identity upsert did not return a row.");
          bindings.set(participant.externalParticipantId, {
            participant,
            identityId: identity.id,
            ...(contactId ? { contactId } : {}),
          });
          await transaction
            .insert(conversationParticipants)
            .values({
              conversationId: conversation.id,
              channelIdentityId: identity.id,
              contactId,
              externalParticipantId: participant.externalParticipantId,
              role: participant.role,
              displayName: participant.displayName,
              address: participant.address,
              metadata: participant.identity?.metadata ?? {},
            })
            .onConflictDoUpdate({
              target: [
                conversationParticipants.conversationId,
                conversationParticipants.externalParticipantId,
              ],
              set: {
                channelIdentityId: identity.id,
                contactId,
                role: participant.role,
                displayName: participant.displayName,
                address: participant.address,
                metadata: participant.identity?.metadata ?? {},
                updatedAt: new Date(),
              },
            });
        }

        const insertedMessages = [];
        for (const messageCandidate of candidate.messages) {
          result.discoveredCount += 1;
          const senderBinding = messageCandidate.senderExternalParticipantId
            ? bindings.get(messageCandidate.senderExternalParticipantId)
            : undefined;
          const [insertedMessage] = await transaction
            .insert(messages)
            .values({
              conversationId: conversation.id,
              integrationAccountId: candidate.integrationAccountId,
              senderIdentityId: senderBinding?.identityId,
              channel: "x",
              externalMessageId: messageCandidate.externalMessageId,
              idempotencyKey: messageCandidate.idempotencyKey,
              direction: messageCandidate.direction,
              sentAt: new Date(messageCandidate.sentAt),
              receivedAt: messageCandidate.receivedAt
                ? new Date(messageCandidate.receivedAt)
                : undefined,
              subject: messageCandidate.subject,
              bodyText: messageCandidate.bodyText,
              bodyHtml: messageCandidate.bodyHtml,
              snippet: messageCandidate.snippet,
              contentHash: hashContent({
                bodyText: messageCandidate.bodyText,
                bodyHtml: messageCandidate.bodyHtml,
                metadata: messageCandidate.metadata,
              }),
              hasReply: messageCandidate.metadata.hasReply === true,
              replyReceivedAt:
                typeof messageCandidate.metadata.replyReceivedAt === "string"
                  ? new Date(messageCandidate.metadata.replyReceivedAt)
                  : undefined,
              metadata: {
                ...messageCandidate.metadata,
                ...(messageCandidate.replyToExternalMessageId
                  ? {
                      replyToExternalMessageId:
                        messageCandidate.replyToExternalMessageId,
                    }
                  : {}),
              },
              ...provenanceColumns(messageCandidate.provenance),
            })
            .onConflictDoNothing({ target: messages.idempotencyKey })
            .returning();
          if (insertedMessage) {
            insertedMessages.push(insertedMessage);
            result.insertedCount += 1;
          } else {
            result.skippedCount += 1;
          }
        }

        const allMessages = await transaction
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conversation.id))
          .orderBy(asc(messages.sentAt));
        for (const [index, message] of allMessages.entries()) {
          if (message.direction !== "outbound") continue;
          const reply = allMessages
            .slice(index + 1)
            .find(
              (candidateMessage) => candidateMessage.direction === "inbound",
            );
          await transaction
            .update(messages)
            .set({
              hasReply: Boolean(reply),
              replyReceivedAt: reply?.sentAt,
              updatedAt: new Date(),
            })
            .where(eq(messages.id, message.id));
        }

        const firstMessage = allMessages[0];
        const lastMessage = allMessages.at(-1);
        const lastInbound = allMessages
          .filter((message) => message.direction === "inbound")
          .at(-1);
        const lastOutbound = allMessages
          .filter((message) => message.direction === "outbound")
          .at(-1);
        const firstOutboundIndex = allMessages.findIndex(
          (message) => message.direction === "outbound",
        );
        const replyAfterOutbound =
          firstOutboundIndex < 0
            ? undefined
            : allMessages
                .slice(firstOutboundIndex + 1)
                .find((message) => message.direction === "inbound");
        const replyState: ReplyState = replyAfterOutbound
          ? "replied"
          : firstOutboundIndex >= 0 && lastMessage?.direction === "outbound"
            ? "awaiting_reply"
            : firstOutboundIndex < 0
              ? "not_applicable"
              : "unknown";
        await transaction
          .update(conversations)
          .set({
            firstMessageAt: firstMessage?.sentAt,
            lastMessageAt: lastMessage?.sentAt,
            lastInboundAt: lastInbound?.sentAt,
            lastOutboundAt: lastOutbound?.sentAt,
            touchCount: allMessages.length,
            replyState,
            preview:
              lastMessage?.snippet ??
              lastMessage?.bodyText ??
              candidate.preview,
            updatedAt: new Date(),
          })
          .where(eq(conversations.id, conversation.id));

        const externalCandidates = new Map(
          candidate.messages.map((messageCandidate) => [
            messageCandidate.externalMessageId,
            messageCandidate,
          ]),
        );
        const contactIds = new Set<string>();
        for (const insertedMessage of insertedMessages) {
          const messageCandidate = externalCandidates.get(
            insertedMessage.externalMessageId,
          );
          if (!messageCandidate) continue;
          const targets =
            insertedMessage.direction === "inbound"
              ? [
                  messageCandidate.senderExternalParticipantId
                    ? bindings.get(messageCandidate.senderExternalParticipantId)
                    : undefined,
                ].filter(
                  (
                    binding,
                  ): binding is ParticipantBinding & { contactId: string } =>
                    Boolean(binding?.contactId),
                )
              : insertedMessage.direction === "outbound"
                ? nonOwnerBindings(bindings)
                : [];
          for (const target of targets) {
            contactIds.add(target.contactId);
            const hadOutboundBefore = allMessages.some(
              (message) =>
                message.direction === "outbound" &&
                message.sentAt < insertedMessage.sentAt,
            );
            await transaction
              .insert(touchpoints)
              .values({
                contactId: target.contactId,
                conversationId: conversation.id,
                messageId: insertedMessage.id,
                integrationAccountId: candidate.integrationAccountId,
                idempotencyKey: createIdempotencyKey(
                  "x-touchpoint",
                  insertedMessage.id,
                  target.contactId,
                ),
                channel: "x",
                direction: insertedMessage.direction,
                kind:
                  insertedMessage.direction === "inbound" && hadOutboundBefore
                    ? "reply"
                    : "message",
                replyState:
                  insertedMessage.direction === "inbound" && hadOutboundBefore
                    ? "replied"
                    : insertedMessage.direction === "outbound"
                      ? "awaiting_reply"
                      : "unknown",
                happenedAt: insertedMessage.sentAt,
                isAutomated: true,
                summary: insertedMessage.snippet ?? insertedMessage.bodyText,
                metadata: {
                  externalMessageId: insertedMessage.externalMessageId,
                },
                sourceExternalId: insertedMessage.externalMessageId,
                sourceUrl: messageCandidate.provenance.sourceUrl,
                sourceCollectedAt: new Date(
                  messageCandidate.provenance.collectedAt,
                ),
                sourceConfidence: messageCandidate.provenance.confidence,
                sourceProvenance: [messageCandidate.provenance],
              })
              .onConflictDoNothing({ target: touchpoints.idempotencyKey });
          }
        }

        for (const contactId of contactIds) {
          const contactTouchpoints = await transaction
            .select()
            .from(touchpoints)
            .where(eq(touchpoints.contactId, contactId))
            .orderBy(asc(touchpoints.happenedAt));
          const inbound = contactTouchpoints.filter(
            (touchpoint) => touchpoint.direction === "inbound",
          );
          const outbound = contactTouchpoints.filter(
            (touchpoint) => touchpoint.direction === "outbound",
          );
          const lastTouchpoint = contactTouchpoints.at(-1);
          const contactReplyState: ReplyState = contactTouchpoints.some(
            (touchpoint) => touchpoint.kind === "reply",
          )
            ? "replied"
            : lastTouchpoint?.direction === "outbound"
              ? "awaiting_reply"
              : "unknown";
          await transaction
            .update(contacts)
            .set({
              replyState: contactReplyState,
              firstTouchAt: contactTouchpoints[0]?.happenedAt,
              lastTouchAt: lastTouchpoint?.happenedAt,
              lastInboundAt: inbound.at(-1)?.happenedAt,
              lastOutboundAt: outbound.at(-1)?.happenedAt,
              touchCount: contactTouchpoints.length,
              inboundTouchCount: inbound.length,
              outboundTouchCount: outbound.length,
              updatedAt: new Date(),
            })
            .where(eq(contacts.id, contactId));
        }

        const analysisPayload = {
          channel: "x",
          externalConversationId: candidate.externalConversationId,
          participants: candidate.participants.map((participant) => ({
            externalParticipantId: participant.externalParticipantId,
            role: participant.role,
            displayName: participant.displayName,
            handle: participant.identity?.handle,
          })),
          messages: allMessages.map((message) => ({
            id: message.id,
            externalMessageId: message.externalMessageId,
            direction: message.direction,
            sentAt: message.sentAt.toISOString(),
            bodyText: message.bodyText,
          })),
        };
        const inputHash = hashContent(analysisPayload);
        const [analysisJob] = await transaction
          .insert(analysisJobs)
          .values({
            idempotencyKey: createIdempotencyKey(
              "x-analysis",
              conversation.id,
              inputHash,
            ),
            jobType: "classify_outreach",
            status: "queued",
            entityType: "conversation",
            entityId: conversation.id,
            inputHash,
            runner: "codex-cli",
            schemaVersion: 1,
            payload: analysisPayload,
          })
          .onConflictDoNothing({ target: analysisJobs.idempotencyKey })
          .returning();
        if (analysisJob) result.analysisEnqueuedCount += 1;
      }

      return result;
    });
  }
}

async function getXAccount(
  database: ThreadlineDatabase,
  integrationAccountId: string,
) {
  const [account] = await database
    .select()
    .from(integrationAccounts)
    .where(
      and(
        eq(integrationAccounts.id, integrationAccountId),
        eq(integrationAccounts.provider, "x"),
      ),
    )
    .limit(1);
  if (!account) {
    throw new XIntegrationError(
      "X_INVALID_RESPONSE",
      `X integration account ${integrationAccountId} was not found.`,
    );
  }
  return account;
}

function accountIdentity(account: IntegrationAccount): XAccountIdentity {
  const usernameFromMetadata =
    typeof account.metadata.username === "string"
      ? account.metadata.username
      : undefined;
  const username =
    usernameFromMetadata ??
    account.displayName.replace(/^@/, "").trim() ??
    account.externalAccountId;
  return {
    id: account.externalAccountId,
    username,
    ...(typeof account.metadata.name === "string"
      ? { name: account.metadata.name }
      : {}),
  };
}

async function openXCredentials(account: IntegrationAccount) {
  const vault = new EnvironmentCredentialVault();
  return xCredentialsSchema.parse(
    await vault.open<XCredentials>(
      account.credentialCiphertext,
      xCredentialContext(account.externalAccountId),
    ),
  );
}

export async function installXIntegrationAccount(options: {
  database: ThreadlineDatabase;
  account: XAccountIdentity;
  credentials: XCredentials;
  authSource: string;
  now?: Date;
}) {
  const now = options.now ?? new Date();
  const vault = new EnvironmentCredentialVault();
  const ciphertext = await vault.seal(
    options.credentials,
    xCredentialContext(options.account.id),
  );
  const [account] = await options.database
    .insert(integrationAccounts)
    .values({
      provider: "x",
      externalAccountId: options.account.id,
      displayName: `@${options.account.username}`,
      status: "connected",
      syncEnabled: true,
      readOnly: true,
      scopes: ["dm.read"],
      credentialCiphertext: ciphertext,
      credentialKeyVersion:
        getEncryptionEnvironment().INTEGRATION_ENCRYPTION_KEY_VERSION,
      connectedAt: now,
      metadata: {
        username: options.account.username,
        ...(options.account.name ? { name: options.account.name } : {}),
        authSource: options.authSource,
        transport: "bird-compatible",
      },
    })
    .onConflictDoUpdate({
      target: [
        integrationAccounts.provider,
        integrationAccounts.externalAccountId,
      ],
      set: {
        displayName: `@${options.account.username}`,
        status: "connected",
        syncEnabled: true,
        scopes: ["dm.read"],
        credentialCiphertext: ciphertext,
        credentialKeyVersion:
          getEncryptionEnvironment().INTEGRATION_ENCRYPTION_KEY_VERSION,
        connectedAt: now,
        lastErrorAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        metadata: {
          username: options.account.username,
          ...(options.account.name ? { name: options.account.name } : {}),
          authSource: options.authSource,
          transport: "bird-compatible",
        },
        updatedAt: now,
      },
    })
    .returning();
  if (!account)
    throw new Error("X integration account upsert did not return a row.");
  return account;
}

export async function checkDatabaseXIntegrationHealth(options: {
  database: ThreadlineDatabase;
  integrationAccountId: string;
  now?: Date;
  endpoints?: XWebEndpointConfig;
  fetchImpl?: typeof fetch;
}) {
  const account = await getXAccount(
    options.database,
    options.integrationAccountId,
  );
  const credentials = await openXCredentials(account);
  const owner = accountIdentity(account);
  const transport = new BirdWithWebFallbackTransport({
    credentials,
    owner,
    ...(options.endpoints ? { endpoints: options.endpoints } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return new XDirectMessageConnector({ owner, transport }).checkConnection({
    integrationAccountId: account.id,
    now: options.now ?? new Date(),
  });
}

export async function runDatabaseXSync(options: {
  database: ThreadlineDatabase;
  integrationAccountId: string;
  trigger?: SyncTrigger;
  now?: Date;
  limit?: number;
  since?: Date;
  signal?: AbortSignal;
  endpoints?: XWebEndpointConfig;
  fetchImpl?: typeof fetch;
}) {
  const now = options.now ?? new Date();
  const account = await getXAccount(
    options.database,
    options.integrationAccountId,
  );
  if (!account.syncEnabled || account.status === "disabled") {
    throw new XIntegrationError(
      "X_INVALID_RESPONSE",
      "X integration sync is disabled.",
    );
  }
  const credentials = await openXCredentials(account);
  const owner = accountIdentity(account);
  const repositories = createRepositories(options.database);
  const cursorBefore = await repositories.integrations.getCursor(
    account.id,
    X_DM_RESOURCE,
  );
  const run = await repositories.sync.start({
    integrationAccountId: account.id,
    idempotencyKey: createIdempotencyKey(
      "x-sync-run",
      account.id,
      options.trigger ?? "manual",
      now.toISOString(),
    ),
    resource: X_DM_RESOURCE,
    trigger: options.trigger ?? "manual",
    status: "running",
    startedAt: now,
    cursorBeforeCiphertext: cursorBefore?.cursorCiphertext,
    metadata: { connector: "x-dm", readOnly: true },
  });
  const transport = new BirdWithWebFallbackTransport({
    credentials,
    owner,
    ...(options.endpoints ? { endpoints: options.endpoints } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const connector = new XDirectMessageConnector({ owner, transport });
  const store = new DatabaseXSyncStore(options.database);

  try {
    const summary = await syncXDirectMessages({
      connector,
      store,
      integrationAccountId: account.id,
      now,
      ...(options.limit ? { limit: options.limit } : {}),
      ...(options.since ? { since: options.since } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const cursorAfter = await repositories.integrations.getCursor(
      account.id,
      X_DM_RESOURCE,
    );
    await repositories.sync.complete(run.id, {
      status: "succeeded",
      completedAt: new Date(),
      cursorAfterCiphertext: cursorAfter?.cursorCiphertext ?? null,
      discoveredCount: summary.discoveredCount,
      insertedCount: summary.insertedCount,
      updatedCount: summary.updatedCount,
      skippedCount: summary.skippedCount,
      failedCount: 0,
      errorCode: null,
      errorMessage: null,
      metadata: {
        pages: summary.pages,
        analysisEnqueuedCount: summary.analysisEnqueuedCount,
        readOnly: true,
      },
    });
    await options.database
      .update(integrationAccounts)
      .set({
        status: "connected",
        lastSyncedAt: new Date(),
        lastErrorAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(integrationAccounts.id, account.id));
    return { runId: run.id, ...summary };
  } catch (error) {
    const integrationError = toXIntegrationError(error);
    const cursorAfterFailure = await repositories.integrations.getCursor(
      account.id,
      X_DM_RESOURCE,
    );
    const madePartialProgress =
      cursorAfterFailure?.cursorCiphertext !== cursorBefore?.cursorCiphertext;
    await repositories.sync.complete(run.id, {
      status: madePartialProgress ? "partial" : "failed",
      completedAt: new Date(),
      cursorAfterCiphertext: cursorAfterFailure?.cursorCiphertext ?? null,
      discoveredCount: 0,
      insertedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      failedCount: 1,
      errorCode: integrationError.code,
      errorMessage: integrationError.message,
      metadata: {
        retryable: integrationError.retryable,
        readOnly: true,
        madePartialProgress,
      },
    });
    await options.database
      .update(integrationAccounts)
      .set({
        status: "attention_required",
        lastErrorAt: new Date(),
        lastErrorCode: integrationError.code,
        lastErrorMessage: integrationError.message,
        updatedAt: new Date(),
      })
      .where(eq(integrationAccounts.id, account.id));
    throw integrationError;
  }
}
