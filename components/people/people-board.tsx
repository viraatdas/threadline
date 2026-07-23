"use client";

import { ChevronRight, Sparkles, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import {
  extractCampaignTerms,
  loadCampaigns,
  matchesCampaign,
  saveCampaigns,
  type Campaign,
} from "@/components/people/campaigns";
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
import type { RelationshipStage } from "@/lib/domain/constants";

interface StageColumn {
  // The stage written when a card is dropped or moved into this column.
  canonical: RelationshipStage;
  // Every stored stage this column absorbs — the database enum still has 7
  // stages, but the pipeline only needs 4 answers: not sent, their turn,
  // your turn, done.
  stages: readonly RelationshipStage[];
  label: string;
  hint: string;
}

const STAGE_COLUMNS: StageColumn[] = [
  {
    canonical: "planned",
    stages: ["planned"],
    label: "Planned",
    hint: "Not sent yet",
  },
  {
    canonical: "waiting",
    stages: ["waiting", "dormant", "unreviewed"],
    label: "Waiting for reply",
    hint: "Sent — their turn",
  },
  {
    canonical: "replied",
    stages: ["replied", "active"],
    label: "Replied",
    hint: "They answered — your turn",
  },
  {
    canonical: "closed",
    stages: ["closed"],
    label: "Closed",
    hint: "Done",
  },
];

export function stageLabel(stage: RelationshipStage): string {
  return (
    STAGE_COLUMNS.find((column) => column.stages.includes(stage))?.label ??
    stage
  );
}

function bucketOf(stage: RelationshipStage): StageColumn {
  return (
    STAGE_COLUMNS.find((column) => column.stages.includes(stage)) ??
    STAGE_COLUMNS[1]!
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
  // Prefer the server-computed origin direction: list payloads ship with an
  // empty timeline, so deriving it client-side would hide everyone.
  if (person.firstMessageDirection !== undefined) {
    return person.firstMessageDirection === "outbound";
  }
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
  // Default to the narrowest lens that actually has people, so the board
  // never opens blank while data is still syncing or sparse.
  const [lens, setLens] = useState<BoardLens>(() => {
    if (people.some((person) => isOutreach(person, ownerDomain)))
      return "outreach";
    if (people.some(isConversation)) return "conversations";
    return "all";
  });
  const canMove = Boolean(onMoveStage);

  const [campaigns, setCampaigns] = useState<Campaign[]>(() =>
    loadCampaigns(),
  );
  const [activeCampaignId, setActiveCampaignId] = useState("");
  const [campaignFormOpen, setCampaignFormOpen] = useState(false);
  const [campaignName, setCampaignName] = useState("");
  const [campaignSample, setCampaignSample] = useState("");

  const outreachPeople = people.filter((person) =>
    isOutreach(person, ownerDomain),
  );
  const conversationPeople = people.filter(isConversation);
  const lensPeople =
    lens === "outreach"
      ? outreachPeople
      : lens === "conversations"
        ? conversationPeople
        : people;

  const activeCampaign =
    campaigns.find((campaign) => campaign.id === activeCampaignId) ?? null;
  const campaignTerms = useMemo(
    () => (activeCampaign ? extractCampaignTerms(activeCampaign.sample) : []),
    [activeCampaign],
  );
  const shownPeople = activeCampaign
    ? lensPeople.filter((person) => matchesCampaign(person, campaignTerms))
    : lensPeople;

  function createCampaign() {
    const name = campaignName.trim();
    const sample = campaignSample.trim();
    if (!name || !sample) return;
    const campaign: Campaign = {
      id: crypto.randomUUID(),
      name,
      sample,
      createdAt: new Date().toISOString(),
    };
    const next = [...campaigns, campaign];
    setCampaigns(next);
    saveCampaigns(next);
    setActiveCampaignId(campaign.id);
    setCampaignFormOpen(false);
    setCampaignName("");
    setCampaignSample("");
  }

  function removeCampaign(id: string) {
    const next = campaigns.filter((campaign) => campaign.id !== id);
    setCampaigns(next);
    saveCampaigns(next);
    if (activeCampaignId === id) setActiveCampaignId("");
  }

  const grouped = new Map<RelationshipStage, PersonRecord[]>(
    STAGE_COLUMNS.map((column) => [column.canonical, [] as PersonRecord[]]),
  );
  for (const person of shownPeople) {
    grouped.get(bucketOf(person.relationshipStage).canonical)?.push(person);
  }

  function move(personId: string, stage: RelationshipStage) {
    const person = people.find((item) => item.id === personId);
    // Moving within the same bucket is a no-op even when the stored stage
    // differs (e.g. dormant → waiting).
    if (!person || bucketOf(person.relationshipStage).canonical === stage)
      return;
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
            {canMove ? "Drag cards between stages" : "Read-only preview"}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
          Campaign
          <select
            value={activeCampaignId}
            onChange={(event) => setActiveCampaignId(event.target.value)}
            className="h-6 max-w-[200px] cursor-pointer rounded-[6px] border border-line bg-background px-1.5 text-[11px] text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            <option value="">All outreach</option>
            {campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>
        </label>
        {activeCampaign ? (
          <>
            <span className="text-[11px] text-ink-faint">
              {shownPeople.length} matched by sample message
            </span>
            <button
              type="button"
              aria-label={`Delete campaign ${activeCampaign.name}`}
              onClick={() => removeCampaign(activeCampaign.id)}
              className="grid size-5 place-items-center rounded-[5px] text-ink-faint hover:bg-danger/10 hover:text-danger focus-visible:outline-2 focus-visible:outline-accent"
            >
              <X className="size-3" strokeWidth={1.8} aria-hidden="true" />
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => setCampaignFormOpen((open) => !open)}
          className="h-6 rounded-[6px] border border-line bg-background px-2 text-[11px] text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          {campaignFormOpen ? "Cancel" : "New campaign"}
        </button>
      </div>

      {campaignFormOpen ? (
        <div className="max-w-xl space-y-2 rounded-[10px] border border-line bg-surface-subtle p-3">
          <label className="block">
            <span className="text-[11px] font-medium text-ink">
              Campaign name
            </span>
            <input
              value={campaignName}
              onChange={(event) => setCampaignName(event.target.value)}
              placeholder="YC alum outreach"
              className="mt-1 h-8 w-full rounded-[6px] border border-line bg-background px-2 text-[12px] text-ink focus-visible:outline-2 focus-visible:outline-accent"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium text-ink">
              Sample message
            </span>
            <textarea
              value={campaignSample}
              onChange={(event) => setCampaignSample(event.target.value)}
              rows={5}
              placeholder="Paste one email you sent for this campaign — the board keeps conversations whose messages share its distinctive language."
              className="mt-1 w-full rounded-[6px] border border-line bg-background p-2 text-[12px] leading-relaxed text-ink focus-visible:outline-2 focus-visible:outline-accent"
            />
          </label>
          <button
            type="button"
            onClick={createCampaign}
            disabled={!campaignName.trim() || !campaignSample.trim()}
            className="h-7 rounded-[6px] bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-40"
          >
            Save campaign
          </button>
        </div>
      ) : null}

      <div className="-mx-1 overflow-x-auto pb-2">
        <div className="flex min-w-max gap-3 px-1">
          {STAGE_COLUMNS.map((column) => {
            const columnPeople = grouped.get(column.canonical) ?? [];
            const isDropTarget = dragOverStage === column.canonical;
            return (
              <div
                key={column.canonical}
                className={`flex w-[264px] shrink-0 flex-col rounded-[10px] border bg-surface-subtle transition-colors ${
                  isDropTarget
                    ? "border-accent/50 bg-accent-subtle"
                    : "border-line"
                }`}
                onDragOver={(event) => {
                  if (!canMove || !draggedId) return;
                  event.preventDefault();
                  setDragOverStage(column.canonical);
                }}
                onDragLeave={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node))
                    return;
                  setDragOverStage((current) =>
                    current === column.canonical ? null : current,
                  );
                }}
                onDrop={(event) => {
                  if (!canMove || !draggedId) return;
                  event.preventDefault();
                  move(draggedId, column.canonical);
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

                        {person.aiDigest ? (
                          <p
                            className="mt-2 flex items-start gap-1.5 text-[11px] leading-[1.5] text-ink"
                            title={`AI gist (${person.aiDigest.kind}) — generated ${formatTimeAgo(person.aiDigest.at, generatedAt)}`}
                          >
                            <Sparkles
                              className="mt-[2px] size-3 shrink-0 text-accent"
                              strokeWidth={1.8}
                              aria-hidden="true"
                            />
                            <span className="min-w-0">
                              {person.aiDigest.text}
                            </span>
                          </p>
                        ) : null}

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
                                value={
                                  bucketOf(person.relationshipStage).canonical
                                }
                                onChange={(event) =>
                                  move(
                                    person.id,
                                    event.target.value as RelationshipStage,
                                  )
                                }
                                className="h-6 max-w-[120px] cursor-pointer rounded-[6px] border border-transparent bg-transparent px-1 text-[10px] text-ink-faint transition-colors hover:border-line hover:text-ink-muted focus-visible:outline-2 focus-visible:outline-accent"
                              >
                                {STAGE_COLUMNS.map((column) => (
                                  <option
                                    key={column.canonical}
                                    value={column.canonical}
                                  >
                                    Stage: {column.label}
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
