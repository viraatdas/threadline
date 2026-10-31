"use client";

import { Mail, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { enrollAction, findEmailsAction } from "@/app/(app)/actions";
import { Button, Empty, Score, Select, Status, cn, relativeTime } from "@/components/ui";
import { describeInTouch } from "@/lib/domain";
import type { PeopleData, PersonRow } from "@/lib/queries";
import { STAKEHOLDER_LABELS } from "@/lib/rank";

const VIEWS = [
  { key: "best", label: "Best next" },
  { key: "active", label: "In sequence" },
  { key: "replied", label: "Replied" },
  { key: "held", label: "Already in touch" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
] as const;

const MAX_BATCH = 25;

export function People({
  data,
  q,
  campaigns,
  apollo,
  lastFill,
}: {
  data: PeopleData;
  q: string;
  campaigns: { id: string; name: string }[];
  apollo: boolean;
  lastFill: { at: string; sourced: number; researched: number; peopleFound: number; emails: number } | null;
}) {
  return (
    <div>
      <div className="flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-3xl">
          <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.035em]">People</h1>
          <p className="mt-2 text-[14px] leading-6 text-ink-muted">
            Everyone you could reach, best first. The score is the company’s fit, times how close their role is to the
            CI decision, times whether you can reach them, adjusted by who has replied so far. Each row says why.
          </p>
          {lastFill ? (
            <p className="mt-1 text-[12px] text-ink-faint">
              Hourly fill {relativeTime(lastFill.at)}: +{lastFill.sourced} companies, {lastFill.researched} researched,{" "}
              {lastFill.peopleFound} people found, {lastFill.emails} emails from Apollo.
            </p>
          ) : null}
        </div>
        <Link href="/find" className="text-[13px] font-medium text-accent-strong hover:underline">
          Find more →
        </Link>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <nav aria-label="People views" className="flex flex-wrap gap-1">
          {VIEWS.map((item) => (
            <Link
              key={item.key}
              href={`/people?view=${item.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              aria-current={data.view === item.key ? "page" : undefined}
              className={cn(
                "rounded-[6px] px-2.5 py-1.5 text-[12px] font-medium",
                data.view === item.key ? "bg-ink text-white" : "text-ink-muted hover:bg-surface-subtle hover:text-ink",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <form action="/people" className="flex items-center gap-2">
          <input type="hidden" name="view" value={data.view} />
          <input
            name="q"
            defaultValue={q}
            placeholder="Name, title or company"
            aria-label="Search people"
            className="h-8 w-56 rounded-[7px] border border-line bg-white px-2.5 text-[12px] outline-none focus:border-line-strong"
          />
        </form>
      </div>

      <PeopleTable
        rows={data.rows}
        campaigns={campaigns}
        apollo={apollo}
        empty={
          data.view === "best" ? (
            <>
              No one to contact yet. Research companies on{" "}
              <Link href="/prospects" className="font-medium text-accent-strong hover:underline">Prospects</Link> and find
              their people, or give a campaign an audience and the hourly job will do it.
            </>
          ) : (
            "No one here."
          )
        }
      />
      {data.total > data.rows.length ? (
        <p className="mt-3 text-[12px] text-ink-faint">
          Showing the top {data.rows.length} of {data.total}. Search to narrow it down.
        </p>
      ) : null}

      <Learning learning={data.learning} />
    </div>
  );
}

export function PeopleTable({
  rows,
  campaigns,
  apollo,
  empty,
  defaultCampaignId,
}: {
  rows: PersonRow[];
  campaigns: { id: string; name: string }[];
  apollo: boolean;
  empty: React.ReactNode;
  defaultCampaignId?: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [campaignId, setCampaignId] = useState(defaultCampaignId ?? campaigns[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const ids = [...selected];
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const tooMany = selected.size > MAX_BATCH;

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const enroll = () =>
    startTransition(async () => {
      const result = await enrollAction(ids, campaignId);
      if (!result.ok) return void toast.error(result.error);
      if (result.message) toast.warning(result.message);
      else toast.success(`Enrolled ${result.data.enrolled}. Drafts are on Today.`);
      setSelected(new Set());
      router.refresh();
    });

  const findEmails = () =>
    startTransition(async () => {
      const result = await findEmailsAction(ids);
      if (!result.ok) return void toast.error(result.error);
      toast.success(`Apollo found ${result.data.found} of ${result.data.checked} emails`);
      setSelected(new Set());
      router.refresh();
    });

  if (!rows.length) return <Empty>{empty}</Empty>;

  return (
    <>
      {selected.size ? (
        <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-[8px] border border-line bg-white px-3 py-2 shadow-[0_4px_16px_oklch(0_0_0/0.06)]">
          <span className="mr-1 text-[13px] font-medium tabular-nums">{selected.size} selected</span>
          {tooMany ? <span className="text-[12px] text-warning">Up to {MAX_BATCH} at a time</span> : null}
          {campaigns.length ? (
            <>
              <Select aria-label="Campaign" value={campaignId} onChange={(event) => setCampaignId(event.target.value)} className="h-8 w-auto text-[12px]">
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </Select>
              <Button size="sm" variant="primary" disabled={pending || !campaignId || tooMany} onClick={enroll}>
                Enroll
              </Button>
            </>
          ) : null}
          {apollo ? (
            <Button size="sm" disabled={pending || tooMany} onClick={findEmails} title="Uses one Apollo credit per person">
              Find emails
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left text-[13px]">
          <thead>
            <tr className="border-b border-line text-[12px] text-ink-muted">
              <th className="w-8 py-2 pr-2">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)))}
                  className="accent-[var(--accent)]"
                />
              </th>
              <th className="py-2 pr-4 font-medium">Person</th>
              <th className="py-2 pr-4 font-medium">Why</th>
              <th className="w-40 py-2 pr-4 font-medium">Reach</th>
              <th className="w-48 py-2 pr-4 font-medium">Status</th>
              <th className="w-14 py-2 font-medium">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className={cn("border-b border-line align-top", selected.has(row.id) && "bg-accent-subtle/50")}>
                <td className="py-3 pr-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.name}`}
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row.id)}
                    className="accent-[var(--accent)]"
                  />
                </td>
                <td className="max-w-[260px] py-3 pr-4">
                  <p className="font-medium text-ink">{row.name}</p>
                  <p className="truncate text-[12px] text-ink-muted">{row.title ?? "No title"}</p>
                  <p className="mt-0.5 text-[12px] text-ink-faint">
                    {STAKEHOLDER_LABELS[row.rank.stakeholder]}
                    {row.company ? (
                      <>
                        {" · "}
                        <Link href={`/prospects/${row.company.id}`} className="text-ink-muted hover:text-ink hover:underline">
                          {row.company.name}
                        </Link>
                      </>
                    ) : null}
                  </p>
                </td>
                <td className="max-w-[380px] py-3 pr-4 text-[12px] leading-5 text-ink-muted">
                  <p className="line-clamp-3">{row.rank.reasons.slice(1).join(" · ")}</p>
                  <p className="mt-0.5 line-clamp-1 text-ink-faint">{row.rank.reasons[0]}</p>
                </td>
                <td className="py-3 pr-4 text-[12px] text-ink-muted">
                  {row.email ? (
                    <p className="flex items-center gap-1 truncate" title={row.email}>
                      <Mail className="size-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">{row.email}</span>
                    </p>
                  ) : null}
                  {row.emailStatus && row.emailStatus !== "found" ? (
                    <p className={row.emailStatus === "bounced" ? "text-danger" : "text-warning"}>{row.emailStatus}</p>
                  ) : null}
                  {row.linkedinUrl ? (
                    <a href={row.linkedinUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-ink">
                      <UserRound className="size-3" aria-hidden="true" />
                      LinkedIn
                    </a>
                  ) : null}
                  {!row.email && !row.linkedinUrl ? <span className="text-ink-faint">—</span> : null}
                </td>
                <td className="py-3 pr-4 text-[12px] text-ink-muted">
                  <PersonStatus row={row} />
                </td>
                <td className="py-3">
                  <Score value={row.rank.score} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PersonStatus({ row }: { row: PersonRow }) {
  const touch = row.inTouch ? (
    <p className="mt-1">
      <Status tone={row.included ? "neutral" : "warning"}>
        {row.included ? "In touch, included" : "In touch"}
      </Status>
      <span className="block text-ink-faint">{describeInTouch(row.inTouch)}</span>
    </p>
  ) : null;
  if (row.stage === "active") {
    return (
      <>
        <Status tone="blue">
          {row.campaign ? `${row.campaign.name} · step ${row.nextStep + 1}/${row.campaign.steps}` : "In sequence"}
        </Status>
        {row.nextStepAt ? <p className="text-ink-faint">next {relativeTime(row.nextStepAt)}</p> : null}
        {touch}
      </>
    );
  }
  if (row.stage === "replied" || row.stage === "meeting") {
    return <Status tone="accent">{row.stage === "meeting" ? "Meeting" : `Replied ${relativeTime(row.repliedAt)}`}</Status>;
  }
  if (row.stage === "closed") {
    return <Status>Closed{row.closedReason ? ` (${row.closedReason.replaceAll("_", " ")})` : ""}</Status>;
  }
  return (
    <>
      <Status>{row.lastContactedAt ? `Contacted ${relativeTime(row.lastContactedAt)}` : "Not contacted"}</Status>
      {touch}
    </>
  );
}

function Learning({ learning }: { learning: PeopleData["learning"] }) {
  return (
    <section className="mt-10 border-t border-line pt-6">
      <h2 className="text-[15px] font-semibold">What’s working</h2>
      {learning.replied === 0 ? (
        <p className="mt-1 max-w-2xl text-[13px] leading-6 text-ink-muted">
          {learning.contacted
            ? `${learning.contacted} contacted, no replies yet.`
            : "Nothing sent yet."}{" "}
          Once replies come in, reply rates by role, first channel and campaign show here, and roles that reply more
          rank higher (pulled toward the average until there are enough of them).
        </p>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-ink-muted">
            {learning.replied} of {learning.contacted} contacted replied ({Math.round((learning.replied / learning.contacted) * 100)}%).
          </p>
          <div className="mt-4 grid gap-6 md:grid-cols-3">
            <RateTable title="By role" rows={learning.byRole} lifts={learning.lifts} />
            <RateTable title="By first channel" rows={learning.byChannel} />
            <RateTable title="By campaign" rows={learning.byCampaign} />
          </div>
        </>
      )}
    </section>
  );
}

function RateTable({
  title,
  rows,
  lifts,
}: {
  title: string;
  rows: { key: string; label: string; contacted: number; replied: number }[];
  lifts?: PeopleData["learning"]["lifts"];
}) {
  return (
    <table className="w-full text-left text-[12px]">
      <caption className="mb-1 text-left font-medium text-ink">{title}</caption>
      <thead>
        <tr className="border-b border-line text-ink-muted">
          <th className="py-1 pr-2 font-normal"> </th>
          <th className="py-1 pr-2 text-right font-normal">Replied</th>
          <th className="py-1 text-right font-normal">{lifts ? "Ranking ×" : "Rate"}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className="border-b border-line">
            <td className="py-1 pr-2">{row.label}</td>
            <td className="py-1 pr-2 text-right tabular-nums">
              {row.replied}/{row.contacted}
            </td>
            <td className="py-1 text-right tabular-nums">
              {lifts ? (lifts[row.key]?.lift ?? 1).toFixed(1) : `${Math.round((row.replied / row.contacted) * 100)}%`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
