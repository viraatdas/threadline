import type { Metadata } from "next";

import { PeopleWorkspace } from "@/components/people/people-workspace";
import type { PeopleFilters } from "@/components/people/types";
import { loadPeopleListWorkspaceData } from "@/lib/db/workspace";
import { CHANNEL_VALUES, REPLY_STATE_VALUES } from "@/lib/domain/constants";

import { addContact, mergeContacts } from "../workspace-actions";

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
  const demo = first(params.demo) === "1";
  const data =
    demo
      ? (await import("@/components/people/sample-data")).workspaceData
      : await loadPeopleListWorkspaceData();
  return (
    <PeopleWorkspace
      data={data}
      initialFilters={parseFilters(params)}
      {...(mergeId && data.people.some((person) => person.id === mergeId)
        ? { initialMergeSourceId: mergeId }
        : {})}
      {...(demo
        ? {}
        : {
            addContactAction: addContact,
            mergeContactsAction: mergeContacts,
          })}
    />
  );
}
