"use client";

import { ChevronRight, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ChannelMark } from "@/components/people/channel-mark";
import {
  avatarHue,
  followUpStatus,
  formatTimeAgo,
  initials,
  isNoiseEmail,
} from "@/components/people/formatters";
import type {
  CompanyRecord,
  PersonRecord,
} from "@/components/people/types";
import { RELATIONSHIP_STAGE_VALUES } from "@/lib/domain/constants";
import type { RelationshipStage } from "@/lib/domain/constants";

interface StageColumn {
  stage: RelationshipStage;
  label: string;
  hint: string;
}

const STAGE_COLUMNS: StageColumn[] = [
  { stage: "planned", label: "Planned", hint: "Outreach intended, not sent yet" },
  { stage: "waiting", label: "Waiting for reply", hint: "You reached out, no reply yet" },
  { stage: "replied", label: "Replied", hint: "They replied — active conversation" },
  { stage: "active", label: "Active", hint: "Ongoing back-and-forth" },
  { stage: "dormant", label: "Dormant", hint: "Gone quiet, may revisit" },
  { stage: "closed", label: "Closed", hint: "No further follow-up" },
  { stage: "unreviewed", label: "Unreviewed", hint: "New, not yet triaged" },
];

export function stageLabel(stage: RelationshipStage): string {
  return (
    STAGE_COLUMNS.find((column) => column.stage === stage)?.label ?? stage
  );
}

interface PeopleBoardProps {
  people: PersonRecord[];
  companies: CompanyRecord[];
  generatedAt: string;
  ownerDomain?: string | null;
  onMoveStage?: (person: PersonRecord, stage: RelationshipStage) => void;
  onDelete?: (person: PersonRecord) => void;
}

type BoardLens = "outreach" | "conversations" | "all";

// A conversation the owner took part in: they emailed the person, got a
// reply, or added the person by hand.
function isConversation(person: PersonRecord): boolean {
  return (
    person.outboundTouchCount > 0 ||
    person.replyState === "replied" ||
    person.hasManualOverride
  );
}

// The default lens: outreach the owner STARTED — the earliest stored message
// went from them to a real person outside their own company. This is the
// cold-outreach pipeline (pitch → reply → follow-up); inbound-first threads,
// teammates, and bulk senders live behind the wider lenses.
export function isOutreach(
  person: PersonRecord,
  ownerDomain: string | null,
): boolean {
  if (person.hasManualOverride) return true;
  if (isNoiseEmail(person.primaryEmail)) return false;
  const domain = person.primaryEmail?.split("@")[1]?.toLowerCase() ?? null;
  if (ownerDomain && domain === ownerDomain.toLowerCase()) return false;
  const messages = person.timeline.filter(
    (item) => item.kind === "message" || item.kind === "reply",
  );
  // Timeline is newest-first, so the last entry is the thread's origin.
  const earliest = messages[messages.length - 1];
  return earliest?.direction === "outbound";
}

function companyNameFor(person: PersonRecord, companies: CompanyRecord[]) {
  const match = companies.find((company) => company.id === person.companyId);
  return match?.name ?? person.company.value;
}

export function PeopleBoard({
  people,
  companies,
  generatedAt,
  ownerDomain = null,
  onMoveStage,
  onDelete,
}: PeopleBoardProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<RelationshipStage | null>(
    null,
  );
  const [lens, setLens] = useState<BoardLens>("outreach");
  const canMove = Boolean(onMoveStage);

  const outreachPeople = people.filter((person) =>
    isOutreach(person, ownerDomain),
  );
  const conversationPeople = people.filter(isConversation);
  const shownPeople =
    lens === "outreach"
      ? outreachPeople
      : lens === "conversations"
        ? conversationPeople
        : people;

  const grouped = new Map<RelationshipStage, PersonRecord[]>(
    STAGE_COLUMNS.map((column) => [column.stage, [] as PersonRecord[]]),
  );
  for (const person of shownPeople) {
    const bucket = grouped.get(person.relationshipStage);
    if (bucket) bucket.push(person);
    else grouped.set(person.relationshipStage, [person]);
  }

  function move(personId: string, stage: RelationshipStage) {
    const person = people.find((item) => item.id === personId);
    if (!person || person.relationshipStage === stage) return;
    onMoveStage?.(person, stage);
  }

  return (
    <section aria-labelledby="board-results-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2
          id="board-results-heading"
          className="text-[14px] font-semibold text-ink"
        >
          {shownPeople.length} relationships by stage
        </h2>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
            Show
            <select
              value={lens}
              onChange={(event) => setLens(event.target.value as BoardLens)}
              className="h-6 cursor-pointer rounded-[6px] border border-line bg-background px-1.5 text-[11px] text-ink focus-visible:outline-2 focus-visible:outline-accent"
            >
              <option value="outreach">
                Outreach I started ({outreachPeople.length})
              </option>
              <option value="conversations">
                All conversations ({conversationPeople.length})
              </option>
              <option value="all">Everything ({people.length})</option>
            </select>
          </label>
          <p className="hidden text-[11px] text-ink-faint sm:block">
            {canMove
              ? "Drag a card between columns to update the pipeline"
              : "Read-only preview"}
          </p>
        </div>
      </div>

      <div className="-mx-1 overflow-x-auto pb-2">
        <div className="flex min-w-max gap-3 px-1">
          {STAGE_COLUMNS.map((column) => {
            const columnPeople = grouped.get(column.stage) ?? [];
            const isDropTarget = dragOverStage === column.stage;
            return (
              <div
                key={column.stage}
                className={`flex w-[264px] shrink-0 flex-col rounded-[10px] border bg-surface-subtle transition-colors ${
                  isDropTarget
                    ? "border-accent/50 bg-accent-subtle"
                    : "border-line"
                }`}
                onDragOver={(event) => {
                  if (!canMove || !draggedId) return;
                  event.preventDefault();
                  setDragOverStage(column.stage);
                }}
                onDragLeave={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node))
                    return;
                  setDragOverStage((current) =>
                    current === column.stage ? null : current,
                  );
                }}
                onDrop={(event) => {
                  if (!canMove || !draggedId) return;
                  event.preventDefault();
                  move(draggedId, column.stage);
                  setDraggedId(null);
                  setDragOverStage(null);
                }}
              >
                <div className="flex items-baseline justify-between gap-2 border-b border-line px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-ink">
                      {column.label}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-ink-faint">
                      {column.hint}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-[11px] font-semibold text-ink-muted tabular-nums shadow-[inset_0_0_0_1px_var(--line)]">
                    {columnPeople.length}
                  </span>
                </div>

                <div className="flex-1 space-y-2 p-2">
                  {columnPeople.length === 0 ? (
                    <p className="px-1 py-6 text-center text-[11px] text-ink-faint">
                      No relationships here.
                    </p>
                  ) : (
                    columnPeople.map((person) => (
                      <article
                        key={person.id}
                        draggable={canMove}
                        onDragStart={(event) => {
                          if (!canMove) return;
                          setDraggedId(person.id);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", person.id);
                        }}
                        onDragEnd={() => {
                          setDraggedId(null);
                          setDragOverStage(null);
                        }}
                        className={`rounded-[8px] border border-line bg-background p-3 transition-shadow ${
                          canMove ? "cursor-grab active:cursor-grabbing" : ""
                        } ${
                          draggedId === person.id
                            ? "opacity-50"
                            : "hover:shadow-[0_1px_3px_rgba(20,30,40,0.08)]"
                        }`}
                      >
                        <div className="flex items-start gap-2.5">
                          <span
                            className="grid size-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold"
                            style={{
                              background: `oklch(0.94 0.045 ${avatarHue(person.displayName)})`,
                              color: `oklch(0.42 0.09 ${avatarHue(person.displayName)})`,
                            }}
                          >
                            {initials(person.displayName)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <Link
                              href={`/people/${person.id}`}
                              className="block truncate text-[13px] font-semibold text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            >
                              {person.displayName}
                            </Link>
                            <p className="mt-0.5 truncate text-[11px] text-ink-muted">
                              {person.title.value} ·{" "}
                              {companyNameFor(person, companies)}
                            </p>
                          </div>
                          <span className="flex shrink-0 items-center">
                            {onDelete ? (
                              <button
                                type="button"
                                aria-label={`Delete ${person.displayName}`}
                                onClick={() => onDelete(person)}
                                className="grid size-6 place-items-center rounded-[6px] text-ink-faint hover:bg-danger/10 hover:text-danger focus-visible:outline-2 focus-visible:outline-accent"
                              >
                                <Trash2
                                  className="size-3.5"
                                  strokeWidth={1.8}
                                  aria-hidden="true"
                                />
                              </button>
                            ) : null}
                            <Link
                              href={`/people/${person.id}`}
                              aria-label={`Open ${person.displayName}`}
                              className="grid size-6 place-items-center rounded-[6px] text-ink-faint hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                            >
                              <ChevronRight
                                className="size-4"
                                strokeWidth={1.8}
                                aria-hidden="true"
                              />
                            </Link>
                          </span>
                        </div>

                        {person.recentMessages[0] ? (
                          <Link
                            href={`/people/${person.id}`}
                            className="mt-2.5 block rounded-[6px] bg-surface-subtle p-2 transition-colors hover:bg-accent-subtle/60 focus-visible:outline-2 focus-visible:outline-accent"
                          >
                            <div className="flex items-baseline gap-1.5">
                              <span
                                aria-hidden="true"
                                className="shrink-0 text-[11px] text-ink-faint"
                                title={
                                  person.recentMessages[0].direction ===
                                  "outbound"
                                    ? "You sent this"
                                    : "They sent this"
                                }
                              >
                                {person.recentMessages[0].direction ===
                                "outbound"
                                  ? "↑"
                                  : person.recentMessages[0].direction ===
                                      "inbound"
                                    ? "↓"
                                    : "•"}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">
                                {person.recentMessages[0].subject}
                              </span>
                              <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
                                {formatTimeAgo(
                                  person.recentMessages[0].at,
                                  generatedAt,
                                )}
                              </span>
                            </div>
                            <p className="mt-1 line-clamp-2 text-[11px] leading-[1.5] text-ink-muted">
                              {person.recentMessages[0].snippet}
                            </p>
                            {person.recentMessages.length > 1 ? (
                              <p className="mt-1 text-[10px] text-ink-faint">
                                +{person.recentMessages.length - 1} earlier in
                                thread
                              </p>
                            ) : null}
                          </Link>
                        ) : (
                          <p className="mt-2.5 rounded-[6px] bg-surface-subtle p-2 text-[11px] text-ink-faint">
                            No email context yet — history is still syncing.
                          </p>
                        )}

                        {(() => {
                          const status = followUpStatus(person, generatedAt);
                          return (
                            <p className="mt-2 flex items-center gap-1.5 text-[11px]">
                              <span
                                aria-hidden="true"
                                className={`size-1.5 shrink-0 rounded-full ${
                                  status.tone === "attention"
                                    ? "bg-warning"
                                    : status.tone === "positive"
                                      ? "bg-accent"
                                      : "bg-ink-faint/60"
                                }`}
                              />
                              <span
                                className={
                                  status.tone === "neutral"
                                    ? "text-ink-muted"
                                    : "font-medium text-ink"
                                }
                              >
                                {status.label}
                              </span>
                            </p>
                          );
                        })()}

                        <div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-2">
                          <span className="flex items-center gap-1.5">
                            {person.identities.map((identity) => (
                              <ChannelMark
                                key={identity.id}
                                channel={identity.channel}
                              />
                            ))}
                            <span className="text-[10px] tabular-nums text-ink-faint">
                              {person.touchCount} touches
                            </span>
                          </span>
                          {canMove ? (
                            <label className="min-w-0">
                              <span className="sr-only">
                                Move {person.displayName} to a stage
                              </span>
                              <select
                                value={person.relationshipStage}
                                onChange={(event) =>
                                  move(
                                    person.id,
                                    event.target.value as RelationshipStage,
                                  )
                                }
                                className="h-6 max-w-[120px] cursor-pointer rounded-[6px] border border-transparent bg-transparent px-1 text-[10px] text-ink-faint transition-colors hover:border-line hover:text-ink-muted focus-visible:outline-2 focus-visible:outline-accent"
                              >
                                {RELATIONSHIP_STAGE_VALUES.map((stage) => (
                                  <option key={stage} value={stage}>
                                    Stage: {stageLabel(stage)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
