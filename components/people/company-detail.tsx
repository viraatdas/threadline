"use client";

import {
  ArrowLeft,
  Building2,
  History,
  Pencil,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { ChannelMark } from "@/components/people/channel-mark";
import {
  confidenceLabel,
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
import { EvidenceBadge, ReplyBadge } from "@/components/people/status-badge";
import type {
  CompanyRecord,
  PersonRecord,
  ResolvedField,
} from "@/components/people/types";
import { UndoNotice } from "@/components/people/undo-notice";
import type {
  CompanyCorrectionField,
  CorrectCompanyAction,
  EditCompanyAction,
} from "@/components/workspace-actions";
import { workspaceActionError } from "@/components/workspace-actions";

type CompanyField = CompanyCorrectionField;

interface CompanyDetailProps {
  initialCompany: CompanyRecord;
  people: PersonRecord[];
  now: string;
  editCompanyAction?: EditCompanyAction;
  correctCompanyAction?: CorrectCompanyAction;
}

function CompanyFieldRow({
  label,
  field,
  onCorrect,
}: {
  label: string;
  field: ResolvedField;
  onCorrect: () => void;
}) {
  return (
    <div className="grid gap-2 border-b border-line py-4 last:border-b-0 sm:grid-cols-[110px_minmax(0,1fr)_auto] sm:items-start sm:gap-4">
      <p className="text-[11px] font-semibold tracking-[0.07em] text-ink-faint uppercase">
        {label}
      </p>
      <div>
        <p className="text-[13px] font-medium text-ink">{field.value}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <EvidenceBadge kind={field.kind} />
          <span className="text-[11px] text-ink-faint tabular-nums">
            {Math.round(field.confidence * 100)}%
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

export function CompanyDetail({
  initialCompany,
  people,
  now,
  editCompanyAction,
  correctCompanyAction,
}: CompanyDetailProps) {
  const [company, setCompany] = useState(initialCompany);
  const [editing, setEditing] = useState(false);
  const [correcting, setCorrecting] = useState<CompanyField | null>(null);
  const [undo, setUndo] = useState<CompanyRecord | null>(null);
  const [undoMessage, setUndoMessage] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  function checkpoint(message: string) {
    setUndo(company);
    setUndoMessage(message);
  }

  async function handleEdit(formData: FormData) {
    const snapshot = company;
    const name = String(formData.get("name") ?? company.name).trim();
    const domain = String(formData.get("domain") ?? "").trim();
    const description = String(formData.get("description") ?? "").trim();
    const occurredAt = new Date().toISOString();
    if (!editCompanyAction) checkpoint("Company edits saved.");
    else setUndo(null);
    setActionError(null);
    const nextCompany: CompanyRecord = {
      ...company,
      name,
      domain: domain || null,
      description: description || null,
      hasManualOverride: true,
      audit: [
        {
          id: `company-edit-${Date.now()}`,
          occurredAt,
          actor: "owner@threadline.local",
          action: "Company edited",
          detail: "Updated owner-managed company fields.",
          outcome: "success",
        },
        ...company.audit,
      ],
    };
    setCompany(nextCompany);
    setEditing(false);

    if (!editCompanyAction) return;
    try {
      const result = await editCompanyAction(company.id, formData);
      const error = workspaceActionError(
        result,
        "The company changes could not be saved.",
      );
      if (error) {
        setCompany(snapshot);
        setActionError(error);
      } else if (result.ok) {
        setCompany((current) => ({
          ...current,
          audit: current.audit.map((entry, index) =>
            index === 0
              ? {
                  ...entry,
                  actor: result.data.actorEmail,
                  occurredAt: result.data.occurredAt,
                }
              : entry,
          ),
        }));
      }
    } catch {
      setCompany(snapshot);
      setActionError("The company changes could not be saved. Check your connection and try again.");
    }
  }

  async function handleCorrection(formData: FormData) {
    if (!correcting) return;
    const correctedField = correcting;
    const snapshot = company;
    const value = String(formData.get("value") ?? "").trim();
    const reason = String(formData.get("reason") ?? "").trim();
    if (!value) return;
    const occurredAt = new Date().toISOString();
    if (!correctCompanyAction) checkpoint("Company correction saved.");
    else setUndo(null);
    setActionError(null);
    const nextCompany: CompanyRecord = {
      ...company,
      [correctedField]: {
        ...company[correctedField],
        value,
        kind: "override",
        confidence: 1,
        overrides: [
          {
            field: correctedField,
            value,
            ...(reason ? { reason } : {}),
            overriddenAt: occurredAt,
            overriddenBy: "owner@threadline.local",
          },
          ...company[correctedField].overrides,
        ],
      },
      hasManualOverride: true,
      audit: [
        {
          id: `company-correction-${Date.now()}`,
          occurredAt,
          actor: "owner@threadline.local",
          action: `Corrected ${correctedField}`,
          detail: reason || `Set ${correctedField} to ${value}.`,
          outcome: "success",
        },
        ...company.audit,
      ],
    };
    setCompany(nextCompany);
    setCorrecting(null);

    if (!correctCompanyAction) return;
    try {
      const result = await correctCompanyAction(
        company.id,
        correctedField,
        formData,
      );
      const error = workspaceActionError(
        result,
        "The company correction could not be saved.",
      );
      if (error) {
        setCompany(snapshot);
        setActionError(error);
      } else if (result.ok) {
        setCompany((current) => ({
          ...current,
          audit: current.audit.map((entry, index) =>
            index === 0
              ? {
                  ...entry,
                  actor: result.data.actorEmail,
                  occurredAt: result.data.occurredAt,
                }
              : entry,
          ),
        }));
      }
    } catch {
      setCompany(snapshot);
      setActionError("The company correction could not be saved. Check your connection and try again.");
    }
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
      <div className="border-b border-line pb-7">
        <Link
          href="/people?view=companies"
          className="inline-flex min-h-8 items-center gap-1.5 rounded-[6px] text-[12px] font-medium text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ArrowLeft
            className="size-3.5"
            strokeWidth={1.8}
            aria-hidden="true"
          />
          Back to companies
        </Link>
        <div className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="grid size-12 place-items-center rounded-[10px] bg-surface-subtle text-ink-muted">
              <Building2
                className="size-5"
                strokeWidth={1.7}
                aria-hidden="true"
              />
            </span>
            <div>
              <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.035em] text-ink">
                {company.name}
              </h1>
              <p className="mt-2 text-[14px] text-ink-muted">
                {company.industry.value}
                {company.domain ? ` · ${company.domain}` : ""}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {company.channelMix.map((channel) => (
                  <ChannelMark key={channel} channel={channel} showLabel />
                ))}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={secondaryButtonClass}
          >
            <Pencil className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
            Edit company
          </button>
        </div>
      </div>

      <section aria-label="Company relationship metrics">
        <dl className="grid border-y border-line sm:grid-cols-2 lg:grid-cols-5">
          {[
            ["Relationships", String(company.activeRelationshipCount)],
            ["Replied", String(company.repliedCount)],
            ["Awaiting", String(company.awaitingReplyCount)],
            ["Last touch", formatRelativeDate(company.lastTouchAt, now)],
            ["Next touch", formatRelativeDate(company.nextTouchAt, now)],
          ].map(([label, value], index) => (
            <div
              key={label}
              className={`py-4 sm:px-5 ${index === 0 ? "sm:pl-0" : ""} ${index > 0 ? "border-t border-line sm:border-t-0 sm:border-l" : ""}`}
            >
              <dt className="text-[11px] text-ink-faint">{label}</dt>
              <dd className="mt-1.5 text-[15px] font-semibold text-ink tabular-nums">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="grid gap-10 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)] xl:gap-14">
        <div className="space-y-10">
          <section aria-labelledby="company-context-heading">
            <div className="mb-3 flex items-end justify-between gap-4">
              <div>
                <h2
                  id="company-context-heading"
                  className="text-[15px] font-semibold text-ink"
                >
                  Resolved company context
                </h2>
                <p className="mt-1 text-[13px] text-ink-muted">
                  Source-grounded fields remain distinct from model inference
                  and owner overrides.
                </p>
              </div>
              <span className="text-[11px] text-ink-faint">
                {confidenceLabel(company.confidence)}
              </span>
            </div>
            <div className="border-y border-line">
              <CompanyFieldRow
                label="Industry"
                field={company.industry}
                onCorrect={() => setCorrecting("industry")}
              />
              <CompanyFieldRow
                label="Size"
                field={company.sizeRange}
                onCorrect={() => setCorrecting("sizeRange")}
              />
              <CompanyFieldRow
                label="Location"
                field={company.location}
                onCorrect={() => setCorrecting("location")}
              />
            </div>
            {company.description ? (
              <p className="mt-4 max-w-2xl text-[13px] leading-6 text-ink-muted">
                {company.description}
              </p>
            ) : null}
          </section>

          <section aria-labelledby="relationships-heading">
            <div className="mb-4 flex items-center gap-2">
              <UsersRound
                className="size-4 text-ink-muted"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <div>
                <h2
                  id="relationships-heading"
                  className="text-[15px] font-semibold text-ink"
                >
                  People at {company.name}
                </h2>
                <p className="mt-1 text-[13px] text-ink-muted">
                  Individual reply and touch metrics, without pipeline stages.
                </p>
              </div>
            </div>
            {people.length ? (
              <div className="border-y border-line">
                {people.map((person) => (
                  <article
                    key={person.id}
                    className="flex flex-col gap-3 border-b border-line py-4 last:border-b-0 sm:flex-row sm:items-center"
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-subtle text-[11px] font-semibold text-ink-muted">
                      {initials(person.displayName)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/people/${person.id}`}
                        className="text-[13px] font-semibold text-ink hover:underline"
                      >
                        {person.displayName}
                      </Link>
                      <p className="mt-0.5 text-[12px] text-ink-muted">
                        {person.title.value}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                      <ReplyBadge state={person.replyState} />
                      <span className="text-[11px] text-ink-faint tabular-nums">
                        {person.touchCount} touches
                      </span>
                      <span className="text-[11px] text-ink-faint">
                        {formatRelativeDate(person.lastTouchAt, now)}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="border-y border-line py-10 text-center text-[13px] text-ink-muted">
                No relationships are linked to this company.
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-8">
          <section aria-labelledby="provenance-heading">
            <h2
              id="provenance-heading"
              className="text-[15px] font-semibold text-ink"
            >
              Source provenance
            </h2>
            <div className="mt-3 border-y border-line">
              {company.sourceProvenance.map((source) => (
                <div
                  key={`${source.provider}-${source.externalId}`}
                  className="flex items-center justify-between gap-3 border-b border-line py-3 last:border-b-0"
                >
                  <ChannelMark channel={source.provider} showLabel />
                  <div className="text-right">
                    <p className="text-[11px] font-medium text-ink">
                      {Math.round(source.confidence * 100)}% source confidence
                    </p>
                    <time
                      dateTime={source.collectedAt}
                      className="text-[10px] text-ink-faint"
                    >
                      Observed {formatDateTime(source.collectedAt)}
                    </time>
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section aria-labelledby="company-audit-heading">
            <div className="mb-3 flex items-center gap-2">
              <History
                className="size-4 text-ink-muted"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <h2
                id="company-audit-heading"
                className="text-[15px] font-semibold text-ink"
              >
                Audit history
              </h2>
            </div>
            {company.audit.length ? (
              <ol className="border-y border-line">
                {company.audit.map((entry) => (
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
            ) : (
              <div className="border-y border-line py-5 text-[12px] text-ink-muted">
                No manual changes recorded.
              </div>
            )}
          </section>
          <div className="rounded-[8px] border border-line bg-surface-subtle px-3 py-3 text-[11px] leading-5 text-ink-muted">
            <ShieldCheck
              className="mr-1 inline size-3.5 text-accent-strong"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            Company corrections update Threadline only. External profiles and
            messages remain untouched.
          </div>
        </aside>
      </div>

      <Modal
        open={editing}
        onOpenChange={setEditing}
        title="Edit company"
        description="Owner-managed fields override the current resolved value inside Threadline."
      >
        <form action={handleEdit} className="space-y-4">
          <label className="block text-[12px] font-medium text-ink">
            Company name
            <input
              name="name"
              defaultValue={company.name}
              required
              className={`${controlClass} mt-1.5`}
            />
          </label>
          <label className="block text-[12px] font-medium text-ink">
            Domain
            <input
              name="domain"
              defaultValue={company.domain ?? ""}
              className={`${controlClass} mt-1.5`}
            />
          </label>
          <label className="block text-[12px] font-medium text-ink">
            Description
            <textarea
              name="description"
              defaultValue={company.description ?? ""}
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
              Save company
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
        description="The original source or model value stays available in the evidence history."
      >
        <form action={handleCorrection} className="space-y-4">
          <label className="block text-[12px] font-medium text-ink">
            Resolved value
            <input
              name="value"
              defaultValue={correcting ? company[correcting].value : ""}
              required
              className={`${controlClass} mt-1.5`}
            />
          </label>
          <label className="block text-[12px] font-medium text-ink">
            Reason, optional
            <textarea name="reason" className={`${textAreaClass} mt-1.5`} />
          </label>
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

      {undo ? (
        <UndoNotice
          message={undoMessage}
          onUndo={() => {
            setCompany(undo);
            setUndo(null);
          }}
          onDismiss={() => setUndo(null)}
        />
      ) : null}
    </div>
  );
}
