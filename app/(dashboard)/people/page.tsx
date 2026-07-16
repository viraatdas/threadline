import type { Metadata } from "next";

import { PeopleWorkspace, workspaceData } from "@/components/people";
import type { PeopleFilters } from "@/components/people";
import { CHANNEL_VALUES, REPLY_STATE_VALUES } from "@/lib/domain/constants";

export const metadata: Metadata = {
  title: "People",
  description:
    "Search and inspect source-grounded relationships and companies.",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseFilters(params: Awaited<SearchParams>): PeopleFilters {
  const view = first(params.view);
  const reply = first(params.reply);
  const channel = first(params.channel);
  const confidence = first(params.confidence);

  return {
    query: first(params.q) ?? "",
    view: view === "companies" ? "companies" : "people",
    reply:
      reply &&
      REPLY_STATE_VALUES.includes(reply as (typeof REPLY_STATE_VALUES)[number])
        ? (reply as PeopleFilters["reply"])
        : "all",
    channel:
      channel &&
      CHANNEL_VALUES.includes(channel as (typeof CHANNEL_VALUES)[number])
        ? (channel as PeopleFilters["channel"])
        : "all",
    confidence:
      confidence === "review" || confidence === "confirmed"
        ? confidence
        : "all",
  };
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const mergeId = first(params.merge);
  return (
    <PeopleWorkspace
      data={workspaceData}
      initialFilters={parseFilters(params)}
      {...(mergeId &&
      workspaceData.people.some((person) => person.id === mergeId)
        ? { initialMergeSourceId: mergeId }
        : {})}
    />
  );
}
