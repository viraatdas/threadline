import type { Metadata } from "next";

import { workspaceData } from "@/components/people";
import type { OutreachFilters } from "@/components/people";
import { OutreachWorkspace } from "@/components/outreach";
import { CHANNEL_VALUES } from "@/lib/domain/constants";

export const metadata: Metadata = {
  title: "Outreach",
  description: "Review planned, due, waiting, replied, and stale follow-ups.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseFilters(params: Awaited<SearchParams>): OutreachFilters {
  const channel = first(params.channel);
  const state = first(params.state);
  return {
    query: first(params.q) ?? "",
    channel:
      channel &&
      CHANNEL_VALUES.includes(channel as (typeof CHANNEL_VALUES)[number])
        ? (channel as OutreachFilters["channel"])
        : "all",
    ownerState:
      state === "needs_review" || state === "overridden" ? state : "all",
  };
}

export default async function OutreachPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  return (
    <OutreachWorkspace
      data={workspaceData}
      initialFilters={parseFilters(params)}
    />
  );
}
