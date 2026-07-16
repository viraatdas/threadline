import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  getCompany,
  getPerson,
  getPlanForPerson,
  PersonDetail,
  WORKSPACE_NOW,
} from "@/components/people";

interface PersonPageProps {
  params: Promise<{ personId: string }>;
}

export async function generateMetadata({
  params,
}: PersonPageProps): Promise<Metadata> {
  const person = getPerson((await params).personId);
  return { title: person?.displayName ?? "Relationship" };
}

export default async function PersonPage({ params }: PersonPageProps) {
  const { personId } = await params;
  const person = getPerson(personId);
  if (!person) notFound();

  return (
    <PersonDetail
      initialPerson={person}
      company={person.companyId ? getCompany(person.companyId) : null}
      initialPlan={getPlanForPerson(person.id)}
      now={WORKSPACE_NOW}
    />
  );
}
