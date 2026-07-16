import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Inbox,
  MessageCircleReply,
  RefreshCw,
  UsersRound,
} from "lucide-react";

import {
  ChannelIcon,
  channelLabels,
} from "@/components/dashboard/channel-icon";
import { CopySuggestionButton } from "@/components/dashboard/copy-suggestion-button";
import {
  actionKindLabel,
  formatCompactNumber,
  formatDashboardDate,
  formatDueDate,
  formatRelativeTime,
  replyStateLabel,
} from "@/components/dashboard/format";
import type {
  ActionUrgency,
  DashboardAnalysisHealth,
  DashboardMode,
  DashboardSnapshot,
  DashboardSyncHealth,
} from "@/components/dashboard/types";
import { PageHeader } from "@/components/shell";

interface DashboardOverviewProps {
  data: DashboardSnapshot;
  mode?: DashboardMode;
}

const metricDefinitions = [
  { key: "planned", label: "Planned", detail: "Open outreach plans" },
  {
    key: "followUpsDue",
    label: "Follow-ups due",
    detail: "Due now or overdue",
  },
  {
    key: "contacted",
    label: "Contacted",
    detail: "People reached at least once",
  },
  { key: "replied", label: "Replied", detail: "Outreach with a response" },
  {
    key: "unreplied",
    label: "Awaiting reply",
    detail: "Open outbound threads",
  },
  {
    key: "replyRate",
    label: "Reply rate",
    detail: "Replies across known outcomes",
  },
] as const;

const urgencyStyles: Record<ActionUrgency, string> = {
  overdue: "bg-danger",
  today: "bg-warning",
  upcoming: "bg-accent",
  watch: "bg-secondary",
};

const urgencyLabels: Record<ActionUrgency, string> = {
  overdue: "Overdue",
  today: "Due today",
  upcoming: "Upcoming",
  watch: "Watch",
};

function SectionHeading({
  id,
  title,
  description,
  meta,
}: {
  id: string;
  title: string;
  description: string;
  meta?: string;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-5">
      <div>
        <h2 id={id} className="text-[15px] font-semibold text-ink">
          {title}
        </h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-muted">
          {description}
        </p>
      </div>
      {meta ? (
        <p className="hidden shrink-0 text-[11px] text-ink-faint sm:block">
          {meta}
        </p>
      ) : null}
    </div>
  );
}

function StatusDot({ status }: { status: DashboardSyncHealth["status"] }) {
  const className =
    status === "healthy"
      ? "bg-accent"
      : status === "syncing"
        ? "bg-secondary"
        : status === "attention"
          ? "bg-danger"
          : "bg-line-strong";

  return (
    <span
      className={`size-2 shrink-0 rounded-full ${className}`}
      aria-hidden="true"
    />
  );
}

function AnalysisStatusIcon({
  status,
}: {
  status: DashboardAnalysisHealth["status"];
}) {
  if (status === "attention") {
    return (
      <CircleAlert
        className="size-4 text-danger"
        strokeWidth={1.8}
        aria-hidden="true"
      />
    );
  }

  if (status === "working") {
    return (
      <RefreshCw
        className="size-4 text-secondary"
        strokeWidth={1.8}
        aria-hidden="true"
      />
    );
  }

  return (
    <CheckCircle2
      className="size-4 text-accent-strong"
      strokeWidth={1.8}
      aria-hidden="true"
    />
  );
}

export function DashboardOverview({
  data,
  mode = "live",
}: DashboardOverviewProps) {
  const totalChannelMessages = data.channelMix.reduce(
    (total, channel) => total + channel.count,
    0,
  );

  return (
    <div className="space-y-10 lg:space-y-12">
      <PageHeader
        eyebrow={formatDashboardDate(data.generatedAt)}
        title="Today’s relationship view"
        description="Start with the few threads that need judgment, then scan outreach evidence, recent replies, and source health. Threadline never sends on your behalf."
        action={
          <div className="flex items-center gap-2">
            {mode === "demo" ? (
              <Link
                href="/"
                className="inline-flex min-h-9 items-center rounded-[6px] border border-line px-3 text-[12px] font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
              >
                Exit demo
              </Link>
            ) : null}
            <Link
              href="/people"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-[6px] bg-accent-strong px-3 text-[12px] font-semibold text-white transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
            >
              Review people
              <ArrowRight
                className="size-3.5"
                strokeWidth={2}
                aria-hidden="true"
              />
            </Link>
          </div>
        }
      />

      {mode === "demo" ? (
        <div className="flex items-start gap-3 border-y border-line bg-surface-subtle px-3 py-3 text-[12px] leading-5 text-ink-muted sm:px-4">
          <CircleAlert
            className="mt-0.5 size-3.5 shrink-0 text-secondary"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <p>
            <span className="font-medium text-ink">Demo data.</span> These
            relationships illustrate the finished workflow; no source records
            were read.
          </p>
        </div>
      ) : null}

      <section aria-labelledby="next-actions-heading">
        <SectionHeading
          id="next-actions-heading"
          title="Next actions"
          description="The shortest useful list: planned outreach, due follow-ups, and replies worth waiting on."
          meta={`${data.nextActions.length} prioritized`}
        />

        {data.nextActions.length > 0 ? (
          <ol className="border-y border-line">
            {data.nextActions.map((action, index) => (
              <li
                key={action.id}
                className="grid gap-4 border-b border-line py-5 last:border-b-0 sm:grid-cols-[28px_minmax(0,1fr)_auto] sm:gap-5"
              >
                <div className="hidden pt-0.5 sm:block" aria-hidden="true">
                  <span className="text-[11px] font-medium text-ink-faint tabular-nums">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                </div>

                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span
                      className={`size-2 rounded-full ${urgencyStyles[action.urgency]}`}
                      aria-hidden="true"
                    />
                    <span className="text-[11px] font-semibold tracking-[0.08em] text-ink-muted uppercase">
                      {actionKindLabel(action.kind)} ·{" "}
                      {urgencyLabels[action.urgency]}
                    </span>
                    {action.channel ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-ink-faint">
                        <ChannelIcon
                          channel={action.channel}
                          className="size-3"
                        />
                        {channelLabels[action.channel]}
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <Link
                      href={`/people/${action.contactId}`}
                      className="text-[16px] font-semibold tracking-[-0.015em] text-ink hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {action.contactName}
                    </Link>
                    <p className="text-[12px] text-ink-muted">
                      {[action.role, action.companyName]
                        .filter(Boolean)
                        .join(" · ") || "Relationship details pending"}
                    </p>
                  </div>

                  <p className="mt-3 max-w-3xl text-[13px] leading-5 text-ink-muted">
                    <span className="font-medium text-ink">
                      {action.rationaleSource === "model"
                        ? "Model rationale"
                        : "Why this is here"}
                      {action.confidence !== null
                        ? ` · ${Math.round(action.confidence * 100)}% confidence`
                        : ""}
                      :
                    </span>{" "}
                    {action.rationale}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-faint">
                    <span>
                      {action.touchCount} recorded{" "}
                      {action.touchCount === 1 ? "touch" : "touches"}
                    </span>
                    {action.lastTouchAt ? (
                      <span>
                        Last contact{" "}
                        {formatRelativeTime(
                          action.lastTouchAt,
                          data.generatedAt,
                        )}
                      </span>
                    ) : (
                      <span>No outreach recorded</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end sm:justify-start">
                  <div className="text-left sm:text-right">
                    <p className="text-[11px] text-ink-faint">Next touch</p>
                    <p className="mt-0.5 text-[12px] font-semibold text-ink tabular-nums">
                      {formatDueDate(action.dueAt, data.generatedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {action.suggestedDraft ? (
                      <CopySuggestionButton text={action.suggestedDraft} />
                    ) : null}
                    <Link
                      href={`/people/${action.contactId}`}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px] font-medium text-accent-strong transition-colors hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
                    >
                      Open
                      <ArrowRight
                        className="size-3.5"
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="border-y border-line py-9 text-center">
            <CheckCircle2
              className="mx-auto size-5 text-accent-strong"
              strokeWidth={1.6}
              aria-hidden="true"
            />
            <p className="mt-3 text-[13px] font-medium text-ink">
              No immediate actions.
            </p>
            <p className="mx-auto mt-1 max-w-lg text-[12px] leading-5 text-ink-muted">
              Planned outreach and follow-ups will appear here when they become
              timely.
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="outreach-summary-heading">
        <SectionHeading
          id="outreach-summary-heading"
          title="Outreach summary"
          description="Known relationship outcomes across every connected channel."
          meta={`Updated ${formatRelativeTime(data.generatedAt, data.generatedAt)}`}
        />
        <dl className="grid border-y border-line sm:grid-cols-3 xl:grid-cols-6">
          {metricDefinitions.map((metric, index) => {
            const value = data.metrics[metric.key];
            const displayValue =
              metric.key === "replyRate"
                ? `${value}%`
                : formatCompactNumber(value);

            return (
              <div
                key={metric.key}
                className={`py-4 sm:px-4 ${index > 0 ? "border-t border-line sm:border-t-0 sm:border-l" : ""} ${index >= 3 ? "sm:border-t xl:border-t-0" : ""} ${index === 3 ? "sm:border-l-0 xl:border-l" : ""}`}
              >
                <dt className="text-[11px] font-medium text-ink-muted">
                  {metric.label}
                </dt>
                <dd className="mt-1.5 text-[23px] font-semibold tracking-[-0.035em] text-ink tabular-nums">
                  {displayValue}
                </dd>
                <p className="mt-1 text-[10px] leading-4 text-ink-faint">
                  {metric.detail}
                </p>
              </div>
            );
          })}
        </dl>
      </section>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] xl:gap-14">
        <section aria-labelledby="channel-mix-heading">
          <SectionHeading
            id="channel-mix-heading"
            title="Channel mix"
            description="Outbound touches by source, not vanity activity."
            meta={`${totalChannelMessages} total`}
          />

          <figure className="border-y border-line py-2">
            <figcaption className="sr-only">
              Outbound outreach distribution by channel
            </figcaption>
            <div className="divide-y divide-line" aria-hidden="true">
              {data.channelMix.map((item) => (
                <div
                  key={item.channel}
                  className="grid grid-cols-[92px_minmax(0,1fr)_52px] items-center gap-3 py-3"
                >
                  <span className="inline-flex items-center gap-2 text-[12px] font-medium text-ink">
                    <ChannelIcon channel={item.channel} />
                    {channelLabels[item.channel]}
                  </span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-surface-subtle">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${item.share}%` }}
                    />
                  </span>
                  <span className="text-right text-[11px] text-ink-muted tabular-nums">
                    {item.count} · {item.share}%
                  </span>
                </div>
              ))}
            </div>
            <table className="sr-only">
              <caption>Outbound outreach by channel</caption>
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <th scope="col">Touches</th>
                  <th scope="col">Share</th>
                </tr>
              </thead>
              <tbody>
                {data.channelMix.map((item) => (
                  <tr key={item.channel}>
                    <th scope="row">{channelLabels[item.channel]}</th>
                    <td>{item.count}</td>
                    <td>{item.share}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </figure>
        </section>

        <section aria-labelledby="stale-heading">
          <SectionHeading
            id="stale-heading"
            title="Relationships going quiet"
            description="Active threads with no recorded touch in the last three weeks."
            meta={`${data.staleRelationships.length} shown`}
          />

          {data.staleRelationships.length > 0 ? (
            <div className="border-y border-line">
              {data.staleRelationships.map((relationship) => (
                <Link
                  key={relationship.contactId}
                  href={`/people/${relationship.contactId}`}
                  className="grid gap-1 border-b border-line py-3.5 transition-colors last:border-b-0 hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-5 sm:px-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-ink">
                      {relationship.contactName}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                      {[relationship.role, relationship.companyName]
                        .filter(Boolean)
                        .join(" · ") || "Relationship details pending"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-ink-faint sm:justify-end">
                    <span>{replyStateLabel(relationship.replyState)}</span>
                    <span className="tabular-nums">
                      {formatRelativeTime(
                        relationship.lastTouchAt,
                        data.generatedAt,
                      )}
                    </span>
                    <ArrowRight
                      className="size-3.5"
                      strokeWidth={1.7}
                      aria-hidden="true"
                    />
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="border-y border-line py-8 text-center">
              <UsersRound
                className="mx-auto size-5 text-ink-faint"
                strokeWidth={1.6}
                aria-hidden="true"
              />
              <p className="mt-3 text-[12px] text-ink-muted">
                No active relationships are stale.
              </p>
            </div>
          )}
        </section>
      </div>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1.45fr)_minmax(330px,0.55fr)] xl:gap-14">
        <section aria-labelledby="recent-conversations-heading">
          <SectionHeading
            id="recent-conversations-heading"
            title="Recent conversations"
            description="Latest source-grounded outreach and reply activity."
            meta={`${data.recentConversations.length} shown`}
          />

          {data.recentConversations.length > 0 ? (
            <div className="overflow-x-auto border-y border-line">
              <table className="w-full min-w-[660px] border-collapse text-left">
                <caption className="sr-only">
                  Recent customer outreach conversations
                </caption>
                <thead>
                  <tr className="border-b border-line text-[10px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
                    <th scope="col" className="py-2.5 pr-5">
                      Relationship
                    </th>
                    <th scope="col" className="px-3 py-2.5">
                      Latest context
                    </th>
                    <th scope="col" className="px-3 py-2.5">
                      State
                    </th>
                    <th scope="col" className="py-2.5 pl-3 text-right">
                      Updated
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentConversations.map((conversation) => (
                    <tr
                      key={conversation.id}
                      className="border-b border-line last:border-b-0"
                    >
                      <th
                        scope="row"
                        className="py-3.5 pr-5 align-top font-normal"
                      >
                        <div className="flex items-start gap-2.5">
                          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-[6px] bg-surface-subtle text-ink-muted">
                            <ChannelIcon
                              channel={conversation.channel}
                              className="size-3.5"
                            />
                            <span className="sr-only">
                              {channelLabels[conversation.channel]}
                            </span>
                          </span>
                          <div className="min-w-0">
                            {conversation.contactId ? (
                              <Link
                                href={`/people/${conversation.contactId}`}
                                className="block max-w-44 truncate text-[12px] font-medium text-ink hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                              >
                                {conversation.contactName}
                              </Link>
                            ) : (
                              <span className="block max-w-44 truncate text-[12px] font-medium text-ink">
                                {conversation.contactName}
                              </span>
                            )}
                            <span className="mt-0.5 block max-w-44 truncate text-[10px] text-ink-faint">
                              {conversation.companyName ||
                                channelLabels[conversation.channel]}
                            </span>
                          </div>
                        </div>
                      </th>
                      <td className="max-w-[360px] px-3 py-3.5 align-top">
                        <p className="truncate text-[12px] font-medium text-ink">
                          {conversation.subject || "Direct message"}
                        </p>
                        <p className="mt-1 line-clamp-1 text-[11px] text-ink-muted">
                          {conversation.preview ||
                            "No preview available from the source."}
                        </p>
                      </td>
                      <td className="px-3 py-3.5 align-top">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-muted">
                          {conversation.replyState === "replied" ? (
                            <MessageCircleReply
                              className="size-3.5 text-accent-strong"
                              strokeWidth={1.8}
                              aria-hidden="true"
                            />
                          ) : (
                            <Clock3
                              className="size-3.5 text-ink-faint"
                              strokeWidth={1.8}
                              aria-hidden="true"
                            />
                          )}
                          {replyStateLabel(conversation.replyState)}
                        </span>
                      </td>
                      <td className="py-3.5 pl-3 text-right align-top text-[11px] whitespace-nowrap text-ink-faint tabular-nums">
                        {formatRelativeTime(
                          conversation.lastMessageAt,
                          data.generatedAt,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="border-y border-line py-9 text-center">
              <Inbox
                className="mx-auto size-5 text-ink-faint"
                strokeWidth={1.6}
                aria-hidden="true"
              />
              <p className="mt-3 text-[12px] text-ink-muted">
                No customer outreach has been classified yet.
              </p>
            </div>
          )}
        </section>

        <section aria-labelledby="system-health-heading">
          <SectionHeading
            id="system-health-heading"
            title="System health"
            description="Source freshness and analysis queue status."
          />

          <div className="border-y border-line">
            {data.syncHealth.length > 0 ? (
              data.syncHealth.map((source) => (
                <div
                  key={source.id}
                  className="border-b border-line py-3.5 last:border-b-0"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2">
                      <StatusDot status={source.status} />
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ink">
                        <ChannelIcon channel={source.channel} />
                        {source.displayName}
                      </span>
                    </div>
                    <span className="text-[10px] font-medium text-ink-muted">
                      {source.statusLabel}
                    </span>
                  </div>
                  <p className="mt-1.5 pl-4 text-[11px] leading-4 text-ink-muted">
                    {source.detail}
                  </p>
                  <p className="mt-1 pl-4 text-[10px] text-ink-faint">
                    {source.lastSyncedAt
                      ? `Last synced ${formatRelativeTime(source.lastSyncedAt, data.generatedAt)}`
                      : "No successful sync recorded"}
                  </p>
                </div>
              ))
            ) : (
              <div className="py-5">
                <p className="text-[12px] font-medium text-ink">
                  No sources connected
                </p>
                <p className="mt-1 text-[11px] leading-4 text-ink-muted">
                  Connect a read-only source to begin building relationship
                  history.
                </p>
                <Link
                  href="/settings"
                  className="mt-3 inline-flex min-h-8 items-center gap-1 text-[11px] font-semibold text-accent-strong hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Open settings
                  <ArrowRight
                    className="size-3"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                </Link>
              </div>
            )}
          </div>

          <div className="mt-4 border-y border-line py-3.5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <AnalysisStatusIcon status={data.analysisHealth.status} />
                <p className="text-[12px] font-medium text-ink">
                  Analysis queue
                </p>
              </div>
              <span className="text-[10px] font-medium text-ink-muted">
                {data.analysisHealth.status === "working"
                  ? "Working"
                  : data.analysisHealth.status === "attention"
                    ? "Needs attention"
                    : "Caught up"}
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-ink-muted">
              {data.analysisHealth.detail}
            </p>
            <dl className="mt-3 grid grid-cols-4 gap-2 border-t border-line pt-3 text-center">
              {[
                ["Queued", data.analysisHealth.queued],
                ["Running", data.analysisHealth.running],
                ["Failed", data.analysisHealth.failed],
                ["Done", data.analysisHealth.succeeded],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[9px] text-ink-faint">{label}</dt>
                  <dd className="mt-0.5 text-[12px] font-semibold text-ink tabular-nums">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            {data.analysisHealth.oldestQueuedAt ? (
              <p className="mt-3 flex items-center gap-1.5 text-[10px] text-ink-faint">
                <CalendarClock
                  className="size-3"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                Oldest queued{" "}
                {formatRelativeTime(
                  data.analysisHealth.oldestQueuedAt,
                  data.generatedAt,
                )}
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
