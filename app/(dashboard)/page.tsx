import { Suspense } from "react";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  sql,
} from "drizzle-orm";

import {
  createDashboardDemoData,
  DashboardEmpty,
  DashboardError,
  DashboardLoading,
  DashboardOverview,
} from "@/components/dashboard";
import type {
  DashboardAnalysisHealth,
  DashboardChannelMix,
  DashboardConversation,
  DashboardNextAction,
  DashboardSnapshot,
  DashboardStaleRelationship,
  DashboardSyncHealth,
} from "@/components/dashboard";
import { getDatabase } from "@/lib/db/client";
import {
  analysisJobs,
  analysisResults,
  companies,
  contacts,
  conversationParticipants,
  conversations,
  integrationAccounts,
  messages,
  outreachPlans,
  syncRuns,
} from "@/lib/db/schema";
import type { Channel } from "@/lib/domain/constants";

type DashboardLoadResult =
  | { status: "ready"; data: DashboardSnapshot }
  | { status: "empty" }
  | { status: "error"; message: string };

type DashboardSearchParams = Promise<{
  demo?: string | string[];
}>;

const ACTIVE_PLAN_STATUSES = ["draft", "planned", "active"] as const;
const STALE_RELATIONSHIP_STAGES = [
  "active",
  "waiting",
  "replied",
  "dormant",
] as const;
const CHANNELS: Channel[] = ["gmail", "linkedin", "x"];

function toIso(value: Date | null) {
  return value?.toISOString() ?? null;
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  return null;
}

function createRationaleMap(
  rows: Array<{
    entityId: string;
    result: Record<string, unknown>;
    confidence: number;
  }>,
) {
  const rationales = new Map<
    string,
    { rationale: string; confidence: number }
  >();

  for (const row of rows) {
    if (rationales.has(row.entityId)) continue;
    const rationale = firstString(row.result, [
      "rationale",
      "reason",
      "summary",
      "recommendation",
    ]);
    if (rationale)
      rationales.set(row.entityId, { rationale, confidence: row.confidence });
  }

  return rationales;
}

function calculateUrgency(
  dueAt: Date | null,
  now: Date,
): DashboardNextAction["urgency"] {
  if (!dueAt) return "watch";

  const dueDay = new Date(
    dueAt.getFullYear(),
    dueAt.getMonth(),
    dueAt.getDate(),
  ).getTime();
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();

  if (dueDay < today) return "overdue";
  if (dueDay === today) return "today";
  return "upcoming";
}

function runDetail(run: {
  status: string;
  discoveredCount: number;
  insertedCount: number;
  updatedCount: number;
  failedCount: number;
  errorMessage: string | null;
}) {
  if (run.errorMessage) return run.errorMessage;
  if (run.status === "queued") return "Sync is queued";
  if (run.status === "running") return "Reading new source activity";

  const changed = run.insertedCount + run.updatedCount;
  if (run.failedCount > 0) {
    return `${run.discoveredCount} checked; ${run.failedCount} could not be read`;
  }

  return `${run.discoveredCount} checked; ${changed === 0 ? "no changes" : `${changed} changed`}`;
}

async function loadDashboardSnapshot(
  now = new Date(),
): Promise<DashboardLoadResult> {
  if (!process.env.DATABASE_URL) {
    return {
      status: "error",
      message:
        "The database connection is not configured for this environment.",
    };
  }

  try {
    const database = getDatabase();
    const staleBefore = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1_000);

    const [
      totalContactRows,
      plannedRows,
      followUpRows,
      contactedRows,
      repliedRows,
      unrepliedRows,
      channelCountRows,
      planActionRows,
      waitingActionRows,
      staleRows,
      conversationRows,
      accountRows,
      syncRunRows,
      analysisCountRows,
      oldestQueueRows,
      rationaleRows,
    ] = await Promise.all([
      database.select({ value: count() }).from(contacts),
      database
        .select({ value: count() })
        .from(outreachPlans)
        .where(inArray(outreachPlans.status, ACTIVE_PLAN_STATUSES)),
      database
        .select({ value: count() })
        .from(outreachPlans)
        .where(
          and(
            inArray(outreachPlans.status, ACTIVE_PLAN_STATUSES),
            isNotNull(outreachPlans.nextTouchAt),
            lte(outreachPlans.nextTouchAt, now),
          ),
        ),
      database
        .select({ value: count() })
        .from(contacts)
        .where(gt(contacts.outboundTouchCount, 0)),
      database
        .select({ value: count() })
        .from(contacts)
        .where(
          and(
            gt(contacts.outboundTouchCount, 0),
            eq(contacts.replyState, "replied"),
          ),
        ),
      database
        .select({ value: count() })
        .from(contacts)
        .where(
          and(
            gt(contacts.outboundTouchCount, 0),
            eq(contacts.replyState, "awaiting_reply"),
          ),
        ),
      database
        .select({ channel: messages.channel, value: count() })
        .from(messages)
        .where(eq(messages.direction, "outbound"))
        .groupBy(messages.channel),
      database
        .select({
          id: outreachPlans.id,
          contactId: outreachPlans.contactId,
          contactName: contacts.displayName,
          companyName: companies.name,
          role: contacts.title,
          status: outreachPlans.status,
          preferredChannels: outreachPlans.preferredChannels,
          nextTouchAt: outreachPlans.nextTouchAt,
          firstTouchAt: outreachPlans.firstTouchAt,
          lastTouchAt: contacts.lastTouchAt,
          completedTouchCount: outreachPlans.completedTouchCount,
          touchCount: contacts.touchCount,
          suggestedDraft: outreachPlans.suggestedDraft,
          metadata: outreachPlans.metadata,
        })
        .from(outreachPlans)
        .innerJoin(contacts, eq(outreachPlans.contactId, contacts.id))
        .leftJoin(companies, eq(outreachPlans.companyId, companies.id))
        .where(inArray(outreachPlans.status, ACTIVE_PLAN_STATUSES))
        .orderBy(
          sql`${outreachPlans.nextTouchAt} asc nulls last`,
          desc(outreachPlans.updatedAt),
        )
        .limit(12),
      database
        .select({
          contactId: contacts.id,
          contactName: contacts.displayName,
          companyName: companies.name,
          role: contacts.title,
          lastOutboundAt: contacts.lastOutboundAt,
          lastTouchAt: contacts.lastTouchAt,
          touchCount: contacts.touchCount,
        })
        .from(contacts)
        .leftJoin(companies, eq(contacts.companyId, companies.id))
        .where(
          and(
            eq(contacts.replyState, "awaiting_reply"),
            gt(contacts.outboundTouchCount, 0),
          ),
        )
        .orderBy(asc(contacts.lastOutboundAt))
        .limit(12),
      database
        .select({
          contactId: contacts.id,
          contactName: contacts.displayName,
          companyName: companies.name,
          role: contacts.title,
          replyState: contacts.replyState,
          lastTouchAt: contacts.lastTouchAt,
          touchCount: contacts.touchCount,
        })
        .from(contacts)
        .leftJoin(companies, eq(contacts.companyId, companies.id))
        .where(
          and(
            isNotNull(contacts.lastTouchAt),
            lt(contacts.lastTouchAt, staleBefore),
            inArray(contacts.relationshipStage, STALE_RELATIONSHIP_STAGES),
          ),
        )
        .orderBy(asc(contacts.lastTouchAt))
        .limit(5),
      database
        .select({
          id: conversations.id,
          contactId: conversationParticipants.contactId,
          contactName: contacts.displayName,
          companyName: companies.name,
          channel: conversations.channel,
          subject: conversations.subject,
          preview: conversations.preview,
          lastMessageAt: conversations.lastMessageAt,
          createdAt: conversations.createdAt,
          replyState: conversations.replyState,
          touchCount: conversations.touchCount,
        })
        .from(conversations)
        .leftJoin(
          conversationParticipants,
          and(
            eq(conversationParticipants.conversationId, conversations.id),
            eq(conversationParticipants.role, "contact"),
          ),
        )
        .leftJoin(contacts, eq(conversationParticipants.contactId, contacts.id))
        .leftJoin(companies, eq(contacts.companyId, companies.id))
        .where(eq(conversations.isCustomerOutreach, true))
        .orderBy(
          desc(conversations.lastMessageAt),
          desc(conversations.createdAt),
        )
        .limit(24),
      database
        .select()
        .from(integrationAccounts)
        .orderBy(asc(integrationAccounts.provider)),
      database
        .select()
        .from(syncRuns)
        .orderBy(desc(syncRuns.createdAt))
        .limit(60),
      database
        .select({ status: analysisJobs.status, value: count() })
        .from(analysisJobs)
        .groupBy(analysisJobs.status),
      database
        .select({ scheduledAt: analysisJobs.scheduledAt })
        .from(analysisJobs)
        .where(eq(analysisJobs.status, "queued"))
        .orderBy(asc(analysisJobs.scheduledAt))
        .limit(1),
      database
        .select({
          entityId: analysisResults.entityId,
          result: analysisResults.result,
          confidence: analysisResults.confidence,
        })
        .from(analysisResults)
        .where(eq(analysisResults.entityType, "contact"))
        .orderBy(desc(analysisResults.createdAt))
        .limit(100),
    ]);

    const totalContacts = totalContactRows[0]?.value ?? 0;
    const planned = plannedRows[0]?.value ?? 0;
    const followUpsDue = followUpRows[0]?.value ?? 0;
    const contacted = contactedRows[0]?.value ?? 0;
    const replied = repliedRows[0]?.value ?? 0;
    const unreplied = unrepliedRows[0]?.value ?? 0;
    const knownReplyOutcomes = replied + unreplied;
    const rationaleByContact = createRationaleMap(rationaleRows);

    const plannedActions: DashboardNextAction[] = planActionRows.map((row) => {
      const modelRationale = rationaleByContact.get(row.contactId);
      const metadataRationale = firstString(row.metadata, [
        "rationale",
        "reason",
        "summary",
      ]);
      const kind =
        row.completedTouchCount === 0 && row.firstTouchAt === null
          ? "planned_outreach"
          : "follow_up";

      return {
        id: row.id,
        contactId: row.contactId,
        contactName: row.contactName,
        companyName: row.companyName,
        role: row.role,
        channel: row.preferredChannels[0] ?? null,
        kind,
        urgency: calculateUrgency(row.nextTouchAt, now),
        dueAt: toIso(row.nextTouchAt),
        lastTouchAt: toIso(row.lastTouchAt),
        touchCount: row.touchCount,
        rationale:
          modelRationale?.rationale ??
          metadataRationale ??
          (kind === "planned_outreach"
            ? "This approved plan has no recorded first touch yet."
            : "The planned next-touch date makes this relationship timely to review."),
        rationaleSource: modelRationale ? "model" : "rule",
        confidence: modelRationale?.confidence ?? null,
        suggestedDraft: row.suggestedDraft,
      };
    });

    const plannedContactIds = new Set(
      plannedActions.map((action) => action.contactId),
    );
    const waitingActions: DashboardNextAction[] = waitingActionRows
      .filter((row) => !plannedContactIds.has(row.contactId))
      .map((row) => {
        const modelRationale = rationaleByContact.get(row.contactId);

        return {
          id: `waiting-${row.contactId}`,
          contactId: row.contactId,
          contactName: row.contactName,
          companyName: row.companyName,
          role: row.role,
          channel: null,
          kind: "awaiting_reply",
          urgency: "watch",
          dueAt: null,
          lastTouchAt: toIso(row.lastTouchAt ?? row.lastOutboundAt),
          touchCount: row.touchCount,
          rationale:
            modelRationale?.rationale ??
            "No inbound reply has been recorded since the latest outbound touch.",
          rationaleSource: modelRationale ? "model" : "rule",
          confidence: modelRationale?.confidence ?? null,
          suggestedDraft: null,
        };
      });

    const urgencyOrder: Record<DashboardNextAction["urgency"], number> = {
      overdue: 0,
      today: 1,
      upcoming: 2,
      watch: 3,
    };
    const nextActions = [...plannedActions, ...waitingActions]
      .sort((left, right) => {
        const urgencyDifference =
          urgencyOrder[left.urgency] - urgencyOrder[right.urgency];
        if (urgencyDifference !== 0) return urgencyDifference;

        return (
          (left.dueAt
            ? new Date(left.dueAt).getTime()
            : Number.MAX_SAFE_INTEGER) -
          (right.dueAt
            ? new Date(right.dueAt).getTime()
            : Number.MAX_SAFE_INTEGER)
        );
      })
      .slice(0, 6);

    const totalChannelTouches = channelCountRows.reduce(
      (total, row) => total + row.value,
      0,
    );
    const channelCounts = new Map(
      channelCountRows.map((row) => [row.channel, row.value]),
    );
    const channelMix: DashboardChannelMix[] = CHANNELS.map((channel) => {
      const value = channelCounts.get(channel) ?? 0;
      return {
        channel,
        count: value,
        share:
          totalChannelTouches > 0
            ? Math.round((value / totalChannelTouches) * 100)
            : 0,
      };
    });

    const staleRelationships: DashboardStaleRelationship[] = staleRows.flatMap(
      (row) =>
        row.lastTouchAt
          ? [
              {
                contactId: row.contactId,
                contactName: row.contactName,
                companyName: row.companyName,
                role: row.role,
                replyState: row.replyState,
                lastTouchAt: row.lastTouchAt.toISOString(),
                touchCount: row.touchCount,
              },
            ]
          : [],
    );

    const seenConversationIds = new Set<string>();
    const recentConversations: DashboardConversation[] = [];
    for (const row of conversationRows) {
      if (seenConversationIds.has(row.id)) continue;
      seenConversationIds.add(row.id);
      recentConversations.push({
        id: row.id,
        contactId: row.contactId,
        contactName: row.contactName ?? row.subject ?? "Unresolved contact",
        companyName: row.companyName,
        channel: row.channel,
        subject: row.subject,
        preview: row.preview,
        lastMessageAt: (row.lastMessageAt ?? row.createdAt).toISOString(),
        replyState: row.replyState,
        touchCount: row.touchCount,
      });
      if (recentConversations.length === 6) break;
    }

    const latestRunByAccount = new Map<string, (typeof syncRunRows)[number]>();
    for (const run of syncRunRows) {
      if (!latestRunByAccount.has(run.integrationAccountId)) {
        latestRunByAccount.set(run.integrationAccountId, run);
      }
    }

    const syncHealth: DashboardSyncHealth[] = accountRows.map((account) => {
      const latestRun = latestRunByAccount.get(account.id);
      const latestRunNeedsAttention =
        latestRun?.status === "failed" || latestRun?.status === "partial";
      const status: DashboardSyncHealth["status"] =
        account.status === "attention_required" || latestRunNeedsAttention
          ? "attention"
          : latestRun?.status === "running" || latestRun?.status === "queued"
            ? "syncing"
            : account.status === "connected"
              ? "healthy"
              : "not_connected";
      const statusLabel =
        status === "attention"
          ? "Needs attention"
          : status === "syncing"
            ? "Syncing"
            : status === "healthy"
              ? "Current"
              : "Not connected";

      return {
        id: account.id,
        channel: account.provider,
        displayName: account.displayName,
        status,
        statusLabel,
        lastSyncedAt: toIso(account.lastSyncedAt),
        detail: latestRun
          ? runDetail(latestRun)
          : (account.lastErrorMessage ??
            "Waiting for the first read-only sync"),
      };
    });

    const analysisCounts = new Map(
      analysisCountRows.map((row) => [row.status, row.value]),
    );
    const queued = analysisCounts.get("queued") ?? 0;
    const running = analysisCounts.get("running") ?? 0;
    const failed = analysisCounts.get("failed") ?? 0;
    const succeeded = analysisCounts.get("succeeded") ?? 0;
    const analysisStatus: DashboardAnalysisHealth["status"] =
      failed > 0 ? "attention" : queued > 0 || running > 0 ? "working" : "idle";
    const analysisHealth: DashboardAnalysisHealth = {
      status: analysisStatus,
      queued,
      running,
      failed,
      succeeded,
      oldestQueuedAt: toIso(oldestQueueRows[0]?.scheduledAt ?? null),
      detail:
        analysisStatus === "attention"
          ? `${failed} analysis ${failed === 1 ? "job needs" : "jobs need"} review; source records remain unchanged.`
          : analysisStatus === "working"
            ? `${queued + running} changed ${queued + running === 1 ? "thread is" : "threads are"} being analyzed by the subscription worker.`
            : "No changed threads are waiting for analysis.",
    };

    if (totalContacts === 0 && planned === 0 && accountRows.length === 0) {
      return { status: "empty" };
    }

    return {
      status: "ready",
      data: {
        generatedAt: now.toISOString(),
        metrics: {
          planned,
          followUpsDue,
          contacted,
          replied,
          unreplied,
          replyRate:
            knownReplyOutcomes > 0
              ? Math.round((replied / knownReplyOutcomes) * 100)
              : 0,
        },
        nextActions,
        channelMix,
        staleRelationships,
        recentConversations,
        syncHealth,
        analysisHealth,
      },
    };
  } catch {
    return {
      status: "error",
      message:
        "Threadline could not read the latest aggregates. The next refresh will try again.",
    };
  }
}

async function DashboardDataRegion({ demo }: { demo: boolean }) {
  if (demo) {
    return <DashboardOverview data={createDashboardDemoData()} mode="demo" />;
  }

  const result = await loadDashboardSnapshot();

  if (result.status === "empty") return <DashboardEmpty />;
  if (result.status === "error")
    return <DashboardError message={result.message} />;
  return <DashboardOverview data={result.data} />;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: DashboardSearchParams;
}) {
  const parameters = await searchParams;
  const demoValue = Array.isArray(parameters.demo)
    ? parameters.demo[0]
    : parameters.demo;

  return (
    <Suspense fallback={<DashboardLoading />}>
      <DashboardDataRegion demo={demoValue === "1"} />
    </Suspense>
  );
}
