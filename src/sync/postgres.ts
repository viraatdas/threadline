import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";

import type { ThreadlineDatabase } from "@/lib/db/client";
import {
  analysisJobs,
  analysisResults,
  auditEvents,
  channelIdentities,
  contacts,
  conversationParticipants,
  conversations,
  integrationAccounts,
  messages,
  outreachPlans,
  syncCursors,
  syncRuns,
  touchpoints,
} from "@/lib/db/schema";
import type { AnalysisJobType, Channel } from "@/lib/domain/constants";
import { createIdempotencyKey, hashContent } from "@/lib/security/idempotency";
import {
  deriveRelationshipMetrics,
  isAnalysisCovered,
  planConservativeIdentityMerges,
} from "@/src/sync/reconcile";
import type {
  ChannelSyncCounts,
  SyncCoordinatorStore,
  SyncRunClaim,
  SyncReconciler,
  SyncReconciliationSummary,
  UnifiedSyncAccount,
} from "@/src/sync/types";

const RECONCILIATION_LOCK = "threadline:sync:reconciliation";

export class PostgresSyncCoordinatorStore implements SyncCoordinatorStore {
  constructor(private readonly database: ThreadlineDatabase) {}

  async listAccounts(
    channels?: readonly Channel[],
  ): Promise<UnifiedSyncAccount[]> {
    const rows = channels?.length
      ? await this.database
          .select()
          .from(integrationAccounts)
          .where(inArray(integrationAccounts.provider, [...channels]))
          .orderBy(
            asc(integrationAccounts.provider),
            asc(integrationAccounts.createdAt),
          )
      : await this.database
          .select()
          .from(integrationAccounts)
          .orderBy(
            asc(integrationAccounts.provider),
            asc(integrationAccounts.createdAt),
          );
    return rows.map((account) => ({
      id: account.id,
      channel: account.provider,
      displayName: account.displayName,
      status: account.status,
      syncEnabled: account.syncEnabled,
    }));
  }

  claimRun(input: {
    account: UnifiedSyncAccount;
    resource: string;
    trigger: "manual" | "scheduled";
    invocationId: string;
    now: Date;
    leaseMs: number;
  }): Promise<SyncRunClaim> {
    return this.database.transaction(async (transaction) => {
      const lockKey = `threadline:sync:${input.account.id}:${input.resource}`;
      const acquired = await tryTransactionLock(transaction, lockKey);
      if (!acquired)
        return { acquired: false as const, reason: "locked" as const };

      const idempotencyKey = createIdempotencyKey(
        "unified-sync-run",
        input.account.id,
        input.resource,
        input.trigger,
        input.invocationId,
      );
      const [duplicate] = await transaction
        .select()
        .from(syncRuns)
        .where(eq(syncRuns.idempotencyKey, idempotencyKey))
        .limit(1);
      if (duplicate) {
        return {
          acquired: false,
          reason: "duplicate" as const,
          runId: duplicate.id,
          status: duplicate.status,
        };
      }

      const resource = coordinatorResource(
        input.account.channel,
        input.resource,
      );
      const staleBefore = new Date(input.now.getTime() - input.leaseMs);
      await transaction
        .update(syncRuns)
        .set({
          status: "cancelled",
          completedAt: input.now,
          errorCode: "sync_lease_expired",
          errorMessage:
            "A previous unified sync lease expired before completion.",
          updatedAt: input.now,
        })
        .where(
          and(
            eq(syncRuns.integrationAccountId, input.account.id),
            eq(syncRuns.resource, resource),
            eq(syncRuns.status, "running"),
            lt(syncRuns.startedAt, staleBefore),
          ),
        );

      const [active] = await transaction
        .select({ id: syncRuns.id, status: syncRuns.status })
        .from(syncRuns)
        .where(
          and(
            eq(syncRuns.integrationAccountId, input.account.id),
            eq(syncRuns.resource, resource),
            eq(syncRuns.status, "running"),
            gt(syncRuns.startedAt, staleBefore),
          ),
        )
        .limit(1);
      if (active) {
        return {
          acquired: false,
          reason: "locked" as const,
          runId: active.id,
          status: active.status,
        };
      }

      const [cursor] = await transaction
        .select({ ciphertext: syncCursors.cursorCiphertext })
        .from(syncCursors)
        .where(
          and(
            eq(syncCursors.integrationAccountId, input.account.id),
            eq(syncCursors.resource, input.resource),
          ),
        )
        .limit(1);
      const [run] = await transaction
        .insert(syncRuns)
        .values({
          integrationAccountId: input.account.id,
          idempotencyKey,
          resource,
          trigger: input.trigger,
          status: "running",
          startedAt: input.now,
          cursorBeforeCiphertext: cursor?.ciphertext,
          metadata: {
            channel: input.account.channel,
            sourceResource: input.resource,
            invocationId: input.invocationId,
            readOnly: true,
          },
        })
        .returning({ id: syncRuns.id });
      if (!run) throw new Error("Unified sync run could not be created.");
      return { acquired: true, runId: run.id };
    });
  }

  async completeRun(input: {
    runId: string;
    account: UnifiedSyncAccount;
    resource: string;
    status: "succeeded" | "partial" | "failed";
    counts: ChannelSyncCounts;
    completedAt: Date;
    errorCode?: string;
    errorMessage?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const [[cursor], [run]] = await Promise.all([
        transaction
          .select({ ciphertext: syncCursors.cursorCiphertext })
          .from(syncCursors)
          .where(
            and(
              eq(syncCursors.integrationAccountId, input.account.id),
              eq(syncCursors.resource, input.resource),
            ),
          )
          .limit(1),
        transaction
          .select({ metadata: syncRuns.metadata })
          .from(syncRuns)
          .where(eq(syncRuns.id, input.runId))
          .limit(1),
      ]);
      await transaction
        .update(syncRuns)
        .set({
          status: input.status,
          completedAt: input.completedAt,
          cursorAfterCiphertext: cursor?.ciphertext ?? null,
          discoveredCount: input.counts.discoveredCount,
          insertedCount: input.counts.insertedCount,
          updatedCount: input.counts.updatedCount,
          skippedCount: input.counts.skippedCount,
          failedCount: input.counts.failedCount,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          metadata: { ...(run?.metadata ?? {}), ...(input.metadata ?? {}) },
          updatedAt: input.completedAt,
        })
        .where(eq(syncRuns.id, input.runId));
    });
  }
}

export class PostgresSyncReconciler implements SyncReconciler {
  constructor(private readonly database: ThreadlineDatabase) {}

  reconcile(input: {
    integrationAccountIds: readonly string[];
    now: Date;
  }): Promise<SyncReconciliationSummary> {
    if (input.integrationAccountIds.length === 0) {
      return Promise.resolve({
        contactsMerged: 0,
        contactsRecomputed: 0,
        analysisJobsEnqueued: 0,
      });
    }

    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${RECONCILIATION_LOCK}))`,
      );

      const contactRows = await transaction.select().from(contacts);
      const identityRows = await transaction
        .select({
          contactId: channelIdentities.contactId,
          channel: channelIdentities.channel,
          address: channelIdentities.address,
          isOwner: channelIdentities.isOwner,
        })
        .from(channelIdentities);
      const mergePlans = planConservativeIdentityMerges(
        contactRows,
        identityRows,
      );
      const contactById = new Map(
        contactRows.map((contact) => [contact.id, contact]),
      );
      const recomputeContactIds = new Set<string>();

      for (const plan of mergePlans) {
        const canonical = contactById.get(plan.canonicalContactId);
        const duplicates = plan.duplicateContactIds.flatMap((id) => {
          const contact = contactById.get(id);
          return contact ? [contact] : [];
        });
        if (!canonical || duplicates.length === 0) continue;
        const duplicateIds = duplicates.map((contact) => contact.id);
        await transaction
          .update(channelIdentities)
          .set({ contactId: canonical.id, updatedAt: input.now })
          .where(inArray(channelIdentities.contactId, duplicateIds));
        await transaction
          .update(conversationParticipants)
          .set({ contactId: canonical.id, updatedAt: input.now })
          .where(inArray(conversationParticipants.contactId, duplicateIds));
        await transaction
          .update(touchpoints)
          .set({ contactId: canonical.id, updatedAt: input.now })
          .where(inArray(touchpoints.contactId, duplicateIds));
        await transaction
          .update(outreachPlans)
          .set({ contactId: canonical.id, updatedAt: input.now })
          .where(inArray(outreachPlans.contactId, duplicateIds));
        await transaction
          .update(analysisJobs)
          .set({ entityId: canonical.id, updatedAt: input.now })
          .where(
            and(
              eq(analysisJobs.entityType, "contact"),
              inArray(analysisJobs.entityId, duplicateIds),
            ),
          );
        await transaction
          .update(analysisResults)
          .set({ entityId: canonical.id, updatedAt: input.now })
          .where(
            and(
              eq(analysisResults.entityType, "contact"),
              inArray(analysisResults.entityId, duplicateIds),
            ),
          );
        await transaction
          .update(auditEvents)
          .set({ entityId: canonical.id })
          .where(
            and(
              eq(auditEvents.entityType, "contact"),
              inArray(auditEvents.entityId, duplicateIds),
            ),
          );
        await transaction
          .update(contacts)
          .set({
            primaryEmail: plan.email,
            companyId:
              canonical.companyId ??
              duplicates.find((contact) => contact.companyId)?.companyId,
            givenName:
              canonical.givenName ?? firstDefined(duplicates, "givenName"),
            familyName:
              canonical.familyName ?? firstDefined(duplicates, "familyName"),
            title: canonical.title ?? firstDefined(duplicates, "title"),
            seniority:
              canonical.seniority ?? firstDefined(duplicates, "seniority"),
            location:
              canonical.location ?? firstDefined(duplicates, "location"),
            notes: mergeNotes([
              canonical.notes,
              ...duplicates.map((contact) => contact.notes),
            ]),
            confidence: Math.max(
              canonical.confidence,
              ...duplicates.map((contact) => contact.confidence),
            ),
            sourceProvenance: mergeProvenance([
              ...canonical.sourceProvenance,
              ...duplicates.flatMap((contact) => contact.sourceProvenance),
            ]),
            metadata: {
              ...canonical.metadata,
              unifiedIdentityEmail: plan.email,
              mergedContactIds: uniqueStrings([
                ...metadataStrings(canonical.metadata, "mergedContactIds"),
                ...duplicateIds,
              ]),
            },
            updatedAt: input.now,
          })
          .where(eq(contacts.id, canonical.id));
        await transaction
          .delete(contacts)
          .where(inArray(contacts.id, duplicateIds));
        recomputeContactIds.add(canonical.id);
      }

      const touchedContactRows = await transaction
        .selectDistinct({ contactId: touchpoints.contactId })
        .from(touchpoints)
        .where(
          inArray(touchpoints.integrationAccountId, [
            ...input.integrationAccountIds,
          ]),
        );
      for (const row of touchedContactRows)
        recomputeContactIds.add(row.contactId);

      const contactsRecomputed = await recomputeRelationships(
        transaction,
        [...recomputeContactIds],
        input.now,
      );
      const analysisJobsEnqueued = await ensureAnalysisCoverage(
        transaction,
        input.integrationAccountIds,
        input.now,
      );

      return {
        contactsMerged: mergePlans.reduce(
          (count, plan) => count + plan.duplicateContactIds.length,
          0,
        ),
        contactsRecomputed,
        analysisJobsEnqueued,
      };
    });
  }
}

async function recomputeRelationships(
  transaction: Transaction,
  contactIds: readonly string[],
  now: Date,
): Promise<number> {
  if (contactIds.length === 0) return 0;
  const aggregates = await transaction
    .select({
      contactId: touchpoints.contactId,
      touchCount: sql<number>`count(*)::int`,
      inboundTouchCount: sql<number>`count(*) filter (where ${touchpoints.direction} = 'inbound')::int`,
      outboundTouchCount: sql<number>`count(*) filter (where ${touchpoints.direction} = 'outbound')::int`,
      firstTouchAt: sql<Date | null>`min(${touchpoints.happenedAt})`,
      lastTouchAt: sql<Date | null>`max(${touchpoints.happenedAt})`,
      lastInboundAt: sql<Date | null>`max(${touchpoints.happenedAt}) filter (where ${touchpoints.direction} = 'inbound')`,
      lastOutboundAt: sql<Date | null>`max(${touchpoints.happenedAt}) filter (where ${touchpoints.direction} = 'outbound')`,
    })
    .from(touchpoints)
    .where(inArray(touchpoints.contactId, [...contactIds]))
    .groupBy(touchpoints.contactId);
  const aggregateByContact = new Map(
    aggregates.map((aggregate) => [aggregate.contactId, aggregate]),
  );
  const rows = await transaction
    .select({
      id: contacts.id,
      manualOverrides: contacts.manualOverrides,
    })
    .from(contacts)
    .where(inArray(contacts.id, [...contactIds]));

  for (const contact of rows) {
    const metrics = deriveRelationshipMetrics(
      aggregateByContact.get(contact.id),
    );
    const replyStateOverridden = contact.manualOverrides.some(
      (override) => override.field === "replyState",
    );
    const relationshipStageOverridden = contact.manualOverrides.some(
      (override) => override.field === "relationshipStage",
    );
    await transaction
      .update(contacts)
      .set({
        touchCount: metrics.touchCount,
        inboundTouchCount: metrics.inboundTouchCount,
        outboundTouchCount: metrics.outboundTouchCount,
        firstTouchAt: metrics.firstTouchAt,
        lastTouchAt: metrics.lastTouchAt,
        lastInboundAt: metrics.lastInboundAt,
        lastOutboundAt: metrics.lastOutboundAt,
        ...(!replyStateOverridden ? { replyState: metrics.replyState } : {}),
        ...(!relationshipStageOverridden
          ? { relationshipStage: metrics.relationshipStage }
          : {}),
        updatedAt: now,
      })
      .where(eq(contacts.id, contact.id));
  }
  return rows.length;
}

async function ensureAnalysisCoverage(
  transaction: Transaction,
  integrationAccountIds: readonly string[],
  now: Date,
): Promise<number> {
  const conversationRows = await transaction
    .select()
    .from(conversations)
    .where(
      inArray(conversations.integrationAccountId, [...integrationAccountIds]),
    );
  if (conversationRows.length === 0) return 0;
  const conversationIds = conversationRows.map(
    (conversation) => conversation.id,
  );
  const messageRows = await transaction
    .select()
    .from(messages)
    .where(inArray(messages.conversationId, conversationIds))
    .orderBy(asc(messages.sentAt), asc(messages.id));
  const participantRows = await transaction
    .select({
      conversationId: conversationParticipants.conversationId,
      externalParticipantId: conversationParticipants.externalParticipantId,
      role: conversationParticipants.role,
      displayName: conversationParticipants.displayName,
      handle: channelIdentities.handle,
    })
    .from(conversationParticipants)
    .leftJoin(
      channelIdentities,
      eq(conversationParticipants.channelIdentityId, channelIdentities.id),
    )
    .where(inArray(conversationParticipants.conversationId, conversationIds));
  const existingRows = await transaction
    .select({
      entityId: analysisJobs.entityId,
      jobType: analysisJobs.jobType,
      inputHash: analysisJobs.inputHash,
      payload: analysisJobs.payload,
    })
    .from(analysisJobs)
    .where(
      and(
        eq(analysisJobs.entityType, "conversation"),
        inArray(analysisJobs.entityId, conversationIds),
      ),
    );
  const messagesByConversation = groupBy(
    messageRows,
    (message) => message.conversationId,
  );
  const participantsByConversation = groupBy(
    participantRows,
    (participant) => participant.conversationId,
  );
  const jobsByConversation = groupBy(existingRows, (job) => job.entityId);
  let inserted = 0;

  for (const conversation of conversationRows) {
    const conversationMessages =
      messagesByConversation.get(conversation.id) ?? [];
    if (conversationMessages.length === 0) continue;
    const descriptor = analysisDescriptor(
      conversation,
      conversationMessages,
      participantsByConversation.get(conversation.id) ?? [],
    );
    const existingJobs = jobsByConversation.get(conversation.id) ?? [];
    for (const jobType of descriptor.jobTypes) {
      const covered = isAnalysisCovered(
        {
          jobType,
          inputHash: descriptor.inputHash,
          messageExternalIds: descriptor.messageExternalIds,
        },
        existingJobs,
      );
      if (covered) continue;
      const rows = await transaction
        .insert(analysisJobs)
        .values({
          idempotencyKey: createIdempotencyKey(
            "unified-analysis",
            conversation.id,
            jobType,
            descriptor.inputHash,
          ),
          jobType,
          status: "queued",
          entityType: "conversation",
          entityId: conversation.id,
          inputHash: descriptor.inputHash,
          runner: "codex-cli",
          schemaVersion: 1,
          payload: descriptor.payload,
          scheduledAt: now,
        })
        .onConflictDoNothing({ target: analysisJobs.idempotencyKey })
        .returning({ id: analysisJobs.id });
      inserted += rows.length;
    }
  }
  return inserted;
}

function analysisDescriptor(
  conversation: typeof conversations.$inferSelect,
  conversationMessages: readonly (typeof messages.$inferSelect)[],
  participants: readonly {
    externalParticipantId: string;
    role: "owner" | "contact" | "other";
    displayName: string | null;
    handle: string | null;
  }[],
): {
  inputHash: string;
  messageExternalIds: string[];
  jobTypes: readonly AnalysisJobType[];
  payload: Record<string, unknown>;
} {
  const messageExternalIds = conversationMessages.map(
    (message) => message.externalMessageId,
  );
  if (conversation.channel === "linkedin") {
    const inputHash = hashContent(
      conversationMessages.map((message) => ({
        id: message.externalMessageId,
        direction: message.direction,
        sentAt: message.sentAt.toISOString(),
        bodyText: message.bodyText ?? undefined,
      })),
    );
    return {
      inputHash,
      messageExternalIds,
      jobTypes: [
        "classify_outreach",
        "summarize_thread",
        "detect_reply",
      ] as const,
      payload: {
        channel: "linkedin",
        externalConversationId: conversation.externalConversationId,
        messageCount: conversationMessages.length,
        replyState: conversation.replyState,
      },
    };
  }

  if (conversation.channel === "x") {
    const payload = {
      channel: "x",
      externalConversationId: conversation.externalConversationId,
      participants: participants.map((participant) => ({
        externalParticipantId: participant.externalParticipantId,
        role: participant.role,
        displayName: participant.displayName ?? undefined,
        handle: participant.handle ?? undefined,
      })),
      messages: conversationMessages.map((message) => ({
        id: message.id,
        externalMessageId: message.externalMessageId,
        direction: message.direction,
        sentAt: message.sentAt.toISOString(),
        bodyText: message.bodyText,
      })),
    };
    return {
      inputHash: hashContent(payload),
      messageExternalIds,
      jobTypes: ["classify_outreach"] as const,
      payload,
    };
  }

  const metadataInputHash = conversation.metadata.gmailInputHash;
  const payload = {
    source: "gmail",
    integrationAccountId: conversation.integrationAccountId,
    externalConversationId: conversation.externalConversationId,
    subject: conversation.subject,
    participants,
    messages: conversationMessages.map((message) => ({
      id: message.id,
      externalMessageId: message.externalMessageId,
      direction: message.direction,
      sentAt: message.sentAt.toISOString(),
      subject: message.subject,
      snippet: message.snippet,
      bodyText: message.bodyText,
    })),
    deterministicReplyState: conversation.replyState,
  };
  return {
    inputHash:
      typeof metadataInputHash === "string"
        ? metadataInputHash
        : hashContent(payload),
    messageExternalIds,
    jobTypes: ["classify_outreach"] as const,
    payload,
  };
}

async function tryTransactionLock(
  transaction: Transaction,
  key: string,
): Promise<boolean> {
  const rows = await transaction.execute(
    sql`select pg_try_advisory_xact_lock(hashtext(${key})) as acquired`,
  );
  const row = Array.from(
    rows as unknown as readonly { acquired: boolean }[],
  )[0];
  return row?.acquired === true;
}

function coordinatorResource(channel: Channel, resource: string): string {
  return `unified:${channel}:${resource}`;
}

function firstDefined<
  TKey extends "givenName" | "familyName" | "title" | "seniority" | "location",
>(rows: readonly (typeof contacts.$inferSelect)[], key: TKey) {
  return rows.find((row) => row[key])?.[key] ?? null;
}

function mergeNotes(values: readonly (string | null)[]): string | null {
  const notes = uniqueStrings(
    values.filter((value): value is string => Boolean(value?.trim())),
  );
  return notes.length > 0 ? notes.join("\n\n") : null;
}

function mergeProvenance(
  values: (typeof contacts.$inferSelect)["sourceProvenance"],
) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.provider}:${value.integrationAccountId ?? ""}:${value.externalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function metadataStrings(
  metadata: Record<string, unknown>,
  key: string,
): string[] {
  const value = metadata[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function groupBy<TValue, TKey>(
  values: readonly TValue[],
  key: (value: TValue) => TKey,
): Map<TKey, TValue[]> {
  const groups = new Map<TKey, TValue[]>();
  for (const value of values) {
    const groupKey = key(value);
    const group = groups.get(groupKey) ?? [];
    group.push(value);
    groups.set(groupKey, group);
  }
  return groups;
}

type Transaction = Parameters<
  Parameters<ThreadlineDatabase["transaction"]>[0]
>[0];
