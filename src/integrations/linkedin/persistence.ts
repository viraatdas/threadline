import { and, eq } from "drizzle-orm";

import type { ThreadlineDatabase } from "@/lib/db/client";
import {
  analysisJobs,
  channelIdentities,
  companies,
  contacts,
  conversationParticipants,
  conversations,
  integrationAccounts,
  messages,
  touchpoints,
} from "@/lib/db/schema";
import type {
  ContactCandidate,
  ConversationCandidate,
  MessageCandidate,
  ParticipantCandidate,
  SourceProvenance,
  SyncPage,
} from "@/lib/domain/schemas";
import { createIdempotencyKey, hashContent } from "@/lib/security/idempotency";

import type {
  LinkedinIngestionSink,
  LinkedinIngestionStats,
} from "@/src/integrations/linkedin/sync";

type PageStats = Omit<LinkedinIngestionStats, "cursor">;

export class DatabaseLinkedinIngestionSink implements LinkedinIngestionSink {
  constructor(private readonly database: ThreadlineDatabase) {}

  async ingest(page: SyncPage): Promise<PageStats> {
    const stats: PageStats = {
      discovered: page.conversations.reduce(
        (count, conversation) => count + conversation.messages.length,
        0,
      ),
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      analysisJobsEnqueued: 0,
    };

    const contactsByExternalId = new Map<string, ContactCandidate>();
    for (const contact of page.contacts) contactsByExternalId.set(contact.provenance.externalId, contact);

    for (const conversation of page.conversations) {
      try {
        const result = await this.persistConversation(conversation, contactsByExternalId);
        stats.inserted += result.inserted;
        stats.updated += result.updated;
        stats.skipped += result.skipped;
        stats.analysisJobsEnqueued += result.analysisJobsEnqueued;
      } catch {
        stats.failed += 1;
      }
    }

    await this.database
      .update(integrationAccounts)
      .set({
        status: stats.failed > 0 ? "attention_required" : "connected",
        lastSyncedAt: new Date(page.collectedAt),
        lastErrorAt: stats.failed > 0 ? new Date() : null,
        lastErrorCode: stats.failed > 0 ? "linkedin_ingestion_partial" : null,
        lastErrorMessage: stats.failed > 0 ? "One or more LinkedIn conversations failed ingestion." : null,
        updatedAt: new Date(),
      })
      .where(eq(integrationAccounts.id, page.integrationAccountId));

    return stats;
  }

  private async persistConversation(
    candidate: ConversationCandidate,
    contactsByExternalId: ReadonlyMap<string, ContactCandidate>,
  ) {
    const timestamps = conversationTimestamps(candidate.messages);
    const replyState = String(candidate.metadata.replyState ?? "unknown") as
      | "unknown"
      | "awaiting_reply"
      | "replied"
      | "not_applicable";
    const existing = await this.findConversation(
      candidate.integrationAccountId,
      candidate.externalConversationId,
    );
    const [conversation] = await this.database
      .insert(conversations)
      .values({
        integrationAccountId: candidate.integrationAccountId,
        channel: "linkedin",
        externalConversationId: candidate.externalConversationId,
        idempotencyKey: candidate.idempotencyKey,
        subject: candidate.subject,
        preview: candidate.preview,
        firstMessageAt: timestamps.firstMessageAt,
        lastMessageAt: timestamps.lastMessageAt,
        lastInboundAt: timestamps.lastInboundAt,
        lastOutboundAt: timestamps.lastOutboundAt,
        touchCount: candidate.messages.length,
        replyState,
        metadata: candidate.metadata,
        ...source(candidate.provenance),
      })
      .onConflictDoUpdate({
        target: [conversations.integrationAccountId, conversations.externalConversationId],
        set: {
          subject: candidate.subject,
          preview: candidate.preview,
          firstMessageAt: timestamps.firstMessageAt,
          lastMessageAt: timestamps.lastMessageAt,
          lastInboundAt: timestamps.lastInboundAt,
          lastOutboundAt: timestamps.lastOutboundAt,
          touchCount: candidate.messages.length,
          replyState,
          metadata: candidate.metadata,
          ...source(candidate.provenance),
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!conversation) throw new Error("LinkedIn conversation upsert returned no row.");

    const participantRecords = new Map<string, Awaited<ReturnType<typeof this.persistParticipant>>>();
    for (const participant of candidate.participants) {
      participantRecords.set(
        participant.externalParticipantId,
        await this.persistParticipant(
          candidate.integrationAccountId,
          conversation.id,
          participant,
          contactsByExternalId.get(participant.externalParticipantId),
          timestamps,
          replyState,
        ),
      );
    }
    const relationshipContact = [...participantRecords.values()].find((record) => record.contactId);

    let inserted = 0;
    let skipped = 0;
    for (const message of candidate.messages) {
      const sender = message.senderExternalParticipantId
        ? participantRecords.get(message.senderExternalParticipantId)
        : undefined;
      const hasReply =
        message.direction === "outbound" &&
        candidate.messages.some(
          (other) => other.direction === "inbound" && other.sentAt > message.sentAt,
        );
      const replyReceivedAt = hasReply
        ? new Date(
            candidate.messages.find(
              (other) => other.direction === "inbound" && other.sentAt > message.sentAt,
            )!.sentAt,
          )
        : undefined;
      const [storedMessage] = await this.database
        .insert(messages)
        .values({
          conversationId: conversation.id,
          integrationAccountId: candidate.integrationAccountId,
          senderIdentityId: sender?.identityId,
          channel: "linkedin",
          externalMessageId: message.externalMessageId,
          idempotencyKey: message.idempotencyKey,
          direction: message.direction,
          sentAt: new Date(message.sentAt),
          receivedAt: message.receivedAt ? new Date(message.receivedAt) : undefined,
          subject: message.subject,
          bodyText: message.bodyText,
          bodyHtml: message.bodyHtml,
          snippet: message.snippet,
          contentHash: hashContent({ bodyText: message.bodyText, sentAt: message.sentAt }),
          hasReply,
          replyReceivedAt,
          metadata: message.metadata,
          ...source(message.provenance),
        })
        .onConflictDoNothing({ target: messages.idempotencyKey })
        .returning();

      if (!storedMessage) {
        skipped += 1;
        continue;
      }

      inserted += 1;
      if (relationshipContact?.contactId) {
        await this.database
          .insert(touchpoints)
          .values({
            contactId: relationshipContact.contactId,
            companyId: relationshipContact.companyId,
            conversationId: conversation.id,
            messageId: storedMessage.id,
            integrationAccountId: candidate.integrationAccountId,
            idempotencyKey: createIdempotencyKey("linkedin-touchpoint", storedMessage.id),
            channel: "linkedin",
            direction: message.direction,
            kind: message.direction === "inbound" ? "reply" : "message",
            replyState,
            happenedAt: new Date(message.sentAt),
            isAutomated: true,
            summary: message.snippet,
            metadata: { externalMessageId: message.externalMessageId },
            ...source(message.provenance),
          })
          .onConflictDoNothing({ target: touchpoints.idempotencyKey });
      }
    }

    const analysisJobsEnqueued = await this.enqueueAnalysisJobs(conversation.id, candidate);
    return {
      inserted,
      skipped,
      updated: existing ? 1 : 0,
      analysisJobsEnqueued,
    };
  }

  private async persistParticipant(
    integrationAccountId: string,
    conversationId: string,
    participant: ParticipantCandidate,
    candidate: ContactCandidate | undefined,
    timestamps: ReturnType<typeof conversationTimestamps>,
    replyState: "unknown" | "awaiting_reply" | "replied" | "not_applicable",
  ) {
    const companyId = candidate?.company ? await this.persistCompany(candidate) : undefined;
    const contactId =
      participant.role === "contact"
        ? await this.persistContact(
            integrationAccountId,
            participant,
            candidate,
            companyId,
            timestamps,
            replyState,
          )
        : undefined;
    const identityId = participant.identity
      ? await this.persistIdentity(integrationAccountId, participant, contactId)
      : undefined;

    await this.database
      .insert(conversationParticipants)
      .values({
        conversationId,
        channelIdentityId: identityId,
        contactId,
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
          channelIdentityId: identityId,
          contactId,
          role: participant.role,
          displayName: participant.displayName,
          address: participant.address,
          updatedAt: new Date(),
        },
      });

    return { contactId, identityId, companyId };
  }

  private async persistCompany(candidate: ContactCandidate) {
    const linkedinUrl = String(candidate.metadata.company && typeof candidate.metadata.company === "object"
      ? (candidate.metadata.company as { publicUrl?: unknown }).publicUrl ?? ""
      : candidate.company?.externalId ?? "");
    const existing = linkedinUrl
      ? (
          await this.database
            .select()
            .from(companies)
            .where(eq(companies.linkedinUrl, linkedinUrl))
            .limit(1)
        )[0]
      : undefined;
    const companyMetadata =
      candidate.metadata.company && typeof candidate.metadata.company === "object"
        ? (candidate.metadata.company as Record<string, unknown>)
        : {};
    const values = {
      name: candidate.company!.name,
      normalizedName: candidate.company!.name.trim().toLowerCase(),
      domain: candidate.company!.domain,
      websiteUrl: stringValue(companyMetadata.website),
      linkedinUrl: linkedinUrl || undefined,
      industry: stringValue(companyMetadata.industry),
      location:
        stringValue(companyMetadata.headquarters) ?? stringValue(companyMetadata.location),
      description: stringValue(companyMetadata.description),
      confidence: candidate.confidence,
      metadata: companyMetadata,
      ...source(candidate.provenance),
    };

    if (existing) {
      await this.database.update(companies).set({ ...values, updatedAt: new Date() }).where(eq(companies.id, existing.id));
      return existing.id;
    }
    const [company] = await this.database.insert(companies).values(values).returning();
    return company?.id;
  }

  private async persistContact(
    integrationAccountId: string,
    participant: ParticipantCandidate,
    candidate: ContactCandidate | undefined,
    companyId: string | undefined,
    timestamps: ReturnType<typeof conversationTimestamps>,
    replyState: "unknown" | "awaiting_reply" | "replied" | "not_applicable",
  ) {
    const [identity] = await this.database
      .select()
      .from(channelIdentities)
      .where(
        and(
          eq(channelIdentities.channel, "linkedin"),
          eq(channelIdentities.integrationAccountId, integrationAccountId),
          eq(channelIdentities.externalId, participant.externalParticipantId),
        ),
      )
      .limit(1);
    const values = {
      companyId,
      displayName: candidate?.displayName ?? participant.displayName ?? "LinkedIn contact",
      givenName: candidate?.givenName,
      familyName: candidate?.familyName,
      title: candidate?.title,
      seniority: candidate?.seniority,
      location: candidate?.location,
      relationshipStage: replyState === "replied" ? ("replied" as const) : ("active" as const),
      replyState,
      firstTouchAt: timestamps.firstMessageAt,
      lastTouchAt: timestamps.lastMessageAt,
      lastInboundAt: timestamps.lastInboundAt,
      lastOutboundAt: timestamps.lastOutboundAt,
      touchCount: timestamps.touchCount,
      inboundTouchCount: timestamps.inboundTouchCount,
      outboundTouchCount: timestamps.outboundTouchCount,
      confidence: candidate?.confidence ?? 0.6,
      metadata: candidate?.metadata ?? {},
      ...(candidate ? source(candidate.provenance) : {}),
    };

    if (identity?.contactId) {
      await this.database.update(contacts).set({ ...values, updatedAt: new Date() }).where(eq(contacts.id, identity.contactId));
      return identity.contactId;
    }
    const [contact] = await this.database.insert(contacts).values(values).returning();
    if (!contact) throw new Error("LinkedIn contact insert returned no row.");
    return contact.id;
  }

  private async persistIdentity(
    integrationAccountId: string,
    participant: ParticipantCandidate,
    contactId: string | undefined,
  ) {
    const identity = participant.identity!;
    const [stored] = await this.database
      .insert(channelIdentities)
      .values({
        contactId,
        integrationAccountId,
        channel: "linkedin",
        externalId: identity.externalId,
        handle: identity.handle,
        address: identity.address,
        displayName: identity.displayName,
        profileUrl: identity.profileUrl,
        isOwner: identity.isOwner,
        confidence: identity.provenance.confidence,
        metadata: identity.metadata,
        ...source(identity.provenance),
      })
      .onConflictDoUpdate({
        target: [
          channelIdentities.integrationAccountId,
          channelIdentities.channel,
          channelIdentities.externalId,
        ],
        set: {
          contactId,
          handle: identity.handle,
          address: identity.address,
          displayName: identity.displayName,
          profileUrl: identity.profileUrl,
          isOwner: identity.isOwner,
          confidence: identity.provenance.confidence,
          metadata: identity.metadata,
          ...source(identity.provenance),
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!stored) throw new Error("LinkedIn identity upsert returned no row.");
    return stored.id;
  }

  private async enqueueAnalysisJobs(conversationId: string, candidate: ConversationCandidate) {
    let inserted = 0;
    for (const job of buildLinkedinAnalysisJobs(conversationId, candidate)) {
      const rows = await this.database
        .insert(analysisJobs)
        .values(job)
        .onConflictDoNothing({ target: analysisJobs.idempotencyKey })
        .returning({ id: analysisJobs.id });
      inserted += rows.length;
    }
    return inserted;
  }

  private async findConversation(integrationAccountId: string, externalConversationId: string) {
    const [conversation] = await this.database
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.integrationAccountId, integrationAccountId),
          eq(conversations.externalConversationId, externalConversationId),
        ),
      )
      .limit(1);
    return conversation;
  }
}

export function buildLinkedinAnalysisJobs(
  conversationId: string,
  candidate: ConversationCandidate,
) {
  const inputHash = hashContent(
    candidate.messages.map((message) => ({
      id: message.externalMessageId,
      direction: message.direction,
      sentAt: message.sentAt,
      bodyText: message.bodyText,
    })),
  );
  return (["classify_outreach", "summarize_thread", "detect_reply"] as const).map(
    (jobType) => ({
      idempotencyKey: createIdempotencyKey(
        "linkedin-analysis",
        conversationId,
        jobType,
        inputHash,
      ),
      jobType,
      entityType: "conversation" as const,
      entityId: conversationId,
      inputHash,
      runner: "codex-cli",
      schemaVersion: 1,
      payload: {
        channel: "linkedin",
        externalConversationId: candidate.externalConversationId,
        messageCount: candidate.messages.length,
        replyState: candidate.metadata.replyState,
      },
    }),
  );
}

function source(provenance: SourceProvenance) {
  return {
    sourceExternalId: provenance.externalId,
    sourceUrl: provenance.sourceUrl,
    sourceCollectedAt: new Date(provenance.collectedAt),
    sourceConfidence: provenance.confidence,
    sourceProvenance: [provenance],
  };
}

function conversationTimestamps(messagesInput: readonly MessageCandidate[]) {
  const sorted = [...messagesInput].sort((left, right) => left.sentAt.localeCompare(right.sentAt));
  const inbound = sorted.filter((message) => message.direction === "inbound");
  const outbound = sorted.filter((message) => message.direction === "outbound");
  return {
    firstMessageAt: sorted[0] ? new Date(sorted[0].sentAt) : undefined,
    lastMessageAt: sorted.at(-1) ? new Date(sorted.at(-1)!.sentAt) : undefined,
    lastInboundAt: inbound.at(-1) ? new Date(inbound.at(-1)!.sentAt) : undefined,
    lastOutboundAt: outbound.at(-1) ? new Date(outbound.at(-1)!.sentAt) : undefined,
    touchCount: sorted.length,
    inboundTouchCount: inbound.length,
    outboundTouchCount: outbound.length,
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
