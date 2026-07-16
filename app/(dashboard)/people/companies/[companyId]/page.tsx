import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  CompanyDetail,
  getCompany,
  WORKSPACE_NOW,
  workspaceData,
} from "@/components/people";

interface CompanyPageProps {
  params: Promise<{ companyId: string }>;
}

export async function generateMetadata({
  params,
}: CompanyPageProps): Promise<Metadata> {
  const company = getCompany((await params).companyId);
  return { title: company?.name ?? "Company" };
}

export default async function CompanyPage({ params }: CompanyPageProps) {
  const { companyId } = await params;
  const company = getCompany(companyId);
  if (!company) notFound();

  return (
    <CompanyDetail
      initialCompany={company}
      people={workspaceData.people.filter(
        (person) => person.companyId === company.id,
      )}
      now={WORKSPACE_NOW}
    />
  );
}
