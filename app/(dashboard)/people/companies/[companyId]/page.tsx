import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CompanyDetail } from "@/components/people/company-detail";
import type { PeopleWorkspaceData } from "@/components/people/types";
import { loadCompanyWorkspaceData } from "@/lib/db/workspace";

import { correctCompany, editCompany } from "../../../workspace-actions";

interface CompanyPageProps {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

async function getWorkspaceData(
  companyId: string,
  searchParams: CompanyPageProps["searchParams"],
): Promise<PeopleWorkspaceData> {
  const query = await searchParams;
  return first(query.demo) === "1"
    ? (await import("@/components/people/sample-data")).workspaceData
    : loadCompanyWorkspaceData(companyId);
}

export async function generateMetadata({
  params,
  searchParams,
}: CompanyPageProps): Promise<Metadata> {
  const { companyId } = await params;
  const data = await getWorkspaceData(companyId, searchParams);
  const company = data.companies.find((item) => item.id === companyId);
  return { title: company?.name ?? "Company" };
}

export default async function CompanyPage({
  params,
  searchParams,
}: CompanyPageProps) {
  const { companyId } = await params;
  const [query, data] = await Promise.all([
    searchParams,
    getWorkspaceData(companyId, searchParams),
  ]);
  const demo = first(query.demo) === "1";
  const company = data.companies.find((item) => item.id === companyId);
  if (!company) notFound();

  return (
    <CompanyDetail
      initialCompany={company}
      people={data.people.filter((person) => person.companyId === company.id)}
      now={data.generatedAt}
      {...(demo
        ? {}
        : {
            editCompanyAction: editCompany,
            correctCompanyAction: correctCompany,
          })}
    />
  );
}
