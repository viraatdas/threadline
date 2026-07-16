"use client";

import {
  CalendarClock,
  Check,
  ChevronDown,
  Clipboard,
  ClockAlert,
  FilePenLine,
  Filter,
  History,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { ChannelMark } from "@/components/people/channel-mark";
import {
  formatDateTime,
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
  OutreachFilters,
  OutreachPlanView,
  OutreachQueueGroup,
  PeopleWorkspaceData,
} from "@/components/people/types";
import { UndoNotice } from "@/components/people/undo-notice";
import { groupOutreachPlans } from "@/components/outreach/queue-utils";
import { PageHeader } from "@/components/shell";
import type {
  CompleteOutreachPlanAction,
  RescheduleOutreachPlanAction,
  RetryOutreachDraftAction,
} from "@/components/workspace-actions";
import { workspaceActionError } from "@/components/workspace-actions";

interface OutreachWorkspaceProps {
  data: PeopleWorkspaceData;
  initialFilters: OutreachFilters;
  completePlanAction?: CompleteOutreachPlanAction;
  reschedulePlanAction?: RescheduleOutreachPlanAction;
  retryDraftAction?: RetryOutreachDraftAction;
}

interface UndoState {
  plans: OutreachPlanView[];
  message: string;
}

const groupMeta: Record<
  OutreachQueueGroup,
  { label: string; description: string }
> = {
  planned: {
    label: "Planned",
    description: "Future touches prepared for owner review.",
  },
  due: {
    label: "Due",
    description: "Follow-ups whose review date has arrived.",
  },
  waiting: {
    label: "Waiting for reply",
    description: "Recent outreach with no inbound response yet.",
  },
  replied: {
    label: "Replied",
    description: "Relationships with an observed inbound response.",
  },
  stale: {
    label: "Stale",
    description: "Unanswered outreach quiet for at least fourteen days.",
  },
};

const groupOrder: OutreachQueueGroup[] = [
  "due",
  "planned",
  "waiting",
  "replied",
  "stale",
];

function writeFilters(filters: OutreachFilters) {
  const url = new URL(window.location.href);
  const entries = Object.entries(filters) as [keyof OutreachFilters, string][];
  for (const [key, value] of entries) {
    const param = key === "query" ? "q" : key === "ownerState" ? "state" : key;
    if (value === "" || value === "all") url.searchParams.delete(param);
    else url.searchParams.set(param, value);
  }
  window.history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function DraftStatus({
  plan,
  onRetry,
  onCopy,
  copied,
}: {
  plan: OutreachPlanView;
  onRetry: () => void;
  onCopy: () => void;
  copied: boolean;
}) {
  const draft = plan.suggestedDraft;
  if (draft.status === "succeeded" && draft.text) {
    return (
      <div className="mt-4 rounded-[8px] border border-line bg-surface-subtle px-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent-strong">
            <Sparkles
              className="size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Draft ready · {draft.evidenceCount} sources
          </span>
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-[6px] px-2 text-[11px] font-semibold text-ink hover:bg-background focus-visible:outline-2 focus-visible:outline-accent"
          >
            <Clipboard
              className="size-3.5"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            {copied ? "Copied" : "Copy draft"}
          </button>
        </div>
        <p className="mt-2 line-clamp-3 text-[12px] leading-5 text-ink-muted">
          {draft.text}
        </p>
      </div>
    );
  }

  const statusText =
    draft.status === "running"
      ? "Generating suggestion…"
      : draft.status === "failed"
        ? "Suggestion failed"
        : "Suggestion queued";
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-line bg-surface-subtle px-3 py-3">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-muted">
        <FilePenLine
          className="size-3.5"
          strokeWidth={1.8}
          aria-hidden="true"
        />
        {statusText} · {draft.runner}
      </span>
      {draft.status === "failed" ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-[6px] px-2 text-[11px] font-semibold text-accent-strong hover:bg-accent-subtle"
        >
          <RefreshCw
            className="size-3.5"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function OutreachWorkspace({
  data,
  initialFilters,
  completePlanAction,
  reschedulePlanAction,
  retryDraftAction,
}: OutreachWorkspaceProps) {
  const [plans, setPlans] = useState(data.plans);
  const [filters, setFilters] = useState(initialFilters);
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function updateFilters(patch: Partial<OutreachFilters>) {
    setFilters((current) => {
      const next = { ...current, ...patch };
      writeFilters(next);
      return next;
    });
  }

  const filteredPlans = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    return plans.filter((plan) => {
      const person = data.people.find((item) => item.id === plan.contactId);
      const company = data.companies.find((item) => item.id === plan.companyId);
      const searchable =
        `${person?.displayName ?? ""} ${company?.name ?? ""} ${plan.objective}`.toLowerCase();
      const ownerStateMatches =
        filters.ownerState === "all" ||
        (filters.ownerState === "overridden" && plan.hasManualOverride) ||
        (filters.ownerState === "needs_review" &&
          ["queued", "running", "failed"].includes(plan.suggestedDraft.status));
      return (
        (!query || searchable.includes(query)) &&
        (filters.channel === "all" ||
          plan.preferredChannels.includes(filters.channel)) &&
        ownerStateMatches
      );
    });
  }, [data.companies, data.people, filters, plans]);

  const grouped = useMemo(
    () => groupOutreachPlans(filteredPlans, data.generatedAt),
    [data.generatedAt, filteredPlans],
  );
  const activeCount = groupOrder.reduce(
    (count, group) => count + grouped[group].length,
    0,
  );
  const completedCount = plans.filter(
    (plan) => plan.status === "completed",
  ).length;
  const reschedulingPlan =
    plans.find((plan) => plan.id === reschedulingId) ?? null;
  const hasFilters =
    filters.query !== "" ||
    filters.channel !== "all" ||
    filters.ownerState !== "all";

  async function completePlan(planId: string) {
    const plan = plans.find((item) => item.id === planId);
    if (!plan) return;
    const snapshot = plans;
    setActionError(null);
    setPlans((current) =>
      current.map((item) =>
        item.id === planId
          ? {
              ...item,
              status: "completed",
              completedAt: new Date().toISOString(),
              audit: [
                {
                  id: `complete-${Date.now()}`,
                  occurredAt: new Date().toISOString(),
                  actor: "owner@threadline.local",
                  action: "Plan completed",
                  detail: "Marked complete inside Threadline.",
                  outcome: "success",
                },
                ...item.audit,
              ],
            }
          : item,
      ),
    );
    if (!completePlanAction) {
      setUndo({
        plans: snapshot,
        message: `${data.people.find((person) => person.id === plan.contactId)?.displayName ?? "Plan"} marked complete.`,
      });
      return;
    }

    setUndo(null);
    try {
      const result = await completePlanAction(planId);
      const error = workspaceActionError(
        result,
        "The outreach plan could not be completed.",
      );
      if (error) {
        setPlans(snapshot);
        setActionError(error);
      }
    } catch {
      setPlans(snapshot);
      setActionError("The outreach plan could not be completed. Check your connection and try again.");
    }
  }

  function reschedule(formData: FormData) {
    if (!reschedulingPlan) return;
    const date = String(formData.get("date") ?? "");
    if (!date) return;
    const nextTouchAt = new Date(`${date}T09:30:00`).toISOString();
    const snapshot = plans;
    setActionError(null);
    setPlans((current) =>
      current.map((plan) =>
        plan.id === reschedulingPlan.id
          ? {
              ...plan,
              nextTouchAt,
              status: "planned",
              hasManualOverride: true,
              audit: [
                {
                  id: `reschedule-${Date.now()}`,
                  occurredAt: new Date().toISOString(),
                  actor: "owner@threadline.local",
                  action: "Plan rescheduled",
                  detail: `Moved review to ${formatDateTime(nextTouchAt)}.`,
                  outcome: "success",
                },
                ...plan.audit,
              ],
            }
          : plan,
      ),
    );
    setReschedulingId(null);

    if (!reschedulePlanAction) {
      setUndo({ plans: snapshot, message: "Follow-up review rescheduled." });
      return;
    }

    setUndo(null);
    void (async () => {
      try {
        const result = await reschedulePlanAction(
          reschedulingPlan.id,
          formData,
        );
        const error = workspaceActionError(
          result,
          "The follow-up could not be rescheduled.",
        );
        if (error) {
          setPlans(snapshot);
          setActionError(error);
        } else if (result.ok) {
          setPlans((current) =>
            current.map((plan) =>
              plan.id === result.data.planId
                ? { ...plan, nextTouchAt: result.data.nextTouchAt }
                : plan,
            ),
          );
        }
      } catch {
        setPlans(snapshot);
        setActionError(
          "The follow-up could not be rescheduled. Check your connection and try again.",
        );
      }
    })();
  }

  async function retrySuggestion(planId: string) {
    const snapshot = plans;
    setActionError(null);

    if (retryDraftAction) {
      setUndo(null);
      setPlans((current) =>
        current.map((plan) =>
          plan.id === planId
            ? {
                ...plan,
                suggestedDraft: {
                  status: "queued",
                  evidenceCount: plan.suggestedDraft.evidenceCount,
                  runner: plan.suggestedDraft.runner,
                },
              }
            : plan,
        ),
      );
      try {
        const result = await retryDraftAction(planId);
        const error = workspaceActionError(
          result,
          "The draft retry could not be queued.",
        );
        if (error) {
          setPlans(snapshot);
          setActionError(error);
        }
      } catch {
        setPlans(snapshot);
        setActionError("The draft retry could not be queued. Check your connection and try again.");
      }
      return;
    }

    setPlans((current) =>
      current.map((plan) =>
        plan.id === planId
          ? {
              ...plan,
              suggestedDraft: {
                status: "succeeded",
                text: "Thanks for the thoughtful reply. I pulled together the concrete local-first note workflow we discussed. If it would be useful, I can share the short outline for your review.",
                generatedAt: new Date().toISOString(),
                evidenceCount: plan.suggestedDraft.evidenceCount,
                runner: plan.suggestedDraft.runner,
              },
            }
          : plan,
      ),
    );
    setUndo({
      plans: snapshot,
      message: "Draft suggestion regenerated for review.",
    });
  }

  async function copyDraft(plan: OutreachPlanView) {
    if (!plan.suggestedDraft.text) return;
    await navigator.clipboard.writeText(plan.suggestedDraft.text);
    setCopiedId(plan.id);
  }

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
        eyebrow="Follow-up workspace"
        title="Outreach queue"
        description="Plan, review, and close the loop from one queue. Suggestions are internal and copy-only; Threadline never performs an external message action."
      />

      <section aria-label="Outreach summary">
        <dl className="grid border-y border-line sm:grid-cols-2 lg:grid-cols-6">
          {[
            ["Active", activeCount],
            ["Due", grouped.due.length],
            ["Waiting", grouped.waiting.length],
            ["Replied", grouped.replied.length],
            ["Stale", grouped.stale.length],
            ["Completed", completedCount],
          ].map(([label, value], index) => (
            <div
              key={String(label)}
              className={`py-4 sm:px-5 ${index === 0 ? "sm:pl-0" : ""} ${index > 0 ? "border-t border-line sm:border-t-0 sm:border-l" : ""}`}
            >
              <dt className="text-[11px] text-ink-faint">{label}</dt>
              <dd className="mt-1.5 text-[20px] font-semibold tracking-[-0.03em] text-ink tabular-nums">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section
        aria-label="Outreach filters"
        className="flex flex-col gap-3 border-y border-line py-3 lg:flex-row lg:items-center"
      >
        <div className="relative min-w-0 flex-1 lg:max-w-[420px]">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label="Search outreach"
            value={filters.query}
            onChange={(event) => updateFilters({ query: event.target.value })}
            placeholder="Search person, company, or objective"
            className={`${controlClass} pl-9`}
          />
        </div>
        <span className="hidden items-center gap-1.5 text-[11px] font-semibold tracking-[0.07em] text-ink-faint uppercase lg:inline-flex">
          <Filter className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
          Filter
        </span>
        <label className="sr-only" htmlFor="outreach-channel">
          Channel
        </label>
        <select
          id="outreach-channel"
          value={filters.channel}
          onChange={(event) =>
            updateFilters({
              channel: event.target.value as OutreachFilters["channel"],
            })
          }
          className="h-9 rounded-[7px] border border-line bg-background px-3 text-[12px] text-ink"
        >
          <option value="all">All channels</option>
          <option value="gmail">Gmail</option>
          <option value="linkedin">LinkedIn</option>
          <option value="x">X</option>
        </select>
        <label className="sr-only" htmlFor="owner-state">
          Review state
        </label>
        <select
          id="owner-state"
          value={filters.ownerState}
          onChange={(event) =>
            updateFilters({
              ownerState: event.target.value as OutreachFilters["ownerState"],
            })
          }
          className="h-9 rounded-[7px] border border-line bg-background px-3 text-[12px] text-ink"
        >
          <option value="all">All review states</option>
          <option value="needs_review">Needs review</option>
          <option value="overridden">Owner override</option>
        </select>
        {hasFilters ? (
          <button
            type="button"
            onClick={() =>
              updateFilters({ query: "", channel: "all", ownerState: "all" })
            }
            className="min-h-9 px-2 text-[12px] font-semibold text-accent-strong hover:underline"
          >
            Clear filters
          </button>
        ) : null}
      </section>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_260px] xl:gap-12">
        <div className="space-y-10">
          {groupOrder.map((group) => {
            const groupPlans = grouped[group];
            return (
              <section key={group} aria-labelledby={`${group}-heading`}>
                <div className="mb-3 flex items-baseline justify-between gap-4">
                  <div>
                    <h2
                      id={`${group}-heading`}
                      className="text-[15px] font-semibold text-ink"
                    >
                      {groupMeta[group].label}{" "}
                      <span className="ml-1 text-[12px] font-medium text-ink-faint tabular-nums">
                        {groupPlans.length}
                      </span>
                    </h2>
                    <p className="mt-1 text-[12px] text-ink-muted">
                      {groupMeta[group].description}
                    </p>
                  </div>
                  {group === "due" && groupPlans.length ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-danger">
                      <ClockAlert
                        className="size-3.5"
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                      Needs judgment
                    </span>
                  ) : null}
                </div>
                {groupPlans.length ? (
                  <div className="border-y border-line">
                    {groupPlans.map((plan) => {
                      const person = data.people.find(
                        (item) => item.id === plan.contactId,
                      );
                      const company = data.companies.find(
                        (item) => item.id === plan.companyId,
                      );
                      if (!person) return null;
                      return (
                        <article
                          key={plan.id}
                          className="border-b border-line py-5 last:border-b-0"
                        >
                          <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-subtle text-[11px] font-semibold text-ink-muted">
                              {initials(person.displayName)}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <Link
                                  href={`/people/${person.id}`}
                                  className="text-[14px] font-semibold text-ink hover:underline"
                                >
                                  {person.displayName}
                                </Link>
                                <ReplyBadge state={plan.replyState} />
                                {plan.hasManualOverride ? (
                                  <span className="text-[10px] font-semibold tracking-[0.06em] text-accent-strong uppercase">
                                    Owner adjusted
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-1 text-[12px] text-ink-muted">
                                {person.title.value}
                                {company ? ` · ${company.name}` : ""}
                              </p>
                              <p className="mt-3 max-w-2xl text-[13px] leading-5 text-ink">
                                {plan.objective}
                              </p>
                              <div className="mt-3 flex flex-wrap items-center gap-2">
                                {plan.preferredChannels.map((channel) => (
                                  <ChannelMark
                                    key={channel}
                                    channel={channel}
                                    showLabel
                                  />
                                ))}
                                <span className="text-[11px] text-ink-faint tabular-nums">
                                  {plan.completedTouchCount}/
                                  {plan.plannedTouchCount} planned touches
                                </span>
                              </div>
                              <DraftStatus
                                plan={plan}
                                copied={copiedId === plan.id}
                                onCopy={() => copyDraft(plan)}
                                onRetry={() => retrySuggestion(plan.id)}
                              />
                              {plan.audit.length ? (
                                <details className="group mt-3">
                                  <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium text-ink-muted focus-visible:outline-2 focus-visible:outline-accent">
                                    <History
                                      className="size-3.5"
                                      strokeWidth={1.8}
                                      aria-hidden="true"
                                    />
                                    {plan.audit.length} audit{" "}
                                    {plan.audit.length === 1
                                      ? "entry"
                                      : "entries"}
                                    <ChevronDown
                                      className="size-3 transition-transform group-open:rotate-180"
                                      strokeWidth={1.8}
                                      aria-hidden="true"
                                    />
                                  </summary>
                                  <ol className="ml-5 border-l border-line pl-3">
                                    {plan.audit.map((entry) => (
                                      <li
                                        key={entry.id}
                                        className="py-2 text-[11px] leading-5 text-ink-muted"
                                      >
                                        <span className="font-medium text-ink">
                                          {entry.action}
                                        </span>{" "}
                                        · {entry.detail}
                                      </li>
                                    ))}
                                  </ol>
                                </details>
                              ) : null}
                            </div>
                            <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-line pt-4 lg:w-[210px] lg:grid-cols-1 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5">
                              <div>
                                <p className="text-[10px] font-semibold tracking-[0.07em] text-ink-faint uppercase">
                                  Next review
                                </p>
                                <p
                                  className={
                                    group === "due"
                                      ? "mt-1 text-[12px] font-semibold text-danger"
                                      : "mt-1 text-[12px] font-semibold text-ink"
                                  }
                                >
                                  {formatRelativeDate(
                                    plan.nextTouchAt,
                                    data.generatedAt,
                                  )}
                                </p>
                              </div>
                              <div>
                                <p className="text-[10px] font-semibold tracking-[0.07em] text-ink-faint uppercase">
                                  Last touch
                                </p>
                                <p className="mt-1 text-[12px] font-medium text-ink">
                                  {formatRelativeDate(
                                    plan.lastTouchAt,
                                    data.generatedAt,
                                  )}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => setReschedulingId(plan.id)}
                                className={`${secondaryButtonClass} col-span-2 mt-1 lg:col-span-1`}
                              >
                                <CalendarClock
                                  className="size-3.5"
                                  strokeWidth={1.8}
                                  aria-hidden="true"
                                />
                                Reschedule
                              </button>
                              <button
                                type="button"
                                onClick={() => completePlan(plan.id)}
                                className={`${secondaryButtonClass} col-span-2 lg:col-span-1`}
                              >
                                <Check
                                  className="size-3.5"
                                  strokeWidth={1.8}
                                  aria-hidden="true"
                                />
                                Mark complete
                              </button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="border-y border-line py-8 text-center">
                    <p className="text-[12px] text-ink-muted">
                      No relationships in {groupMeta[group].label.toLowerCase()}
                      .
                    </p>
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <aside className="space-y-6 xl:sticky xl:top-6 xl:self-start">
          <div className="rounded-[8px] border border-line bg-surface-subtle px-4 py-4">
            <ShieldCheck
              className="size-4 text-accent-strong"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <h2 className="mt-3 text-[13px] font-semibold text-ink">
              Copy-only by design
            </h2>
            <p className="mt-1 text-[11px] leading-5 text-ink-muted">
              Drafts can be reviewed and copied. There is no send, reply, post,
              connect, delete, or external modify control anywhere in this
              queue.
            </p>
          </div>
          <div className="border-y border-line py-4">
            <h2 className="text-[13px] font-semibold text-ink">Queue logic</h2>
            <ul className="mt-3 space-y-2 text-[11px] leading-5 text-ink-muted">
              <li>Due uses the owner-planned review date.</li>
              <li>Waiting reflects observed outbound history with no reply.</li>
              <li>
                Stale means fourteen quiet days, not a failed relationship.
              </li>
              <li>Replied requires an observed inbound response.</li>
            </ul>
          </div>
        </aside>
      </div>

      <Modal
        open={Boolean(reschedulingPlan)}
        onOpenChange={(open) => {
          if (!open) setReschedulingId(null);
        }}
        title="Reschedule follow-up review"
        description="This changes only the internal review date; it does not schedule or send an external message."
      >
        <form action={reschedule} className="space-y-4">
          <label className="block text-[12px] font-medium text-ink">
            New review date
            <input
              name="date"
              type="date"
              required
              defaultValue={reschedulingPlan?.nextTouchAt?.slice(0, 10) ?? ""}
              className={`${controlClass} mt-1.5`}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setReschedulingId(null)}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
            <button type="submit" className={primaryButtonClass}>
              <CalendarClock
                className="size-3.5"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              Save date
            </button>
          </div>
        </form>
      </Modal>

      {undo ? (
        <UndoNotice
          message={undo.message}
          onUndo={() => {
            setPlans(undo.plans);
            setUndo(null);
          }}
          onDismiss={() => setUndo(null)}
        />
      ) : null}
    </div>
  );
}
