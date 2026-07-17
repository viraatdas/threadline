"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ChannelMark } from "@/components/people/channel-mark";
import { formatRelativeDate, initials } from "@/components/people/formatters";
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
  { stage: "unreviewed", label: "Unreviewed", hint: "New from sync, not yet triaged" },
  { stage: "planned", label: "Planned", hint: "Outreach intended, not started" },
  { stage: "active", label: "Active", hint: "Conversation in progress" },
  { stage: "waiting", label: "Waiting", hint: "Awaiting their reply" },
  { stage: "replied", label: "Replied", hint: "They responded" },
  { stage: "dormant", label: "Dormant", hint: "Gone quiet, may revisit" },
  { stage: "closed", label: "Closed", hint: "No further follow-up planned" },
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
}: PeopleBoardProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<RelationshipStage | null>(
    null,
  );
  const canMove = Boolean(onMoveStage);

  const grouped = new Map<RelationshipStage, PersonRecord[]>(
    STAGE_COLUMNS.map((column) => [column.stage, [] as PersonRecord[]]),
  );
  for (const person of people) {
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
      <div className="flex items-baseline justify-between gap-4">
        <h2
          id="board-results-heading"
          className="text-[14px] font-semibold text-ink"
        >
          {people.length} relationships by stage
        </h2>
        <p className="text-[11px] text-ink-faint">
          {canMove
            ? "Drag a card between columns, or use its stage menu, to update the pipeline"
            : "Read-only preview of the relationship pipeline"}
        </p>
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
                          <Link
                            href={`/people/${person.id}`}
                            aria-label={`Open ${person.displayName}`}
                            className="grid size-6 shrink-0 place-items-center rounded-[6px] text-ink-faint hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                          >
                            <ChevronRight
                              className="size-4"
                              strokeWidth={1.8}
                              aria-hidden="true"
                            />
                          </Link>
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
