"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { enrollCompaniesAction, researchAction, setCompanyStatusAction } from "@/app/(app)/actions";
import { Button, Empty, Score, Select, cn, relativeTime } from "@/components/ui";
import type { ProspectRow } from "@/lib/queries";

const VIEWS = [
  { key: "all", label: "All" },
  { key: "hot", label: "Score 70+" },
  { key: "unresearched", label: "Not researched" },
  { key: "archived", label: "Archived" },
] as const;

export function Prospects({
  rows,
  view,
  q,
  campaigns,
}: {
  rows: ProspectRow[];
  view: string;
  q: string;
  campaigns: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const ids = [...selected];
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const act = (work: () => Promise<{ ok: boolean; error?: string; message?: string }>, success: string) =>
    startTransition(async () => {
      const result = await work();
      if (!result.ok) return void toast.error(result.error ?? "Failed");
      if (result.message) toast.warning(result.message);
      else toast.success(success);
      setSelected(new Set());
      router.refresh();
    });

  return (
    <div>
      <div className="flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.035em]">Prospects</h1>
          <p className="mt-2 text-[14px] text-ink-muted">
            Companies ranked by fit. Research scores them against your pitch; open one to find people and enroll them.
          </p>
        </div>
        <Link href="/find" className="text-[13px] font-medium text-accent-strong hover:underline">
          Find more →
        </Link>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <nav aria-label="Prospect views" className="flex flex-wrap gap-1">
          {VIEWS.map((item) => (
            <Link
              key={item.key}
              href={`/prospects?view=${item.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              aria-current={view === item.key ? "page" : undefined}
              className={cn(
                "rounded-[6px] px-2.5 py-1.5 text-[12px] font-medium",
                view === item.key ? "bg-ink text-white" : "text-ink-muted hover:bg-surface-subtle hover:text-ink",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {q ? (
          <p className="text-[12px] text-ink-muted">
            Matching “{q}” · <Link href={`/prospects?view=${view}`} className="underline">clear</Link>
          </p>
        ) : null}
      </div>

      {selected.size ? (
        <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-[8px] border border-line bg-white px-3 py-2 shadow-[0_4px_16px_oklch(0_0_0/0.06)]">
          <span className="mr-1 text-[13px] font-medium tabular-nums">{selected.size} selected</span>
          <Button
            size="sm"
            disabled={pending || selected.size > 15}
            title={selected.size > 15 ? "Research up to 15 at a time" : undefined}
            onClick={() => act(() => researchAction(ids), "Research done")}
          >
            {pending ? "Working…" : "Research with AI"}
          </Button>
          {campaigns.length ? (
            <>
              <Select
                aria-label="Campaign"
                value={campaignId}
                onChange={(event) => setCampaignId(event.target.value)}
                className="h-8 w-auto text-[12px]"
              >
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="primary"
                disabled={pending || !campaignId}
                onClick={() => act(() => enrollCompaniesAction(ids, campaignId), "Enrolled — drafts are on Today")}
              >
                Enroll their people
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              act(() => setCompanyStatusAction(ids, view === "archived" ? "new" : "archived"), view === "archived" ? "Restored" : "Archived")
            }
          >
            {view === "archived" ? "Restore" : "Archive"}
          </Button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Empty>
          No companies here yet. <Link href="/find" className="font-medium text-accent-strong hover:underline">Find some</Link>.
        </Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
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
                <th className="py-2 pr-4 font-medium">Company</th>
                <th className="w-14 py-2 pr-4 font-medium">Fit</th>
                <th className="py-2 pr-4 font-medium">Best signal</th>
                <th className="w-24 py-2 pr-4 font-medium">People</th>
                <th className="w-28 py-2 font-medium">Added</th>
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
                  <td className="max-w-[320px] py-3 pr-4">
                    <Link href={`/prospects/${row.id}`} className="font-medium text-ink hover:underline">
                      {row.name}
                    </Link>
                    <p className="truncate text-[12px] text-ink-muted">
                      {[row.domain, row.ycBatch ? `YC ${row.ycBatch}` : null].filter(Boolean).join(" · ") || row.source}
                    </p>
                    {row.fitSummary ? <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-ink-muted">{row.fitSummary}</p> : null}
                  </td>
                  <td className="py-3 pr-4">
                    <Score value={row.score} />
                  </td>
                  <td className="max-w-[360px] py-3 pr-4">
                    {row.topSignal ? (
                      <p className="line-clamp-2 text-[12px] leading-5">
                        <span className={cn("mr-1.5 inline-block size-1.5 rounded-full align-middle", row.topStrength === 3 ? "bg-accent" : row.topStrength === 2 ? "bg-secondary" : "bg-ink-faint")} aria-hidden="true" />
                        {row.topSignal}
                        {row.signalCount > 1 ? <span className="text-ink-faint"> +{row.signalCount - 1}</span> : null}
                      </p>
                    ) : (
                      <span className="text-[12px] text-ink-faint">—</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-[12px] text-ink-muted tabular-nums">
                    {row.peopleCount}
                    {row.activeCount ? <span className="text-accent-strong"> · {row.activeCount} contacted</span> : null}
                  </td>
                  <td className="py-3 text-[12px] text-ink-muted">{relativeTime(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
