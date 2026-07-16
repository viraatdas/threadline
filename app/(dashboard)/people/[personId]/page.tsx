import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PersonDetail } from "@/components/people/person-detail";
import type { PeopleWorkspaceData } from "@/components/people/types";
import { loadPersonWorkspaceData } from "@/lib/db/workspace";

import {
  correctContact,
  editContact,
  upsertOutreachPlan,
} from "../../workspace-actions";

interface PersonPageProps {
  params: Promise<{ personId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function getWorkspaceData(
  personId: string,
  searchParams: PersonPageProps["searchParams"],
): Promise<PeopleWorkspaceData> {
  const query = await searchParams;
  return first(query.demo) === "1"
    ? (await import("@/components/people/sample-data")).workspaceData
    : loadPersonWorkspaceData(personId);
}

export async function generateMetadata({
  params,
  searchParams,
}: PersonPageProps): Promise<Metadata> {
  const { personId } = await params;
  const data = await getWorkspaceData(personId, searchParams);
  const person = data.people.find((item) => item.id === personId);
  return { title: person?.displayName ?? "Relationship" };
}

export default async function PersonPage({
  params,
  searchParams,
}: PersonPageProps) {
  const { personId } = await params;
  const [query, data] = await Promise.all([
    searchParams,
    getWorkspaceData(personId, searchParams),
  ]);
  const demo = first(query.demo) === "1";
  const person = data.people.find((item) => item.id === personId);
  if (!person) notFound();

  return (
    <PersonDetail
      initialPerson={person}
      company={
        person.companyId
          ? (data.companies.find(
              (company) => company.id === person.companyId,
            ) ?? null)
          : null
      }
      initialPlan={
        data.plans.find((plan) => plan.contactId === person.id) ?? null
      }
      now={data.generatedAt}
      {...(demo
        ? {}
        : {
            editContactAction: editContact,
            correctContactAction: correctContact,
            upsertPlanAction: upsertOutreachPlan,
          })}
    />
  );
}
