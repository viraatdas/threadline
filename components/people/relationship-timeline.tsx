import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarClock,
  FilePenLine,
  Link2,
  Mail,
  MessageCircle,
  StickyNote,
} from "lucide-react";

import { channelLabel, formatDateTime } from "@/components/people/formatters";
import { EvidenceBadge, ReplyBadge } from "@/components/people/status-badge";
import type { TimelineItem } from "@/components/people/types";

function TimelineIcon({ item }: { item: TimelineItem }) {
  if (item.kind === "planned_follow_up") return CalendarClock;
  if (item.kind === "note") return StickyNote;
  if (item.kind === "draft") return FilePenLine;
  if (item.channel === "gmail") return Mail;
  if (item.channel === "linkedin") return Link2;
  return MessageCircle;
}

export function RelationshipTimeline({ items }: { items: TimelineItem[] }) {
  const orderedItems = items.toSorted(
    (left, right) =>
      new Date(right.happenedAt).getTime() -
      new Date(left.happenedAt).getTime(),
  );

  if (!orderedItems.length) {
    return (
      <div className="border-y border-line py-12 text-center">
        <MessageCircle
          className="mx-auto size-5 text-ink-faint"
          strokeWidth={1.6}
          aria-hidden="true"
        />
        <p className="mt-4 text-[14px] font-medium text-ink">
          No cross-channel history yet.
        </p>
        <p className="mx-auto mt-1 max-w-sm text-[13px] leading-5 text-ink-muted">
          Read-only messages and manual relationship notes will appear here in
          chronological order.
        </p>
      </div>
    );
  }

  return (
    <ol
      className="border-y border-line"
      aria-label="Cross-channel relationship timeline"
    >
      {orderedItems.map((item, index) => {
        const Icon = TimelineIcon({ item });
        const DirectionIcon =
          item.direction === "inbound"
            ? ArrowDownLeft
            : item.direction === "outbound"
              ? ArrowUpRight
              : null;
        return (
          <li
            key={item.id}
            className="relative grid grid-cols-[36px_minmax(0,1fr)] gap-3 border-b border-line py-5 last:border-b-0 sm:grid-cols-[46px_minmax(0,1fr)_150px] sm:gap-4"
          >
            {index < orderedItems.length - 1 ? (
              <span
                aria-hidden="true"
                className="absolute top-10 bottom-[-20px] left-[17px] w-px bg-line sm:left-[22px]"
              />
            ) : null}
            <span className="relative z-10 grid size-9 place-items-center rounded-full border border-line bg-background text-ink-muted sm:size-11">
              <Icon className="size-4" strokeWidth={1.7} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[13px] font-semibold text-ink">
                  {item.title}
                </h3>
                {DirectionIcon ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-ink-faint">
                    <DirectionIcon
                      className="size-3"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                    {item.direction === "inbound" ? "Inbound" : "Outbound"}
                  </span>
                ) : null}
              </div>
              <p className="mt-1.5 max-w-2xl text-[13px] leading-5 text-ink-muted">
                {item.summary}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <EvidenceBadge kind={item.provenance.kind} />
                {item.replyState !== "not_applicable" ? (
                  <ReplyBadge state={item.replyState} />
                ) : null}
              </div>
            </div>
            <div className="col-start-2 text-[11px] leading-5 text-ink-faint sm:col-start-3 sm:row-start-1 sm:text-right">
              <time dateTime={item.happenedAt}>
                {formatDateTime(item.happenedAt)}
              </time>
              <p>{channelLabel(item.channel)}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
