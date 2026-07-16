import { and, eq, inArray, sql } from "drizzle-orm";

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
} from "@/lib/db/schema";
import type { CredentialVault } from "@/lib/domain/contracts";
import type {
  ConversationCandidate,
  MessageCandidate,
  ParticipantCandidate,
} from "@/lib/domain/schemas";
import { createIdempotencyKey, hashContent } from "@/lib/security/idempotency";
import {
  GMAIL_CURSOR_RESOURCE,
  GMAIL_READ_ONLY_CAPABILITIES,
  GMAIL_SCOPES,
} from "@/src/integrations/gmail/constants";
import type {
  GmailIntegrationAccountRecord,
  GmailPersistResult,
  GmailStoredCredentials,
  GmailSyncCounts,
  GmailSyncCursor,
  GmailSyncRunRecord,
  GmailSyncStore,
} from "@/src/integrations/gmail/types";

export class PostgresGmailStore implements GmailSyncStore {
  private readonly repositories;

  constructor(
    private readonly database: ThreadlineDatabase,
    private readonly vault: CredentialVault,
    private readonly credentialKeyVersion: number,
  ) {
    this.repositories = createRepositories(database);
  }

  async getAccount(): Promise<GmailIntegrationAccountRecord | null> {
    const [account] = await this.database
      .select()
      .from(integrationAccounts)
      .where(eq(integrationAccounts.provider, "gmail"))
      .limit(1);
    return account ? toAccountRecord(account) : null;
  }

  async getAccountByEmail(
    email: string,
  ): Promise<GmailIntegrationAccountRecord | null> {
    const account = await this.repositories.integrations.findByProviderAccount(
      "gmail",
      email.trim().toLowerCase(),
    );
    return account ? toAccountRecord(account) : null;
  }

  async getCredentials(
    account: GmailIntegrationAccountRecord,
  ): Promise<GmailStoredCredentials> {
    return this.vault.open<GmailStoredCredentials>(
      account.credentialCiphertext,
      credentialContext(account.externalAccountId),
    );
  }

  async saveConnectedAccount(input: {
    email: string;
    displayName?: string;
    credentials: GmailStoredCredentials;
    backfillDays: number;
    now: Date;
  }): Promise<GmailIntegrationAccountRecord> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.getAccountByEmail(email);
    const existingCredentials = existing
      ? await this.getCredentials(existing)
      : undefined;
    const credentials = mergeCredentials(
      existingCredentials,
      input.credentials,
    );
    if (!credentials.refreshToken) {
      throw new Error(
        "Google did not issue an offline refresh token. Reconnect with consent.",
      );
    }
    const credentialCiphertext = await this.vault.seal(
      credentials,
      credentialContext(email),
    );
    const account = await this.repositories.integrations.upsert({
      provider: "gmail",
      externalAccountId: email,
      displayName: input.displayName?.trim() || email,
      accountEmail: email,
      status: "connected",
      syncEnabled: true,
      readOnly: true,
      scopes: [...GMAIL_SCOPES],
      credentialCiphertext,
      credentialKeyVersion: this.credentialKeyVersion,
      connectedAt: existing?.connectedAt ?? input.now,
      metadata: {
        ...existing?.metadata,
        backfillDays: input.backfillDays,
        capabilities: GMAIL_READ_ONLY_CAPABILITIES,
      },
    });
    const [updated] = await this.database
      .update(integrationAccounts)
      .set({
        connectedAt: existing?.connectedAt ?? input.now,
        lastErrorAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: input.now,
      })
      .where(eq(integrationAccounts.id, account.id))
      .returning();
    if (!updated)
      throw new Error("Connected Gmail account could not be updated.");
    return toAccountRecord(updated);
  }

  async updateCredentials(
    account: GmailIntegrationAccountRecord,
    credentials: GmailStoredCredentials,
  ): Promise<void> {
    const existing = await this.getCredentials(account);
    const merged = mergeCredentials(existing, credentials);
    const credentialCiphertext = await this.vault.seal(
      merged,
      credentialContext(account.externalAccountId),
    );
    await this.database
      .update(integrationAccounts)
      .set({
        credentialCiphertext,
        credentialKeyVersion: this.credentialKeyVersion,
        updatedAt: new Date(),
      })
      .where(eq(integrationAccounts.id, account.id));
  }

  async disableAccount(
    account: GmailIntegrationAccountRecord,
    now: Date,
  ): Promise<void> {
    const credentialCiphertext = await this.vault.seal(
      { revokedAt: now.toISOString(), scopes: [...GMAIL_SCOPES] },
      credentialContext(account.externalAccountId),
    );
    await this.database
      .update(integrationAccounts)
      .set({
        status: "disabled",
        syncEnabled: false,
        credentialCiphertext,
        credentialKeyVersion: this.credentialKeyVersion,
        updatedAt: now,
      })
      .where(eq(integrationAccounts.id, account.id));
  }

  async getCursor(
    account: GmailIntegrationAccountRecord,
  ): Promise<GmailSyncCursor | null> {
    const row = await this.repositories.integrations.getCursor(
      account.id,
      GMAIL_CURSOR_RESOURCE,
    );
    if (!row) return null;
    return this.vault.open<GmailSyncCursor>(
      row.cursorCiphertext,
      cursorContext(account.id),
    );
  }

  async startSyncRun(input: {
    account: GmailIntegrationAccountRecord;
    idempotencyKey: string;
    trigger: "manual" | "scheduled" | "webhook" | "backfill";
    cursorBefore: GmailSyncCursor | null;
    now: Date;
  }): Promise<GmailSyncRunRecord> {
    const cursorBeforeCiphertext = input.cursorBefore
      ? await this.vault.seal(
          input.cursorBefore,
          runCursorContext(input.idempotencyKey, "before"),
        )
      : undefined;
    const run = await this.repositories.sync.start({
      integrationAccountId: input.account.id,
      idempotencyKey: input.idempotencyKey,
      resource: GMAIL_CURSOR_RESOURCE,
      trigger: input.trigger,
      startedAt: input.now,
      ...(cursorBeforeCiphertext ? { cursorBeforeCiphertext } : {}),
      metadata: {},
    });
    return { id: run.id, status: run.status };
  }

  async persistConversation(
    account: GmailIntegrationAccountRecord,
    candidate: ConversationCandidate,
    now: Date,
  ): Promise<GmailPersistResult> {
    return this.database.transaction(async (transaction) => {
      const [existingConversation] = await transaction
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.integrationAccountId, account.id),
            eq(
              conversations.externalConversationId,
              candidate.externalConversationId,
            ),
          ),
        )
        .limit(1);
      const inputHash =
        metadataString(candidate.metadata, "gmailInputHash") ??
        hashContent(candidate);
      if (
        metadataString(existingConversation?.metadata, "gmailInputHash") ===
        inputHash
      ) {
        return {
          conversationId: existingConversation!.id,
          changed: false,
          insertedMessages: 0,
          updatedMessages: 0,
          analysisEnqueued: false,
        };
      }

      const sentDates = candidate.messages.map(
        (message) => new Date(message.sentAt),
      );
      const firstMessageAt = minimumDate(sentDates);
      const lastMessageAt = maximumDate(sentDates);
      const inboundDates = candidate.messages
        .filter((message) => message.direction === "inbound")
        .map((message) => new Date(message.sentAt));
      const outboundDates = candidate.messages
        .filter((message) => message.direction === "outbound")
        .map((message) => new Date(message.sentAt));
      const detectedReplyState = deterministicReplyState(candidate.messages);
      const replyState =
        existingConversation &&
        hasFieldOverride(existingConversation.manualOverrides, "replyState")
          ? existingConversation.replyState
          : detectedReplyState;
      const mergedMetadata = {
        ...existingConversation?.metadata,
        ...candidate.metadata,
        gmailInputHash: inputHash,
      };
      const [conversation] = await transaction
        .insert(conversations)
        .values({
          integrationAccountId: account.id,
          channel: "gmail",
          externalConversationId: candidate.externalConversationId,
          idempotencyKey: candidate.idempotencyKey,
          subject: candidate.subject,
          preview: candidate.preview,
          firstMessageAt,
          lastMessageAt,
          lastInboundAt: maximumDate(inboundDates),
          lastOutboundAt: maximumDate(outboundDates),
          touchCount: candidate.messages.length,
          replyState,
          metadata: mergedMetadata,
          sourceExternalId: candidate.provenance.externalId,
          sourceCollectedAt: new Date(candidate.provenance.collectedAt),
          sourceConfidence: candidate.provenance.confidence,
          sourceProvenance: [candidate.provenance],
        })
        .onConflictDoUpdate({
          target: [
            conversations.integrationAccountId,
            conversations.externalConversationId,
          ],
          set: {
            subject: candidate.subject,
            preview: candidate.preview,
            firstMessageAt,
            lastMessageAt,
            lastInboundAt: maximumDate(inboundDates),
            lastOutboundAt: maximumDate(outboundDates),
            touchCount: candidate.messages.length,
            replyState,
            metadata: mergedMetadata,
            sourceCollectedAt: new Date(candidate.provenance.collectedAt),
            sourceProvenance: [candidate.provenance],
            updatedAt: now,
          },
        })
        .returning();
      if (!conversation)
        throw new Error("Gmail conversation upsert did not return a row.");

      const participantRecords = new Map<
        string,
        { identityId: string; contactId: string | null }
      >();
      for (const participant of candidate.participants) {
        const record = await upsertParticipant(
          transaction,
          account,
          participant,
          now,
        );
        participantRecords.set(participant.externalParticipantId, record);
        await transaction
          .insert(conversationParticipants)
          .values({
            conversationId: conversation.id,
            channelIdentityId: record.identityId,
            contactId: record.contactId,
            externalParticipantId: participant.externalParticipantId,
            role: participant.role,
            displayName: participant.displayName,
            address: participant.address,
            metadata: {},
          })
          .onConflictDoUpdate({
            target: [
              conversationParticipants.conversationId,
              conversationParticipants.externalParticipantId,
            ],
            set: {
              channelIdentityId: record.identityId,
              contactId: record.contactId,
              role: participant.role,
              displayName: participant.displayName,
              address: participant.address,
              updatedAt: now,
            },
          });
      }

      const externalMessageIds = candidate.messages.map(
        (message) => message.externalMessageId,
      );
      const existingMessages = externalMessageIds.length
        ? await transaction
            .select({ externalMessageId: messages.externalMessageId })
            .from(messages)
            .where(
              and(
                eq(messages.integrationAccountId, account.id),
                inArray(messages.externalMessageId, externalMessageIds),
              ),
            )
        : [];
      const existingMessageIds = new Set(
        existingMessages.map((message) => message.externalMessageId),
      );
      const messageRows = new Map<string, { id: string }>();
      for (const message of candidate.messages) {
        const reply = replyForMessage(message, candidate.messages);
        const senderIdentityId = message.senderExternalParticipantId
          ? participantRecords.get(message.senderExternalParticipantId)
              ?.identityId
          : undefined;
        const [row] = await transaction
          .insert(messages)
          .values({
            conversationId: conversation.id,
            integrationAccountId: account.id,
            senderIdentityId,
            channel: "gmail",
            externalMessageId: message.externalMessageId,
            idempotencyKey: message.idempotencyKey,
            direction: message.direction,
            sentAt: new Date(message.sentAt),
            receivedAt: message.receivedAt
              ? new Date(message.receivedAt)
              : null,
            subject: message.subject,
            bodyText: message.bodyText,
            bodyHtml: message.bodyHtml,
            snippet: message.snippet,
            contentHash: hashContent({
              bodyText: message.bodyText,
              bodyHtml: message.bodyHtml,
              metadata: message.metadata,
            }),
            hasReply: Boolean(reply),
            replyReceivedAt: reply ? new Date(reply.sentAt) : null,
            metadata: message.metadata,
            sourceExternalId: message.provenance.externalId,
            sourceCollectedAt: new Date(message.provenance.collectedAt),
            sourceConfidence: message.provenance.confidence,
            sourceProvenance: [message.provenance],
          })
          .onConflictDoUpdate({
            target: [messages.integrationAccountId, messages.externalMessageId],
            set: {
              conversationId: conversation.id,
              senderIdentityId,
              direction: message.direction,
              sentAt: new Date(message.sentAt),
              receivedAt: message.receivedAt
                ? new Date(message.receivedAt)
                : null,
              subject: message.subject,
              bodyText: message.bodyText,
              bodyHtml: message.bodyHtml,
              snippet: message.snippet,
              contentHash: hashContent({
                bodyText: message.bodyText,
                bodyHtml: message.bodyHtml,
                metadata: message.metadata,
              }),
              hasReply: Boolean(reply),
              replyReceivedAt: reply ? new Date(reply.sentAt) : null,
              metadata: message.metadata,
              sourceCollectedAt: new Date(message.provenance.collectedAt),
              sourceProvenance: [message.provenance],
              updatedAt: now,
            },
          })
          .returning({ id: messages.id });
        if (!row) throw new Error("Gmail message upsert did not return a row.");
        messageRows.set(message.externalMessageId, row);
      }

      for (const message of candidate.messages) {
        if (!message.replyToExternalMessageId) continue;
        const row = messageRows.get(message.externalMessageId);
        const replyTo = messageRows.get(message.replyToExternalMessageId);
        if (row && replyTo) {
          await transaction
            .update(messages)
            .set({ replyToMessageId: replyTo.id })
            .where(eq(messages.id, row.id));
        }
      }

      const contactIds = new Set<string>();
      for (const message of candidate.messages) {
        const messageRow = messageRows.get(message.externalMessageId);
        if (!messageRow) continue;
        const targetParticipants = touchpointParticipants(
          message,
          candidate.participants,
        );
        for (const participant of targetParticipants) {
          const contactId = participantRecords.get(
            participant.externalParticipantId,
          )?.contactId;
          if (!contactId) continue;
          contactIds.add(contactId);
          const messageReply = replyForMessage(message, candidate.messages);
          await transaction
            .insert(touchpoints)
            .values({
              contactId,
              conversationId: conversation.id,
              messageId: messageRow.id,
              integrationAccountId: account.id,
              idempotencyKey: createIdempotencyKey(
                "gmail-touchpoint",
                account.id,
                participant.externalParticipantId,
                message.externalMessageId,
              ),
              channel: "gmail",
              direction: message.direction,
              kind:
                message.direction === "inbound" &&
                hasEarlierOutbound(message, candidate.messages)
                  ? "reply"
                  : "message",
              replyState:
                message.direction === "outbound"
                  ? messageReply
                    ? "replied"
                    : "awaiting_reply"
                  : "replied",
              happenedAt: new Date(message.sentAt),
              isAutomated: true,
              summary: (message.bodyText ?? message.snippet)?.slice(0, 500),
              metadata: {},
              sourceExternalId: message.externalMessageId,
              sourceCollectedAt: new Date(message.provenance.collectedAt),
              sourceConfidence: message.provenance.confidence,
              sourceProvenance: [message.provenance],
            })
            .onConflictDoNothing({ target: touchpoints.idempotencyKey });
        }
      }

      for (const contactId of contactIds)
        await refreshContactAggregates(transaction, contactId, now);

      const analysisIdempotencyKey = createIdempotencyKey(
        "gmail-analysis",
        account.id,
        conversation.externalConversationId,
        inputHash,
      );
      const [analysisJob] = await transaction
        .insert(analysisJobs)
        .values({
          idempotencyKey: analysisIdempotencyKey,
          jobType: "classify_outreach",
          status: "queued",
          entityType: "conversation",
          entityId: conversation.id,
          inputHash,
          runner: "codex-cli",
          schemaVersion: 1,
          payload: {
            source: "gmail",
            integrationAccountId: account.id,
            externalConversationId: candidate.externalConversationId,
            subject: candidate.subject ?? null,
            participants: candidate.participants,
            messages: candidate.messages,
            deterministicReplyState: detectedReplyState,
          },
          scheduledAt: now,
        })
        .onConflictDoNothing({ target: analysisJobs.idempotencyKey })
        .returning({ id: analysisJobs.id });

      return {
        conversationId: conversation.id,
        changed: true,
        insertedMessages: candidate.messages.filter(
          (message) => !existingMessageIds.has(message.externalMessageId),
        ).length,
        updatedMessages: candidate.messages.filter((message) =>
          existingMessageIds.has(message.externalMessageId),
        ).length,
        analysisEnqueued: Boolean(analysisJob),
      };
    });
  }

  async saveCursor(
    account: GmailIntegrationAccountRecord,
    cursor: GmailSyncCursor,
  ): Promise<void> {
    const existing = await this.getCursor(account);
    if (existing && compareHistoryIds(existing.historyId, cursor.historyId) > 0)
      return;
    const cursorCiphertext = await this.vault.seal(
      cursor,
      cursorContext(account.id),
    );
    await this.repositories.integrations.upsertCursor({
      integrationAccountId: account.id,
      resource: GMAIL_CURSOR_RESOURCE,
      cursorCiphertext,
      cursorKeyVersion: this.credentialKeyVersion,
      lastSeenExternalId: cursor.historyId,
      lastSeenAt: new Date(cursor.updatedAt),
    });
  }

  async completeSyncRun(input: {
    runId: string;
    status: "succeeded" | "partial" | "failed";
    cursorAfter: GmailSyncCursor | null;
    counts: GmailSyncCounts;
    completedAt: Date;
    errorCode?: string;
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const cursorAfterCiphertext = input.cursorAfter
      ? await this.vault.seal(
          input.cursorAfter,
          runCursorContext(input.runId, "after"),
        )
      : null;
    await this.repositories.sync.complete(input.runId, {
      status: input.status,
      completedAt: input.completedAt,
      cursorAfterCiphertext,
      discoveredCount: input.counts.discoveredCount,
      insertedCount: input.counts.insertedCount,
      updatedCount: input.counts.updatedCount,
      skippedCount: input.counts.skippedCount,
      failedCount: input.counts.failedCount,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      metadata: {
        ...input.metadata,
        analysisEnqueuedCount: input.counts.analysisEnqueuedCount,
      },
    });
  }

  async markConnected(accountId: string, syncedAt: Date): Promise<void> {
    await this.database
      .update(integrationAccounts)
      .set({
        status: "connected",
        lastSyncedAt: syncedAt,
        lastErrorAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        updatedAt: syncedAt,
      })
      .where(eq(integrationAccounts.id, accountId));
  }

  async markAttentionRequired(
    accountId: string,
    code: string,
    message: string,
    at: Date,
  ): Promise<void> {
    await this.database
      .update(integrationAccounts)
      .set({
        status: "attention_required",
        lastErrorAt: at,
        lastErrorCode: code,
        lastErrorMessage: message.slice(0, 500),
        updatedAt: at,
      })
      .where(eq(integrationAccounts.id, accountId));
  }
}

async function upsertParticipant(
  transaction: Parameters<Parameters<ThreadlineDatabase["transaction"]>[0]>[0],
  account: GmailIntegrationAccountRecord,
  participant: ParticipantCandidate,
  now: Date,
): Promise<{ identityId: string; contactId: string | null }> {
  const identity = participant.identity;
  if (!identity)
    throw new Error("Gmail participant is missing its channel identity.");
  const [identityRow] = await transaction
    .insert(channelIdentities)
    .values({
      integrationAccountId: account.id,
      channel: "gmail",
      externalId: identity.externalId,
      handle: identity.handle,
      address: identity.address,
      displayName: identity.displayName,
      profileUrl: identity.profileUrl,
      isOwner: identity.isOwner,
      confidence: identity.provenance.confidence,
      metadata: identity.metadata,
      sourceExternalId: identity.provenance.externalId,
      sourceCollectedAt: new Date(identity.provenance.collectedAt),
      sourceConfidence: identity.provenance.confidence,
      sourceProvenance: [identity.provenance],
    })
    .onConflictDoUpdate({
      target: [
        channelIdentities.integrationAccountId,
        channelIdentities.channel,
        channelIdentities.externalId,
      ],
      set: {
        address: identity.address,
        displayName: identity.displayName,
        isOwner: identity.isOwner,
        metadata: identity.metadata,
        sourceCollectedAt: new Date(identity.provenance.collectedAt),
        sourceProvenance: [identity.provenance],
        updatedAt: now,
      },
    })
    .returning();
  if (!identityRow)
    throw new Error("Gmail identity upsert did not return a row.");
  if (participant.role === "owner")
    return { identityId: identityRow.id, contactId: null };
  if (identityRow.contactId)
    return { identityId: identityRow.id, contactId: identityRow.contactId };

  const address = participant.address ?? participant.externalParticipantId;
  const [contact] = await transaction
    .insert(contacts)
    .values({
      displayName: participant.displayName ?? address,
      primaryEmail: address,
      relationshipStage: "unreviewed",
      replyState: "unknown",
      confidence: 1,
      metadata: {},
      sourceExternalId: address,
      sourceCollectedAt: now,
      sourceConfidence: 1,
      sourceProvenance: [identity.provenance],
    })
    .returning();
  if (!contact) throw new Error("Gmail contact insert did not return a row.");
  await transaction
    .update(channelIdentities)
    .set({ contactId: contact.id, updatedAt: now })
    .where(eq(channelIdentities.id, identityRow.id));
  return { identityId: identityRow.id, contactId: contact.id };
}

async function refreshContactAggregates(
  transaction: Parameters<Parameters<ThreadlineDatabase["transaction"]>[0]>[0],
  contactId: string,
  now: Date,
): Promise<void> {
  const [aggregate] = await transaction
    .select({
      touchCount: sql<number>`count(*)::int`,
      inboundTouchCount: sql<number>`count(*) filter (where ${touchpoints.direction} = 'inbound')::int`,
      outboundTouchCount: sql<number>`count(*) filter (where ${touchpoints.direction} = 'outbound')::int`,
      firstTouchAt: sql<Date | null>`min(${touchpoints.happenedAt})`,
      lastTouchAt: sql<Date | null>`max(${touchpoints.happenedAt})`,
      lastInboundAt: sql<Date | null>`max(${touchpoints.happenedAt}) filter (where ${touchpoints.direction} = 'inbound')`,
      lastOutboundAt: sql<Date | null>`max(${touchpoints.happenedAt}) filter (where ${touchpoints.direction} = 'outbound')`,
    })
    .from(touchpoints)
    .where(eq(touchpoints.contactId, contactId));
  if (!aggregate) return;
  const detectedReplyState = aggregate.lastOutboundAt
    ? aggregate.lastInboundAt &&
      aggregate.lastInboundAt > aggregate.lastOutboundAt
      ? "replied"
      : "awaiting_reply"
    : "not_applicable";
  const [contact] = await transaction
    .select({ manualOverrides: contacts.manualOverrides })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  const replyStateOverridden = hasFieldOverride(
    contact?.manualOverrides ?? [],
    "replyState",
  );
  const relationshipStageOverridden = hasFieldOverride(
    contact?.manualOverrides ?? [],
    "relationshipStage",
  );
  await transaction
    .update(contacts)
    .set({
      firstTouchAt: aggregate.firstTouchAt,
      lastTouchAt: aggregate.lastTouchAt,
      lastInboundAt: aggregate.lastInboundAt,
      lastOutboundAt: aggregate.lastOutboundAt,
      touchCount: aggregate.touchCount,
      inboundTouchCount: aggregate.inboundTouchCount,
      outboundTouchCount: aggregate.outboundTouchCount,
      ...(!replyStateOverridden ? { replyState: detectedReplyState } : {}),
      ...(!relationshipStageOverridden
        ? {
            relationshipStage:
              detectedReplyState === "replied"
                ? ("replied" as const)
                : detectedReplyState === "awaiting_reply"
                  ? ("waiting" as const)
                  : ("active" as const),
          }
        : {}),
      updatedAt: now,
    })
    .where(eq(contacts.id, contactId));
}

function touchpointParticipants(
  message: MessageCandidate,
  participants: ParticipantCandidate[],
): ParticipantCandidate[] {
  const ownerAddresses = new Set(
    participants
      .filter((participant) => participant.role === "owner")
      .map((participant) => participant.externalParticipantId),
  );
  const senderAddress = metadataString(message.metadata, "senderAddress");
  const recipients = metadataStringArray(
    message.metadata,
    "recipientAddresses",
  );
  const targetAddresses =
    message.direction === "inbound"
      ? senderAddress
        ? [senderAddress]
        : []
      : recipients;
  const matches = participants.filter(
    (participant) =>
      participant.role !== "owner" &&
      targetAddresses.includes(participant.externalParticipantId),
  );
  if (matches.length > 0) return matches;
  return participants.filter(
    (participant) =>
      participant.role !== "owner" &&
      !ownerAddresses.has(participant.externalParticipantId),
  );
}

function replyForMessage(
  message: MessageCandidate,
  messagesInThread: MessageCandidate[],
): MessageCandidate | undefined {
  if (message.direction !== "outbound") return undefined;
  const sentAt = Date.parse(message.sentAt);
  return messagesInThread
    .filter(
      (candidate) =>
        candidate.direction === "inbound" &&
        Date.parse(candidate.sentAt) > sentAt,
    )
    .sort(
      (left, right) => Date.parse(left.sentAt) - Date.parse(right.sentAt),
    )[0];
}

function hasEarlierOutbound(
  message: MessageCandidate,
  messagesInThread: MessageCandidate[],
): boolean {
  const sentAt = Date.parse(message.sentAt);
  return messagesInThread.some(
    (candidate) =>
      candidate.direction === "outbound" &&
      Date.parse(candidate.sentAt) < sentAt,
  );
}

function deterministicReplyState(
  messagesInThread: MessageCandidate[],
): "awaiting_reply" | "replied" | "not_applicable" | "unknown" {
  const outbound = messagesInThread.filter(
    (message) => message.direction === "outbound",
  );
  if (outbound.length === 0)
    return messagesInThread.some((message) => message.direction === "inbound")
      ? "not_applicable"
      : "unknown";
  const latestOutbound = Math.max(
    ...outbound.map((message) => Date.parse(message.sentAt)),
  );
  return messagesInThread.some(
    (message) =>
      message.direction === "inbound" &&
      Date.parse(message.sentAt) > latestOutbound,
  )
    ? "replied"
    : "awaiting_reply";
}

function minimumDate(values: Date[]): Date | null {
  return values.length > 0
    ? new Date(Math.min(...values.map((value) => value.getTime())))
    : null;
}

function maximumDate(values: Date[]): Date | null {
  return values.length > 0
    ? new Date(Math.max(...values.map((value) => value.getTime())))
    : null;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function metadataStringArray(
  metadata: Record<string, unknown>,
  key: string,
): string[] {
  const value = metadata[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function credentialContext(externalAccountId: string): string {
  return `integration:gmail:${externalAccountId}`;
}

function cursorContext(accountId: string): string {
  return `integration:gmail:${accountId}:cursor:${GMAIL_CURSOR_RESOURCE}`;
}

function runCursorContext(runId: string, position: "before" | "after"): string {
  return `integration:gmail:sync-run:${runId}:${position}`;
}

function mergeCredentials(
  existing: GmailStoredCredentials | undefined,
  incoming: GmailStoredCredentials,
): GmailStoredCredentials {
  return {
    ...(incoming.accessToken
      ? { accessToken: incoming.accessToken }
      : existing?.accessToken
        ? { accessToken: existing.accessToken }
        : {}),
    ...(incoming.refreshToken
      ? { refreshToken: incoming.refreshToken }
      : existing?.refreshToken
        ? { refreshToken: existing.refreshToken }
        : {}),
    ...(incoming.expiryDate
      ? { expiryDate: incoming.expiryDate }
      : existing?.expiryDate
        ? { expiryDate: existing.expiryDate }
        : {}),
    ...(incoming.tokenType
      ? { tokenType: incoming.tokenType }
      : existing?.tokenType
        ? { tokenType: existing.tokenType }
        : {}),
    scopes:
      incoming.scopes.length > 0
        ? incoming.scopes
        : (existing?.scopes ?? [...GMAIL_SCOPES]),
  };
}

function toAccountRecord(
  account: typeof integrationAccounts.$inferSelect,
): GmailIntegrationAccountRecord {
  if (!account.accountEmail)
    throw new Error("Gmail integration account is missing its email address.");
  return {
    id: account.id,
    externalAccountId: account.externalAccountId,
    displayName: account.displayName,
    accountEmail: account.accountEmail,
    status: account.status,
    syncEnabled: account.syncEnabled,
    scopes: account.scopes,
    credentialCiphertext: account.credentialCiphertext,
    credentialKeyVersion: account.credentialKeyVersion,
    connectedAt: account.connectedAt,
    lastSyncedAt: account.lastSyncedAt,
    lastErrorAt: account.lastErrorAt,
    lastErrorCode: account.lastErrorCode,
    lastErrorMessage: account.lastErrorMessage,
    metadata: account.metadata,
  };
}

function compareHistoryIds(left: string, right: string): number {
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
  } catch {
    return left.localeCompare(right);
  }
}

function hasFieldOverride(
  overrides: ReadonlyArray<{ field: string }>,
  field: string,
): boolean {
  return overrides.some((override) => override.field === field);
}
