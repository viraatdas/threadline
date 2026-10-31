"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { saveAudienceAction } from "@/app/(app)/actions";
import { PeopleTable } from "@/components/people";
import { Button, Input, Section, Status, relativeTime } from "@/components/ui";
import { CHANNEL_LABELS } from "@/lib/domain";
import type { CampaignData } from "@/lib/queries";

export function CampaignView({
  data,
  campaigns,
  apollo,
}: {
  data: CampaignData;
  campaigns: { id: string; name: string }[];
  apollo: boolean;
}) {
  const { campaign, members, suggestions } = data;
  const router = useRouter();
  const [audience, setAudience] = useState(campaign.audience ?? "");
  const [pending, startTransition] = useTransition();
  const count = (stages: string[]) => members.filter((member) => stages.includes(member.stage)).length;

  const saveAudience = () =>
    startTransition(async () => {
      const result = await saveAudienceAction(campaign.id, audience);
      if (!result.ok) return void toast.error(result.error);
      toast.success(audience.trim() ? "Saved. The hourly job sources from it within the hour." : "Audience cleared");
      router.refresh();
    });

  return (
    <div>
      <div className="flex flex-col gap-4 border-b border-line pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 max-w-3xl">
          <Link href="/campaigns" className="text-[12px] text-ink-muted hover:text-ink">
            ← Campaigns
          </Link>
          <h1 className="mt-1 flex items-center gap-3 text-[28px] leading-[1.15] font-semibold tracking-[-0.035em]">
            {campaign.name}
            <Status tone={campaign.active ? "accent" : "neutral"}>{campaign.active ? "active" : "paused"}</Status>
          </h1>
          <p className="mt-2 text-[13px] leading-6 text-ink-muted">{campaign.angle}</p>
          <ol className="mt-3 flex flex-wrap gap-1.5 text-[12px]">
            {campaign.steps.map((step, index) => (
              <li key={index} className="rounded-[6px] border border-line px-2 py-1 text-ink-muted">
                {index === 0 ? "Day 0" : `+${step.waitDays}d`} · {CHANNEL_LABELS[step.channel]}
              </li>
            ))}
          </ol>
        </div>
        <dl className="grid shrink-0 grid-cols-4 gap-4 text-right text-[12px] text-ink-muted">
          {(
            [
              ["In sequence", count(["active"])],
              ["Replied", count(["replied", "meeting"])],
              ["Closed", count(["closed"])],
              ["Total", members.length],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="text-[16px] font-semibold text-ink tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <Section
        title="Audience"
        description="Who to source for this campaign: YC directory phrases, comma-separated (matched against each company's description, industry and tags). Once a day the hourly job adds new matches to Prospects, researches them, finds their people and looks up a few emails. It never enrolls anyone."
      >
        <form
          className="flex max-w-3xl flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            saveAudience();
          }}
        >
          <Input
            aria-label="Audience"
            value={audience}
            onChange={(event) => setAudience(event.target.value)}
            placeholder="ios, mobile app, macos, react native"
          />
          <Button type="submit" disabled={pending}>
            Save
          </Button>
        </form>
        <p className="mt-2 text-[12px] text-ink-faint">
          {campaign.audience
            ? data.sourcedAt
              ? `Last sourced ${relativeTime(data.sourcedAt)}.`
              : "Not sourced yet; the next hourly run will."
            : "No audience: add companies from Find instead."}
        </p>
      </Section>

      <Section title={`In this campaign (${members.length})`} description="Everyone enrolled, with where they are in the sequence.">
        <PeopleTable
          rows={members}
          campaigns={campaigns}
          apollo={apollo}
          defaultCampaignId={campaign.id}
          empty="No one enrolled yet. Pick from the best candidates below."
        />
      </Section>

      <Section
        title="Best next candidates"
        description="The highest-ranked people not in any sequence and not already in touch with you. Enrolling drafts the first step on Today; nothing sends until you approve it."
      >
        <PeopleTable
          rows={suggestions}
          campaigns={campaigns}
          apollo={apollo}
          defaultCampaignId={campaign.id}
          empty={
            <>
              No candidates yet. See <Link href="/people" className="font-medium text-accent-strong hover:underline">People</Link>.
            </>
          }
        />
      </Section>
    </div>
  );
}
