"use client";

import { ChevronRight, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ChannelMark } from "@/components/people/channel-mark";
import {
  emailParties,
  formatRelativeDate,
  initials,
} from "@/components/people/formatters";
import { ReplyBadge } from "@/components/people/status-badge";
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
  onMoveStage?: (person: PersonRecord, stage: RelationshipStage) => void;
  onDelete?: (person: PersonRecord) => void;
}

function companyNameFor(person: PersonRecord, companies: CompanyRecord[]) {
  const match = companies.find((company) => company.id === person.companyId);
  return match?.name ?? person.company.value;
}

export function PeopleBoard({
  people,
  companies,
  generatedAt,
  onMoveStage,
  onDelete,
}: PeopleBoardProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<RelationshipStage | null>(
    null,
  );
  const [outreachOnly, setOutreachOnly] = useState(true);
  const canMove = Boolean(onMoveStage);

  // A genuine conversation is one you took part in: you emailed them
  // (outbound), they replied to you, or you added/edited them by hand.
  // Pure inbound mail (newsletters, promos, cold inbound) is filtered out.
  const isConversation = (person: PersonRecord) =>
    person.outboundTouchCount > 0 ||
    person.replyState === "replied" ||
    person.hasManualOverride;
  const hiddenCount = people.filter(
    (person) => !isConversation(person),
  ).length;
  const shownPeople = outreachOnly ? people.filter(isConversation) : people;

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
          {hiddenCount > 0 ? (
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-muted">
              <input
                type="checkbox"
                checked={outreachOnly}
                onChange={(event) => setOutreachOnly(event.target.checked)}
                className="size-3.5 accent-accent"
              />
              My conversations only
              <span className="text-ink-faint">({hiddenCount} inbound hidden)</span>
            </label>
          ) : null}
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
                        className={`rounded-[8px] border border-line bg-background p-2.5 transition-shadow ${
                          canMove ? "cursor-grab active:cursor-grabbing" : ""
                        } ${
                          draggedId === person.id
                            ? "opacity-50"
                            : "hover:shadow-[0_1px_3px_rgba(20,30,40,0.08)]"
                        }`}
                      >
                        <div className="flex items-start gap-2.5">
                          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-subtle text-[10px] font-semibold text-ink-muted">
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

                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <ReplyBadge state={person.replyState} />
                          {person.identities.map((identity) => (
                            <ChannelMark
                              key={identity.id}
                              channel={identity.channel}
                            />
                          ))}
                        </div>

                        <div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-2 text-[11px] text-ink-faint">
                          <span className="tabular-nums">
                            {person.touchCount} touches
                          </span>
                          <span>
                            {person.lastTouchAt
                              ? `Last ${formatRelativeDate(
                                  person.lastTouchAt,
                                  generatedAt,
                                ).toLowerCase()}`
                              : "No activity"}
                          </span>
                        </div>

                        {person.recentMessages[0] ? (
                          <div className="mt-2 rounded-[6px] border border-line bg-surface-subtle p-2">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="flex min-w-0 items-baseline gap-1">
                                <span
                                  aria-hidden="true"
                                  className="shrink-0 text-ink-faint"
                                >
                                  {person.recentMessages[0].direction ===
                                  "outbound"
                                    ? "↑"
                                    : person.recentMessages[0].direction ===
                                        "inbound"
                                      ? "↓"
                                      : "•"}
                                </span>
                                <span className="truncate text-[11px] font-semibold text-ink">
                                  {person.recentMessages[0].subject}
                                </span>
                              </span>
                              <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
                                {formatRelativeDate(
                                  person.recentMessages[0].at,
                                  generatedAt,
                                )}
                              </span>
                            </div>
                            <p className="mt-0.5 truncate text-[10px] text-ink-faint">
                              {person.recentMessages[0].direction === "outbound"
                                ? `to ${
                                    emailParties(
                                      "outbound",
                                      person.displayName,
                                      person.primaryEmail,
                                    ).to
                                  }`
                                : `from ${
                                    emailParties(
                                      person.recentMessages[0].direction,
                                      person.displayName,
                                      person.primaryEmail,
                                    ).from
                                  }`}
                            </p>
                            <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-ink-muted">
                              {person.recentMessages[0].snippet}
                            </p>
                            {person.recentMessages.length > 1 ? (
                              <p className="mt-1 text-[10px] text-ink-faint">
                                +{person.recentMessages.length - 1} earlier
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {canMove ? (
                          <label className="mt-2 block">
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
                              className="h-7 w-full rounded-[6px] border border-line bg-surface-subtle px-1.5 text-[11px] text-ink-muted focus-visible:outline-2 focus-visible:outline-accent"
                            >
                              {RELATIONSHIP_STAGE_VALUES.map((stage) => (
                                <option key={stage} value={stage}>
                                  Stage: {stageLabel(stage)}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
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
