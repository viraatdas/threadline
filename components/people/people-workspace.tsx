"use client";

import {
  Building2,
  ChevronRight,
  ContactRound,
  Filter,
  GitMerge,
  Plus,
  Search,
  UserRoundPlus,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { ChannelMark } from "@/components/people/channel-mark";
import {
  confidenceLabel,
  formatRelativeDate,
  initials,
} from "@/components/people/formatters";
import {
  Modal,
  controlClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/people/modal";
import { ReplyBadge } from "@/components/people/status-badge";
import type {
  CompanyRecord,
  PeopleFilters,
  PeopleWorkspaceData,
  PersonRecord,
} from "@/components/people/types";
import { UndoNotice } from "@/components/people/undo-notice";
import { PageHeader } from "@/components/shell";
import type {
  AddContactAction,
  MergeContactsAction,
} from "@/components/workspace-actions";
import { workspaceActionError } from "@/components/workspace-actions";

interface PeopleWorkspaceProps {
  data: PeopleWorkspaceData;
  initialFilters: PeopleFilters;
  initialMergeSourceId?: string;
  addContactAction?: AddContactAction;
  mergeContactsAction?: MergeContactsAction;
}

interface UndoState {
  people: PersonRecord[];
  message: string;
}

function writeFilters(filters: PeopleFilters) {
  const url = new URL(window.location.href);
  const entries = Object.entries(filters) as [keyof PeopleFilters, string][];

  for (const [key, value] of entries) {
    const isDefault =
      (key === "query" && value === "") ||
      (key === "view" && value === "people") ||
      value === "all";
    if (isDefault) url.searchParams.delete(key === "query" ? "q" : key);
    else url.searchParams.set(key === "query" ? "q" : key, value);
  }

  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function companyFor(person: PersonRecord, companies: CompanyRecord[]) {
  return companies.find((company) => company.id === person.companyId) ?? null;
}

function makeManualPerson(formData: FormData): PersonRecord {
  const displayName = String(formData.get("displayName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const company =
    String(formData.get("company") ?? "Independent").trim() || "Independent";
  const title =
    String(formData.get("title") ?? "Role not set").trim() || "Role not set";
  const now = new Date().toISOString();
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `manual-${Date.now()}`;

  return {
    id,
    displayName,
    primaryEmail: email || null,
    companyId: null,
    title: {
      value: title,
      kind: "override",
      confidence: 1,
      evidence: [],
      overrides: [
        {
          field: "title",
          value: title,
          reason: "Added manually.",
          overriddenAt: now,
          overriddenBy: "owner@threadline.local",
        },
      ],
    },
    company: {
      value: company,
      kind: "override",
      confidence: 1,
      evidence: [],
      overrides: [
        {
          field: "company",
          value: company,
          reason: "Added manually.",
          overriddenAt: now,
          overriddenBy: "owner@threadline.local",
        },
      ],
    },
    location: {
      value: "Not set",
      kind: "override",
      confidence: 1,
      evidence: [],
      overrides: [],
    },
    relationshipStage: "planned",
    replyState: "unknown",
    firstTouchAt: null,
    lastTouchAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    plannedFollowUpAt: null,
    touchCount: 0,
    inboundTouchCount: 0,
    outboundTouchCount: 0,
    confidence: 1,
    notes: "Added manually. No source messages are attached yet.",
    hasManualOverride: true,
    identities: [],
    timeline: [],
    audit: [
      {
        id: `${id}-audit`,
        occurredAt: now,
        actor: "owner@threadline.local",
        action: "Relationship added",
        detail: "Created manually inside Threadline.",
        outcome: "success",
      },
    ],
    sourceProvenance: [],
  };
}

function EmptyRows({
  view,
  hasFilters,
}: {
  view: PeopleFilters["view"];
  hasFilters: boolean;
}) {
  const Icon = view === "people" ? ContactRound : Building2;
  return (
    <div className="border-y border-line py-14 text-center">
      <Icon
        className="mx-auto size-5 text-ink-faint"
        strokeWidth={1.6}
        aria-hidden="true"
      />
      <p className="mt-4 text-[14px] font-medium text-ink">
        {hasFilters
          ? "No matches in this view."
          : view === "people"
            ? "No people yet."
            : "No companies yet."}
      </p>
      <p className="mx-auto mt-1 max-w-md text-[13px] leading-5 text-ink-muted">
        {hasFilters
          ? "Try clearing a filter or using a broader search term."
          : "Relationships appear after read-only sources sync, or you can add one manually."}
      </p>
    </div>
  );
}

export function PeopleWorkspace({
  data,
  initialFilters,
  initialMergeSourceId,
  addContactAction,
  mergeContactsAction,
}: PeopleWorkspaceProps) {
  const [people, setPeople] = useState(data.people);
  const [filters, setFilters] = useState(initialFilters);
  const [addOpen, setAddOpen] = useState(false);
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(
    initialMergeSourceId ?? null,
  );
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function updateFilters(patch: Partial<PeopleFilters>) {
    setFilters((current) => {
      const next = { ...current, ...patch };
      writeFilters(next);
      return next;
    });
  }

  const visiblePeople = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    return people.filter((person) => {
      const channels = person.identities.map((identity) => identity.channel);
      const searchable =
        `${person.displayName} ${person.primaryEmail ?? ""} ${person.title.value} ${person.company.value}`.toLowerCase();
      const confidenceMatches =
        filters.confidence === "all" ||
        (filters.confidence === "review"
          ? person.confidence < 0.85
          : person.confidence >= 0.9);
      return (
        (!query || searchable.includes(query)) &&
        (filters.reply === "all" || person.replyState === filters.reply) &&
        (filters.channel === "all" || channels.includes(filters.channel)) &&
        confidenceMatches
      );
    });
  }, [filters, people]);

  const visibleCompanies = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    return data.companies.filter((company) => {
      const searchable =
        `${company.name} ${company.domain ?? ""} ${company.industry.value} ${company.location.value}`.toLowerCase();
      const replyMatches =
        filters.reply === "all" ||
        (filters.reply === "replied" && company.repliedCount > 0) ||
        (filters.reply === "awaiting_reply" && company.awaitingReplyCount > 0);
      const confidenceMatches =
        filters.confidence === "all" ||
        (filters.confidence === "review"
          ? company.confidence < 0.85
          : company.confidence >= 0.9);
      return (
        (!query || searchable.includes(query)) &&
        replyMatches &&
        (filters.channel === "all" ||
          company.channelMix.includes(filters.channel)) &&
        confidenceMatches
      );
    });
  }, [data.companies, filters]);

  function handleAdd(formData: FormData) {
    const snapshot = people;
    const person = makeManualPerson(formData);
    setActionError(null);
    setPeople((current) => [person, ...current]);
    setAddOpen(false);

    if (!addContactAction) {
      setUndo({
        people: snapshot,
        message: `${person.displayName} was added manually.`,
      });
      return;
    }

    setUndo(null);
    void (async () => {
      try {
        const result = await addContactAction(formData);
        const error = workspaceActionError(
          result,
          "The relationship could not be added.",
        );
        if (error) {
          setPeople(snapshot);
          setActionError(error);
          return;
        }
        if (result.ok) {
          setPeople((current) =>
            current.map((item) =>
              item.id === person.id
                ? {
                    ...item,
                    id: result.data.contactId,
                    companyId: result.data.companyId,
                    audit: item.audit.map((entry, index) =>
                      index === 0
                        ? {
                            ...entry,
                            actor: result.data.actorEmail,
                            occurredAt: result.data.occurredAt,
                          }
                        : entry,
                    ),
                  }
                : item,
            ),
          );
        }
      } catch {
        setPeople(snapshot);
        setActionError(
          "The relationship could not be added. Check your connection and try again.",
        );
      }
    })();
  }

  function handleMerge() {
    if (!mergeSourceId || !mergeTargetId || mergeSourceId === mergeTargetId)
      return;
    const source = people.find((person) => person.id === mergeSourceId);
    const target = people.find((person) => person.id === mergeTargetId);
    if (!source || !target) return;

    const snapshot = people;
    setActionError(null);
    const mergedTarget: PersonRecord = {
      ...target,
      touchCount: target.touchCount + source.touchCount,
      inboundTouchCount: target.inboundTouchCount + source.inboundTouchCount,
      outboundTouchCount: target.outboundTouchCount + source.outboundTouchCount,
      identities: [
        ...target.identities,
        ...source.identities.filter(
          (identity) =>
            !target.identities.some((item) => item.id === identity.id),
        ),
      ],
      timeline: [...target.timeline, ...source.timeline].toSorted(
        (left, right) =>
          new Date(right.happenedAt).getTime() -
          new Date(left.happenedAt).getTime(),
      ),
      hasManualOverride: true,
      audit: [
        {
          id: `merge-${Date.now()}`,
          occurredAt: new Date().toISOString(),
          actor: "owner@threadline.local",
          action: "Relationships merged",
          detail: `Merged ${source.displayName} into this relationship.`,
          outcome: "success",
        },
        ...target.audit,
      ],
    };

    setPeople((current) =>
      current
        .filter((person) => person.id !== source.id)
        .map((person) => (person.id === target.id ? mergedTarget : person)),
    );
    setMergeSourceId(null);
    setMergeTargetId("");

    if (!mergeContactsAction) {
      setUndo({
        people: snapshot,
        message: `${source.displayName} was merged into ${target.displayName}.`,
      });
      return;
    }

    setUndo(null);
    void (async () => {
      try {
        const result = await mergeContactsAction(source.id, target.id);
        const error = workspaceActionError(
          result,
          "The relationships could not be merged.",
        );
        if (error) {
          setPeople(snapshot);
          setActionError(error);
        }
      } catch {
        setPeople(snapshot);
        setActionError(
          "The relationships could not be merged. Check your connection and try again.",
        );
      }
    })();
  }

  const hasFilters =
    filters.query !== "" ||
    filters.reply !== "all" ||
    filters.channel !== "all" ||
    filters.confidence !== "all";
  const mergeSource =
    people.find((person) => person.id === mergeSourceId) ?? null;

  return (
    <div className="space-y-8">
      {actionError ? (
        <p
          role="alert"
          className="rounded-[8px] border border-danger/30 bg-danger/5 px-3 py-2.5 text-[12px] text-danger"
        >
          {actionError}
        </p>
      ) : null}
      <PageHeader
        eyebrow="Relationship workspace"
        title="People and companies"
        description="Inspect source-grounded identity, cross-channel history, and the next thoughtful follow-up. Model conclusions remain reviewable and external sources stay read-only."
        action={
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className={primaryButtonClass}
          >
            <UserRoundPlus
              className="size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Add person
          </button>
        }
      />

      <section aria-label="Relationship filters" className="space-y-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div
            className="inline-flex w-fit rounded-[8px] border border-line bg-surface-subtle p-1"
            aria-label="Relationship view"
          >
            {(["people", "companies"] as const).map((view) => (
              <button
                key={view}
                type="button"
                aria-pressed={filters.view === view}
                onClick={() => updateFilters({ view })}
                className={
                  filters.view === view
                    ? "min-h-8 rounded-[6px] bg-background px-3 text-[12px] font-semibold text-ink shadow-[inset_0_0_0_1px_var(--line)]"
                    : "min-h-8 rounded-[6px] px-3 text-[12px] font-medium text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                }
              >
                {view === "people"
                  ? `People · ${people.length}`
                  : `Companies · ${data.companies.length}`}
              </button>
            ))}
          </div>

          <div className="relative min-w-0 flex-1 xl:max-w-[420px]">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <input
              type="search"
              aria-label={`Search ${filters.view}`}
              value={filters.query}
              onChange={(event) => updateFilters({ query: event.target.value })}
              placeholder={
                filters.view === "people"
                  ? "Search name, company, role, or email"
                  : "Search company, industry, or domain"
              }
              className={`${controlClass} pl-9`}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-y border-line py-3">
          <span className="mr-1 inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
            <Filter className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
            Filter
          </span>
          <label className="sr-only" htmlFor="reply-filter">
            Reply state
          </label>
          <select
            id="reply-filter"
            className="h-8 rounded-[6px] border border-line bg-background px-2 text-[12px] text-ink"
            value={filters.reply}
            onChange={(event) =>
              updateFilters({
                reply: event.target.value as PeopleFilters["reply"],
              })
            }
          >
            <option value="all">All reply states</option>
            <option value="replied">Replied</option>
            <option value="awaiting_reply">Awaiting reply</option>
            <option value="unknown">Unknown</option>
          </select>
          <label className="sr-only" htmlFor="channel-filter">
            Channel
          </label>
          <select
            id="channel-filter"
            className="h-8 rounded-[6px] border border-line bg-background px-2 text-[12px] text-ink"
            value={filters.channel}
            onChange={(event) =>
              updateFilters({
                channel: event.target.value as PeopleFilters["channel"],
              })
            }
          >
            <option value="all">All channels</option>
            <option value="gmail">Gmail</option>
            <option value="linkedin">LinkedIn</option>
            <option value="x">X</option>
          </select>
          <label className="sr-only" htmlFor="confidence-filter">
            Confidence
          </label>
          <select
            id="confidence-filter"
            className="h-8 rounded-[6px] border border-line bg-background px-2 text-[12px] text-ink"
            value={filters.confidence}
            onChange={(event) =>
              updateFilters({
                confidence: event.target.value as PeopleFilters["confidence"],
              })
            }
          >
            <option value="all">All confidence</option>
            <option value="review">Needs review</option>
            <option value="confirmed">High confidence</option>
          </select>
          {hasFilters ? (
            <button
              type="button"
              onClick={() =>
                updateFilters({
                  query: "",
                  reply: "all",
                  channel: "all",
                  confidence: "all",
                })
              }
              className="ml-auto min-h-8 rounded-[6px] px-2 text-[12px] font-medium text-accent-strong hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </section>

      {filters.view === "people" ? (
        visiblePeople.length ? (
          <section aria-labelledby="people-results-heading">
            <div className="mb-3 flex items-baseline justify-between gap-4">
              <h2
                id="people-results-heading"
                className="text-[14px] font-semibold text-ink"
              >
                {visiblePeople.length} relationships
              </h2>
              <p className="text-[11px] text-ink-faint">
                Updated from read-only source history
              </p>
            </div>

            <div className="hidden overflow-x-auto border-y border-line md:block">
              <table className="w-full min-w-[920px] border-collapse text-left">
                <caption className="sr-only">
                  People with company, touch, reply, channel, confidence, and
                  follow-up details
                </caption>
                <thead>
                  <tr className="text-[11px] font-semibold tracking-[0.07em] text-ink-faint uppercase">
                    <th scope="col" className="py-3 pr-4">
                      Person
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Activity
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Reply
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Channels
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Next touch
                    </th>
                    <th scope="col" className="px-4 py-3">
                      Confidence
                    </th>
                    <th scope="col" className="py-3 pl-4">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visiblePeople.map((person) => (
                    <tr
                      key={person.id}
                      className="group border-t border-line text-[13px]"
                    >
                      <td className="py-3.5 pr-4">
                        <div className="flex items-center gap-3">
                          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-subtle text-[11px] font-semibold text-ink-muted">
                            {initials(person.displayName)}
                          </span>
                          <div className="min-w-0">
                            <Link
                              href={`/people/${person.id}`}
                              className="font-semibold text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                            >
                              {person.displayName}
                            </Link>
                            <p className="mt-0.5 truncate text-[12px] text-ink-muted">
                              {person.title.value} ·{" "}
                              {companyFor(person, data.companies)?.name ??
                                person.company.value}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <p className="font-medium tabular-nums text-ink">
                          {person.touchCount} touches
                        </p>
                        <p className="mt-0.5 text-[11px] text-ink-faint">
                          Last{" "}
                          {formatRelativeDate(
                            person.lastTouchAt,
                            data.generatedAt,
                          ).toLowerCase()}
                        </p>
                      </td>
                      <td className="px-4 py-3.5">
                        <ReplyBadge state={person.replyState} />
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="flex gap-1">
                          {person.identities.map((identity) => (
                            <ChannelMark
                              key={identity.id}
                              channel={identity.channel}
                            />
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <span
                          className={
                            person.plannedFollowUpAt &&
                            new Date(person.plannedFollowUpAt) <=
                              new Date(data.generatedAt)
                              ? "font-semibold text-danger"
                              : "text-ink"
                          }
                        >
                          {formatRelativeDate(
                            person.plannedFollowUpAt,
                            data.generatedAt,
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <p className="font-medium tabular-nums text-ink">
                          {Math.round(person.confidence * 100)}%
                        </p>
                        <p className="mt-0.5 text-[11px] text-ink-faint">
                          {confidenceLabel(person.confidence)}
                        </p>
                      </td>
                      <td className="py-3.5 pl-4 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setMergeSourceId(person.id);
                            setMergeTargetId("");
                          }}
                          className="mr-1 inline-flex min-h-8 items-center gap-1 rounded-[6px] px-2 text-[11px] font-medium text-ink-muted opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          <GitMerge
                            className="size-3"
                            strokeWidth={1.8}
                            aria-hidden="true"
                          />
                          Merge
                        </button>
                        <Link
                          href={`/people/${person.id}`}
                          aria-label={`Open ${person.displayName}`}
                          className="inline-grid size-8 place-items-center rounded-[6px] text-ink-muted hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          <ChevronRight
                            className="size-4"
                            strokeWidth={1.8}
                            aria-hidden="true"
                          />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div
              className="border-y border-line md:hidden"
              aria-label="People cards"
            >
              {visiblePeople.map((person) => (
                <article
                  key={person.id}
                  className="border-b border-line py-4 last:border-b-0"
                >
                  <div className="flex items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-subtle text-[11px] font-semibold text-ink-muted">
                      {initials(person.displayName)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/people/${person.id}`}
                        className="text-[14px] font-semibold text-ink hover:underline"
                      >
                        {person.displayName}
                      </Link>
                      <p className="mt-0.5 text-[12px] leading-5 text-ink-muted">
                        {person.title.value} · {person.company.value}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Merge ${person.displayName}`}
                      onClick={() => {
                        setMergeSourceId(person.id);
                        setMergeTargetId("");
                      }}
                      className="grid size-9 place-items-center rounded-[7px] border border-line text-ink-muted"
                    >
                      <GitMerge
                        className="size-3.5"
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <ReplyBadge state={person.replyState} />
                    {person.identities.map((identity) => (
                      <ChannelMark
                        key={identity.id}
                        channel={identity.channel}
                        showLabel
                      />
                    ))}
                  </div>
                  <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3 text-[11px]">
                    <div>
                      <dt className="text-ink-faint">Touches</dt>
                      <dd className="mt-1 font-semibold text-ink tabular-nums">
                        {person.touchCount}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Last touch</dt>
                      <dd className="mt-1 font-semibold text-ink">
                        {formatRelativeDate(
                          person.lastTouchAt,
                          data.generatedAt,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-ink-faint">Next touch</dt>
                      <dd className="mt-1 font-semibold text-ink">
                        {formatRelativeDate(
                          person.plannedFollowUpAt,
                          data.generatedAt,
                        )}
                      </dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          </section>
        ) : (
          <EmptyRows view="people" hasFilters={hasFilters} />
        )
      ) : visibleCompanies.length ? (
        <section aria-labelledby="company-results-heading">
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2
              id="company-results-heading"
              className="text-[14px] font-semibold text-ink"
            >
              {visibleCompanies.length} companies
            </h2>
            <p className="text-[11px] text-ink-faint">
              Grouped from resolved relationship records
            </p>
          </div>
          <div className="hidden overflow-x-auto border-y border-line md:block">
            <table className="w-full min-w-[860px] border-collapse text-left">
              <caption className="sr-only">
                Companies with relationship, reply, channel, and follow-up
                metrics
              </caption>
              <thead>
                <tr className="text-[11px] font-semibold tracking-[0.07em] text-ink-faint uppercase">
                  <th className="py-3 pr-4" scope="col">
                    Company
                  </th>
                  <th className="px-4 py-3" scope="col">
                    Relationships
                  </th>
                  <th className="px-4 py-3" scope="col">
                    Replies
                  </th>
                  <th className="px-4 py-3" scope="col">
                    Channels
                  </th>
                  <th className="px-4 py-3" scope="col">
                    Last touch
                  </th>
                  <th className="px-4 py-3" scope="col">
                    Next touch
                  </th>
                  <th className="py-3 pl-4" scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleCompanies.map((company) => (
                  <tr
                    key={company.id}
                    className="border-t border-line text-[13px]"
                  >
                    <td className="py-4 pr-4">
                      <Link
                        href={`/people/companies/${company.id}`}
                        className="font-semibold text-ink hover:underline"
                      >
                        {company.name}
                      </Link>
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        {company.domain} · {company.industry.value}
                      </p>
                    </td>
                    <td className="px-4 py-4 font-medium tabular-nums">
                      {company.activeRelationshipCount}
                    </td>
                    <td className="px-4 py-4">
                      <span className="font-medium tabular-nums">
                        {company.repliedCount}
                      </span>
                      <span className="text-ink-faint">
                        {" "}
                        replied · {company.awaitingReplyCount} waiting
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex gap-1">
                        {company.channelMix.map((channel) => (
                          <ChannelMark key={channel} channel={channel} />
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      {formatRelativeDate(
                        company.lastTouchAt,
                        data.generatedAt,
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {formatRelativeDate(
                        company.nextTouchAt,
                        data.generatedAt,
                      )}
                    </td>
                    <td className="py-4 pl-4 text-right">
                      <Link
                        href={`/people/companies/${company.id}`}
                        aria-label={`Open ${company.name}`}
                        className="inline-grid size-8 place-items-center rounded-[6px] text-ink-muted hover:bg-surface-subtle"
                      >
                        <ChevronRight
                          className="size-4"
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            className="border-y border-line md:hidden"
            aria-label="Company cards"
          >
            {visibleCompanies.map((company) => (
              <article
                key={company.id}
                className="border-b border-line py-4 last:border-b-0"
              >
                <div className="flex items-start gap-3">
                  <span className="grid size-9 place-items-center rounded-[8px] bg-surface-subtle text-ink-muted">
                    <Building2
                      className="size-4"
                      strokeWidth={1.7}
                      aria-hidden="true"
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/people/companies/${company.id}`}
                      className="text-[14px] font-semibold text-ink"
                    >
                      {company.name}
                    </Link>
                    <p className="mt-0.5 text-[12px] text-ink-muted">
                      {company.industry.value} · {company.domain}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex gap-1">
                  {company.channelMix.map((channel) => (
                    <ChannelMark key={channel} channel={channel} showLabel />
                  ))}
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3 text-[11px]">
                  <div>
                    <dt className="text-ink-faint">People</dt>
                    <dd className="mt-1 font-semibold tabular-nums">
                      {company.activeRelationshipCount}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-faint">Replies</dt>
                    <dd className="mt-1 font-semibold tabular-nums">
                      {company.repliedCount}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-faint">Next</dt>
                    <dd className="mt-1 font-semibold">
                      {formatRelativeDate(
                        company.nextTouchAt,
                        data.generatedAt,
                      )}
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <EmptyRows view="companies" hasFilters={hasFilters} />
      )}

      <Modal
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add a relationship"
        description="Create a manual record inside Threadline. This does not contact the person or change any external source."
      >
        <form action={handleAdd} className="space-y-4">
          <label className="block text-[12px] font-medium text-ink">
            Name
            <input
              name="displayName"
              required
              autoFocus
              className={`${controlClass} mt-1.5`}
              placeholder="Full name"
            />
          </label>
          <label className="block text-[12px] font-medium text-ink">
            Email, optional
            <input
              name="email"
              type="email"
              className={`${controlClass} mt-1.5`}
              placeholder="name@company.com"
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-[12px] font-medium text-ink">
              Company
              <input
                name="company"
                className={`${controlClass} mt-1.5`}
                placeholder="Company"
              />
            </label>
            <label className="block text-[12px] font-medium text-ink">
              Role
              <input
                name="title"
                className={`${controlClass} mt-1.5`}
                placeholder="Role"
              />
            </label>
          </div>
          <div className="rounded-[8px] border border-line bg-surface-subtle px-3 py-2.5 text-[12px] leading-5 text-ink-muted">
            <Plus
              className="mr-1 inline size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Manual fields are labeled as owner overrides until source evidence
            is attached.
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
            <button type="submit" className={primaryButtonClass}>
              Add relationship
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(mergeSource)}
        onOpenChange={(open) => {
          if (!open) setMergeSourceId(null);
        }}
        title="Merge duplicate relationship"
        {...(mergeSource
          ? {
              description: `Choose the relationship that should keep ${mergeSource.displayName}'s history and identities.`,
            }
          : {})}
        footer={
          <>
            <button
              type="button"
              onClick={() => setMergeSourceId(null)}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleMerge}
              disabled={!mergeTargetId}
              className={primaryButtonClass}
            >
              <GitMerge
                className="size-3.5"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              Merge records
            </button>
          </>
        }
      >
        <label className="block text-[12px] font-medium text-ink">
          Keep this relationship
          <select
            aria-label="Merge target"
            value={mergeTargetId}
            onChange={(event) => setMergeTargetId(event.target.value)}
            className={`${controlClass} mt-1.5`}
          >
            <option value="">Select a person</option>
            {people
              .filter((person) => person.id !== mergeSourceId)
              .map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName} · {person.company.value}
                </option>
              ))}
          </select>
        </label>
        <p className="mt-3 text-[12px] leading-5 text-ink-muted">
          Threadline combines local history, touch counts, and channel
          identities. Nothing is changed in Gmail, LinkedIn, or X.
        </p>
      </Modal>

      {undo ? (
        <UndoNotice
          message={undo.message}
          onUndo={() => {
            setPeople(undo.people);
            setUndo(null);
          }}
          onDismiss={() => setUndo(null)}
        />
      ) : null}
    </div>
  );
}
