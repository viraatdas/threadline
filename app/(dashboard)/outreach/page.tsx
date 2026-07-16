import type { Metadata } from "next";

import type { OutreachFilters } from "@/components/people/types";
import { OutreachWorkspace } from "@/components/outreach/outreach-workspace";
import { loadOutreachWorkspaceData } from "@/lib/db/workspace";
import { CHANNEL_VALUES } from "@/lib/domain/constants";

import {
  completeOutreachPlan,
  rescheduleOutreachPlan,
  retryOutreachDraft,
} from "../workspace-actions";

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
  const demo = first(params.demo) === "1";
  const data =
    demo
      ? (await import("@/components/people/sample-data")).workspaceData
      : await loadOutreachWorkspaceData();
  return (
    <OutreachWorkspace
      data={data}
      initialFilters={parseFilters(params)}
      {...(demo
        ? {}
        : {
            completePlanAction: completeOutreachPlan,
            reschedulePlanAction: rescheduleOutreachPlan,
            retryDraftAction: retryOutreachDraft,
          })}
    />
  );
}
