"use client";

import {
  ArrowLeft,
  Building2,
  CalendarClock,
  Check,
  Clipboard,
  FilePenLine,
  GitMerge,
  History,
  Pencil,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ChannelMark } from "@/components/people/channel-mark";
import {
  confidenceLabel,
  formatDate,
  formatDateTime,
  formatRelativeDate,
  initials,
} from "@/components/people/formatters";
import {
  Modal,
  controlClass,
  primaryButtonClass,
  secondaryButtonClass,
  textAreaClass,
} from "@/components/people/modal";
import { RelationshipTimeline } from "@/components/people/relationship-timeline";
import { EvidenceBadge, ReplyBadge } from "@/components/people/status-badge";
import type {
  CompanyRecord,
  OutreachPlanView,
  PersonRecord,
  ResolvedField,
} from "@/components/people/types";
import { UndoNotice } from "@/components/people/undo-notice";

interface PersonDetailProps {
  initialPerson: PersonRecord;
  company: CompanyRecord | null;
  initialPlan: OutreachPlanView | null;
  now: string;
}

type CorrectableField = "title" | "company" | "location";

interface UndoState {
  person: PersonRecord;
  plan: OutreachPlanView | null;
  message: string;
}

function FieldRow({
  label,
  field,
  onCorrect,
}: {
  label: string;
  field: ResolvedField;
  onCorrect: () => void;
}) {
  return (
    <div className="grid gap-2 border-b border-line py-4 last:border-b-0 sm:grid-cols-[120px_minmax(0,1fr)_auto] sm:items-start sm:gap-4">
      <p className="text-[11px] font-semibold tracking-[0.07em] text-ink-faint uppercase">
        {label}
      </p>
      <div>
        <p className="text-[13px] font-medium text-ink">{field.value}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <EvidenceBadge kind={field.kind} />
          <span className="text-[11px] text-ink-faint tabular-nums">
            {Math.round(field.confidence * 100)}% confidence
          </span>
        </div>
        {field.evidence.at(0) ? (
          <p className="mt-2 text-[11px] leading-5 text-ink-muted">
            {field.evidence[0]?.detail}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onCorrect}
        className="inline-flex min-h-8 w-fit items-center gap-1.5 rounded-[6px] px-2 text-[11px] font-medium text-accent-strong hover:bg-accent-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <Pencil className="size-3" strokeWidth={1.8} aria-hidden="true" />
        Correct
      </button>
    </div>
  );
}

export function PersonDetail({
  initialPerson,
  company,
  initialPlan,
  now,
}: PersonDetailProps) {
  const [person, setPerson] = useState(initialPerson);
  const [plan, setPlan] = useState(initialPlan);
  const [editing, setEditing] = useState(false);
  const [correcting, setCorrecting] = useState<CorrectableField | null>(null);
  const [planning, setPlanning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [undo, setUndo] = useState<UndoState | null>(null);

  function checkpoint(message: string) {
    setUndo({ person, plan, message });
  }

  function handleEdit(formData: FormData) {
    checkpoint("Relationship edits saved.");
    const displayName = String(
      formData.get("displayName") ?? person.displayName,
    ).trim();
    const email = String(formData.get("email") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    const occurredAt = new Date().toISOString();
    setPerson((current) => ({
      ...current,
      displayName,
      primaryEmail: email || null,
      notes: notes || null,
      hasManualOverride: true,
      audit: [
        {
          id: `edit-${Date.now()}`,
          occurredAt,
          actor: "owner@threadline.local",
          action: "Relationship edited",
          detail: "Updated owner-managed identity or notes.",
          outcome: "success",
        },
        ...current.audit,
      ],
    }));
    setEditing(false);
  }

  function handleCorrection(formData: FormData) {
    if (!correcting) return;
    const value = String(formData.get("value") ?? "").trim();
    const reason = String(formData.get("reason") ?? "").trim();
    if (!value) return;

    checkpoint(
      `${correcting[0]?.toUpperCase()}${correcting.slice(1)} corrected.`,
    );
    const occurredAt = new Date().toISOString();
    setPerson((current) => ({
      ...current,
      [correcting]: {
        ...current[correcting],
        value,
        kind: "override",
        confidence: 1,
        overrides: [
          {
            field: correcting,
            value,
            ...(reason ? { reason } : {}),
            overriddenAt: occurredAt,
            overriddenBy: "owner@threadline.local",
          },
          ...current[correcting].overrides,
        ],
      },
      hasManualOverride: true,
      audit: [
        {
          id: `correction-${Date.now()}`,
          occurredAt,
          actor: "owner@threadline.local",
          action: `Corrected ${correcting}`,
          detail: reason || `Set ${correcting} to ${value}.`,
          outcome: "success",
        },
        ...current.audit,
      ],
    }));
    setCorrecting(null);
  }

  function handlePlan(formData: FormData) {
    const objective = String(formData.get("objective") ?? "").trim();
    const date = String(formData.get("nextTouchAt") ?? "");
    const channel = String(
      formData.get("channel") ?? "gmail",
    ) as OutreachPlanView["preferredChannels"][number];
    const nextTouchAt = date
      ? new Date(`${date}T09:30:00`).toISOString()
      : null;
    const occurredAt = new Date().toISOString();
    checkpoint(plan ? "Outreach plan updated." : "Outreach plan created.");
    setPlan((current) => ({
      id:
        current?.id ??
        (typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `plan-${Date.now()}`),
      contactId: person.id,
      companyId: person.companyId,
      status: "planned",
      objective,
      preferredChannels: [channel],
      nextTouchAt,
      cadenceIntervalDays: current?.cadenceIntervalDays ?? 7,
      plannedTouchCount: current?.plannedTouchCount ?? 1,
      completedTouchCount: current?.completedTouchCount ?? 0,
      firstTouchAt: current?.firstTouchAt ?? person.firstTouchAt,
      lastTouchAt: current?.lastTouchAt ?? person.lastTouchAt,
      completedAt: null,
      replyState: person.replyState,
      suggestedDraft: current?.suggestedDraft ?? {
        status: "queued",
        evidenceCount: person.timeline.length,
        runner: "codex-cli",
      },
      hasManualOverride: true,
      createdAt: current?.createdAt ?? occurredAt,
      audit: [
        {
          id: `plan-${Date.now()}`,
          occurredAt,
          actor: "owner@threadline.local",
          action: current ? "Plan updated" : "Plan created",
          detail: `Next review planned for ${nextTouchAt ? formatDate(nextTouchAt) : "an unscheduled date"}.`,
          outcome: "success",
        },
        ...(current?.audit ?? []),
      ],
    }));
    setPerson((current) => ({
      ...current,
      plannedFollowUpAt: nextTouchAt,
      relationshipStage: "planned",
      hasManualOverride: true,
    }));
    setPlanning(false);
  }

  async function copyDraft() {
    const text = plan?.suggestedDraft.text;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
  }

  const title = correcting ? person[correcting].value : "";

  return (
    <div className="space-y-8">
      <div className="border-b border-line pb-7">
        <Link
          href="/people"
          className="inline-flex min-h-8 items-center gap-1.5 rounded-[6px] text-[12px] font-medium text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ArrowLeft
            className="size-3.5"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          Back to people
        </Link>
        <div className="mt-5 flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-full bg-surface-subtle text-[14px] font-semibold text-ink-muted">
              {initials(person.displayName)}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.035em] text-ink">
                  {person.displayName}
                </h1>
                <ReplyBadge state={person.replyState} />
              </div>
              <p className="mt-2 text-[14px] text-ink-muted">
                {person.title.value} · {person.company.value}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {person.identities.map((identity) => (
                  <ChannelMark
                    key={identity.id}
                    channel={identity.channel}
                    showLabel
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className={secondaryButtonClass}
            >
              <Pencil
                className="size-3.5"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              Edit
            </button>
            <Link
              href={`/people?merge=${person.id}`}
              className={secondaryButtonClass}
            >
              <GitMerge
                className="size-3.5"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              Merge
            </Link>
            <button
              type="button"
              onClick={() => setPlanning(true)}
              className={primaryButtonClass}
            >
              <CalendarClock
                className="size-3.5"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              Plan follow-up
            </button>
          </div>
        </div>
      </div>

      <section aria-labelledby="metrics-heading">
        <h2 id="metrics-heading" className="sr-only">
          Relationship metrics
        </h2>
        <dl className="grid border-y border-line sm:grid-cols-2 lg:grid-cols-5">
          {[
            ["First touch", formatDate(person.firstTouchAt)],
            ["Last touch", formatRelativeDate(person.lastTouchAt, now)],
            ["Touches", String(person.touchCount)],
            ["Channel mix", `${person.identities.length} sources`],
            ["Next planned", formatRelativeDate(person.plannedFollowUpAt, now)],
          ].map(([label, value], index) => (
            <div
              key={label}
              className={`py-4 sm:px-5 ${index === 0 ? "sm:pl-0" : ""} ${index > 0 ? "border-t border-line sm:border-t-0 sm:border-l" : ""}`}
            >
              <dt className="text-[11px] font-medium text-ink-faint">
                {label}
              </dt>
              <dd className="mt-1.5 text-[15px] font-semibold tracking-[-0.02em] text-ink tabular-nums">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] xl:gap-14">
        <div className="space-y-10">
          <section aria-labelledby="identity-heading">
            <div className="mb-3 flex items-end justify-between gap-4">
              <div>
                <h2
                  id="identity-heading"
                  className="text-[15px] font-semibold text-ink"
                >
                  Resolved identity
                </h2>
                <p className="mt-1 text-[13px] text-ink-muted">
                  Each field distinguishes source facts, model conclusions, and
                  owner corrections.
                </p>
              </div>
              <span className="text-[11px] text-ink-faint">
                {confidenceLabel(person.confidence)}
              </span>
            </div>
            <div className="border-y border-line">
              <FieldRow
                label="Role"
                field={person.title}
                onCorrect={() => setCorrecting("title")}
              />
              <FieldRow
                label="Company"
                field={person.company}
                onCorrect={() => setCorrecting("company")}
              />
              <FieldRow
                label="Location"
                field={person.location}
                onCorrect={() => setCorrecting("location")}
              />
            </div>
            <div
              className="mt-4 flex flex-wrap gap-2"
              aria-label="Evidence legend"
            >
              <EvidenceBadge kind="observed" />
              <EvidenceBadge kind="inferred" />
              <EvidenceBadge kind="override" />
            </div>
          </section>

          <section aria-labelledby="timeline-heading">
            <div className="mb-4">
              <h2
                id="timeline-heading"
                className="text-[15px] font-semibold text-ink"
              >
                Relationship timeline
              </h2>
              <p className="mt-1 text-[13px] text-ink-muted">
                One chronology across Gmail, LinkedIn, X, notes, drafts, and
                planned follow-ups.
              </p>
            </div>
            <RelationshipTimeline items={person.timeline} />
          </section>
        </div>

        <aside className="space-y-8">
          <section aria-labelledby="plan-heading">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2
                id="plan-heading"
                className="text-[15px] font-semibold text-ink"
              >
                Next outreach
              </h2>
              <button
                type="button"
                onClick={() => setPlanning(true)}
                className="text-[11px] font-semibold text-accent-strong hover:underline"
              >
                Edit plan
              </button>
            </div>
            {plan ? (
              <div className="border-y border-line py-4">
                <div className="flex items-start gap-3">
                  <CalendarClock
                    className="mt-0.5 size-4 text-accent-strong"
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                  <div>
                    <p className="text-[13px] font-semibold text-ink">
                      {formatDateTime(plan.nextTouchAt)}
                    </p>
                    <p className="mt-1 text-[12px] leading-5 text-ink-muted">
                      {plan.objective}
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex gap-1 pl-7">
                  {plan.preferredChannels.map((channel) => (
                    <ChannelMark key={channel} channel={channel} showLabel />
                  ))}
                </div>
              </div>
            ) : (
              <div className="border-y border-line py-8 text-center">
                <p className="text-[13px] font-medium text-ink">
                  No follow-up planned.
                </p>
                <button
                  type="button"
                  onClick={() => setPlanning(true)}
                  className="mt-2 text-[12px] font-semibold text-accent-strong hover:underline"
                >
                  Add a plan
                </button>
              </div>
            )}
          </section>

          <section aria-labelledby="draft-heading">
            <div className="mb-3">
              <h2
                id="draft-heading"
                className="text-[15px] font-semibold text-ink"
              >
                Internal draft suggestion
              </h2>
              <p className="mt-1 text-[12px] leading-5 text-ink-muted">
                Generated for review. Threadline can copy text, but cannot send
                it.
              </p>
            </div>
            <div className="border-y border-line py-4">
              {plan?.suggestedDraft.status === "succeeded" &&
              plan.suggestedDraft.text ? (
                <>
                  <div className="flex items-center gap-2 text-[11px] font-medium text-accent-strong">
                    <Sparkles
                      className="size-3.5"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                    Ready · {plan.suggestedDraft.evidenceCount} evidence items
                  </div>
                  <p className="mt-3 text-[13px] leading-6 text-ink">
                    {plan.suggestedDraft.text}
                  </p>
                  <button
                    type="button"
                    onClick={copyDraft}
                    className={`${secondaryButtonClass} mt-4 w-full`}
                  >
                    <Clipboard
                      className="size-3.5"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                    {copied ? "Copied to clipboard" : "Copy draft"}
                  </button>
                </>
              ) : (
                <div className="py-5 text-center">
                  <FilePenLine
                    className="mx-auto size-5 text-ink-faint"
                    strokeWidth={1.6}
                    aria-hidden="true"
                  />
                  <p className="mt-3 text-[13px] font-medium text-ink">
                    {plan?.suggestedDraft.status === "running"
                      ? "Generating suggestion…"
                      : plan?.suggestedDraft.status === "failed"
                        ? "Suggestion generation needs a retry."
                        : "Suggestion is queued."}
                  </p>
                  <p className="mt-1 text-[11px] text-ink-faint">
                    Runner: {plan?.suggestedDraft.runner ?? "codex-cli"}
                  </p>
                </div>
              )}
            </div>
          </section>

          <section aria-labelledby="company-heading">
            <div className="mb-3">
              <h2
                id="company-heading"
                className="text-[15px] font-semibold text-ink"
              >
                Company context
              </h2>
            </div>
            {company ? (
              <Link
                href={`/people/companies/${company.id}`}
                className="group flex items-start gap-3 border-y border-line py-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <span className="grid size-9 place-items-center rounded-[8px] bg-surface-subtle text-ink-muted">
                  <Building2
                    className="size-4"
                    strokeWidth={1.7}
                    aria-hidden="true"
                  />
                </span>
                <div>
                  <p className="text-[13px] font-semibold text-ink group-hover:underline">
                    {company.name}
                  </p>
                  <p className="mt-1 text-[12px] text-ink-muted">
                    {company.industry.value} · {company.activeRelationshipCount}{" "}
                    relationships
                  </p>
                </div>
              </Link>
            ) : (
              <div className="border-y border-line py-5 text-[12px] text-ink-muted">
                No company record is linked.
              </div>
            )}
          </section>

          <section aria-labelledby="audit-heading">
            <div className="mb-3 flex items-center gap-2">
              <History
                className="size-4 text-ink-muted"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <h2
                id="audit-heading"
                className="text-[15px] font-semibold text-ink"
              >
                Audit history
              </h2>
            </div>
            <ol className="border-y border-line">
              {person.audit.map((entry) => (
                <li
                  key={entry.id}
                  className="border-b border-line py-3 last:border-b-0"
                >
                  <p className="text-[12px] font-medium text-ink">
                    {entry.action}
                  </p>
                  <p className="mt-1 text-[11px] leading-5 text-ink-muted">
                    {entry.detail}
                  </p>
                  <time
                    dateTime={entry.occurredAt}
                    className="mt-1 block text-[10px] text-ink-faint"
                  >
                    {formatDateTime(entry.occurredAt)}
                  </time>
                </li>
              ))}
            </ol>
          </section>

          <div className="rounded-[8px] border border-line bg-surface-subtle px-3 py-3 text-[11px] leading-5 text-ink-muted">
            <ShieldCheck
              className="mr-1 inline size-3.5 text-accent-strong"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Read-only guarantee: no action here sends, replies, posts, connects,
            deletes, or modifies a Gmail, LinkedIn, or X message.
          </div>
        </aside>
      </div>

      <Modal
        open={editing}
        onOpenChange={setEditing}
        title="Edit relationship"
        description="Changes stay inside Threadline and are recorded as owner-managed fields."
      >
        <form action={handleEdit} className="space-y-4">
          <label className="block text-[12px] font-medium text-ink">
            Name
            <input
              name="displayName"
              defaultValue={person.displayName}
              required
              className={`${controlClass} mt-1.5`}
            />
          </label>
          <label className="block text-[12px] font-medium text-ink">
            Email
            <input
              name="email"
              type="email"
              defaultValue={person.primaryEmail ?? ""}
              className={`${controlClass} mt-1.5`}
            />
          </label>
          <label className="block text-[12px] font-medium text-ink">
            Private notes
            <textarea
              name="notes"
              defaultValue={person.notes ?? ""}
              className={`${textAreaClass} mt-1.5`}
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
            <button type="submit" className={primaryButtonClass}>
              <Check
                className="size-3.5"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              Save changes
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(correcting)}
        onOpenChange={(open) => {
          if (!open) setCorrecting(null);
        }}
        title={`Correct ${correcting ?? "field"}`}
        description="The source evidence remains visible; your value becomes the resolved owner override."
      >
        <form action={handleCorrection} className="space-y-4">
          <label className="block text-[12px] font-medium text-ink">
            Resolved value
            <input
              name="value"
              defaultValue={title}
              required
              autoFocus
              className={`${controlClass} mt-1.5`}
            />
          </label>
          <label className="block text-[12px] font-medium text-ink">
            Reason, optional
            <textarea
              name="reason"
              className={`${textAreaClass} mt-1.5`}
              placeholder="What did the model or source get wrong?"
            />
          </label>
          <div className="rounded-[8px] border border-line bg-surface-subtle px-3 py-2.5 text-[11px] leading-5 text-ink-muted">
            The previous value and its evidence remain in the audit trail.
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCorrecting(null)}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
            <button type="submit" className={primaryButtonClass}>
              Save correction
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={planning}
        onOpenChange={setPlanning}
        title={plan ? "Update follow-up plan" : "Plan a follow-up"}
        description="Planning stays internal. Copy any approved draft and send it yourself in the source app."
      >
        <form action={handlePlan} className="space-y-4">
          <label className="block text-[12px] font-medium text-ink">
            Objective
            <textarea
              name="objective"
              required
              defaultValue={plan?.objective ?? ""}
              className={`${textAreaClass} mt-1.5`}
              placeholder="What should this touch accomplish?"
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-[12px] font-medium text-ink">
              Review date
              <input
                name="nextTouchAt"
                type="date"
                defaultValue={plan?.nextTouchAt?.slice(0, 10) ?? ""}
                className={`${controlClass} mt-1.5`}
              />
            </label>
            <label className="block text-[12px] font-medium text-ink">
              Preferred channel
              <select
                name="channel"
                defaultValue={plan?.preferredChannels[0] ?? "gmail"}
                className={`${controlClass} mt-1.5`}
              >
                <option value="gmail">Gmail</option>
                <option value="linkedin">LinkedIn</option>
                <option value="x">X</option>
              </select>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPlanning(false)}
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
              Save plan
            </button>
          </div>
        </form>
      </Modal>

      {undo ? (
        <UndoNotice
          message={undo.message}
          onUndo={() => {
            setPerson(undo.person);
            setPlan(undo.plan);
            setUndo(null);
          }}
          onDismiss={() => setUndo(null)}
        />
      ) : null}
    </div>
  );
}
